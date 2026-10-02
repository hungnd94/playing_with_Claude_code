// Mutation testing for the differential CPU test: inject a stuck-at fault
// into one random gate, then check whether random programs expose it.
//   node tools/mutate.js [mutants=100]
import { buildCPU } from '../src/cpu.js';
import { optimize } from '../src/netlist.js';
import { createMachineSync } from '../src/wasm.js';
import { Emulator } from '../src/isa.js';
import { K_NAND } from '../src/hdl.js';
import { rng, randomProgram, randomWord, branchPrograms } from '../test/helpers.js';

const mutants = Number(process.argv[2] || 100);
const base = optimize(buildCPU());
const gates = [];
for (let n = 2; n < base.size; n++) if (base.kind[n] === K_NAND) gates.push(n);
const pick = rng(5);
let caught = 0;
for (let m = 0; m < mutants; m++) {
  const nl = optimize(buildCPU());
  const g = gates[(pick() * gates.length) | 0];
  const stuck = pick() < 0.5;
  nl.in0[g] = nl.in1[g] = stuck ? 0 : 1; // NAND(0,0) = 1: stuck-at-1; NAND(1,1) = 0: stuck-at-0
  const mach = createMachineSync(nl);
  let found = false;
  for (let trial = 0; trial < 40 && !found; trial++) {
    const rand = rng(1000 + trial);
    const rom = randomProgram(rand);
    const ram = new Uint16Array(65536).map(() => randomWord(rand));
    const emu = new Emulator(rom, ram.slice());
    mach.reset();
    mach.mems.rom.set(rom);
    mach.mems.ram.set(ram);
    for (let c = 0; c < 3000 && !found; c++) {
      emu.step();
      mach.run(1);
      if (mach.reg('pc') !== emu.pc) found = true;
      for (let r = 1; r < 8; r++) if (mach.reg(`r${r}`) !== emu.r[r]) found = true;
    }
    if (!mach.mems.ram.every((v, i) => v === emu.ram[i])) found = true;
  }
  for (const { rom, ram, cycles } of found ? [] : branchPrograms()) {
    const emu = new Emulator(rom, ram.slice());
    mach.reset();
    mach.mems.rom.set(rom);
    mach.mems.ram.set(ram);
    for (let c = 0; c < cycles && !found; c++) {
      emu.step();
      mach.run(1);
      if (mach.reg('pc') !== emu.pc) found = true;
      for (let r = 1; r < 8; r++) if (mach.reg(`r${r}`) !== emu.r[r]) found = true;
    }
  }
  if (found) caught++;
  else console.log(`not caught: gate ${g} stuck at ${stuck ? 1 : 0}`);
}
console.log(`caught ${caught} of ${mutants} injected faults`);
