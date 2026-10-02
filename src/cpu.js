// cpu.js — the N16 processor, wired gate by gate.
//
// N16 is a 16-bit, single-cycle, Harvard-architecture RISC machine:
//   * 8 registers r0..r7 (r0 always reads 0, writes to it are discarded)
//   * instruction ROM and data RAM, 64K words each, both 16 bits wide
//   * every instruction executes in exactly one clock cycle
//
// Instruction word:  L cc h ddd aaa bbb fff
//   L   (bit 15)    operand B is the literal word ROM[pc+1] (instruction is 2 words)
//   cc  (14..13)    class: 00 ALU, 01 LOAD, 10 STORE, 11 JUMP
//   h   (12)        high bit of the ALU function
//   ddd (11..9)     destination register
//   aaa (8..6)      source register A
//   bbb (5..3)      source register B
//   fff (2..0)      ALU function (low bits) / jump condition
//
// See src/isa.js for the reference (behavioural) definition of every
// instruction; test/cpu.test.js checks that this circuit matches it exactly.

import { Circuit, chip } from './hdl.js';
import {
  Not, And, Or, Xor, Mux, Mux16, Decoder, SelectBus, Adder, Inc16, IsZero,
  FullAdder, HalfAdder,
} from './gates.js';

// ------------------------------------------------------------------- ALU

/** Bitwise logic unit. f1f0: 00 AND, 01 OR, 10 XOR, 11 ANDN (a & ~b). */
const LogicUnit = chip('Logic', (c, A, B, f0, f1) => A.map((a, i) => c.scoped(`bit${i}`, () => {
  const b = B[i];
  const n = c.nand(a, b);
  const and = Not(c, n);
  const or = c.nand(Not(c, a), Not(c, b));
  const xor = c.nand(c.nand(a, n), c.nand(b, n));
  const andn = Not(c, c.nand(a, Not(c, b)));
  return Mux(c, Mux(c, and, or, f0), Mux(c, xor, andn, f0), f1);
})));

/** Barrel shifter: shifts A by amt (4 bits). right/arith select the kind. */
const Shifter = chip('Shifter', (c, A, amt, right, arith) => {
  const rev = (bus) => bus.slice().reverse();
  // A right shift is a left shift of the bit-reversed word.
  let x = c.scoped('flipIn', () => Mux16(c, A, rev(A), right));
  const fill = And(c, arith, A[15]);
  for (let k = 0; k < 4; k++) {
    const dist = 1 << k;
    x = c.scoped(`stage${dist}`, () =>
      x.map((bit, i) => Mux(c, bit, i >= dist ? x[i - dist] : fill, amt[k])));
  }
  return c.scoped('flipOut', () => Mux16(c, x, rev(x), right));
});

/**
 * Signed 16x16 -> 32 bit array multiplier (Baugh-Wooley).
 * Partial products are summed column by column with full adders.
 */
const Multiplier = chip('Multiplier', (c, A, B) => {
  const cols = Array.from({ length: 32 }, () => []);
  c.scoped('partials', () => {
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        const n = c.nand(A[i], B[j]);
        // Baugh-Wooley: products with exactly one sign bit are inverted.
        const inverted = (i === 15) !== (j === 15);
        cols[i + j].push(inverted ? n : Not(c, n));
      }
    }
  });
  cols[16].push(1);
  cols[31].push(1);
  c.scoped('adders', () => {
    for (let col = 0; col < 32; col++) {
      const q = cols[col];
      while (q.length > 1) {
        let r;
        if (q.length >= 3) r = FullAdder(c, q.shift(), q.shift(), q.shift());
        else r = HalfAdder(c, q.shift(), q.shift());
        q.push(r.sum);
        if (col + 1 < 32) cols[col + 1].push(r.carry);
      }
      if (q.length === 0) q.push(0);
    }
  });
  const p = cols.map((q) => q[0]);
  return { lo: p.slice(0, 16), hi: p.slice(16) };
});

/**
 * ALU. F = [f0, f1, f2, f3]. Groups by f3f2:
 *   00 arithmetic: 0 ADD, 1 SUB, 2 SLT, 3 SLTU
 *   01 logic:      4 AND, 5 OR,  6 XOR, 7 ANDN
 *   10 shift:      8 SHL, 9 SHR, 10 SRA, (11 = SRA)
 *   11 multiply:  12 MUL, 13 MULH, (14 = MUL, 15 = MULH)
 */
export const ALU = chip('ALU', (c, A, B, F) => {
  const [f0, f1, f2, f3] = F;

  const arith = c.scoped('Arith', () => {
    const sub = Or(c, f0, f1);
    const Bx = c.scoped('invertB', () => B.map((b) => Xor(c, b, sub)));
    const { sum, cout } = Adder(c, A, Bx, sub);
    const lt = c.scoped('Compare', () => {
      const a15 = A[15], b15 = B[15];
      const ltS = Or(c, And(c, a15, Not(c, b15)), And(c, Not(c, Xor(c, a15, b15)), sum[15]));
      const ltU = Not(c, cout);
      return Mux(c, ltS, ltU, f0);
    });
    const nf1 = Not(c, f1);
    return [Mux(c, sum[0], lt, f1), ...sum.slice(1).map((s) => And(c, s, nf1))];
  });

  // Operand isolation: the logic unit, shifter and multiplier only see their
  // operands when selected. Idle, their inputs sit at zero and nothing inside
  // them switches (a real power-saving technique; it also lets the simulator
  // skip blocks whose inputs did not change).
  const iso = c.scoped('Isolate', () => {
    const nf2 = Not(c, f2), nf3 = Not(c, f3);
    const gate = (en, bus) => bus.map((x) => And(c, x, en));
    const isLogic = And(c, nf3, f2), isShift = And(c, f3, nf2), isMul = And(c, f3, f2);
    return {
      logic: { A: gate(isLogic, A), B: gate(isLogic, B), f: gate(isLogic, [f0, f1]) },
      shift: { A: gate(isShift, A), amt: gate(isShift, B.slice(0, 4)), f: gate(isShift, [f0, f1]) },
      mul: { A: gate(isMul, A), B: gate(isMul, B) },
    };
  });

  const logic = LogicUnit(c, iso.logic.A, iso.logic.B, iso.logic.f[0], iso.logic.f[1]);
  const shifted = Shifter(c, iso.shift.A, iso.shift.amt,
    Or(c, iso.shift.f[0], iso.shift.f[1]), iso.shift.f[1]);
  const prod = Multiplier(c, iso.mul.A, iso.mul.B);

  return c.scoped('Result', () => {
    const mul = Mux16(c, prod.lo, prod.hi, f0);
    const g0 = Mux16(c, arith, logic, f2);
    const g1 = Mux16(c, shifted, mul, f2);
    return Mux16(c, g0, g1, f3);
  });
});

// ------------------------------------------------------------------- CPU

export function buildCPU() {
  const c = new Circuit('N16');

  // ---- state: program counter and the register file
  const pc = c.scoped('PC', () => c.dffBus(16));
  const regs = c.scoped('RegFile', () => {
    const r = [null];
    for (let i = 1; i < 8; i++) r.push(c.scoped(`r${i}`, () => c.dffBus(16)));
    return r;
  });

  // ---- fetch: the instruction and the (optional) literal word after it
  const { ins, lit, pc1 } = c.scoped('Fetch', () => {
    const pc1 = c.scoped('pc+1', () => Inc16(c, pc.q));
    const ins = c.memRead('rom', pc.q);
    const lit = c.memRead('rom', pc1);
    return { ins, lit, pc1 };
  });

  // ---- decode
  const dec = c.scoped('Decode', () => {
    const L = ins[15];
    const n14 = Not(c, ins[14]), n13 = Not(c, ins[13]);
    const isALU = And(c, n14, n13);
    const isLD = And(c, n14, ins[13]);
    const isST = And(c, ins[14], n13);
    const isJ = And(c, ins[14], ins[13]);
    // Non-ALU instructions force the ALU to ADD (address / target arithmetic).
    const F = [ins[0], ins[1], ins[2], ins[12]].map((x) => And(c, x, isALU));
    return {
      L, isALU, isLD, isST, isJ, F,
      d: ins.slice(9, 12), a: ins.slice(6, 9), b: ins.slice(3, 6), f: ins.slice(0, 3),
    };
  });

  // ---- register read ports (r0 reads as zero: it simply has no select line)
  const readPort = (name, sel) => c.scoped(name, () => {
    const lines = Decoder(c, sel);
    return SelectBus(c, lines.slice(1), regs.slice(1).map((r) => r.q));
  });
  const RA = readPort('ReadA', dec.a);
  const RB = readPort('ReadB', dec.b);
  const Bop = c.scoped('OperandB', () => Mux16(c, RB, lit, dec.L));

  // ---- execute
  const result = ALU(c, RA, Bop, dec.F);

  // ---- memory: address is always the ALU result; store data comes from RB
  const memData = c.scoped('Memory', () => {
    c.memWrite('ram', result, RB, dec.isST);
    return c.memRead('ram', result);
  });

  // ---- branch unit
  const { pcInc, pcNext } = c.scoped('Branch', () => {
    const pcInc = Mux16(c, pc1, c.scoped('pc+2', () => Inc16(c, pc1)), dec.L);
    const Z = IsZero(c, RA);
    const N = RA[15];
    const [f0, f1, f2] = dec.f;
    const cond = Xor(c, f2, Or(c, And(c, f0, Z), And(c, f1, N)));
    const taken = And(c, dec.isJ, cond);
    return { pcInc, pcNext: Mux16(c, pcInc, Bop, taken) };
  });
  pc.set(pcNext);

  // ---- write back
  c.scoped('WriteBack', () => {
    const wb = Mux16(c, Mux16(c, result, memData, dec.isLD), pcInc, dec.isJ);
    const regWrite = Not(c, dec.isST);
    const lines = Decoder(c, dec.d);
    for (let i = 1; i < 8; i++) {
      c.scoped(`r${i}`, () => {
        const we = And(c, lines[i], regWrite);
        regs[i].set(Mux16(c, regs[i].q, wb, we));
      });
    }
  });

  c.probe('pc', pc.q);
  c.probe('ins', ins);
  c.probe('lit', lit);
  for (let i = 1; i < 8; i++) c.probe(`r${i}`, regs[i].q);
  c.probe('alu', result);
  return c;
}
