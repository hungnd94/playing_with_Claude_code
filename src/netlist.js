// netlist.js — logic optimisation of a Circuit into a flat NAND netlist.
//
// The optimiser only ever *removes* gates; the result is still nothing but
// 2-input NAND gates (plus the flip-flops and memory ports). It performs:
//   * constant propagation   NAND(0,x) = 1, NAND(1,x) = NOT x, ...
//   * double-negation removal NOT(NOT x) = x
//   * complement detection    NAND(x, NOT x) = 1
//   * structural hashing      identical gates are merged
//   * dead-gate elimination   gates that cannot affect state are dropped
//
// Net numbering in the result: 0 = const 0, 1 = const 1, then sources
// (flip-flop outputs, memory read data) and gates in topological order.

import { K_CONST, K_NAND, K_DFF, K_MEM } from './hdl.js';

export class Netlist {
  constructor() {
    this.kind = [K_CONST, K_CONST];
    this.in0 = [0, 0];
    this.in1 = [0, 0];
    this.scope = [0, 0];
    this.dffs = []; // { q, d, init, scope }
    this.readPorts = []; // { mem, addr, data }
    this.writePorts = []; // { mem, addr, data, we }
    this.probes = new Map();
    this.scopes = [];
  }

  get size() { return this.kind.length; }

  gateCount() {
    let n = 0;
    for (const k of this.kind) if (k === K_NAND) n++;
    return n;
  }
}

/** Optimise a Circuit. Returns a Netlist. */
export function optimize(circuit, { keepProbes = true } = {}) {
  const pass1 = rewrite(circuit);
  return eliminateDead(pass1, keepProbes);
}

/** Convert without any optimisation (used to cross-check the optimiser). */
export function flatten(circuit) {
  const out = new Netlist();
  out.kind = circuit.kind.slice();
  out.in0 = circuit.in0.slice();
  out.in1 = circuit.in1.slice();
  out.scope = circuit.netScope.slice();
  out.dffs = circuit.dffs.map((f) => ({ ...f }));
  out.readPorts = circuit.readPorts.map((p) => ({ ...p, addr: p.addr.slice(), data: p.data.slice() }));
  out.writePorts = circuit.writePorts.map((p) => ({ ...p }));
  out.probes = new Map(circuit.probes);
  out.scopes = circuit.scopes;
  return out;
}

function rewrite(c) {
  const out = new Netlist();
  out.scopes = c.scopes;
  const map = new Int32Array(c.kind.length).fill(-1);
  map[0] = 0;
  map[1] = 1;
  const hash = new Map(); // "a,b" -> net
  // notOf[x] = y  means net x == NAND(y, y)
  const notOf = new Map();

  const emitNand = (a, b, scope) => {
    if (a > b) [a, b] = [b, a];
    if (a === 0) return 1;
    if (a === 1 && b === 1) return 0;
    if (a === 1) a = b; // NAND(1, x) = NOT x
    if (a === b) {
      const inner = notOf.get(a);
      if (inner !== undefined) return inner; // NOT(NOT x) = x
    } else if (notOf.get(a) === b || notOf.get(b) === a) {
      return 1; // NAND(x, NOT x) = 1
    }
    const key = a * 0x100000 + b;
    const hit = hash.get(key);
    if (hit !== undefined) return hit;
    const n = out.kind.length;
    out.kind.push(K_NAND);
    out.in0.push(a);
    out.in1.push(b);
    out.scope.push(scope);
    hash.set(key, n);
    if (a === b) notOf.set(n, a);
    return n;
  };

  // Flip-flops first (they are sources), then walk nets in creation order,
  // which is already topological for combinational logic.
  for (let i = 0; i < c.dffs.length; i++) {
    const f = c.dffs[i];
    const n = out.kind.length;
    out.kind.push(K_DFF);
    out.in0.push(i);
    out.in1.push(0);
    out.scope.push(f.scope);
    map[f.q] = n;
    out.dffs.push({ q: n, d: -1, init: f.init, scope: f.scope });
  }

  const portSeen = new Map();
  for (let net = 2; net < c.kind.length; net++) {
    const k = c.kind[net];
    if (k === K_NAND) {
      map[net] = emitNand(map[c.in0[net]], map[c.in1[net]], c.netScope[net]);
    } else if (k === K_MEM) {
      const portIdx = c.in0[net], bit = c.in1[net];
      let newPort = portSeen.get(portIdx);
      if (newPort === undefined) {
        const p = c.readPorts[portIdx];
        newPort = out.readPorts.length;
        const rec = { mem: p.mem, addr: p.addr.map((a) => map[a]), data: [], scope: p.scope };
        out.readPorts.push(rec);
        for (let b = 0; b < p.data.length; b++) {
          const n = out.kind.length;
          out.kind.push(K_MEM);
          out.in0.push(newPort);
          out.in1.push(b);
          out.scope.push(p.scope);
          rec.data.push(n);
        }
        portSeen.set(portIdx, newPort);
      }
      map[net] = out.readPorts[newPort].data[bit];
    }
  }
  for (let i = 0; i < c.dffs.length; i++) out.dffs[i].d = map[c.dffs[i].d];
  out.writePorts = c.writePorts.map((p) => ({
    mem: p.mem, addr: p.addr.map((a) => map[a]), data: p.data.map((a) => map[a]), we: map[p.we], scope: p.scope,
  }));
  for (const [name, v] of c.probes) {
    out.probes.set(name, Array.isArray(v) ? v.map((n) => map[n]) : map[v]);
  }
  return out;
}

function eliminateDead(nl, keepProbes) {
  const live = new Uint8Array(nl.size);
  live[0] = live[1] = 1;
  const stack = [];
  const mark = (n) => { if (!live[n]) { live[n] = 1; stack.push(n); } };
  for (const f of nl.dffs) { mark(f.q); mark(f.d); }
  for (const p of nl.writePorts) { p.addr.forEach(mark); p.data.forEach(mark); mark(p.we); }
  if (keepProbes) for (const v of nl.probes.values()) (Array.isArray(v) ? v : [v]).forEach(mark);
  while (stack.length) {
    const n = stack.pop();
    const k = nl.kind[n];
    if (k === K_NAND) { mark(nl.in0[n]); mark(nl.in1[n]); }
    else if (k === K_MEM) {
      const p = nl.readPorts[nl.in0[n]];
      p.addr.forEach(mark);
      p.data.forEach(mark); // keep whole ports together
    }
  }

  const out = new Netlist();
  out.scopes = nl.scopes;
  const map = new Int32Array(nl.size).fill(-1);
  map[0] = 0;
  map[1] = 1;
  const portMap = new Map();
  for (let n = 2; n < nl.size; n++) {
    if (!live[n]) continue;
    const k = nl.kind[n];
    const m = out.kind.length;
    map[n] = m;
    out.kind.push(k);
    out.scope.push(nl.scope[n]);
    if (k === K_NAND) {
      out.in0.push(map[nl.in0[n]]);
      out.in1.push(map[nl.in1[n]]);
    } else if (k === K_DFF) {
      out.in0.push(nl.in0[n]);
      out.in1.push(0);
    } else if (k === K_MEM) {
      const old = nl.in0[n];
      let np = portMap.get(old);
      if (np === undefined) {
        np = out.readPorts.length;
        const p = nl.readPorts[old];
        out.readPorts.push({ mem: p.mem, addr: p.addr.map((a) => map[a]), data: [], scope: p.scope });
        portMap.set(old, np);
      }
      out.in0.push(np);
      out.in1.push(nl.in1[n]);
      out.readPorts[np].data.push(m);
    }
  }
  out.dffs = nl.dffs.map((f) => ({ q: map[f.q], d: map[f.d], init: f.init, scope: f.scope }));
  // Flip-flop indices are preserved (all flip-flops are live by construction).
  out.writePorts = nl.writePorts.map((p) => ({
    mem: p.mem, addr: p.addr.map((a) => map[a]), data: p.data.map((a) => map[a]), we: map[p.we], scope: p.scope,
  }));
  for (const [name, v] of nl.probes) {
    const m = (x) => (live[x] ? map[x] : -1);
    out.probes.set(name, Array.isArray(v) ? v.map(m) : m(v));
  }
  return out;
}
