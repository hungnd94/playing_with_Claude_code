import test from 'node:test';
import assert from 'node:assert/strict';
import { rng } from './helpers.js';
import { compileToAsm, CompileError } from '../src/compiler.js';
import { assemble, loadImage } from '../src/asm.js';
import { Emulator } from '../src/isa.js';
import { buildCPU } from '../src/cpu.js';
import { optimize } from '../src/netlist.js';
import { createMachineSync } from '../src/wasm.js';

const s16 = (x) => (x << 16) >> 16;
const netlist = optimize(buildCPU());

/** Compile + run on the emulator; returns { emu, img }. Optionally cross-check the gates. */
function run(src, { gates = false, maxCycles = 5e6 } = {}) {
  const img = assemble(compileToAsm(src));
  const emu = new Emulator(new Uint16Array(65536), new Uint16Array(65536));
  loadImage(img, emu.rom, emu.ram);
  emu.run(maxCycles);
  assert.ok(emu.halted, 'program did not halt');
  if (gates) {
    const m = createMachineSync(netlist);
    loadImage(img, m.mems.rom, m.mems.ram);
    m.run(emu.cycles + 2);
    assert.ok(m.mems.ram.every((v, i) => v === emu.ram[i]), 'gates disagree with the emulator');
  }
  return { emu, img };
}

function outputs(src, opts) {
  const { emu, img } = run(src, opts);
  const base = img.labels.get('g_out');
  const n = emu.ram[img.labels.get('g_n')];
  return [...emu.ram.subarray(base, base + n)].map(s16);
}

const PRELUDE = 'var out[200]; var n = 0; fn emit(x) { out[n] = x; n += 1; }\n';

test('arithmetic, control flow, recursion (also on the gates)', () => {
  const got = outputs(PRELUDE + `
    fn fib(k) { if (k < 2) { return k; } return fib(k - 1) + fib(k - 2); }
    fn gcd(a, b) { while (b != 0) { var t = a % b; a = b; b = t; } return a; }
    fn main() {
      emit(fib(12));
      emit(gcd(1071, 462));
      var s = 0;
      for (var i = 0; i < 10; i++) { if (i == 3) { continue; } if (i == 8) { break; } s += i; }
      emit(s);
      var k = 0; do { k += 7; } while (k < 30); emit(k);
      emit(-100 / 7); emit(-100 % 7); emit(100 / -7); emit(-9 / 4); emit(-9 % 4); emit(9 % 4);
      emit(1 << 15); emit(-32768 >> 3); emit(-32768 >>> 3);
      emit(!0 + !5 * 2 + ~0 * 4);
    }`, { gates: true });
  assert.deepEqual(got, [144, 21, 25, 35, -14, -2, -14, -2, -1, 1, -32768, -4096, 4096, 1 - 4]);
});

test('arrays, pointers, strings, globals', () => {
  const got = outputs(PRELUDE + `
    const N = 8;
    var a[N];
    var primes[] = { 2, 3, 5, 7, 11 };
    var msg[] = "Hi!";
    var g = 40;
    fn sum(p, len) { var s = 0; for (var i = 0; i < len; i++) { s += p[i]; } return s; }
    fn strlen(p) { var k = 0; while (p[k]) { k++; } return k; }
    fn main() {
      for (var i = 0; i < N; i++) { a[i] = i * i; }
      emit(sum(a, N));
      emit(sum(primes, 5));
      emit(strlen(msg)); emit(msg[1]);
      emit(strlen("hello, world"));
      g += 2; emit(g);
      mem[&g] = 7; emit(g);
      var p = &a; p[2] = 99; emit(a[2]);
      emit(primes[primes[0]]);
    }`);
  assert.deepEqual(got, [140, 28, 3, 105, 12, 42, 7, 99, 5]);
});

// ------------------------------------------------------------ fuzzing

const BIN = ['+', '-', '*', '&', '|', '^', '<<', '>>', '>>>', '==', '!=', '<', '<=', '>', '>=', '&&', '||', '/', '%'];

function evalBin(op, a, b) {
  a = s16(a); b = s16(b);
  switch (op) {
    case '+': return s16(a + b);
    case '-': return s16(a - b);
    case '*': return s16(Math.imul(a, b));
    case '&': return s16(a & b);
    case '|': return s16(a | b);
    case '^': return s16(a ^ b);
    case '<<': return s16(a << (b & 15));
    case '>>': return s16(a >> (b & 15));
    case '>>>': return s16((a & 0xffff) >>> (b & 15));
    case '==': return +(a === b);
    case '!=': return +(a !== b);
    case '<': return +(a < b);
    case '<=': return +(a <= b);
    case '>': return +(a > b);
    case '>=': return +(a >= b);
    case '&&': return +(a !== 0 && b !== 0);
    case '||': return +(a !== 0 || b !== 0);
    case '/': return s16(Math.trunc(a / b));
    case '%': return s16(a % b) || 0;
  }
  throw new Error(op);
}

function genExpr(rand, depth, env) {
  const r = rand();
  if (depth <= 0 || r < 0.25) {
    const k = rand();
    if (k < 0.3) { const v = ((rand() * 200) | 0) - 100; return { src: String(v), v }; }
    if (k < 0.4) { const v = s16((rand() * 65536) | 0); return { src: `(${v})`, v }; }
    const names = Object.keys(env);
    const name = names[(rand() * names.length) | 0];
    if (name.startsWith('arr')) { const i = (rand() * 4) | 0; return { src: `${name}[${i}]`, v: env[name][i] }; }
    return { src: name, v: env[name] };
  }
  const kind = rand();
  if (kind < 0.12) {
    const e = genExpr(rand, depth - 1, env);
    const op = ['-', '!', '~'][(rand() * 3) | 0];
    return { src: `${op}(${e.src})`, v: op === '-' ? s16(-e.v) : op === '!' ? +(e.v === 0) : s16(~e.v) };
  }
  if (kind < 0.2) {
    const a = genExpr(rand, depth - 1, env), b = genExpr(rand, depth - 1, env);
    if (rand() < 0.5) return { src: `add2(${a.src}, ${b.src})`, v: s16(a.v + b.v) };
    return { src: `mulh(${a.src}, ${b.src})`, v: s16(Math.imul(a.v, b.v) >> 16) };
  }
  const op = BIN[(rand() * BIN.length) | 0];
  const a = genExpr(rand, depth - 1, env);
  let b = genExpr(rand, depth - 1, env);
  if (op === '/' || op === '%') {
    if (rand() < 0.4) { const k = [1, 2, 4, 8, 16, 1024][(rand() * 6) | 0]; b = { src: String(k), v: k }; }
    else b = { src: `(${b.src} | 1)`, v: s16(b.v | 1) };
  }
  return { src: `(${a.src} ${op} ${b.src})`, v: evalBin(op, a.v, b.v) };
}

test('fuzz: random expressions agree with a JavaScript reference', () => {
  const rand = rng(2024);
  for (let prog = 0; prog < 60; prog++) {
    const env = {};
    const decls = [];
    // locals (some will get registers, some will live in the frame)
    const nLocals = 2 + ((rand() * 6) | 0);
    for (let i = 0; i < nLocals; i++) {
      const v = s16(((rand() * 2000) | 0) - 1000);
      env[`x${i}`] = v;
      decls.push(`var x${i} = ${v};`);
    }
    const globals = [];
    env.g0 = s16((rand() * 65536) | 0);
    globals.push(`var g0 = ${env.g0};`);
    env.arr0 = [1, -2, 300, -32768].map(s16);
    globals.push(`var arr0[] = { ${env.arr0.join(', ')} };`);
    const body = [];
    const expected = [];
    for (let k = 0; k < 25; k++) {
      const e = genExpr(rand, 1 + ((rand() * 4) | 0), env);
      if (rand() < 0.3) {
        // assign to a local, then emit it
        const names = Object.keys(env).filter((x) => x.startsWith('x'));
        const name = names[(rand() * names.length) | 0];
        env[name] = e.v;
        body.push(`${name} = ${e.src}; emit(${name});`);
      } else body.push(`emit(${e.src});`);
      expected.push(e.v);
    }
    const src = PRELUDE + globals.join('\n') + '\nfn add2(a, b) { return a + b; }\n' +
      `fn main() {\n${decls.join('\n')}\n${body.join('\n')}\n}\n`;
    let got;
    try { got = outputs(src, { gates: prog % 10 === 0 }); } catch (e) { throw new Error(`${e.message}\n${src}`); }
    assert.deepEqual(got, expected, src);
  }
});

test('compile errors point at the line', () => {
  assert.throws(() => compileToAsm('fn main() {\n  x = 1;\n}'), (e) => e instanceof CompileError && /line 2: unknown name 'x'/.test(e.message));
  assert.throws(() => compileToAsm('fn main() { foo(); }'), /unknown function 'foo'/);
  assert.throws(() => compileToAsm('fn f(a) {} fn main() { f(1, 2); }'), /expects 1 argument/);
  assert.throws(() => compileToAsm('fn main() { break; }'), /break outside a loop/);
});
