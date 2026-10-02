// wasm.js — compile a NAND netlist straight to a WebAssembly binary.
//
// Every NAND gate becomes six wasm instructions:
//     local.get a; local.get b; i32.and; i32.const 1; i32.xor; local.set n
// and the whole clock cycle is one straight-line loop body. The browser's
// wasm compiler turns that into tight machine code: millions of gate
// evaluations per millisecond, with no behavioural shortcuts.
//
// Memory layout (bytes): ROM 0..128K, RAM 128K..256K, flip-flop state after.

import { K_NAND, K_DFF, K_MEM } from './hdl.js';
import { Interpreter } from './sim.js';

const MEM_BASE = { rom: 0, ram: 0x20000 };
const STATE_BASE = 0x40000;
const PAGES = 5;

// --------------------------------------------------------------- encoding

function uleb(n, out) {
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
}

function sleb(n, out) {
  for (;;) {
    const byte = n & 0x7f;
    n >>= 7;
    if ((n === 0 && !(byte & 0x40)) || (n === -1 && byte & 0x40)) { out.push(byte); return; }
    out.push(byte | 0x80);
  }
}

function section(id, payload, out) {
  out.push(id);
  uleb(payload.length, out);
  for (const b of payload) out.push(b);
}

function str(s, out) {
  uleb(s.length, out);
  for (const ch of s) out.push(ch.charCodeAt(0));
}

const OP = {
  block: 0x02, loop: 0x03, if: 0x04, end: 0x0b, br: 0x0c, br_if: 0x0d,
  local_get: 0x20, local_set: 0x21,
  i32_load: 0x28, i32_load16_u: 0x2f, i32_store: 0x36, i32_store16: 0x3b,
  i32_const: 0x41, i32_eqz: 0x45, i32_sub: 0x6b, i32_and: 0x71, i32_or: 0x72,
  i32_xor: 0x73, i32_shl: 0x74, i32_shr_u: 0x76,
};

// ---------------------------------------------------------------- codegen

// Blocks whose gates are skipped when none of their inputs changed. Skipping
// is exact: a combinational block's outputs depend only on its inputs.
export const DEFAULT_BLOCKS = ['N16/ALU/Multiplier', 'N16/ALU/Shifter', 'N16/ALU/Logic'];

function scopePathOf(nl, id) {
  const parts = [];
  for (let s = id; s >= 0; s = nl.scopes[s].parent) parts.push(nl.scopes[s].name);
  return parts.reverse().join('/');
}

/** Assign gates to skippable blocks and work out where each block can go. */
export function planBlocks(nl, paths) {
  const blockOfScope = new Map();
  const scopeBlock = (id) => {
    if (blockOfScope.has(id)) return blockOfScope.get(id);
    const path = scopePathOf(nl, id);
    const b = paths.findIndex((p) => path === p || path.startsWith(p + '/'));
    blockOfScope.set(id, b);
    return b;
  };
  const blockOf = new Int32Array(nl.size).fill(-1);
  for (let n = 2; n < nl.size; n++) if (nl.kind[n] === K_NAND) blockOf[n] = scopeBlock(nl.scope[n]);

  const blocks = paths.map((path) => ({ path, gates: [], inputs: new Set(), maxIn: 1, minUse: Infinity }));
  for (let n = 2; n < nl.size; n++) {
    const b = blockOf[n];
    if (b >= 0) blocks[b].gates.push(n);
  }
  const consume = (user, n) => {
    if (n < 2) return;
    const ub = user === null ? -1 : blockOf[user];
    const nb = blockOf[n];
    if (ub >= 0 && nb !== ub) blocks[ub].inputs.add(n);
    if (nb >= 0 && ub !== nb) blocks[nb].minUse = Math.min(blocks[nb].minUse, user === null ? Infinity : user);
  };
  for (let n = 2; n < nl.size; n++) {
    if (nl.kind[n] === K_NAND) { consume(n, nl.in0[n]); consume(n, nl.in1[n]); }
    else if (nl.kind[n] === K_MEM && nl.in1[n] === 0) nl.readPorts[nl.in0[n]].addr.forEach((a) => consume(n, a));
  }
  const sinks = [];
  for (const f of nl.dffs) sinks.push(f.d);
  for (const p of nl.writePorts) sinks.push(...p.addr, ...p.data, p.we);
  for (const n of sinks) if (n >= 2 && blockOf[n] >= 0) blocks[blockOf[n]].minUse = Math.min(blocks[blockOf[n]].minUse, nl.size);

  const valid = [];
  for (const b of blocks) {
    if (!b.gates.length) continue;
    b.inputs = [...b.inputs].sort((x, y) => x - y);
    b.maxIn = b.inputs.length ? b.inputs[b.inputs.length - 1] : 1;
    if (b.minUse <= b.maxIn) throw new Error(`block ${b.path} is not convex`);
    valid.push(b);
  }
  // gates of invalid (empty) blocks stay in the main stream
  const placed = new Int32Array(nl.size).fill(-1);
  valid.forEach((b, i) => b.gates.forEach((g) => { placed[g] = i; }));
  return { blocks: valid, placed };
}

export function buildWasm(nl, { blocks: blockPaths = DEFAULT_BLOCKS } = {}) {
  const { blocks, placed } = planBlocks(nl, blockPaths.filter((p) => nl.scopes.some((s, i) => scopePathOf(nl, i) === p)));
  const code = [];
  const emit = (...bytes) => { for (const b of bytes) code.push(b); };
  const local = (i) => { const o = []; uleb(i, o); return o; };

  // local 0 = cycles param; net n -> local n + 1; extras after that
  const netLocal = (n) => n + 1;
  let nextLocal = nl.size + 1;
  const portWord = nl.readPorts.map(() => nextLocal++);
  const dffTemp = nl.dffs.map(() => nextLocal++);
  for (const b of blocks) {
    b.words = [];
    for (let i = 0; i < b.inputs.length; i += 31) {
      b.words.push({ bits: b.inputs.slice(i, i + 31), cur: nextLocal++, prev: nextLocal++ });
    }
  }

  const getNet = (n) => {
    if (n === 0 || n === 1) emit(OP.i32_const, n);
    else emit(OP.local_get, ...local(netLocal(n)));
  };
  const constI32 = (v) => { const o = []; sleb(v, o); emit(OP.i32_const, ...o); };
  // Push the integer value of a bus.
  const pushWord = (bus) => {
    let first = true;
    let constBits = 0;
    bus.forEach((n, i) => {
      if (n === 1) { constBits |= 1 << i; return; }
      if (n === 0) return;
      getNet(n);
      if (i) { constI32(i); emit(OP.i32_shl); }
      if (!first) emit(OP.i32_or);
      first = false;
    });
    if (first) constI32(constBits);
    else if (constBits) { constI32(constBits); emit(OP.i32_or); }
  };
  const memarg = (align, offset) => { const o = []; uleb(align, o); uleb(offset, o); return o; };

  // load flip-flop state
  nl.dffs.forEach((f, i) => {
    emit(OP.i32_const, 0, OP.i32_load, ...memarg(2, STATE_BASE + 4 * i));
    emit(OP.local_set, ...local(netLocal(f.q)));
  });

  // Previous block inputs start at -1 (impossible for 31-bit words), so every
  // block is evaluated on the first cycle of each run() call.
  for (const b of blocks) for (const w of b.words) { constI32(-1); emit(OP.local_set, ...local(w.prev)); }

  emit(OP.block, 0x40, OP.loop, 0x40);
  emit(OP.local_get, 0, OP.i32_eqz, OP.br_if, 1);

  const emitNand = (n) => {
    const a = nl.in0[n], b = nl.in1[n];
    getNet(a);
    if (a !== b) { getNet(b); emit(OP.i32_and); }
    emit(OP.i32_const, 1, OP.i32_xor, OP.local_set, ...local(netLocal(n)));
  };
  const emitBlock = (b) => {
    for (const w of b.words) { pushWord(w.bits); emit(OP.local_set, ...local(w.cur)); }
    b.words.forEach((w, i) => {
      emit(OP.local_get, ...local(w.cur), OP.local_get, ...local(w.prev), 0x47 /* i32.ne */);
      if (i) emit(OP.i32_or);
    });
    emit(OP.if, 0x40);
    for (const w of b.words) emit(OP.local_get, ...local(w.cur), OP.local_set, ...local(w.prev));
    for (const g of b.gates) emitNand(g);
    emit(OP.end);
  };
  const blocksAfter = new Map();
  for (const b of blocks) {
    if (!blocksAfter.has(b.maxIn)) blocksAfter.set(b.maxIn, []);
    blocksAfter.get(b.maxIn).push(b);
  }
  for (const b of blocksAfter.get(1) || []) emitBlock(b);

  for (let n = 2; n < nl.size; n++) {
    const k = nl.kind[n];
    if (k === K_NAND) {
      if (placed[n] < 0) emitNand(n);
    } else if (k === K_MEM && nl.in1[n] === 0) {
      const pi = nl.in0[n];
      const p = nl.readPorts[pi];
      pushWord(p.addr);
      emit(OP.i32_const, 1, OP.i32_shl);
      emit(OP.i32_load16_u, ...memarg(1, MEM_BASE[p.mem]));
      emit(OP.local_set, ...local(portWord[pi]));
      p.data.forEach((d, bit) => {
        emit(OP.local_get, ...local(portWord[pi]));
        if (bit) { constI32(bit); emit(OP.i32_shr_u); }
        emit(OP.i32_const, 1, OP.i32_and, OP.local_set, ...local(netLocal(d)));
      });
    }
    for (const b of blocksAfter.get(n) || []) emitBlock(b);
  }

  for (const p of nl.writePorts) {
    if (p.we === 0) continue;
    if (p.we !== 1) { getNet(p.we); emit(OP.if, 0x40); }
    pushWord(p.addr);
    emit(OP.i32_const, 1, OP.i32_shl);
    pushWord(p.data);
    emit(OP.i32_store16, ...memarg(1, MEM_BASE[p.mem]));
    if (p.we !== 1) emit(OP.end);
  }

  // Clock edge. D inputs that are themselves flip-flop outputs must be read
  // before any flip-flop changes, so they go through temporaries.
  const isDffNet = (n) => n > 1 && nl.kind[n] === K_DFF;
  nl.dffs.forEach((f, i) => {
    if (isDffNet(f.d)) { getNet(f.d); emit(OP.local_set, ...local(dffTemp[i])); }
  });
  nl.dffs.forEach((f) => {
    if (!isDffNet(f.d)) { getNet(f.d); emit(OP.local_set, ...local(netLocal(f.q))); }
  });
  nl.dffs.forEach((f, i) => {
    if (isDffNet(f.d)) { emit(OP.local_get, ...local(dffTemp[i]), OP.local_set, ...local(netLocal(f.q))); }
  });

  emit(OP.local_get, 0, OP.i32_const, 1, OP.i32_sub, OP.local_set, 0);
  emit(OP.br, 0, OP.end, OP.end);

  // store flip-flop state
  nl.dffs.forEach((f, i) => {
    emit(OP.i32_const, 0);
    getNet(f.q);
    emit(OP.i32_store, ...memarg(2, STATE_BASE + 4 * i));
  });
  emit(OP.end);

  // ---- assemble the module
  const func = [];
  const nLocals = nextLocal - 1; // everything except the parameter
  uleb(1, func); // one local declaration group
  uleb(nLocals, func);
  func.push(0x7f); // i32
  for (const b of code) func.push(b);

  const mod = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  section(1, [1, 0x60, 1, 0x7f, 0], mod); // type 0: (i32) -> ()
  section(3, [1, 0], mod); // func 0 has type 0
  section(5, [1, 0x00, PAGES], mod); // memory, min PAGES
  const exp = [2];
  str('run', exp); exp.push(0x00, 0);
  str('memory', exp); exp.push(0x02, 0);
  section(7, exp, mod);
  const codeSec = [1];
  uleb(func.length, codeSec);
  for (const b of func) codeSec.push(b);
  section(10, codeSec, mod);
  return new Uint8Array(mod);
}

/** A running machine backed by a compiled wasm module. */
export class WasmMachine {
  constructor(nl, instance) {
    this.nl = nl;
    this.runFn = instance.exports.run;
    const buf = instance.exports.memory.buffer;
    this.mems = {
      rom: new Uint16Array(buf, MEM_BASE.rom, 65536),
      ram: new Uint16Array(buf, MEM_BASE.ram, 65536),
    };
    this.state = new Int32Array(buf, STATE_BASE, nl.dffs.length);
    this.cycles = 0;
    this._interp = null;
    this.reset();
  }

  reset() {
    this.nl.dffs.forEach((f, i) => { this.state[i] = f.init; });
    this.cycles = 0;
  }

  run(cycles) {
    this.runFn(cycles);
    this.cycles += cycles;
  }

  /** Values of every net for the current state (for probes and the die shot). */
  snapshot() {
    if (!this._interp) this._interp = new Interpreter(this.nl, this.mems);
    for (let i = 0; i < this.state.length; i++) this._interp.state[i] = this.state[i];
    this._interp.evaluate();
    return this._interp.v;
  }

  probe(name) {
    const v = this.snapshot();
    const x = this.nl.probes.get(name);
    if (!Array.isArray(x)) return v[x];
    let r = 0;
    x.forEach((n, i) => { r |= v[n] << i; });
    return r;
  }

  /** Read a bus of flip-flop outputs (pc, registers) without evaluating gates. */
  reg(name) {
    const bus = this.nl.probes.get(name);
    let x = 0;
    bus.forEach((n, i) => { x |= (this.state[this.nl.in0[n]] & 1) << i; });
    return x;
  }
}

export function createMachineSync(nl, opts) {
  const mod = new WebAssembly.Module(buildWasm(nl, opts));
  return new WasmMachine(nl, new WebAssembly.Instance(mod, {}));
}

export async function createMachine(nl, opts) {
  const { instance } = await WebAssembly.instantiate(buildWasm(nl, opts), {});
  return new WasmMachine(nl, instance);
}
