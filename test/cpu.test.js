// Differential testing: the gate-level CPU must agree with the behavioural
// ISA specification (src/isa.js) on every register, every memory write and
// every program-counter value, for random programs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rng, randomProgram, randomWord, branchPrograms } from './helpers.js';
import { buildCPU } from '../src/cpu.js';
import { optimize, flatten } from '../src/netlist.js';
import { Interpreter } from '../src/sim.js';
import { createMachineSync } from '../src/wasm.js';
import { Emulator } from '../src/isa.js';

const circuit = buildCPU();
const netlist = optimize(circuit);

function randomRam(rand) {
  const ram = new Uint16Array(65536);
  for (let i = 0; i < ram.length; i++) ram[i] = randomWord(rand);
  return ram;
}

/** Copy register values into a gate-level machine's flip-flops. */
function setRegs(nl, state, regs) {
  for (let r = 1; r < 8; r++) {
    nl.probes.get(`r${r}`).forEach((net, bit) => { state[nl.in0[net]] = (regs[r] >> bit) & 1; });
  }
}

function gateState(nl, state) {
  const read = (name) => nl.probes.get(name).reduce((x, net, bit) => x | ((state[nl.in0[net]] & 1) << bit), 0);
  return { pc: read('pc'), r: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i ? read(`r${i}`) : 0)) };
}

test('gate-level CPU (wasm, optimised) matches the ISA emulator on random programs', () => {
  const machine = createMachineSync(netlist);
  for (let trial = 0; trial < 40; trial++) {
    const rand = rng(1000 + trial);
    const rom = randomProgram(rand);
    const ram = randomRam(rand);
    const regs = new Uint16Array(8);
    for (let r = 1; r < 8; r++) regs[r] = randomWord(rand);

    const emu = new Emulator(rom, ram.slice());
    emu.r.set(regs);
    machine.reset();
    machine.mems.rom.set(rom);
    machine.mems.ram.set(ram);
    setRegs(netlist, machine.state, regs);

    let done = 0;
    while (done < 3000) {
      // mix single steps with long bursts (bursts exercise block skipping)
      const n = rand() < 0.5 ? 1 : 1 + ((rand() * 200) | 0);
      for (let i = 0; i < n; i++) emu.step();
      machine.run(n);
      done += n;
      const g = gateState(netlist, machine.state);
      assert.equal(g.pc, emu.pc, `trial ${trial} cycle ${done}: pc`);
      assert.deepEqual(g.r, [...emu.r], `trial ${trial} cycle ${done}: registers`);
    }
    assert.ok(machine.mems.ram.every((v, i) => v === emu.ram[i]), `trial ${trial}: RAM differs`);
  }
});

test('unoptimised netlist (interpreted) matches the ISA emulator', () => {
  const nl = flatten(circuit);
  for (let trial = 0; trial < 4; trial++) {
    const rand = rng(77 + trial);
    const rom = randomProgram(rand);
    const ram = randomRam(rand);
    const emu = new Emulator(rom, ram.slice());
    const sim = new Interpreter(nl, { rom, ram: ram.slice() });
    for (let cyc = 0; cyc < 400; cyc++) {
      emu.step();
      sim.clock();
      const g = gateState(nl, sim.state);
      assert.equal(g.pc, emu.pc, `cycle ${cyc}`);
      assert.deepEqual(g.r, [...emu.r]);
    }
    assert.ok(sim.mems.ram.every((v, i) => v === emu.ram[i]));
  }
});

test('gate counts', () => {
  const s = circuit.stats();
  assert.ok(s.nands > 5000 && s.dffs === 128, JSON.stringify(s));
  assert.ok(netlist.gateCount() < s.nands);
});

test('every jump condition on edge-case values (directed)', () => {
  const machine = createMachineSync(netlist);
  for (const { rom, ram, cycles } of branchPrograms()) {
    const emu = new Emulator(rom, ram.slice());
    machine.reset();
    machine.mems.rom.set(rom);
    machine.mems.ram.set(ram);
    for (let c = 0; c < cycles; c++) {
      emu.step();
      machine.run(1);
      assert.equal(machine.reg('pc'), emu.pc);
      for (let r = 1; r < 8; r++) assert.equal(machine.reg(`r${r}`), emu.r[r]);
    }
  }
});
