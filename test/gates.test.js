import test from 'node:test';
import assert from 'node:assert/strict';
import { combTester, rng } from './helpers.js';
import * as G from '../src/gates.js';
import { ALU } from '../src/cpu.js';
import { alu } from '../src/isa.js';

test('basic gates match their truth tables', () => {
  const t = combTester(1, (c, [x]) => ({
    not: G.Not(c, x[0]),
    and: G.And(c, x[0], x[1]),
    or: G.Or(c, x[0], x[1]),
    xor: G.Xor(c, x[0], x[1]),
    nor: G.Nor(c, x[0], x[1]),
    xnor: G.Xnor(c, x[0], x[1]),
    mux: G.Mux(c, x[0], x[1], x[2]),
  }));
  for (let v = 0; v < 8; v++) {
    const a = v & 1, b = (v >> 1) & 1, s = (v >> 2) & 1;
    const r = t([v]);
    assert.equal(r.not, 1 - a);
    assert.equal(r.and, a & b);
    assert.equal(r.or, a | b);
    assert.equal(r.xor, a ^ b);
    assert.equal(r.nor, 1 - (a | b));
    assert.equal(r.xnor, 1 - (a ^ b));
    assert.equal(r.mux, s ? b : a);
  }
});

test('full adder, all 8 cases', () => {
  const t = combTester(1, (c, [x]) => {
    const r = G.FullAdder(c, x[0], x[1], x[2]);
    return { s: r.sum, c: r.carry };
  });
  for (let v = 0; v < 8; v++) {
    const total = (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1);
    assert.deepEqual(t([v]), { s: total & 1, c: total >> 1 });
  }
});

test('16-bit adder and incrementer', () => {
  const t = combTester(2, (c, [a, b]) => {
    const r = G.Adder(c, a, b);
    return { sum: r.sum, cout: r.cout, inc: G.Inc16(c, a), zero: G.IsZero(c, a) };
  });
  const rand = rng(7);
  for (let i = 0; i < 300; i++) {
    const a = (rand() * 65536) | 0, b = (rand() * 65536) | 0;
    const r = t([a, b]);
    assert.equal(r.sum, (a + b) & 0xffff);
    assert.equal(r.cout, (a + b) >> 16);
    assert.equal(r.inc, (a + 1) & 0xffff);
    assert.equal(r.zero, a === 0 ? 1 : 0);
  }
  assert.equal(t([0, 0]).zero, 1);
});

test('decoder is one-hot', () => {
  const t = combTester(1, (c, [x]) => ({ lines: G.Decoder(c, x.slice(0, 3)) }));
  for (let v = 0; v < 8; v++) assert.equal(t([v]).lines, 1 << v);
});

test('ALU matches the ISA specification for every function', () => {
  const t = combTester(3, (c, [a, b, f]) => ({ out: ALU(c, a, b, f.slice(0, 4)) }));
  const rand = rng(42);
  const special = [0, 1, 2, 0x7fff, 0x8000, 0x8001, 0xffff, 0xfffe, 15, 16];
  for (let F = 0; F < 16; F++) {
    for (let i = 0; i < 120; i++) {
      const a = i < 10 ? special[i] : (rand() * 65536) | 0;
      const b = i < 10 ? special[(i * 7) % 10] : (rand() * 65536) | 0;
      assert.equal(t([a, b, F]).out, alu(F, a, b), `F=${F} a=${a} b=${b}`);
    }
  }
});
