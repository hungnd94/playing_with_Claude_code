// Run a Turtle program headlessly and save screenshots.
//   node tools/run.js programs/life.tt --frames 120 --png out.png [--gates] [--every 30]
import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/toolchain.js';
import { loadImage } from '../src/asm.js';
import { Emulator, IO_FRAME, IO_RANDOM, IO_KEYS } from '../src/isa.js';
import { render, screenSize } from '../src/display.js';
import { encodePNG } from './png.js';
import { buildCPU } from '../src/cpu.js';
import { optimize } from '../src/netlist.js';
import { createMachineSync } from '../src/wasm.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
const file = args[0];
const frames = Number(opt('frames', 60));
const cyclesPerFrame = Number(opt('cpf', 25000));
const pngOut = opt('png', null);
const every = Number(opt('every', 0));
const keyScript = (opt('keys', '') || '').split(',').filter(Boolean).map((s) => s.split(':').map(Number)); // frame:mask

const here = path.dirname(new URL(import.meta.url).pathname);
const lib = fs.readFileSync(path.join(here, '../programs/lib.tt'), 'utf8');
const prog = build(fs.readFileSync(file, 'utf8'), { lib, name: path.basename(file) });
console.log(`ROM: ${prog.image.romSize} words, data ends at 0x${prog.image.dataEnd.toString(16)}`);

let rom, ram, step;
if (flag('gates')) {
  const m = createMachineSync(optimize(buildCPU()));
  rom = m.mems.rom; ram = m.mems.ram;
  loadImage(prog.image, rom, ram);
  step = (n) => m.run(n);
} else {
  const emu = new Emulator(new Uint16Array(65536), new Uint16Array(65536));
  rom = emu.rom; ram = emu.ram;
  loadImage(prog.image, rom, ram);
  step = (n) => { for (let i = 0; i < n; i++) emu.step(); };
}

const shot = (name) => {
  const { w, h } = screenSize(ram);
  const rgba = render(ram, new Uint8Array(w * h * 4));
  fs.writeFileSync(name, encodePNG(rgba, w, h, w === 128 ? 4 : 2));
  console.log('wrote', name);
};

const t0 = performance.now();
for (let f = 0; f < frames; f++) {
  for (const [kf, mask] of keyScript) if (kf === f) ram[IO_KEYS] = mask;
  ram[IO_RANDOM] = (Math.random() * 65536) | 0;
  step(cyclesPerFrame);
  ram[IO_FRAME] = (ram[IO_FRAME] + 1) & 0xffff;
  if (every && pngOut && (f + 1) % every === 0) shot(pngOut.replace(/\.png$/, `-${f + 1}.png`));
}
const dt = (performance.now() - t0) / 1000;
console.log(`${frames} frames, ${(frames * cyclesPerFrame / 1e6).toFixed(1)}M cycles in ${dt.toFixed(2)}s`);
if (pngOut && !every) shot(pngOut);
