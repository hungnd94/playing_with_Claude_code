// Run several programs headlessly and tile their screens into one PNG.
//   node tools/montage.js out.png frames prog1.tt prog2.tt ...
import fs from 'node:fs';
import path from 'node:path';
import { build } from '../src/toolchain.js';
import { loadImage } from '../src/asm.js';
import { Emulator, IO_FRAME } from '../src/isa.js';
import { render } from '../src/display.js';
import { encodePNG } from './png.js';

const [out, framesArg, ...files] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const lib = fs.readFileSync(path.join(here, '../programs/lib.tt'), 'utf8');
const W = 256, H = 192, cols = Math.min(3, files.length), rows = Math.ceil(files.length / cols);
const canvas = new Uint8Array(W * cols * H * rows * 4);
files.forEach((f, idx) => {
  const prog = build(fs.readFileSync(f, 'utf8'), { lib });
  const emu = new Emulator(new Uint16Array(65536), new Uint16Array(65536));
  loadImage(prog.image, emu.rom, emu.ram);
  for (let fr = 0; fr < Number(framesArg); fr++) {
    for (let i = 0; i < 25000; i++) emu.step();
    emu.ram[IO_FRAME]++;
  }
  const color = emu.ram[0xfff0] & 1;
  const sw = color ? 128 : 256, sh = color ? 96 : 192, scale = color ? 2 : 1;
  const px = render(emu.ram, new Uint8Array(sw * sh * 4));
  const ox = (idx % cols) * W, oy = Math.floor(idx / cols) * H;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const si = (((y / scale) | 0) * sw + ((x / scale) | 0)) * 4;
    const di = ((oy + y) * W * cols + ox + x) * 4;
    canvas.set(px.subarray(si, si + 4), di);
  }
});
fs.writeFileSync(out, encodePNG(canvas, W * cols, H * rows, 2));
console.log('wrote', out);
