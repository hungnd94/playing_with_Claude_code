// gates.js — the standard chip library, built from NAND gates only.
//
// Every function takes the circuit `c` first, then input nets or buses
// (arrays of nets, LSB first), and returns output nets / buses.

import { chip } from './hdl.js';

// ---------------------------------------------------------------- 1-bit gates

export const Not = (c, a) => c.nand(a, a);

export const And = chip('And', (c, a, b) => Not(c, c.nand(a, b)));

export const Or = chip('Or', (c, a, b) => c.nand(Not(c, a), Not(c, b)));

export const Nor = chip('Nor', (c, a, b) => Not(c, Or(c, a, b)));

export const Xor = chip('Xor', (c, a, b) => {
  const n = c.nand(a, b);
  return c.nand(c.nand(a, n), c.nand(b, n));
});

export const Xnor = chip('Xnor', (c, a, b) => Not(c, Xor(c, a, b)));

/** sel ? b : a */
export const Mux = chip('Mux', (c, a, b, sel) =>
  c.nand(c.nand(a, Not(c, sel)), c.nand(b, sel)));

/** Returns [sel ? 0 : x, sel ? x : 0]. */
export const DMux = chip('DMux', (c, x, sel) =>
  [And(c, x, Not(c, sel)), And(c, x, sel)]);

// ------------------------------------------------------------- multi-input

/** AND of any number of inputs, as a balanced tree. */
export const AndN = chip('AndN', (c, xs) => reduceTree(xs, (a, b) => And(c, a, b)));

/** OR of any number of inputs, as a balanced tree. */
export const OrN = chip('OrN', (c, xs) => reduceTree(xs, (a, b) => Or(c, a, b)));

function reduceTree(xs, op) {
  if (xs.length === 0) throw new Error('reduceTree: empty');
  let layer = xs.slice();
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < layer.length; i += 2) next.push(op(layer[i], layer[i + 1]));
    if (layer.length & 1) next.push(layer[layer.length - 1]);
    layer = next;
  }
  return layer[0];
}

// ------------------------------------------------------------------ buses

export const Not16 = chip('Not16', (c, a) => a.map((x) => Not(c, x)));
export const And16 = chip('And16', (c, a, b) => a.map((x, i) => And(c, x, b[i])));
export const Or16 = chip('Or16', (c, a, b) => a.map((x, i) => Or(c, x, b[i])));

/** sel ? b : a, bitwise over a bus. */
export const Mux16 = chip('Mux16', (c, a, b, sel) => a.map((x, i) => Mux(c, x, b[i], sel)));

/** One-hot decoder: n select bits -> 2^n lines. */
export const Decoder = chip('Decoder', (c, sel) => {
  const inv = sel.map((s) => Not(c, s));
  const out = [];
  for (let v = 0; v < 1 << sel.length; v++) {
    out.push(AndN(c, sel.map((s, i) => ((v >> i) & 1 ? s : inv[i]))));
  }
  return out;
});

/** Pick one of several buses by one-hot select lines (AND-OR multiplexer). */
export const SelectBus = chip('SelectBus', (c, sels, buses) => {
  const width = buses[0].length;
  const out = [];
  for (let bit = 0; bit < width; bit++) {
    out.push(OrN(c, buses.map((bus, k) => And(c, sels[k], bus[bit]))));
  }
  return out;
});

// -------------------------------------------------------------- arithmetic

export const HalfAdder = chip('HalfAdder', (c, a, b) => {
  const n = c.nand(a, b);
  const sum = c.nand(c.nand(a, n), c.nand(b, n));
  return { sum, carry: Not(c, n) };
});

/** The classic 9-NAND full adder. */
export const FullAdder = chip('FullAdder', (c, a, b, cin) => {
  const n1 = c.nand(a, b);
  const s1 = c.nand(c.nand(a, n1), c.nand(b, n1)); // a ^ b
  const n4 = c.nand(s1, cin);
  const sum = c.nand(c.nand(s1, n4), c.nand(cin, n4)); // a ^ b ^ cin
  const carry = c.nand(n4, n1); // (a & b) | ((a ^ b) & cin)
  return { sum, carry };
});

/** Ripple-carry adder of two equal-width buses. */
export const Adder = chip('Adder', (c, a, b, cin = 0) => {
  const sum = [];
  let carry = cin;
  for (let i = 0; i < a.length; i++) {
    const r = c.scoped(`bit${i}`, () => FullAdder(c, a[i], b[i], carry));
    sum.push(r.sum);
    carry = r.carry;
  }
  return { sum, cout: carry };
});

/** a + 1 */
export const Inc16 = chip('Inc16', (c, a) => {
  const sum = [Not(c, a[0])];
  let carry = a[0];
  for (let i = 1; i < a.length; i++) {
    const r = HalfAdder(c, a[i], carry);
    sum.push(r.sum);
    carry = r.carry;
  }
  return sum;
});

/** Zero test: 1 when every bit of the bus is 0. */
export const IsZero = chip('IsZero', (c, a) => Not(c, OrN(c, a)));
