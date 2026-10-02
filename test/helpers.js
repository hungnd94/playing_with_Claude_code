// Test helpers: drive combinational chips through a memory "input" port.
import { Circuit, constBus } from '../src/hdl.js';
import { optimize, flatten } from '../src/netlist.js';
import { Interpreter } from '../src/sim.js';

/**
 * Build a combinational test circuit. `body(c, ins)` receives `nWords` 16-bit
 * input buses and returns { name: bus | net } outputs. Returns a function
 * (inputWords[]) -> { name: value } evaluated on BOTH the raw and the
 * optimised netlist (and checks they agree).
 */
export function combTester(nWords, body) {
  const c = new Circuit('test');
  const ins = [];
  for (let i = 0; i < nWords; i++) ins.push(c.memRead('in', constBus(i)));
  const outs = body(c, ins);
  for (const [k, v] of Object.entries(outs)) c.probe(k, v);
  const mem = { in: new Uint16Array(Math.max(1, nWords)) };
  const sims = [new Interpreter(flatten(c), mem), new Interpreter(optimize(c), mem)];
  return (words) => {
    mem.in.set(words);
    const results = sims.map((s) => {
      s.evaluate();
      const r = {};
      for (const k of Object.keys(outs)) r[k] = s.probe(k);
      return r;
    });
    for (const k of Object.keys(outs)) {
      if (results[0][k] !== results[1][k]) throw new Error(`optimiser changed output ${k}`);
    }
    return results[0];
  };
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
