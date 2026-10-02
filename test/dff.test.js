// The simulator treats a D flip-flop as a primitive, because settling
// feedback loops gate-by-gate is slow. This test shows nothing is being
// smuggled in: a flip-flop built from 11 NAND gates (two gated D latches in a
// master-slave arrangement), simulated with feedback until it settles,
// behaves exactly like the primitive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rng } from './helpers.js';

/** Tiny netlist with feedback: signals are named, gates are 2-input NANDs. */
function nandFlipFlop() {
  const gates = [];
  const g = (out, a, b) => gates.push({ out, a, b });
  g('nclk', 'clk', 'clk');
  g('nd', 'd', 'd');
  // master latch: transparent while clk = 0
  g('ms', 'd', 'nclk'); g('mr', 'nd', 'nclk');
  g('mq', 'ms', 'mqb'); g('mqb', 'mr', 'mq');
  g('nmq', 'mq', 'mq');
  // slave latch: transparent while clk = 1
  g('ss', 'mq', 'clk'); g('sr', 'nmq', 'clk');
  g('q', 'ss', 'qb'); g('qb', 'sr', 'q');
  return gates;
}

function settle(gates, v) {
  for (let iter = 0; iter < 100; iter++) {
    let changed = false;
    for (const { out, a, b } of gates) {
      const x = 1 ^ (v[a] & v[b]);
      if (v[out] !== x) { v[out] = x; changed = true; }
    }
    if (!changed) return;
  }
  throw new Error('did not settle');
}

test('a flip-flop made of 11 NAND gates behaves like the primitive', () => {
  const gates = nandFlipFlop();
  assert.equal(gates.length, 11);
  const v = { clk: 0, d: 0, mq: 0, mqb: 1, q: 0, qb: 1 };
  settle(gates, v);
  let primitive = 0; // the simulator's flip-flop
  const rand = rng(3);
  for (let cycle = 0; cycle < 2000; cycle++) {
    // D wiggles while the clock is low...
    for (let k = 0; k < 3; k++) {
      v.d = rand() < 0.5 ? 1 : 0;
      settle(gates, v);
      assert.equal(v.q, primitive, 'output must hold between edges');
    }
    // ...and is captured on the rising edge.
    const d = v.d;
    v.clk = 1; settle(gates, v);
    primitive = d;
    assert.equal(v.q, primitive, 'rising edge captures D');
    // changing D while the clock is high does not leak through
    v.d = 1 - v.d; settle(gates, v);
    assert.equal(v.q, primitive);
    v.clk = 0; settle(gates, v);
    assert.equal(v.q, primitive);
    assert.equal(v.qb, 1 - v.q);
  }
});
