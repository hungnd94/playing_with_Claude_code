// asm.js — two-pass assembler for N16.
//
//   label:                      ; comments start with ';' or '//'
//       add  r1, r2, r3         ; register operand (1 word)
//       add  r1, r2, 1000       ; literal operand  (2 words, still 1 cycle)
//       li   r1, label          ; pseudo: add r1, r0, label
//       ld   r1, [r2 + 4]       ; load / store, address = register + operand
//       st   [r2 + 4], r1
//       jz   r1, label          ; jz jnz jlt jge jle jgt jmp jal call ret halt
//   .data                       ; switch to RAM data (initial values)
//   table: .word 1, 2, 3
//          .zero 16
//   .text                       ; back to code
//   .loc 42                     ; following code comes from source line 42
//
// Output: { rom, romSize, ram (sparse init: [addr, value][]), labels, asmLine, srcLine }

import { ALU_CODE, JUMP_CODE, CLS_ALU, CLS_LD, CLS_ST, CLS_J, encode } from './isa.js';

export const DATA_BASE = 0x0010;

const REG = { r0: 0, r1: 1, r2: 2, r3: 3, r4: 4, r5: 5, r6: 6, r7: 7, zero: 0, sp: 6, lr: 7 };

export class AsmError extends Error {
  constructor(msg, line) {
    super(line !== undefined ? `line ${line + 1}: ${msg}` : msg);
    this.line = line;
  }
}

// ------------------------------------------------------------ expressions

function tokenizeExpr(s) {
  const toks = [];
  const re = /\s*(0x[0-9a-fA-F_]+|0b[01_]+|\d+|'(?:\\.|[^'])'|[A-Za-z_.$][\w.$]*|<<|>>|[-+*/%&|^~()])/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < s.length) {
    if (/^\s*$/.test(s.slice(re.lastIndex))) break;
    m = re.exec(s);
    if (!m) throw new Error(`bad expression '${s}'`);
    toks.push(m[1]);
  }
  return toks;
}

const CHAR_ESC = { n: 10, t: 9, r: 13, 0: 0, '\\': 92, "'": 39, '"': 34 };

/** Evaluate a constant expression. resolve(name) -> number | undefined. */
export function evalExpr(src, resolve) {
  const toks = tokenizeExpr(src);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const prec = { '|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
  function primary() {
    const t = next();
    if (t === undefined) throw new Error('unexpected end of expression');
    if (t === '(') { const v = binary(0); if (next() !== ')') throw new Error("expected ')'"); return v; }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (t === '~') return ~primary();
    if (/^0x/i.test(t)) return parseInt(t.slice(2).replace(/_/g, ''), 16);
    if (/^0b/i.test(t)) return parseInt(t.slice(2).replace(/_/g, ''), 2);
    if (/^\d/.test(t)) return parseInt(t, 10);
    if (t[0] === "'") {
      const body = t.slice(1, -1);
      return body[0] === '\\' ? CHAR_ESC[body[1]] : body.charCodeAt(0);
    }
    const v = resolve(t);
    if (v === undefined) throw new Error(`undefined symbol '${t}'`);
    return v;
  }
  function binary(minPrec) {
    let lhs = primary();
    for (;;) {
      const op = peek();
      const p = prec[op];
      if (p === undefined || p <= minPrec) return lhs;
      next();
      const rhs = binary(p);
      switch (op) {
        case '+': lhs += rhs; break;
        case '-': lhs -= rhs; break;
        case '*': lhs *= rhs; break;
        case '/': lhs = Math.trunc(lhs / rhs); break;
        case '%': lhs %= rhs; break;
        case '&': lhs &= rhs; break;
        case '|': lhs |= rhs; break;
        case '^': lhs ^= rhs; break;
        case '<<': lhs <<= rhs; break;
        case '>>': lhs >>= rhs; break;
      }
    }
  }
  const v = binary(0);
  if (i !== toks.length) throw new Error(`unexpected '${toks[i]}' in expression`);
  return v;
}

// ------------------------------------------------------------- operands

function splitOperands(s) {
  const out = [];
  let depth = 0, cur = '', quote = null;
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote && cur[cur.length - 2] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const isReg = (s) => Object.prototype.hasOwnProperty.call(REG, s.toLowerCase());
const regNum = (s) => {
  const r = REG[s.toLowerCase()];
  if (r === undefined) throw new Error(`expected register, got '${s}'`);
  return r;
};

/** Register or literal operand. */
function operand(s) {
  s = s.replace(/^#/, '');
  return isReg(s) ? { reg: regNum(s) } : { expr: s };
}

/** Memory operand "[base + offset]". */
function memOperand(s) {
  const m = /^\[(.*)\]$/.exec(s.trim());
  if (!m) throw new Error(`expected memory operand [..], got '${s}'`);
  const inner = m[1].trim();
  const mm = /^([A-Za-z]\w*)\s*(?:([-+])\s*(.+))?$/.exec(inner);
  if (mm && isReg(mm[1])) {
    const base = regNum(mm[1]);
    if (!mm[2]) return { base, off: null };
    if (mm[2] === '+' && isReg(mm[3].trim())) return { base, offReg: regNum(mm[3].trim()) };
    return { base, off: mm[2] === '-' ? `-(${mm[3]})` : mm[3] };
  }
  return { base: 0, off: inner };
}

// -------------------------------------------------------------- assembler

export function assemble(source, { dataBase = DATA_BASE } = {}) {
  const lines = source.split('\n');
  const symbols = new Map();
  const items = []; // { kind: 'ins'|'word', line, ... }

  // ---- pass 1: parse, size, assign addresses
  let pc = 0;
  let dp = dataBase;
  let section = 'text';
  let loc = -1;
  const ramInit = [];

  const defineLabel = (name, value, line) => {
    if (symbols.has(name)) throw new AsmError(`duplicate symbol '${name}'`, line);
    symbols.set(name, value);
  };

  lines.forEach((raw, ln) => {
    let text = raw.replace(/(;|\/\/).*$/, (m, _g, off) => {
      // keep ';' inside quotes
      const before = raw.slice(0, off);
      return (before.split('"').length % 2 === 0) ? m : '';
    }).trim();
    for (;;) {
      const lm = /^([A-Za-z_.$][\w.$]*):\s*(.*)$/.exec(text);
      if (!lm) break;
      defineLabel(lm[1], section === 'text' ? pc : dp, ln);
      text = lm[2].trim();
    }
    if (!text) return;
    const eq = /^([A-Za-z_.][\w.$]*)\s*=\s*(.+)$/.exec(text);
    if (eq) { items.push({ kind: 'equ', name: eq[1], expr: eq[2], line: ln }); return; }

    const sp = text.search(/\s/);
    const op = (sp < 0 ? text : text.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : text.slice(sp + 1).trim();

    try {
      if (op[0] === '.') {
        switch (op) {
          case '.text': section = 'text'; return;
          case '.data': section = 'data'; return;
          case '.loc': loc = parseInt(rest, 10); return;
          case '.equ': case '.set': {
            const [name, expr] = splitOperands(rest);
            items.push({ kind: 'equ', name, expr, line: ln });
            return;
          }
          case '.word': {
            for (const e of splitOperands(rest)) {
              if (section === 'text') { items.push({ kind: 'word', addr: pc++, expr: e, line: ln, loc }); }
              else items.push({ kind: 'data', addr: dp++, expr: e, line: ln });
            }
            return;
          }
          case '.zero': case '.space': {
            const n = evalExpr(rest, (s) => symbols.get(s));
            if (section === 'text') { for (let k = 0; k < n; k++) items.push({ kind: 'word', addr: pc++, expr: '0', line: ln, loc }); }
            else dp += n;
            return;
          }
          case '.string': {
            const sm = /^"((?:\\.|[^"])*)"$/.exec(rest);
            if (!sm) throw new Error('bad string');
            const chars = [];
            for (let k = 0; k < sm[1].length; k++) {
              const ch = sm[1][k];
              if (ch === '\\') chars.push(CHAR_ESC[sm[1][++k]]);
              else chars.push(ch.charCodeAt(0));
            }
            chars.push(0);
            for (const ch of chars) {
              if (section === 'text') items.push({ kind: 'word', addr: pc++, expr: String(ch), line: ln, loc });
              else items.push({ kind: 'data', addr: dp++, expr: String(ch), line: ln });
            }
            return;
          }
          case '.org': {
            const v = evalExpr(rest, (s) => symbols.get(s));
            if (section === 'text') pc = v; else dp = v;
            return;
          }
          default: throw new Error(`unknown directive ${op}`);
        }
      }
      if (section !== 'text') throw new Error('instruction in .data section');
      const ins = parseInstruction(op, splitOperands(rest));
      ins.addr = pc;
      ins.line = ln;
      ins.loc = loc;
      ins.kind = 'ins';
      items.push(ins);
      pc += ins.L ? 2 : 1;
    } catch (e) {
      if (e instanceof AsmError) throw e;
      throw new AsmError(e.message, ln);
    }
  });

  // equates may refer to labels defined later; resolve iteratively
  const pending = items.filter((it) => it.kind === 'equ');
  for (let round = 0; pending.length && round < 20; round++) {
    for (let k = pending.length - 1; k >= 0; k--) {
      try {
        defineLabel(pending[k].name, evalExpr(pending[k].expr, (s) => symbols.get(s)), pending[k].line);
        pending.splice(k, 1);
      } catch (e) {
        if (!/undefined symbol/.test(e.message)) throw new AsmError(e.message, pending[k].line);
      }
    }
  }
  if (pending.length) {
    try { evalExpr(pending[0].expr, (s) => symbols.get(s)); } catch (e) { throw new AsmError(e.message, pending[0].line); }
  }

  // ---- pass 2: encode
  const romSize = Math.max(pc, ...items.filter((x) => x.kind !== 'data' && x.kind !== 'equ').map((x) => x.addr + 1), 0);
  const rom = new Uint16Array(65536);
  const asmLine = new Int32Array(Math.max(romSize, 1)).fill(-1);
  const srcLine = new Int32Array(Math.max(romSize, 1)).fill(-1);
  const resolve = (s) => symbols.get(s);
  const value = (expr, line) => {
    try { return evalExpr(expr, resolve) & 0xffff; } catch (e) { throw new AsmError(e.message, line); }
  };

  for (const it of items) {
    if (it.kind === 'equ') continue;
    if (it.kind === 'data') { ramInit.push([it.addr, value(it.expr, it.line)]); continue; }
    if (it.kind === 'word') { rom[it.addr] = value(it.expr, it.line); asmLine[it.addr] = it.line; srcLine[it.addr] = it.loc; continue; }
    rom[it.addr] = encode(it);
    asmLine[it.addr] = it.line;
    srcLine[it.addr] = it.loc;
    if (it.L) {
      rom[it.addr + 1] = it.self ? it.addr : value(it.lit, it.line);
      asmLine[it.addr + 1] = it.line;
      srcLine[it.addr + 1] = it.loc;
    }
  }
  return { rom, romSize, ram: ramInit, labels: symbols, asmLine, srcLine, dataEnd: dp };
}

function parseInstruction(op, ops) {
  const need = (n) => { if (ops.length !== n) throw new Error(`${op} expects ${n} operand(s), got ${ops.length}`); };
  const lit = (o, base) => (o.reg !== undefined ? { ...base, b: o.reg } : { ...base, L: 1, lit: o.expr });

  if (op in ALU_CODE) {
    need(3);
    const F = ALU_CODE[op];
    return lit(operand(ops[2]), { cls: CLS_ALU, h: F >> 3, f: F & 7, d: regNum(ops[0]), a: regNum(ops[1]) });
  }
  switch (op) {
    case 'nop': need(0); return { cls: CLS_ALU };
    case 'li': need(2); return lit(operand(ops[1]), { cls: CLS_ALU, d: regNum(ops[0]) });
    case 'mov': need(2); return { cls: CLS_ALU, d: regNum(ops[0]), a: regNum(ops[1]) };
    case 'not': need(2); return { cls: CLS_ALU, f: ALU_CODE.xor, d: regNum(ops[0]), a: regNum(ops[1]), L: 1, lit: '0xffff' };
    case 'neg': need(2); return { cls: CLS_ALU, f: ALU_CODE.sub, d: regNum(ops[0]), b: regNum(ops[1]) };
    case 'inc': need(1); return { cls: CLS_ALU, d: regNum(ops[0]), a: regNum(ops[0]), L: 1, lit: '1' };
    case 'dec': need(1); return { cls: CLS_ALU, d: regNum(ops[0]), a: regNum(ops[0]), L: 1, lit: '-1' };
    case 'ld': {
      need(2);
      const m = memOperand(ops[1]);
      const base = { cls: CLS_LD, d: regNum(ops[0]), a: m.base };
      if (m.offReg !== undefined) return { ...base, b: m.offReg };
      if (m.off === null) return base; // [ra + r0]
      return { ...base, L: 1, lit: m.off };
    }
    case 'st': {
      need(2);
      const m = memOperand(ops[0]);
      if (m.offReg !== undefined) throw new Error('st does not support [reg + reg]');
      return { cls: CLS_ST, a: m.base, b: regNum(ops[1]), L: 1, lit: m.off ?? '0' };
    }
    case 'ret': need(0); return { cls: CLS_J, f: JUMP_CODE.jmp, b: REG.lr };
    case 'halt': need(0); return { cls: CLS_J, f: JUMP_CODE.jmp, L: 1, self: true };
    case 'jmp': need(1); return lit(operand(ops[0]), { cls: CLS_J, f: JUMP_CODE.jmp });
    case 'jal': case 'call': {
      if (ops.length === 1) return lit(operand(ops[0]), { cls: CLS_J, f: JUMP_CODE.jmp, d: REG.lr });
      need(2);
      return lit(operand(ops[1]), { cls: CLS_J, f: JUMP_CODE.jmp, d: regNum(ops[0]) });
    }
  }
  if (op in JUMP_CODE) {
    need(2);
    return lit(operand(ops[1]), { cls: CLS_J, f: JUMP_CODE[op], a: regNum(ops[0]) });
  }
  throw new Error(`unknown instruction '${op}'`);
}

/** Load an assembled image into ROM/RAM arrays. */
export function loadImage(img, rom, ram) {
  rom.fill(0);
  rom.set(img.rom.subarray(0, Math.max(img.romSize, 1)));
  ram.fill(0);
  for (const [addr, v] of img.ram) ram[addr] = v;
}
