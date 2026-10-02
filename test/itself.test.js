// The machine inside the machine: itself.tt simulates a smaller N16 gate by
// gate. Its inner registers must match the behavioural specification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from '../src/toolchain.js';
import { assemble, loadImage } from '../src/asm.js';
import { Emulator, SCREEN } from '../src/isa.js';
import { innerNetlist, innerSource, INNER_PROGRAM } from '../src/selfsim.js';

const read = (f) => fs.readFileSync(new URL(`../programs/${f}`, import.meta.url), 'utf8');

test('the processor simulating itself agrees with the specification', () => {
  const nl = innerNetlist();
  const prog = build(read('itself.tt'), {
    libs: [{ name: 'lib.tt', text: read('lib.tt') }, { name: 'netlist.tt', text: innerSource(nl) }],
    name: 'itself.tt',
  });
  const outer = new Emulator(new Uint16Array(65536), new Uint16Array(65536));
  loadImage(prog.image, outer.rom, outer.ram);
  const cyclesAddr = prog.image.labels.get('g_inner_cycles');
  // reference: the inner program on the behavioural emulator
  const inner = assemble(INNER_PROGRAM);
  const ref = new Emulator(new Uint16Array(65536), new Uint16Array(65536));
  loadImage(inner, ref.rom, ref.ram);
  let checked = 0;
  while (checked < 60) {
    // run the outer machine until the inner one completes another cycle
    const target = outer.ram[cyclesAddr] + 1;
    while (outer.ram[cyclesAddr] < target) outer.step();
    ref.step();
    const ff = (r) => {
      let v = 0;
      for (let k = 0; k < 16; k++) v |= ((outer.ram[SCREEN + r * 16 + k] >> 1) & 1) << k;
      return v;
    };
    assert.equal(ff(0), ref.pc, `inner pc after ${target} cycles`);
    for (let r = 1; r < 8; r++) assert.equal(ff(r), ref.r[r], `inner r${r} after ${target} cycles`);
    checked++;
  }
});
