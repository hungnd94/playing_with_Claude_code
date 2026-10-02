// hdl.js — a tiny hardware description layer.
//
// The only logic primitive is the 2-input NAND gate. Everything else (NOT, AND,
// adders, multiplexers, the whole CPU) is built by wiring NANDs together.
//
// Besides NAND there are exactly two kinds of non-logic primitives:
//   * D flip-flops (one bit of state, updated on the clock edge). A flip-flop
//     can itself be built from NAND gates (see test/dff.test.js), but a
//     zero-delay simulator cannot settle feedback loops cheaply, so — exactly
//     like Nand2Tetris — we treat it as a primitive.
//   * Memory ports (ROM / RAM). These play the role of external memory chips.
//
// A net is identified by an integer. Net 0 is constant 0, net 1 is constant 1.
// Buses are plain JS arrays of nets, least-significant bit first.

export const K_CONST = 0;
export const K_NAND = 1;
export const K_DFF = 2;
export const K_MEM = 3;

export class Circuit {
  constructor(name = 'chip') {
    this.kind = [K_CONST, K_CONST];
    this.in0 = [0, 0]; // NAND: input a | DFF: dff index | MEM: port index
    this.in1 = [0, 0]; // NAND: input b | MEM: bit index
    this.netScope = [0, 0];
    this.scopes = [{ name, parent: -1 }];
    this.cur = 0;
    this.dffs = []; // { q, d, init, scope }
    this.readPorts = []; // { mem, addr: bus, data: bus }
    this.writePorts = []; // { mem, addr: bus, data: bus, we }
    this.probes = new Map(); // name -> net | bus
  }

  get ZERO() { return 0; }
  get ONE() { return 1; }

  _net(kind, a, b) {
    this.kind.push(kind);
    this.in0.push(a);
    this.in1.push(b);
    this.netScope.push(this.cur);
    return this.kind.length - 1;
  }

  /** The one and only logic primitive. */
  nand(a, b) {
    if (a === undefined || b === undefined) throw new Error('nand: undefined input');
    return this._net(K_NAND, a, b);
  }

  /** A D flip-flop. Returns { q, set(d) } — set() closes the feedback loop later. */
  dff(init = 0) {
    const idx = this.dffs.length;
    const q = this._net(K_DFF, idx, 0);
    const rec = { q, d: -1, init, scope: this.cur };
    this.dffs.push(rec);
    return { q, set: (d) => { rec.d = d; } };
  }

  /** A word-wide register of flip-flops. Returns { q: bus, set(bus) }. */
  dffBus(width, init = 0) {
    const ffs = [];
    for (let i = 0; i < width; i++) ffs.push(this.dff((init >> i) & 1));
    return { q: ffs.map((f) => f.q), set: (bus) => ffs.forEach((f, i) => f.set(bus[i])) };
  }

  /** Combinational read port on an external memory. */
  memRead(mem, addr, width = 16) {
    const port = this.readPorts.length;
    const data = [];
    const rec = { mem, addr, data, scope: this.cur };
    this.readPorts.push(rec);
    for (let i = 0; i < width; i++) data.push(this._net(K_MEM, port, i));
    return data;
  }

  /** Write port on an external memory; the write happens on the clock edge. */
  memWrite(mem, addr, data, we) {
    this.writePorts.push({ mem, addr, data, we, scope: this.cur });
  }

  /** Run fn inside a named sub-scope (used for the chip hierarchy / die shot). */
  scoped(name, fn) {
    const id = this.scopes.length;
    this.scopes.push({ name, parent: this.cur });
    const saved = this.cur;
    this.cur = id;
    try { return fn(); } finally { this.cur = saved; }
  }

  probe(name, netOrBus) {
    this.probes.set(name, netOrBus);
    return netOrBus;
  }

  scopePath(id) {
    const parts = [];
    for (let s = id; s >= 0; s = this.scopes[s].parent) parts.push(this.scopes[s].name);
    return parts.reverse().join('/');
  }

  stats() {
    let nands = 0;
    for (const k of this.kind) if (k === K_NAND) nands++;
    return { nands, dffs: this.dffs.length, nets: this.kind.length };
  }
}

/** Define a reusable chip: wraps the body in a named scope. */
export function chip(name, body) {
  const f = (c, ...args) => c.scoped(name, () => body(c, ...args));
  Object.defineProperty(f, 'name', { value: name });
  return f;
}

/** Bus of constant nets for an integer value. */
export function constBus(value, width = 16) {
  const out = [];
  for (let i = 0; i < width; i++) out.push((value >> i) & 1 ? 1 : 0);
  return out;
}
