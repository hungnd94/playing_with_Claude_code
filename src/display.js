// display.js — the video device: turns RAM into pixels.
//
// Mode 0: 256 x 192, 1 bit per pixel.  16 words per row, bit 0 = leftmost.
// Mode 1: 128 x  96, 4 bits per pixel. 32 words per row, nibble 0 = leftmost.
// Video memory starts at RAM[IO_VBASE] (or SCREEN when that is 0).

import { SCREEN, IO_MODE, IO_VBASE } from './isa.js';

// The PICO-8 palette: 16 friendly colours.
export const PALETTE = [
  0x000000, 0x1d2b53, 0x7e2553, 0x008751, 0xab5236, 0x5f574f, 0xc2c3c7, 0xfff1e8,
  0xff004d, 0xffa300, 0xffec27, 0x00e436, 0x29adff, 0x83769c, 0xff77a8, 0xffccaa,
];

export function screenSize(ram) {
  return ram[IO_MODE] & 1 ? { w: 128, h: 96 } : { w: 256, h: 192 };
}

/**
 * Render video memory into an RGBA byte array (w*h*4).
 * mono = [offRGB, onRGB] colours for mode 0.
 */
export function render(ram, out, mono = [0x0b0f0c, 0x9dff8a]) {
  const base = ram[IO_VBASE] || SCREEN;
  const color = ram[IO_MODE] & 1;
  let o = 0;
  const put = (rgb) => {
    out[o++] = (rgb >> 16) & 255; out[o++] = (rgb >> 8) & 255; out[o++] = rgb & 255; out[o++] = 255;
  };
  if (color) {
    for (let y = 0; y < 96; y++) {
      for (let wx = 0; wx < 32; wx++) {
        const w = ram[(base + y * 32 + wx) & 0xffff];
        for (let k = 0; k < 4; k++) put(PALETTE[(w >> (4 * k)) & 15]);
      }
    }
  } else {
    for (let y = 0; y < 192; y++) {
      for (let wx = 0; wx < 16; wx++) {
        const w = ram[(base + y * 16 + wx) & 0xffff];
        for (let k = 0; k < 16; k++) put(mono[(w >> k) & 1]);
      }
    }
  }
  return out;
}
