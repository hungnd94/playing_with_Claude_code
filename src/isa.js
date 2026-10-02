// isa.js — the N16 instruction set: reference emulator and disassembler.
//
// This is the *specification* of the CPU. The gate-level circuit in cpu.js
// must agree with step() below on every cycle (see test/cpu.test.js).

export const CLS_ALU = 0, CLS_LD = 1, CLS_ST = 2, CLS_J = 3;

export const ALU_OPS = [
  'add', 'sub', 'slt', 'sltu',
  'and', 'or', 'xor', 'andn',
  'shl', 'shr', 'sra', 'sra',
  'mul', 'mulh', 'mul', 'mulh',
];
export const ALU_CODE = { add: 0, sub: 1, slt: 2, sltu: 3, and: 4, or: 5, xor: 6, andn: 7, shl: 8, shr: 9, sra: 10, mul: 12, mulh: 13 };

// Jump condition f2 f1 f0: taken = f2 ^ ((f0 & Z) | (f1 & N)), tested on register A.
export const JUMP_CODE = { jnever: 0, jz: 1, jlt: 2, jle: 3, jmp: 4, jnz: 5, jge: 6, jgt: 7 };
export const JUMP_OPS = ['jnever', 'jz', 'jlt', 'jle', 'jmp', 'jnz', 'jge', 'jgt'];

// Memory map (RAM)
export const SCREEN = 0xC000; // 3072 words of video memory
export const SCREEN_WORDS = 3072;
export const IO_MODE = 0xFFF0; // 0: 256x192 mono, 1: 128x96 16 colours
export const IO_KEYS = 0xFFF1; // bitmask of held keys (written by the host)
export const IO_FRAME = 0xFFF2; // frame counter (incremented by the host at 60 Hz)
export const IO_RANDOM = 0xFFF3; // random word (refreshed by the host)
export const IO_VBASE = 0xFFF4; // address of video memory (0 means SCREEN)
export const KEY = { LEFT: 1, RIGHT: 2, UP: 4, DOWN: 8, FIRE: 16, ENTER: 32 };

const s16 = (x) => (x << 16) >> 16;

export function alu(F, a, b) {
  switch (F & 15) {
    case 0: return (a + b) & 0xFFFF;
    case 1: return (a - b) & 0xFFFF;
    case 2: return s16(a) < s16(b) ? 1 : 0;
    case 3: return a < b ? 1 : 0;
    case 4: return a & b;
    case 5: return a | b;
    case 6: return a ^ b;
    case 7: return a & ~b & 0xFFFF;
    case 8: return (a << (b & 15)) & 0xFFFF;
    case 9: return a >>> (b & 15);
    case 10: case 11: return (s16(a) >> (b & 15)) & 0xFFFF;
    case 12: case 14: return Math.imul(a, b) & 0xFFFF;
    case 13: case 15: return (Math.imul(s16(a), s16(b)) >> 16) & 0xFFFF;
  }
  throw new Error('unreachable');
}

export function jumpTaken(f, ra) {
  const Z = ra === 0 ? 1 : 0;
  const N = (ra >> 15) & 1;
  return (((f >> 2) & 1) ^ (((f & 1) & Z) | (((f >> 1) & 1) & N))) === 1;
}

export function decode(ins) {
  return {
    L: (ins >> 15) & 1,
    cls: (ins >> 13) & 3,
    h: (ins >> 12) & 1,
    d: (ins >> 9) & 7,
    a: (ins >> 6) & 7,
    b: (ins >> 3) & 7,
    f: ins & 7,
  };
}

export function encode({ L = 0, cls = 0, h = 0, d = 0, a = 0, b = 0, f = 0 }) {
  return ((L & 1) << 15) | ((cls & 3) << 13) | ((h & 1) << 12) | ((d & 7) << 9) | ((a & 7) << 6) | ((b & 7) << 3) | (f & 7);
}

/** Behavioural N16. State: { pc, r: Uint16Array(8), cycles }. */
export class Emulator {
  constructor(rom, ram) {
    this.rom = rom;
    this.ram = ram;
    this.pc = 0;
    this.r = new Uint16Array(8);
    this.cycles = 0;
    this.halted = false;
  }

  step() {
    const { rom, ram, r } = this;
    const pc = this.pc;
    const ins = rom[pc];
    const lit = rom[(pc + 1) & 0xFFFF];
    const L = (ins >> 15) & 1, cls = (ins >> 13) & 3, h = (ins >> 12) & 1;
    const d = (ins >> 9) & 7, a = (ins >> 6) & 7, b = (ins >> 3) & 7, f = ins & 7;
    const RA = r[a], RB = r[b];
    const B = L ? lit : RB;
    const res = alu(cls === CLS_ALU ? (h << 3) | f : 0, RA, B);
    const pcInc = (pc + 1 + L) & 0xFFFF;
    let next = pcInc;
    switch (cls) {
      case CLS_ALU: r[d] = res; break;
      case CLS_LD: r[d] = ram[res]; break;
      case CLS_ST: ram[res] = RB; break;
      case CLS_J:
        r[d] = pcInc;
        if (jumpTaken(f, RA)) next = B;
        break;
    }
    r[0] = 0;
    if (next === pc) this.halted = true;
    this.pc = next;
    this.cycles++;
  }

  run(maxCycles) {
    for (let i = 0; i < maxCycles && !this.halted; i++) this.step();
  }
}

const reg = (i) => `r${i}`;
const hex = (x) => '0x' + x.toString(16).padStart(4, '0');

/** Disassemble one instruction. Returns { text, size }. */
export function disassemble(ins, lit, labels) {
  const { L, cls, h, d, a, b, f } = decode(ins);
  const name = (v) => (labels && labels.get(v)) || hex(v);
  const size = 1 + L;
  switch (cls) {
    case CLS_ALU: {
      const op = ALU_OPS[(h << 3) | f];
      if (ins === 0) return { text: 'nop', size };
      if (op === 'add' && a === 0 && L) return { text: `li ${reg(d)}, ${s16(lit)}`, size };
      if (op === 'add' && !L && b === 0) return { text: `mov ${reg(d)}, ${reg(a)}`, size };
      return { text: `${op} ${reg(d)}, ${reg(a)}, ${L ? s16(lit) : reg(b)}`, size };
    }
    case CLS_LD: {
      const addr = a === 0 ? (L ? `${name(lit)}` : reg(b)) : `${reg(a)} + ${L ? s16(lit) : reg(b)}`;
      return { text: `ld ${reg(d)}, [${addr}]`, size };
    }
    case CLS_ST: {
      const addr = a === 0 ? (L ? `${name(lit)}` : reg(b)) : `${reg(a)} + ${L ? s16(lit) : reg(b)}`;
      return { text: `st [${addr}], ${reg(b)}`, size };
    }
    case CLS_J: {
      const target = L ? name(lit) : reg(b);
      const op = JUMP_OPS[f];
      if (op === 'jmp') {
        if (d) return { text: `jal ${d === 7 ? '' : reg(d) + ', '}${target}`, size };
        if (!L && b === 7) return { text: 'ret', size };
        return { text: `jmp ${target}`, size };
      }
      return { text: `${op} ${d ? reg(d) + ', ' : ''}${reg(a)}, ${target}`, size };
    }
  }
  return { text: '?', size };
}
