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

/** A ROM full of random code: wherever a jump lands, there is something to run. */
export function randomProgram(rand) {
  const rom = new Uint16Array(65536);
  for (let i = 0; i < rom.length; i++) rom[i] = (rand() * 65536) | 0;
  return rom;
}

const SPECIAL = [0, 0, 0, 0x7fff, 0xffff, 0xfffe, 15, ...Array.from({ length: 16 }, (_, k) => 1 << k)];
export function randomWord(rand) {
  return rand() < 0.4 ? SPECIAL[(rand() * SPECIAL.length) | 0] : (rand() * 65536) | 0;
}


/**
 * Directed programs: every jump condition tested on edge-case register
 * values (zero, each single bit, all ones...). Returns [{ rom, ram }].
 */
export function branchPrograms() {
  const values = [0, 0xffff, 0x7fff, 0x8000, 0x8001, 1, 15, 16];
  for (let k = 0; k < 16; k++) values.push(1 << k, 0xffff ^ (1 << k));
  const progs = [];
  for (const v of values) {
    const rom = new Uint16Array(65536);
    let pc = 0;
    // li r1, v   (add r1, r0, #v)
    rom[pc++] = 0x8000 | (1 << 9); rom[pc++] = v;
    for (let f = 0; f < 8; f++) {
      // j<f> r2, r1, +3 : link into r2, jump over the next instruction if taken
      rom[pc] = 0x8000 | (3 << 13) | (2 << 9) | (1 << 6) | f; rom[pc + 1] = pc + 3; pc += 2;
      rom[pc++] = 0x0000 | (3 << 9) | (3 << 6) | (2 << 3); // add r3, r3, r2 (only when not taken)
    }
    rom[pc] = 0x8000 | (3 << 13) | 4; rom[pc + 1] = pc; // halt
    progs.push({ rom, ram: new Uint16Array(65536), cycles: 30 });
  }
  return progs;
}
