import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble, loadImage, evalExpr } from '../src/asm.js';
import { Emulator, disassemble } from '../src/isa.js';
import { buildCPU } from '../src/cpu.js';
import { optimize } from '../src/netlist.js';
import { createMachineSync } from '../src/wasm.js';

const netlist = optimize(buildCPU());

/** Run on the reference emulator and on the gates; check they agree. */
export function runBoth(img, maxCycles = 200000) {
  const emu = new Emulator(new Uint16Array(65536), new Uint16Array(65536));
  loadImage(img, emu.rom, emu.ram);
  emu.run(maxCycles);
  assert.ok(emu.halted, 'program should halt');
  const m = createMachineSync(netlist);
  loadImage(img, m.mems.rom, m.mems.ram);
  m.run(emu.cycles + 5); // halt is a jump-to-self, extra cycles are harmless
  assert.equal(m.reg('pc'), emu.pc);
  for (let r = 1; r < 8; r++) assert.equal(m.reg(`r${r}`), emu.r[r], `r${r}`);
  assert.ok(m.mems.ram.every((v, i) => v === emu.ram[i]), 'RAM must match');
  return emu;
}

test('expressions', () => {
  const sym = (s) => ({ A: 10 }[s]);
  assert.equal(evalExpr('1 + 2 * 3', sym), 7);
  assert.equal(evalExpr('(1 + 2) * 3', sym), 9);
  assert.equal(evalExpr('A << 2 | 1', sym), 41);
  assert.equal(evalExpr("'a' + 1", sym), 98);
  assert.equal(evalExpr('-0x10 & 0xff', sym), 0xf0);
});

test('fibonacci table', () => {
  const img = assemble(`
        li   r1, 0          ; a
        li   r2, 1          ; b
        li   r3, fib        ; pointer
        li   r4, 20         ; count
  loop: st   [r3], r1
        add  r5, r1, r2
        mov  r1, r2
        mov  r2, r5
        inc  r3
        dec  r4
        jnz  r4, loop
        halt
  .data
  fib:  .zero 20
  `);
  const emu = runBoth(img);
  const base = img.labels.get('fib');
  const fib = [0, 1];
  while (fib.length < 20) fib.push(fib[fib.length - 1] + fib[fib.length - 2]);
  assert.deepEqual([...emu.ram.subarray(base, base + 20)], fib);
});

test('recursive factorial with a stack', () => {
  const img = assemble(`
        li   sp, 0x8000
        li   r1, 7
        call fact
        st   [result], r1
        halt
  ; fact(r1) -> r1, recursive
  fact: jgt  r1, recurse
        li   r1, 1
        ret
  recurse:
        sub  sp, sp, 2
        st   [sp + 0], lr
        st   [sp + 1], r1
        dec  r1
        call fact
        ld   r2, [sp + 1]
        ld   lr, [sp + 0]
        add  sp, sp, 2
        mul  r1, r1, r2
        ret
  .data
  result: .word 0
  `);
  const emu = runBoth(img);
  assert.equal(emu.ram[img.labels.get('result')], 5040);
});

test('bubble sort', () => {
  const values = [9, -3, 700, 42, 0, 5, 5, -32768, 32767, 1];
  const img = assemble(`
  N = ${values.length}
        li   r1, N - 1            ; outer counter
  outer:
        li   r2, 0                ; i
        li   r6, 0                ; swapped
  inner:
        ld   r3, [r2 + arr]
        ld   r4, [r2 + arr + 1]
        slt  r5, r4, r3           ; arr[i+1] < arr[i] ?
        jz   r5, noswap
        st   [r2 + arr], r4
        st   [r2 + arr + 1], r3
        li   r6, 1
  noswap:
        inc  r2
        sub  r5, r2, r1
        jnz  r5, inner
        jz   r6, done
        dec  r1
        jnz  r1, outer
  done: halt
  .data
  arr:  .word ${values.join(', ')}
  `);
  const emu = runBoth(img);
  const base = img.labels.get('arr');
  const got = [...emu.ram.subarray(base, base + values.length)].map((x) => (x << 16) >> 16);
  assert.deepEqual(got, values.slice().sort((a, b) => a - b));
});

test('disassembler round-trips the common forms', () => {
  const src = ['add r1, r2, r3', 'sub r1, r2, 5', 'ld r1, [r2 + 3]', 'st [r2 + 3], r4', 'jz r1, 0x0000', 'ret', 'mov r3, r4', 'li r2, -7'];
  const img = assemble(src.join('\n'));
  const out = [];
  for (let pc = 0; pc < img.romSize;) {
    const { text, size } = disassemble(img.rom[pc], img.rom[pc + 1]);
    out.push(text);
    pc += size;
  }
  assert.deepEqual(out, src);
});

test('errors carry line numbers', () => {
  assert.throws(() => assemble('nop\n  frob r1'), /line 2: unknown instruction/);
  assert.throws(() => assemble('jmp nowhere'), /undefined symbol 'nowhere'/);
});
