// The demo programs compile, run, and behave the same on the gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build } from '../src/toolchain.js';
import { loadImage } from '../src/asm.js';
import { Emulator, IO_FRAME, IO_VBASE, SCREEN } from '../src/isa.js';
import { buildCPU } from '../src/cpu.js';
import { optimize } from '../src/netlist.js';
import { createMachineSync } from '../src/wasm.js';

const lib = fs.readFileSync(new URL('../programs/lib.tt', import.meta.url), 'utf8');
const load = (name) => build(fs.readFileSync(new URL(`../programs/${name}`, import.meta.url), 'utf8'), { lib, name });
const netlist = optimize(buildCPU());

function emulate(prog, frames, cyclesPerFrame = 25000) {
  const emu = new Emulator(new Uint16Array(65536), new Uint16Array(65536));
  loadImage(prog.image, emu.rom, emu.ram);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < cyclesPerFrame; i++) emu.step();
    emu.ram[IO_FRAME]++;
  }
  return emu;
}

for (const name of ['hello.tt', 'life.tt', 'mandel.tt', 'tetris.tt']) {
  test(`${name}: gates and emulator agree for the first 300k cycles`, () => {
    const prog = load(name);
    const emu = emulate(prog, 12);
    const m = createMachineSync(netlist);
    loadImage(prog.image, m.mems.rom, m.mems.ram);
    for (let f = 0; f < 12; f++) { m.run(25000); m.mems.ram[IO_FRAME]++; }
    assert.equal(m.reg('pc'), emu.pc);
    assert.ok(m.mems.ram.every((v, i) => v === emu.ram[i]), 'RAM differs');
  });
}

test('life.tt computes correct generations', () => {
  const prog = load('life.tt');
  const emu = new Emulator(new Uint16Array(65536), new Uint16Array(65536));
  loadImage(prog.image, emu.rom, emu.ram);
  const W = 256, H = 192;
  const grab = (base) => {
    const g = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = (emu.ram[base + (i >> 4)] >> (i & 15)) & 1;
    return g;
  };
  const step = (g) => {
    const o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx || dy) n += g[((y + dy + H) % H) * W + ((x + dx + W) % W)];
      }
      o[y * W + x] = n === 3 || (n === 2 && g[y * W + x]) ? 1 : 0;
    }
    return o;
  };
  let shown = 0, prev = null, checked = 0;
  while (checked < 3 && emu.cycles < 3e6) {
    emu.step();
    const v = emu.ram[IO_VBASE];
    if (v && v !== shown) {
      shown = v;
      const g = grab(v);
      if (prev) { assert.deepEqual(g, step(prev)); checked++; }
      prev = g;
    }
  }
  assert.equal(checked, 3);
});

test('mandel.tt draws the set in many colours', () => {
  const emu = emulate(load('mandel.tt'), 250);
  const seen = new Set();
  for (let i = 0; i < 3072; i++) for (let k = 0; k < 4; k++) seen.add((emu.ram[SCREEN + i] >> (4 * k)) & 15);
  assert.ok(seen.size >= 12, `only ${seen.size} colours`);
});

test('tetris.tt: the AI clears lines', () => {
  const prog = load('tetris.tt');
  const emu = emulate(prog, 1800);
  assert.ok(emu.ram[prog.image.labels.get('g_lines')] >= 5, 'AI should clear some lines in 30 s');
  assert.equal(emu.ram[prog.image.labels.get('g_ai')], 1);
});
