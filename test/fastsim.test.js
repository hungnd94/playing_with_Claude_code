import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCPU } from '../src/cpu.js';
import { optimize } from '../src/netlist.js';
import { FastMachine } from '../src/sim.js';
import { planBlocks, DEFAULT_BLOCKS } from '../src/wasm.js';
import { Emulator } from '../src/isa.js';
import { rng, randomProgram } from './helpers.js';

test('the JavaScript fallback simulator matches the ISA emulator', () => {
  const nl = optimize(buildCPU());
  const m = new FastMachine(nl, planBlocks, DEFAULT_BLOCKS);
  for (let trial = 0; trial < 6; trial++) {
    const rand = rng(500 + trial);
    const rom = randomProgram(rand);
    const emu = new Emulator(rom, new Uint16Array(65536));
    m.reset();
    m.mems.rom.set(rom);
    m.mems.ram.fill(0);
    let done = 0;
    while (done < 1500) {
      const n = 1 + ((rand() * 60) | 0);
      for (let i = 0; i < n; i++) emu.step();
      m.run(n);
      done += n;
      assert.equal(m.reg('pc'), emu.pc);
      for (let r = 1; r < 8; r++) assert.equal(m.reg(`r${r}`), emu.r[r]);
    }
    assert.ok(m.mems.ram.every((v, i) => v === emu.ram[i]));
  }
});
