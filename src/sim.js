// sim.js — gate-level simulation of a Netlist.
//
// Two simulators:
//   * interpret(): a straightforward loop over the gates. Slow, obviously
//     correct — used to cross-check everything else.
//   * compile():   turns the netlist into straight-line JavaScript (one
//     statement per NAND gate) that V8 compiles to machine code.
//
// Every NAND gate is evaluated on every clock cycle. There is no behavioural
// shortcut anywhere: the CPU's behaviour emerges from the gates.

import { K_NAND, K_DFF, K_MEM } from './hdl.js';

/** Reference simulator. mems: { rom: Uint16Array, ram: Uint16Array } */
export class Interpreter {
  constructor(nl, mems) {
    this.nl = nl;
    this.mems = mems;
    this.v = new Uint8Array(nl.size);
    this.v[1] = 1;
    this.state = new Uint8Array(nl.dffs.length);
    nl.dffs.forEach((f, i) => { this.state[i] = f.init; });
  }

  evaluate() {
    const { nl, v, state, mems } = this;
    for (let n = 2; n < nl.size; n++) {
      const k = nl.kind[n];
      if (k === K_NAND) v[n] = 1 ^ (v[nl.in0[n]] & v[nl.in1[n]]);
      else if (k === K_DFF) v[n] = state[nl.in0[n]];
      else if (k === K_MEM) {
        const p = nl.readPorts[nl.in0[n]];
        if (nl.in1[n] === 0) p._word = mems[p.mem][busValue(v, p.addr)];
        v[n] = (p._word >> nl.in1[n]) & 1;
      }
    }
  }

  clock() {
    const { nl, v, state, mems } = this;
    this.evaluate();
    for (const p of nl.writePorts) {
      if (v[p.we]) mems[p.mem][busValue(v, p.addr)] = busValue(v, p.data);
    }
    nl.dffs.forEach((f, i) => { state[i] = v[f.d]; });
  }

  probe(name) {
    const x = this.nl.probes.get(name);
    return Array.isArray(x) ? busValue(this.v, x) : this.v[x];
  }

  /** Value of a probe as seen from the current flip-flop state. */
  peek(name) { this.evaluate(); return this.probe(name); }
}

function busValue(v, bus) {
  let x = 0;
  for (let i = 0; i < bus.length; i++) x |= v[bus[i]] << i;
  return x;
}

/**
 * Compile a netlist to JavaScript.
 * Returns a Machine with run(cycles), snapshot(), and state access.
 */
export function compile(nl, mems) {
  const memNames = [...new Set([...nl.readPorts, ...nl.writePorts].map((p) => p.mem))];
  const memVar = (m) => `M_${m}`;
  const name = (n) => (n === 0 ? '0' : n === 1 ? '1' : `n${n}`);
  const word = (bus) => {
    const parts = [];
    let constBits = 0;
    bus.forEach((n, i) => {
      if (n === 1) constBits |= 1 << i;
      else if (n !== 0) parts.push(i ? `${name(n)}<<${i}` : name(n));
    });
    if (constBits) parts.push(String(constBits));
    return parts.length ? parts.join('|') : '0';
  };

  const body = [];
  // combinational logic, in topological order
  for (let n = 2; n < nl.size; n++) {
    const k = nl.kind[n];
    if (k === K_NAND) {
      const a = nl.in0[n], b = nl.in1[n];
      body.push(a === b ? `const ${name(n)}=1^${name(a)};` : `const ${name(n)}=1^(${name(a)}&${name(b)});`);
    } else if (k === K_MEM && nl.in1[n] === 0) {
      const pi = nl.in0[n];
      const p = nl.readPorts[pi];
      body.push(`const w${pi}=${memVar(p.mem)}[${word(p.addr)}];`);
      p.data.forEach((d, bit) => {
        body.push(`const ${name(d)}=${bit ? `(w${pi}>>${bit})&1` : `w${pi}&1`};`);
      });
    }
  }
  // memory writes at the clock edge
  for (const p of nl.writePorts) {
    const write = `${memVar(p.mem)}[${word(p.addr)}]=${word(p.data)};`;
    body.push(p.we === 1 ? write : p.we === 0 ? '' : `if(${name(p.we)})${write}`);
  }
  // flip-flops latch
  nl.dffs.forEach((f) => { body.push(`${name(f.q)}_=${name(f.d)};`); });

  const dffQ = nl.dffs.map((f) => name(f.q));
  const src = [
    `"use strict";`,
    `return function run(S, ${memNames.map(memVar).join(', ')}, cycles) {`,
    `  let ${dffQ.map((q, i) => `${q}_=S[${i}]`).join(', ')};`,
    `  for (let cyc = 0; cyc < cycles; cyc++) {`,
    `    const ${dffQ.map((q) => `${q}=${q}_`).join(', ')};`,
    ...body.map((l) => '    ' + l),
    `  }`,
    `  ${dffQ.map((q, i) => `S[${i}]=${q}_`).join('; ')};`,
    `};`,
  ].join('\n');

  const run = new Function(src)();
  return new Machine(nl, mems, memNames, run, src);
}

export class Machine {
  constructor(nl, mems, memNames, runFn, src) {
    this.nl = nl;
    this.mems = mems;
    this.memNames = memNames;
    this.runFn = runFn;
    this.source = src;
    this.state = new Int32Array(nl.dffs.length);
    nl.dffs.forEach((f, i) => { this.state[i] = f.init; });
    this.cycles = 0;
    this._interp = null;
  }

  run(cycles) {
    const m = this.memNames.map((n) => this.mems[n]);
    this.runFn(this.state, ...m, cycles);
    this.cycles += cycles;
  }

  /** Evaluate every net for the current state (for probes and the die shot). */
  snapshot() {
    if (!this._interp) this._interp = new Interpreter(this.nl, this.mems);
    this._interp.state.set(this.state);
    this._interp.evaluate();
    return this._interp.v;
  }

  probe(name) {
    const v = this.snapshot();
    const x = this.nl.probes.get(name);
    return Array.isArray(x) ? busValue(v, x) : v[x];
  }

  /** Read a bus made entirely of flip-flop outputs, without evaluating gates. */
  dffBus(name) {
    const bus = this.nl.probes.get(name);
    let x = 0;
    bus.forEach((n, i) => { x |= this.state[this.nl.in0[n]] << i; });
    return x;
  }
}

/**
 * A fast pure-JavaScript gate evaluator: the fallback when WebAssembly is
 * unavailable. Gates are evaluated from flat typed arrays in topological
 * order, and blocks whose inputs did not change are skipped exactly, as in
 * the wasm backend. Same interface as WasmMachine.
 */
export class FastMachine {
  constructor(nl, planBlocks, blockPaths = []) {
    this.nl = nl;
    this.mems = { rom: new Uint16Array(65536), ram: new Uint16Array(65536) };
    this.state = new Int32Array(nl.dffs.length);
    this.v = new Uint8Array(nl.size);
    this.v[1] = 1;
    this.cycles = 0;
    const { blocks, placed } = planBlocks(nl, blockPaths);
    // segments: runs of always-evaluated gates, memory reads, guarded blocks
    const segs = [];
    let run = [];
    const flush = () => { if (run.length) { segs.push({ k: 'gates', gates: Int32Array.from(run) }); run = []; } };
    const after = new Map();
    for (const b of blocks) {
      if (!after.has(b.maxIn)) after.set(b.maxIn, []);
      after.get(b.maxIn).push(b);
    }
    const emitBlocks = (n) => {
      for (const b of after.get(n) || []) {
        flush();
        segs.push({ k: 'block', gates: Int32Array.from(b.gates), inputs: Int32Array.from(b.inputs), prev: new Int8Array(b.inputs.length).fill(-1) });
      }
    };
    emitBlocks(1);
    for (let n = 2; n < nl.size; n++) {
      const k = nl.kind[n];
      if (k === K_NAND) { if (placed[n] < 0) run.push(n); }
      else if (k === K_MEM && nl.in1[n] === 0) { flush(); segs.push({ k: 'mem', port: nl.readPorts[nl.in0[n]] }); }
      emitBlocks(n);
    }
    flush();
    this.segs = segs;
    this.dffQ = Int32Array.from(nl.dffs.map((f) => f.q));
    this.dffD = Int32Array.from(nl.dffs.map((f) => f.d));
    this.next = new Uint8Array(nl.dffs.length);
    this.reset();
  }

  reset() {
    this.nl.dffs.forEach((f, i) => { this.state[i] = f.init; });
    for (const s of this.segs) if (s.k === 'block') s.prev.fill(-1);
    this.cycles = 0;
  }

  run(cycles) {
    const { nl, v, segs, state, dffQ, dffD, next, mems } = this;
    const A = nl.in0, B = nl.in1;
    for (let c = 0; c < cycles; c++) {
      for (let i = 0; i < dffQ.length; i++) v[dffQ[i]] = state[i];
      for (let si = 0; si < segs.length; si++) {
        const s = segs[si];
        if (s.k === 'gates') {
          const g = s.gates;
          for (let i = 0; i < g.length; i++) { const n = g[i]; v[n] = 1 ^ (v[A[n]] & v[B[n]]); }
        } else if (s.k === 'mem') {
          const p = s.port;
          let addr = 0;
          for (let i = 0; i < p.addr.length; i++) addr |= v[p.addr[i]] << i;
          const w = mems[p.mem][addr];
          for (let i = 0; i < p.data.length; i++) v[p.data[i]] = (w >> i) & 1;
        } else {
          const inp = s.inputs, prev = s.prev;
          let changed = false;
          for (let i = 0; i < inp.length; i++) { const x = v[inp[i]]; if (x !== prev[i]) { prev[i] = x; changed = true; } }
          if (changed) {
            const g = s.gates;
            for (let i = 0; i < g.length; i++) { const n = g[i]; v[n] = 1 ^ (v[A[n]] & v[B[n]]); }
          }
        }
      }
      for (const p of nl.writePorts) {
        if (v[p.we]) {
          let addr = 0, data = 0;
          for (let i = 0; i < p.addr.length; i++) addr |= v[p.addr[i]] << i;
          for (let i = 0; i < p.data.length; i++) data |= v[p.data[i]] << i;
          mems[p.mem][addr] = data;
        }
      }
      for (let i = 0; i < dffD.length; i++) next[i] = v[dffD[i]];
      for (let i = 0; i < dffD.length; i++) state[i] = next[i];
    }
    this.cycles += cycles;
  }

  reg(name) {
    const bus = this.nl.probes.get(name);
    let x = 0;
    bus.forEach((n, i) => { x |= (this.state[this.nl.in0[n]] & 1) << i; });
    return x;
  }
}
