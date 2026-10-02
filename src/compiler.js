// compiler.js — the Turtle language, compiled to N16 assembly.
//
// Turtle is a small C-like language where every value is a 16-bit integer.
//
//   const W = 128;                    // compile-time constant
//   var score = 0;                    // global variable
//   var board[200];                   // global array (zeroed)
//   var font[] = { 0x7c, 0x82 };      // initialised array
//   var title[] = "HELLO";            // string (one char per word, 0-terminated)
//
//   fn max(a, b) { if (a > b) { return a; } return b; }
//
//   fn main() {
//     for (var i = 0; i < 10; i += 1) { board[i] = max(i, 5); }
//     mem[0xC000] = 0xFFFF;           // `mem` is all of RAM
//     while (true) { }
//   }
//
// Operators (C precedence): || && | ^ & == != < <= > >= << >> >>> + - * / %
// unary - ! ~ &, indexing a[i] (on arrays, or on any value used as a pointer),
// calls. Intrinsics: mulh(a, b) (high half of the signed product), halt().
//
// Code generation: locals live in registers r3..r5 when profitable (ranked by
// loop-weighted use count), otherwise in the stack frame; expression
// temporaries use the remaining registers and spill to the frame when they
// run out. r1 carries return values, r6 is the stack pointer, r7 the link.

export class CompileError extends Error {
  constructor(msg, line) {
    super(line !== undefined ? `line ${line}: ${msg}` : msg);
    this.line = line;
  }
}

// ------------------------------------------------------------------ lexer

const KEYWORDS = new Set(['fn', 'var', 'const', 'if', 'else', 'while', 'for', 'return', 'break', 'continue', 'asm', 'true', 'false', 'do']);
const OPS = ['>>>=', '>>>', '<<=', '>>=', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '=', '(', ')', '{', '}', '[', ']', ',', ';'];
const ESC = { n: 10, t: 9, r: 13, 0: 0, '\\': 92, "'": 39, '"': 34 };

export function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new CompileError('unterminated comment', line);
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end + 2;
      continue;
    }
    let m;
    if ((m = /^(0x[0-9a-fA-F_]+|0b[01_]+|\d+)/.exec(src.slice(i, i + 40)))) {
      const t = m[1].replace(/_/g, '');
      const v = t.startsWith('0x') ? parseInt(t.slice(2), 16) : t.startsWith('0b') ? parseInt(t.slice(2), 2) : parseInt(t, 10);
      toks.push({ t: 'num', v, line });
      i += m[1].length;
      continue;
    }
    if (ch === "'") {
      let v, len;
      if (src[i + 1] === '\\') { v = ESC[src[i + 2]]; len = 4; } else { v = src.charCodeAt(i + 1); len = 3; }
      if (src[i + len - 1] !== "'" || v === undefined) throw new CompileError('bad character literal', line);
      toks.push({ t: 'num', v, line });
      i += len;
      continue;
    }
    if (ch === '"') {
      let s = '';
      i++;
      while (src[i] !== '"') {
        if (i >= src.length || src[i] === '\n') throw new CompileError('unterminated string', line);
        if (src[i] === '\\') { s += String.fromCharCode(ESC[src[i + 1]]); i += 2; } else s += src[i++];
      }
      i++;
      toks.push({ t: 'str', v: s, line });
      continue;
    }
    if ((m = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 80)))) {
      toks.push({ t: KEYWORDS.has(m[0]) ? 'kw' : 'id', v: m[0], line });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new CompileError(`unexpected character '${ch}'`, line);
    toks.push({ t: 'op', v: op, line });
    i += op.length;
  }
  toks.push({ t: 'eof', v: '<end of file>', line });
  return toks;
}

// ----------------------------------------------------------------- parser

const BINARY_PREC = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '>>>': 8,
  '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);

export function parse(src) {
  const toks = lex(src);
  let p = 0;
  const peek = (k = 0) => toks[p + k];
  const next = () => toks[p++];
  const is = (t, v) => peek().t === t && (v === undefined || peek().v === v);
  const isOp = (v) => is('op', v);
  const accept = (t, v) => (is(t, v) ? next() : null);
  const expect = (t, v) => {
    if (!is(t, v)) throw new CompileError(`expected ${v ?? t} but found '${peek().v}'`, peek().line);
    return next();
  };
  const ident = () => expect('id').v;

  function primary() {
    const tok = next();
    const line = tok.line;
    if (tok.t === 'num') return { k: 'num', v: tok.v, line };
    if (tok.t === 'str') return { k: 'str', v: tok.v, line };
    if (tok.t === 'kw' && (tok.v === 'true' || tok.v === 'false')) return { k: 'num', v: tok.v === 'true' ? 1 : 0, line };
    if (tok.t === 'id') return { k: 'name', name: tok.v, line };
    if (tok.t === 'op' && tok.v === '(') { const e = expr(); expect('op', ')'); return e; }
    throw new CompileError(`unexpected '${tok.v}'`, line);
  }

  function postfix() {
    let e = primary();
    for (;;) {
      if (isOp('(')) {
        if (e.k !== 'name') throw new CompileError('only named functions can be called', e.line);
        next();
        const args = [];
        if (!isOp(')')) { do args.push(expr()); while (accept('op', ',')); }
        expect('op', ')');
        e = { k: 'call', name: e.name, args, line: e.line };
      } else if (isOp('[')) {
        next();
        const index = expr();
        expect('op', ']');
        e = { k: 'index', base: e, index, line: e.line };
      } else return e;
    }
  }

  function unary() {
    if (isOp('-') || isOp('!') || isOp('~') || isOp('&')) {
      const tok = next();
      return { k: 'unary', op: tok.v, e: unary(), line: tok.line };
    }
    if (isOp('+')) { next(); return unary(); }
    return postfix();
  }

  function binary(minPrec) {
    let lhs = unary();
    for (;;) {
      const tok = peek();
      const prec = tok.t === 'op' ? BINARY_PREC[tok.v] : undefined;
      if (prec === undefined || prec <= minPrec) return lhs;
      next();
      const rhs = binary(prec);
      lhs = { k: 'bin', op: tok.v, l: lhs, r: rhs, line: tok.line };
    }
  }

  function expr() { return binary(0); }

  function block() {
    expect('op', '{');
    const body = [];
    while (!isOp('}')) body.push(statement());
    next();
    return { k: 'block', body };
  }

  function simpleStatement() {
    // assignment, ++/--, or expression (call)
    const line = peek().line;
    if (is('kw', 'var')) {
      next();
      const name = ident();
      const init = accept('op', '=') ? expr() : null;
      return { k: 'var', name, init, line };
    }
    const target = expr();
    if (peek().t === 'op' && ASSIGN_OPS.has(peek().v)) {
      const op = next().v;
      return { k: 'assign', target, op, value: expr(), line };
    }
    if (isOp('++') || isOp('--')) {
      const op = next().v === '++' ? '+=' : '-=';
      return { k: 'assign', target, op, value: { k: 'num', v: 1, line }, line };
    }
    if (target.k !== 'call') throw new CompileError('expression has no effect', line);
    return { k: 'expr', e: target, line };
  }

  function statement() {
    const tok = peek();
    const line = tok.line;
    if (isOp('{')) return block();
    if (tok.t === 'kw') {
      switch (tok.v) {
        case 'if': {
          next(); expect('op', '(');
          const cond = expr();
          expect('op', ')');
          const then = statement();
          const els = accept('kw', 'else') ? statement() : null;
          return { k: 'if', cond, then, els, line };
        }
        case 'while': {
          next(); expect('op', '(');
          const cond = expr();
          expect('op', ')');
          return { k: 'while', cond, body: statement(), line };
        }
        case 'do': {
          next();
          const body = statement();
          expect('kw', 'while'); expect('op', '(');
          const cond = expr();
          expect('op', ')'); expect('op', ';');
          return { k: 'dowhile', cond, body, line };
        }
        case 'for': {
          next(); expect('op', '(');
          const init = isOp(';') ? null : simpleStatement();
          expect('op', ';');
          const cond = isOp(';') ? null : expr();
          expect('op', ';');
          const step = isOp(')') ? null : simpleStatement();
          expect('op', ')');
          return { k: 'for', init, cond, step, body: statement(), line };
        }
        case 'return': {
          next();
          const e = isOp(';') ? null : expr();
          expect('op', ';');
          return { k: 'return', e, line };
        }
        case 'break': next(); expect('op', ';'); return { k: 'break', line };
        case 'continue': next(); expect('op', ';'); return { k: 'continue', line };
        case 'asm': {
          next();
          const lines = [];
          if (accept('op', '{')) {
            while (!accept('op', '}')) { lines.push(expect('str').v); accept('op', ';'); }
          } else { lines.push(expect('str').v); expect('op', ';'); }
          return { k: 'asm', lines, line };
        }
      }
    }
    const s = simpleStatement();
    expect('op', ';');
    return s;
  }

  const prog = { consts: [], globals: [], funcs: [] };
  while (!is('eof')) {
    const line = peek().line;
    if (accept('kw', 'const')) {
      const name = ident();
      expect('op', '=');
      prog.consts.push({ name, e: expr(), line });
      expect('op', ';');
    } else if (accept('kw', 'var')) {
      do {
        const name = ident();
        let size = null, init = null;
        if (accept('op', '[')) {
          size = isOp(']') ? 'auto' : expr();
          expect('op', ']');
        }
        if (accept('op', '=')) {
          if (is('str')) init = { k: 'string', v: next().v };
          else if (accept('op', '{')) {
            const items = [];
            if (!isOp('}')) { do { if (isOp('}')) break; items.push(expr()); } while (accept('op', ',')); }
            expect('op', '}');
            init = { k: 'list', items };
          } else init = { k: 'scalar', e: expr() };
        }
        prog.globals.push({ name, size, init, line });
      } while (accept('op', ','));
      expect('op', ';');
    } else if (accept('kw', 'fn')) {
      const name = ident();
      expect('op', '(');
      const params = [];
      if (!isOp(')')) { do params.push(ident()); while (accept('op', ',')); }
      expect('op', ')');
      prog.funcs.push({ name, params, body: block(), line });
    } else {
      throw new CompileError(`unexpected '${peek().v}' at top level`, line);
    }
  }
  return prog;
}

// -------------------------------------------------------- constant folding

const s16 = (x) => (x << 16) >> 16;
const u16 = (x) => x & 0xffff;

function foldBinary(op, a, b) {
  a = s16(a); b = s16(b);
  switch (op) {
    case '+': return u16(a + b);
    case '-': return u16(a - b);
    case '*': return u16(Math.imul(a, b));
    case '/': if (b === 0) return null; return u16(Math.trunc(a / b));
    case '%': if (b === 0) return null; return u16(a % b);
    case '&': return u16(a & b);
    case '|': return u16(a | b);
    case '^': return u16(a ^ b);
    case '<<': return u16(a << (b & 15));
    case '>>': return u16(a >> (b & 15));
    case '>>>': return u16(u16(a) >>> (b & 15));
    case '==': return a === b ? 1 : 0;
    case '!=': return a !== b ? 1 : 0;
    case '<': return a < b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '>': return a > b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    case '&&': return a && b ? 1 : 0;
    case '||': return a || b ? 1 : 0;
  }
  return null;
}

// ---------------------------------------------------------------- codegen

const ALU_MNEMONIC = {
  '+': 'add', '-': 'sub', '*': 'mul', '&': 'and', '|': 'or', '^': 'xor',
  '<<': 'shl', '>>': 'sra', '>>>': 'shr',
};
const COMMUTATIVE = new Set(['+', '*', '&', '|', '^']);
const INVERSE_CMP = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
const TEMP_REGS = [1, 2, 3, 4, 5];
const LOCAL_REGS = [5, 4, 3];
const SP = 6, LR = 7;
const STACK_TOP = 0xc000;

export const RUNTIME = `
; ---- runtime library -------------------------------------------------
; __udivmod: r1 = r1 / r2 (unsigned), r2 = remainder. Clobbers r1, r2 only.
__udivmod:
        sub  sp, sp, 3
        st   [sp + 0], r3
        st   [sp + 1], r4
        st   [sp + 2], r5
        li   r3, 0              ; remainder
        li   r4, 16             ; bit counter
__udm_loop:
        shl  r3, r3, 1
        shr  r5, r1, 15
        or   r3, r3, r5
        shl  r1, r1, 1
        sltu r5, r3, r2
        jnz  r5, __udm_skip
        sub  r3, r3, r2
        or   r1, r1, 1
__udm_skip:
        dec  r4
        jnz  r4, __udm_loop
        mov  r2, r3
        ld   r3, [sp + 0]
        ld   r4, [sp + 1]
        ld   r5, [sp + 2]
        add  sp, sp, 3
        ret
; __div / __mod: signed, truncating (like C). r1 = r1 op r2.
__div:
        sub  sp, sp, 2
        st   [sp + 0], lr
        st   [sp + 1], r3
        xor  r3, r1, r2         ; sign of result in bit 15
        jge  r1, __div_a
        neg  r1, r1
__div_a:
        jge  r2, __div_b
        neg  r2, r2
__div_b:
        call __udivmod
        jge  r3, __div_c
        neg  r1, r1
__div_c:
        ld   lr, [sp + 0]
        ld   r3, [sp + 1]
        add  sp, sp, 2
        ret
__mod:
        sub  sp, sp, 2
        st   [sp + 0], lr
        st   [sp + 1], r3
        mov  r3, r1             ; sign of result = sign of dividend
        jge  r1, __mod_a
        neg  r1, r1
__mod_a:
        jge  r2, __mod_b
        neg  r2, r2
__mod_b:
        call __udivmod
        mov  r1, r2
        jge  r3, __mod_c
        neg  r1, r1
__mod_c:
        ld   lr, [sp + 0]
        ld   r3, [sp + 1]
        add  sp, sp, 2
        ret
`;

class Temp {
  constructor() { this.reg = -1; this.slot = -1; this.pinned = 0; }
}

class FuncGen {
  constructor(cg, fn) {
    this.cg = cg;
    this.fn = fn;
    this.name = fn.name;
    this.out = [];
    this.nSlots = 0;
    this.freeSlots = [];
    this.regOwner = new Array(8).fill(null); // Temp | 'local'
    this.scopes = [new Map()];
    this.loops = [];
    this.usedRegs = new Set();
    this.makesCalls = false;
    this.retLabel = `.Lret_${fn.name}`;
    this.regLocals = new Map(); // declaration node -> register
  }

  // ---------------- emission helpers
  emit(line) { this.out.push('        ' + line); }
  label(l) { this.out.push(`${l}:`); }
  newLabel() { return `.L${this.cg.labelCounter++}`; }
  loc(line) { if (line !== undefined && line !== this.lastLoc) { this.out.push(`.loc ${line}`); this.lastLoc = line; } }
  r(n) { if (n >= 1 && n <= 5) this.usedRegs.add(n); return `r${n}`; }
  frameSym() { return `.F_${this.name}`; }

  // ---------------- frame slots
  allocSlot() { return this.freeSlots.length ? this.freeSlots.pop() : this.nSlots++; }
  freeSlot(s) { this.freeSlots.push(s); }
  slotAddr(s) { return `[sp + ${s}]`; }

  // ---------------- temporaries
  allocReg() {
    for (const r of TEMP_REGS) if (this.regOwner[r] === null) return this.r(r);
    // spill the least recently allocated unpinned temp
    for (const r of TEMP_REGS) {
      const t = this.regOwner[r];
      if (t instanceof Temp && !t.pinned) {
        t.slot = this.allocSlot();
        this.emit(`st   ${this.slotAddr(t.slot)}, r${r}`);
        t.reg = -1;
        this.regOwner[r] = null;
        return this.r(r);
      }
    }
    throw new CompileError('expression too complex (out of registers)', this.lastLoc);
  }

  newTemp() {
    const t = new Temp();
    const reg = this.allocReg();
    t.reg = Number(reg.slice(1));
    this.regOwner[t.reg] = t;
    return t;
  }

  /** Make sure a temp is in a register; returns the register number. */
  use(t) {
    if (t.reg >= 0) return t.reg;
    t.pinned++;
    const reg = Number(this.allocReg().slice(1));
    t.pinned--;
    this.emit(`ld   r${reg}, ${this.slotAddr(t.slot)}`);
    this.freeSlot(t.slot);
    t.slot = -1;
    t.reg = reg;
    this.regOwner[reg] = t;
    return reg;
  }

  release(t) {
    if (t.reg >= 0) { this.regOwner[t.reg] = null; t.reg = -1; }
    if (t.slot >= 0) { this.freeSlot(t.slot); t.slot = -1; }
  }

  // Values: { lit: string|number } | { reg: n } (borrowed local) | { temp: Temp }
  releaseV(v) { if (v && v.temp) this.release(v.temp); }
  pinV(v) { if (v.temp) v.temp.pinned++; }
  unpinV(v) { if (v.temp && v.temp.pinned > 0) v.temp.pinned--; }

  /** Spill every live temporary (before control flow inside an expression). */
  flushTemps() {
    for (const r of TEMP_REGS) {
      const t = this.regOwner[r];
      if (t instanceof Temp) {
        t.slot = this.allocSlot();
        this.emit(`st   ${this.slotAddr(t.slot)}, r${r}`);
        t.reg = -1;
        this.regOwner[r] = null;
      }
    }
  }

  memRef(baseReg, off) {
    if (baseReg === null) return `[${off}]`;
    return off === '0' ? `[r${baseReg}]` : `[r${baseReg} + ${off}]`;
  }

  /** Register number holding v (materialising literals into a temp). */
  regOf(v) {
    if (v.reg !== undefined) return v.reg;
    if (v.temp) return this.use(v.temp);
    const t = this.newTemp();
    this.emit(`li   r${t.reg}, ${v.lit}`);
    v.temp = t;
    delete v.lit;
    return t.reg;
  }

  /** B-operand text: literal or register. */
  operandB(v) { return v.lit !== undefined ? String(v.lit) : `r${this.regOf(v)}`; }

  /** A temp register we may overwrite: reuse v's temp or allocate a new one. */
  destFor(...vs) {
    for (const v of vs) if (v.temp && v.temp.reg >= 0) return v.temp;
    return this.newTemp();
  }

  // ---------------- name resolution
  pushScope() { this.scopes.push(new Map()); }
  popScope() {
    const s = this.scopes.pop();
    for (const v of s.values()) {
      if (v.kind === 'reg') this.regOwner[v.reg] = null;
      else if (v.kind === 'slot' && !v.param) this.freeSlot(v.slot);
    }
  }
  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i].get(name);
      if (v) return v;
    }
    return this.cg.globalsByName.get(name) || null;
  }
  declareLocal(decl, name, line) {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) throw new CompileError(`'${name}' is already declared in this scope`, line);
    const reg = this.regLocals.get(decl);
    let v;
    if (reg !== undefined && this.regOwner[reg] === null) {
      this.regOwner[reg] = 'local';
      this.r(reg);
      v = { kind: 'reg', reg };
    } else {
      v = { kind: 'slot', slot: this.allocSlot() };
    }
    scope.set(name, v);
    return v;
  }

  // ------------------------------------------------------------ expressions
  constValue(e) { return this.cg.constValue(e, this); }

  /** Evaluate an expression. Returns a Value. */
  expr(e) {
    const c = this.constValue(e);
    if (c !== null) return { lit: s16(c) };
    switch (e.k) {
      case 'str': return { lit: this.cg.stringLiteral(e.v) };
      case 'name': {
        const v = this.lookup(e.name);
        if (!v) throw new CompileError(`unknown name '${e.name}'`, e.line);
        if (v.kind === 'reg') return { reg: v.reg };
        if (v.kind === 'slot') { const t = this.newTemp(); this.emit(`ld   r${t.reg}, ${this.slotAddr(v.slot)}`); return { temp: t }; }
        if (v.kind === 'global') { const t = this.newTemp(); this.emit(`ld   r${t.reg}, [${v.label}]`); return { temp: t }; }
        if (v.kind === 'array') return { lit: v.label };
        if (v.kind === 'func') return { lit: v.label };
        throw new CompileError(`'${e.name}' is not a value`, e.line);
      }
      case 'unary': return this.unary(e);
      case 'bin': return this.binary(e);
      case 'index': {
        const { base, off } = this.address(e);
        let br = null;
        if (base) { br = this.regOf(base); this.pinV(base); }
        const t = base ? this.destFor(base) : this.newTemp();
        this.emit(`ld   r${t.reg}, ${this.memRef(br, off)}`);
        if (base) { this.unpinV(base); if (base.temp !== t) this.releaseV(base); }
        return { temp: t };
      }
      case 'call': return this.call(e, true);
    }
    throw new CompileError(`cannot evaluate ${e.k}`, e.line);
  }

  /**
   * Address of an index expression as base register + literal offset.
   * Returns { base: Value|null, off: string }.
   */
  address(e) {
    let baseLit = null, baseVal = null;
    if (e.base.k === 'name' && e.base.name === 'mem' && !this.lookup('mem')) baseLit = '0';
    else {
      const b = this.expr(e.base);
      if (b.lit !== undefined) baseLit = String(b.lit); else baseVal = b;
    }
    const ci = this.constValue(e.index);
    if (ci !== null) {
      const off = baseLit !== null ? `${baseLit} + ${s16(ci)}` : String(s16(ci));
      return { base: baseVal, off: baseVal ? off : off };
    }
    const idx = this.expr(e.index);
    if (baseLit !== null) return { base: idx, off: baseLit };
    // pointer + index
    const a = this.regOf(baseVal);
    this.pinV(baseVal);
    const bop = this.operandB(idx);
    this.pinV(idx);
    const t = this.destFor(baseVal, idx);
    this.emit(`add  r${t.reg}, r${a}, ${bop}`);
    this.unpinV(baseVal); this.unpinV(idx);
    if (baseVal.temp !== t) this.releaseV(baseVal);
    if (idx.temp !== t) this.releaseV(idx);
    return { base: { temp: t }, off: '0' };
  }

  unary(e) {
    if (e.op === '&') {
      if (e.e.k !== 'name') throw new CompileError('& needs a global name', e.line);
      const v = this.lookup(e.e.name);
      if (!v || !['global', 'array', 'func'].includes(v.kind)) throw new CompileError('& only works on globals and functions', e.line);
      return { lit: v.label };
    }
    const v = this.expr(e.e);
    const a = this.regOf(v);
    this.pinV(v);
    const t = this.destFor(v);
    if (e.op === '-') this.emit(`sub  r${t.reg}, r0, r${a}`);
    else if (e.op === '~') this.emit(`xor  r${t.reg}, r${a}, -1`);
    else if (e.op === '!') this.emit(`sltu r${t.reg}, r${a}, 1`);
    this.unpinV(v);
    if (v.temp !== t) this.releaseV(v);
    return { temp: t };
  }

  binary(e) {
    const op = e.op;
    if (op === '&&' || op === '||' || INVERSE_CMP[op]) return this.boolValue(e);
    if (op === '/' || op === '%') return this.divmod(e);
    if (e.op === '-' && this.constValue(e.r) !== null) {
      // x - k  ->  x + (-k)
      return this.binary({ ...e, op: '+', r: { k: 'num', v: -this.constValue(e.r), line: e.line } });
    }
    let l = e.l, r = e.r;
    if (COMMUTATIVE.has(op) && this.constValue(l) !== null) [l, r] = [r, l];
    const lv = this.expr(l);
    const rv = this.expr(r);
    const a = this.regOf(lv);
    this.pinV(lv);
    const b = this.operandB(rv);
    this.pinV(rv);
    const t = this.destFor(lv, rv);
    this.emit(`${ALU_MNEMONIC[op].padEnd(4)} r${t.reg}, r${a}, ${b}`);
    this.unpinV(lv); this.unpinV(rv);
    if (lv.temp !== t) this.releaseV(lv);
    if (rv.temp !== t) this.releaseV(rv);
    return { temp: t };
  }

  divmod(e) {
    const ce = this.constValue(e.r);
    // power-of-two divisor: shifts with round-toward-zero correction
    if (ce !== null && ce > 0 && (ce & (ce - 1)) === 0) {
      const k = Math.log2(ce);
      if (k === 0) return e.op === '/' ? this.expr(e.l) : { lit: 0 };
      const v = this.expr(e.l);
      const x = this.regOf(v);
      this.pinV(v);
      const t = this.newTemp();
      this.emit(`sra  r${t.reg}, r${x}, 15`);
      this.emit(`shr  r${t.reg}, r${t.reg}, ${16 - k}`);
      this.emit(`add  r${t.reg}, r${t.reg}, r${x}`);
      if (e.op === '/') {
        this.emit(`sra  r${t.reg}, r${t.reg}, ${k}`);
      } else {
        this.emit(`and  r${t.reg}, r${t.reg}, ${u16(-ce)}`);
        this.emit(`sub  r${t.reg}, r${x}, r${t.reg}`);
      }
      this.unpinV(v);
      this.releaseV(v);
      return { temp: t };
    }
    return this.callNamed(e.op === '/' ? '__div' : '__mod', [e.l, e.r], e.line);
  }

  /** Materialise a boolean expression as 0/1. */
  boolValue(e) {
    const op = e.op;
    if (op === '==' || op === '!=') {
      const t = this.compareDiff(e.l, e.r);
      if (op === '==') this.emit(`sltu r${t.reg}, r${t.reg}, 1`);
      else this.emit(`sltu r${t.reg}, r0, r${t.reg}`);
      return { temp: t };
    }
    if (op === '<' || op === '>' || op === '<=' || op === '>=') {
      const { t, negate } = this.compareLess(e);
      if (negate) this.emit(`xor  r${t.reg}, r${t.reg}, 1`);
      return { temp: t };
    }
    // && || via branches. Live temporaries are spilled first so that no
    // spill or reload happens on only one of the paths.
    this.flushTemps();
    const lfalse = this.newLabel(), lend = this.newLabel();
    this.cond(e, lfalse, false);
    const t = this.newTemp(); // all temp registers are free here: no spill
    this.emit(`li   r${t.reg}, 1`);
    this.emit(`jmp  ${lend}`);
    this.label(lfalse);
    this.emit(`li   r${t.reg}, 0`);
    this.label(lend);
    return { temp: t };
  }

  /** Temp holding l - r (zero iff equal). */
  compareDiff(l, r) {
    if (this.constValue(l) !== null) [l, r] = [r, l];
    const lv = this.expr(l);
    const rv = this.expr(r);
    const a = this.regOf(lv);
    this.pinV(lv);
    const b = this.operandB(rv);
    this.pinV(rv);
    const t = this.destFor(lv, rv);
    this.emit(`sub  r${t.reg}, r${a}, ${b}`);
    this.unpinV(lv); this.unpinV(rv);
    if (lv.temp !== t) this.releaseV(lv);
    if (rv.temp !== t) this.releaseV(rv);
    return t;
  }

  /**
   * For <, <=, >, >=: returns a temp t = slt(x, y) and whether the
   * expression's truth is NOT t.
   */
  compareLess(e) {
    let x, y, negate;
    switch (e.op) {
      case '<': x = e.l; y = e.r; negate = false; break; // l < r
      case '>=': x = e.l; y = e.r; negate = true; break; // !(l < r)
      case '>': x = e.r; y = e.l; negate = false; break; // r < l
      case '<=': x = e.r; y = e.l; negate = true; break; // !(r < l)
    }
    // slt needs its first operand in a register; if it is a constant k,
    // rewrite k < y  as  !(y < k + 1)
    const cx = this.constValue(x);
    if (cx !== null && this.constValue(y) === null && s16(cx) < 32767) {
      x = y; y = { k: 'num', v: s16(cx) + 1 }; negate = !negate;
    }
    const xv = this.expr(x);
    const yv = this.expr(y);
    const a = this.regOf(xv);
    this.pinV(xv);
    const b = this.operandB(yv);
    this.pinV(yv);
    const t = this.destFor(xv, yv);
    this.emit(`slt  r${t.reg}, r${a}, ${b}`);
    this.unpinV(xv); this.unpinV(yv);
    if (xv.temp !== t) this.releaseV(xv);
    if (yv.temp !== t) this.releaseV(yv);
    return { t, negate };
  }

  /** Jump to `label` when truthiness of e equals `when`. */
  cond(e, label, when) {
    const c = this.constValue(e);
    if (c !== null) { if ((c !== 0) === when) this.emit(`jmp  ${label}`); return; }
    if (e.k === 'unary' && e.op === '!') return this.cond(e.e, label, !when);
    if (e.k === 'bin') {
      const op = e.op;
      if (op === '&&' || op === '||') {
        const shortCircuitsOn = op === '&&' ? false : true;
        if (when === shortCircuitsOn) {
          this.cond(e.l, label, when);
          this.cond(e.r, label, when);
        } else {
          const skip = this.newLabel();
          this.cond(e.l, skip, !when);
          this.cond(e.r, label, when);
          this.label(skip);
        }
        return;
      }
      if (op === '==' || op === '!=') {
        const jumpIfZero = (op === '==') === when;
        const cr = this.constValue(e.r), cl = this.constValue(e.l);
        const other = cr === 0 ? e.l : cl === 0 ? e.r : null;
        if (other) {
          const v = this.expr(other);
          this.emit(`${jumpIfZero ? 'jz ' : 'jnz'}  r${this.regOf(v)}, ${label}`);
          this.releaseV(v);
          return;
        }
        const t = this.compareDiff(e.l, e.r);
        this.emit(`${jumpIfZero ? 'jz ' : 'jnz'}  r${t.reg}, ${label}`);
        this.release(t);
        return;
      }
      if (op === '<' || op === '>' || op === '<=' || op === '>=') {
        // comparisons against zero test the sign directly
        if (this.constValue(e.r) === 0) {
          const v = this.expr(e.l);
          const jop = when ? { '<': 'jlt', '>=': 'jge', '>': 'jgt', '<=': 'jle' }[op] : { '<': 'jge', '>=': 'jlt', '>': 'jle', '<=': 'jgt' }[op];
          this.emit(`${jop}  r${this.regOf(v)}, ${label}`);
          this.releaseV(v);
          return;
        }
        const { t, negate } = this.compareLess(e);
        this.emit(`${(when !== negate) ? 'jnz' : 'jz '}  r${t.reg}, ${label}`);
        this.release(t);
        return;
      }
    }
    const v = this.expr(e);
    this.emit(`${when ? 'jnz' : 'jz '}  r${this.regOf(v)}, ${label}`);
    this.releaseV(v);
  }

  // ------------------------------------------------------------ calls
  call(e, wantValue) {
    if (e.name === 'mulh' && !this.lookup('mulh')) {
      if (e.args.length !== 2) throw new CompileError('mulh takes 2 arguments', e.line);
      return this.binaryRaw('mulh', e.args[0], e.args[1]);
    }
    if (e.name === 'halt' && !this.lookup('halt')) { this.emit('halt'); return { lit: 0 }; }
    const f = this.cg.funcs.get(e.name);
    if (!f) throw new CompileError(`unknown function '${e.name}'`, e.line);
    if (f.params.length !== e.args.length) {
      throw new CompileError(`${e.name} expects ${f.params.length} argument(s), got ${e.args.length}`, e.line);
    }
    return this.callNamed(`f_${e.name}`, e.args, e.line, wantValue);
  }

  binaryRaw(mnemonic, l, r) {
    const lv = this.expr(l);
    const rv = this.expr(r);
    const a = this.regOf(lv);
    this.pinV(lv);
    const b = this.operandB(rv);
    this.pinV(rv);
    const t = this.destFor(lv, rv);
    this.emit(`${mnemonic.padEnd(4)} r${t.reg}, r${a}, ${b}`);
    this.unpinV(lv); this.unpinV(rv);
    if (lv.temp !== t) this.releaseV(lv);
    if (rv.temp !== t) this.releaseV(rv);
    return { temp: t };
  }

  callNamed(label, args, line, wantValue = true) {
    this.makesCalls = true;
    const runtime = label.startsWith('__');
    // evaluate arguments (they may contain calls themselves)
    const vals = [];
    for (const a of args) vals.push(this.expr(a));
    if (runtime) {
      vals.forEach((v) => this.pinV(v));
      // runtime helpers take r1, r2 and clobber only r1, r2
      this.evacuate([1, 2]);
      const moveTo = (v, reg) => {
        if (v.lit !== undefined) this.emit(`li   r${reg}, ${v.lit}`);
        else { const src = this.regOf(v); if (src !== reg) this.emit(`mov  r${reg}, r${src}`); }
      };
      // order matters if an argument already sits in the other register
      const [a, b] = vals;
      const aReg = a.lit === undefined ? this.regOf(a) : -1;
      if (aReg === 2) {
        const bReg = b.lit === undefined ? this.regOf(b) : -1;
        if (bReg === 1) { this.emit('xor  r1, r1, r2'); this.emit('xor  r2, r1, r2'); this.emit('xor  r1, r1, r2'); }
        else { moveTo(a, 1); moveTo(b, 2); }
      } else { moveTo(b, 2); moveTo(a, 1); }
      vals.forEach((v) => { this.unpinV(v); this.releaseV(v); });
      this.r(1); this.r(2);
      this.emit(`call ${label}`);
    } else {
      const n = vals.length;
      // arguments go just below sp: the callee's frame will cover them
      vals.forEach((v, i) => {
        if (v.lit === 0) { this.emit(`st   [sp - ${n - i}], r0`); return; }
        this.emit(`st   [sp - ${n - i}], r${this.regOf(v)}`);
        this.releaseV(v);
      });
      this.evacuate([1]);
      this.emit(`call ${label}`);
    }
    if (!wantValue) return null;
    const t = new Temp();
    t.reg = 1;
    this.regOwner[1] = t;
    this.r(1);
    return { temp: t };
  }

  /** Move live temps out of the given registers (which a call will clobber). */
  evacuate(regs) {
    for (const r of regs) {
      const t = this.regOwner[r];
      if (t === 'local') throw new CompileError('internal: local in clobbered register');
      if (t instanceof Temp) {
        const free = TEMP_REGS.find((x) => !regs.includes(x) && this.regOwner[x] === null);
        if (free !== undefined) {
          this.emit(`mov  r${free}, r${r}`);
          this.r(free);
          this.regOwner[free] = t;
          t.reg = free;
        } else {
          t.slot = this.allocSlot();
          this.emit(`st   ${this.slotAddr(t.slot)}, r${r}`);
          t.reg = -1;
        }
        this.regOwner[r] = null;
      }
    }
  }

  // ------------------------------------------------------------ statements
  assignTo(target, value, line) {
    if (target.k === 'name') {
      const v = this.lookup(target.name);
      if (!v) throw new CompileError(`unknown name '${target.name}'`, line);
      if (v.kind === 'reg') {
        // compute directly into the local's register when possible
        if (value.lit !== undefined) this.emit(`li   r${v.reg}, ${value.lit}`);
        else {
          const src = this.regOf(value);
          if (src !== v.reg) this.emit(`mov  r${v.reg}, r${src}`);
        }
      } else if (v.kind === 'slot') {
        this.emit(`st   ${this.slotAddr(v.slot)}, r${this.regOf(value)}`);
      } else if (v.kind === 'global') {
        this.emit(`st   [${v.label}], r${this.regOf(value)}`);
      } else throw new CompileError(`cannot assign to '${target.name}'`, line);
      this.releaseV(value);
      return;
    }
    if (target.k === 'index') {
      const { base, off } = this.address(target);
      const vr = this.regOf(value);
      this.pinV(value);
      const br = base ? this.regOf(base) : null;
      this.emit(`st   ${this.memRef(br, off)}, r${vr}`);
      this.unpinV(value);
      this.releaseV(value);
      if (base) this.releaseV(base);
      return;
    }
    throw new CompileError('invalid assignment target', line);
  }

  assign(s) {
    let value;
    if (s.op === '=') value = s.value;
    else value = { k: 'bin', op: s.op.slice(0, -1), l: s.target, r: s.value, line: s.line };
    // fast path: register local updated in place (x += k, x = x op y)
    if (s.target.k === 'name') {
      const v = this.lookup(s.target.name);
      if (v && v.kind === 'reg' && value.k === 'bin' && ALU_MNEMONIC[value.op] && value.l.k === 'name' && value.l.name === s.target.name &&
          this.constValue(value) === null) {
        let rhs = value.r;
        let op = value.op;
        const cr = this.constValue(rhs);
        if (op === '-' && cr !== null) { op = '+'; rhs = { k: 'num', v: -cr }; }
        const rv = this.expr(rhs);
        this.emit(`${ALU_MNEMONIC[op].padEnd(4)} r${v.reg}, r${v.reg}, ${this.operandB(rv)}`);
        this.releaseV(rv);
        return;
      }
    }
    this.assignTo(s.target, this.expr(value), s.line);
  }

  stmt(s) {
    if (s.line !== undefined && s.k !== 'block') this.loc(s.line);
    switch (s.k) {
      case 'block':
        this.pushScope();
        for (const x of s.body) this.stmt(x);
        this.popScope();
        return;
      case 'var': {
        const value = s.init ? this.expr(s.init) : { lit: 0 };
        const want = this.regLocals.get(s);
        if (value.temp && value.temp.reg >= 0 && value.temp.reg === want) {
          // the initialiser already sits in the register this local wants
          this.regOwner[want] = null;
          value.temp.reg = -1;
          this.declareLocal(s, s.name, s.line);
          return;
        }
        this.declareLocal(s, s.name, s.line);
        this.assignTo({ k: 'name', name: s.name }, value, s.line);
        return;
      }
      case 'assign': this.assign(s); return;
      case 'expr': { const v = this.call(s.e, false); this.releaseV(v); return; }
      case 'if': {
        const lelse = this.newLabel();
        this.cond(s.cond, lelse, false);
        this.stmt(s.then);
        if (s.els) {
          const lend = this.newLabel();
          this.emit(`jmp  ${lend}`);
          this.label(lelse);
          this.stmt(s.els);
          this.label(lend);
        } else this.label(lelse);
        return;
      }
      case 'while': {
        const lbody = this.newLabel(), lcond = this.newLabel(), lend = this.newLabel();
        const always = this.constValue(s.cond);
        if (always === null) this.emit(`jmp  ${lcond}`);
        else if (always === 0) return;
        this.label(lbody);
        this.loops.push({ brk: lend, cont: lcond });
        this.stmt(s.body);
        this.loops.pop();
        this.label(lcond);
        this.loc(s.line);
        this.cond(s.cond, lbody, true);
        this.label(lend);
        return;
      }
      case 'dowhile': {
        const lbody = this.newLabel(), lcond = this.newLabel(), lend = this.newLabel();
        this.label(lbody);
        this.loops.push({ brk: lend, cont: lcond });
        this.stmt(s.body);
        this.loops.pop();
        this.label(lcond);
        this.loc(s.line);
        this.cond(s.cond, lbody, true);
        this.label(lend);
        return;
      }
      case 'for': {
        this.pushScope();
        if (s.init) this.stmt(s.init);
        const lbody = this.newLabel(), lcont = this.newLabel(), lcond = this.newLabel(), lend = this.newLabel();
        if (s.cond) this.emit(`jmp  ${lcond}`);
        this.label(lbody);
        this.loops.push({ brk: lend, cont: lcont });
        this.stmt(s.body);
        this.loops.pop();
        this.label(lcont);
        if (s.step) this.stmt(s.step);
        this.label(lcond);
        this.loc(s.line);
        if (s.cond) this.cond(s.cond, lbody, true);
        else this.emit(`jmp  ${lbody}`);
        this.label(lend);
        this.popScope();
        return;
      }
      case 'return': {
        if (s.e) {
          const v = this.expr(s.e);
          if (v.lit !== undefined) this.emit(`li   r1, ${v.lit}`);
          else { const r = this.regOf(v); if (r !== 1) this.emit(`mov  r1, r${r}`); }
          this.r(1);
          this.releaseV(v);
        }
        this.emit(`jmp  ${this.retLabel}`);
        return;
      }
      case 'break':
      case 'continue': {
        const loop = this.loops[this.loops.length - 1];
        if (!loop) throw new CompileError(`${s.k} outside a loop`, s.line);
        this.emit(`jmp  ${s.k === 'break' ? loop.brk : loop.cont}`);
        return;
      }
      case 'asm':
        for (const line of s.lines) {
          const text = line.replace(/\{(\w+)\}/g, (m, name) => {
            const v = this.lookup(name);
            if (!v) throw new CompileError(`asm: unknown name '${name}'`, s.line);
            if (v.kind === 'reg') return `r${v.reg}`;
            if (v.kind === 'slot') return `sp + ${v.slot}`;
            if (v.label) return v.label;
            throw new CompileError(`asm: cannot reference '${name}'`, s.line);
          });
          for (const m of text.matchAll(/\br([1-5])\b/g)) this.usedRegs.add(Number(m[1]));
          if (/\b(call|jal)\b/.test(text)) this.makesCalls = true;
          this.emit(text);
        }
        return;
    }
    throw new CompileError(`unknown statement ${s.k}`, s.line);
  }

  // ------------------------------------------------------------ register allocation
  chooseRegisterLocals() {
    // weight each local declaration (and parameter) by loop-nested use count
    const decls = [];
    const uses = new Map();
    const walkExpr = (e, scope, w) => {
      if (!e) return;
      switch (e.k) {
        case 'name': { const d = scope.get(e.name); if (d) uses.set(d, (uses.get(d) || 0) + w); return; }
        case 'unary': walkExpr(e.e, scope, w); return;
        case 'bin': walkExpr(e.l, scope, w); walkExpr(e.r, scope, w); return;
        case 'index': walkExpr(e.base, scope, w); walkExpr(e.index, scope, w); return;
        case 'call': e.args.forEach((a) => walkExpr(a, scope, w)); return;
      }
    };
    const walk = (s, scope, w) => {
      if (!s) return scope;
      switch (s.k) {
        case 'block': { let sc = new Map(scope); for (const x of s.body) sc = walk(x, sc, w); return scope; }
        case 'var': { walkExpr(s.init, scope, w); const sc = new Map(scope); sc.set(s.name, s); decls.push(s); uses.set(s, (uses.get(s) || 0) + w); return sc; }
        case 'assign': walkExpr(s.target, scope, w); walkExpr(s.value, scope, w); return scope;
        case 'expr': walkExpr(s.e, scope, w); return scope;
        case 'if': walkExpr(s.cond, scope, w); walk(s.then, scope, w); walk(s.els, scope, w); return scope;
        case 'while': case 'dowhile': walkExpr(s.cond, scope, w * 8); walk(s.body, scope, w * 8); return scope;
        case 'for': {
          const sc = walk(s.init, new Map(scope), w);
          walkExpr(s.cond, sc, w * 8); walk(s.step, sc, w * 8); walk(s.body, sc, w * 8);
          return scope;
        }
        case 'return': walkExpr(s.e, scope, w); return scope;
        case 'asm':
          for (const l of s.lines) for (const m of l.matchAll(/\{(\w+)\}/g)) { const d = scope.get(m[1]); if (d) uses.set(d, (uses.get(d) || 0) + 1e9); }
          return scope;
      }
      return scope;
    };
    const top = new Map();
    this.fn.paramDecls = this.fn.params.map((p) => ({ k: 'param', name: p }));
    this.fn.paramDecls.forEach((d) => { top.set(d.name, d); decls.push(d); uses.set(d, 1); });
    walk(this.fn.body, top, 1);
    // Greedy: hottest locals get registers. Locals in disjoint scopes may
    // share a register (declareLocal checks availability at run time).
    const ranked = decls.filter((d) => (uses.get(d) || 0) > 1).sort((a, b) => uses.get(b) - uses.get(a));
    const nRegs = this.cg.opts.regLocals ?? LOCAL_REGS.length;
    ranked.slice(0, nRegs).forEach((d, i) => this.regLocals.set(d, LOCAL_REGS[i]));
    // Lower-ranked locals may still pick up a register if one is free when declared.
    ranked.slice(nRegs).forEach((d, i) => this.regLocals.set(d, LOCAL_REGS[i % nRegs]));
  }

  // ------------------------------------------------------------ whole function
  generate() {
    const fn = this.fn;
    this.chooseRegisterLocals();
    // parameters live in the caller-written area at the top of the frame
    const params = new Map();
    fn.params.forEach((p, i) => {
      if (params.has(p)) throw new CompileError(`duplicate parameter '${p}'`, fn.line);
      params.set(p, i);
    });
    const paramScope = this.scopes[0];
    const paramLoads = [];
    fn.paramDecls.forEach((d, i) => {
      const reg = this.regLocals.get(d);
      const memSlot = `${this.frameSym()} - ${fn.params.length - i}`;
      if (reg !== undefined && this.regOwner[reg] === null) {
        this.regOwner[reg] = 'local';
        this.r(reg);
        paramScope.set(d.name, { kind: 'reg', reg });
        paramLoads.push(`ld   r${reg}, [sp + ${memSlot}]`);
      } else {
        paramScope.set(d.name, { kind: 'slot', slot: memSlot, param: true });
      }
    });

    this.loc(fn.line);
    this.stmt(fn.body);

    const saved = [...this.usedRegs].filter((r) => r >= 2 && r <= 5).sort();
    if (this.makesCalls) saved.unshift(LR);
    const nParams = fn.params.length;
    const S = this.nSlots;
    const F = S + saved.length + nParams;
    const pro = [`f_${fn.name}:`, `.loc ${fn.line}`];
    if (F) pro.push(`        sub  sp, sp, ${F}`);
    saved.forEach((r, i) => pro.push(`        st   [sp + ${S + i}], r${r}`));
    paramLoads.forEach((l) => pro.push('        ' + l));
    const epi = [`${this.retLabel}:`];
    saved.forEach((r, i) => epi.push(`        ld   r${r}, [sp + ${S + i}]`));
    if (F) epi.push(`        add  sp, sp, ${F}`);
    epi.push('        ret');
    return [`${this.frameSym()} = ${F}`, ...pro, ...this.out, ...epi].join('\n');
  }
}

export class CodeGen {
  constructor(prog, opts = {}) {
    this.prog = prog;
    this.opts = opts;
    this.labelCounter = 0;
    this.consts = new Map();
    this.globalsByName = new Map();
    this.funcs = new Map();
    this.data = [];
    this.strings = new Map();
  }

  constValue(e, fg) {
    if (!e) return null;
    switch (e.k) {
      case 'num': return u16(e.v);
      case 'name': {
        if (fg) { for (let i = fg.scopes.length - 1; i >= 0; i--) if (fg.scopes[i].has(e.name)) return null; }
        return this.consts.has(e.name) ? this.consts.get(e.name) : null;
      }
      case 'unary': {
        if (e.op === '&') return null;
        const v = this.constValue(e.e, fg);
        if (v === null) return null;
        return e.op === '-' ? u16(-v) : e.op === '~' ? u16(~v) : v === 0 ? 1 : 0;
      }
      case 'bin': {
        const a = this.constValue(e.l, fg);
        const b = this.constValue(e.r, fg);
        if (a !== null && b !== null) return foldBinary(e.op, a, b);
        // algebraic shortcuts that keep side effects intact (operands are pure here)
        return null;
      }
    }
    return null;
  }

  stringLiteral(s) {
    if (!this.strings.has(s)) {
      const label = `str_${this.strings.size}`;
      this.strings.set(s, label);
      this.data.push(`${label}: .word ${[...s].map((ch) => ch.charCodeAt(0)).concat(0).join(', ')}`);
    }
    return this.strings.get(s);
  }

  generate() {
    const { prog } = this;
    for (const c of prog.consts) {
      const v = this.constValue(c.e);
      if (v === null) throw new CompileError(`const ${c.name} is not a constant expression`, c.line);
      if (this.consts.has(c.name)) throw new CompileError(`duplicate const ${c.name}`, c.line);
      this.consts.set(c.name, v);
    }
    for (const f of prog.funcs) {
      if (this.funcs.has(f.name)) throw new CompileError(`duplicate function ${f.name}`, f.line);
      this.funcs.set(f.name, f);
      this.globalsByName.set(f.name, { kind: 'func', label: `f_${f.name}` });
    }
    for (const g of prog.globals) {
      if (this.globalsByName.has(g.name) || this.consts.has(g.name)) throw new CompileError(`duplicate name ${g.name}`, g.line);
      const label = `g_${g.name}`;
      if (g.size === null) {
        let v = 0;
        if (g.init) {
          if (g.init.k !== 'scalar') throw new CompileError(`${g.name} is not an array`, g.line);
          v = this.constValue(g.init.e);
          if (v === null) throw new CompileError(`initialiser of ${g.name} must be constant`, g.line);
        }
        this.globalsByName.set(g.name, { kind: 'global', label });
        this.data.push(`${label}: .word ${v}`);
      } else {
        let values = [];
        if (g.init?.k === 'string') values = [...g.init.v].map((ch) => ch.charCodeAt(0)).concat(0);
        else if (g.init?.k === 'list') {
          values = g.init.items.map((e) => {
            const v = this.constValue(e);
            if (v === null) throw new CompileError(`initialiser of ${g.name} must be constant`, g.line);
            return v;
          });
        } else if (g.init) throw new CompileError(`bad initialiser for array ${g.name}`, g.line);
        let size = values.length;
        if (g.size !== 'auto') {
          size = this.constValue(g.size);
          if (size === null) throw new CompileError(`size of ${g.name} must be constant`, g.line);
          if (values.length > size) throw new CompileError(`too many initialisers for ${g.name}`, g.line);
        }
        this.globalsByName.set(g.name, { kind: 'array', label, size });
        const lines = [`${label}:`];
        for (let i = 0; i < values.length; i += 16) lines.push(`        .word ${values.slice(i, i + 16).join(', ')}`);
        if (size > values.length) lines.push(`        .zero ${size - values.length}`);
        this.data.push(lines.join('\n'));
      }
    }
    if (!this.funcs.has('main')) throw new CompileError('no main() function');
    if (this.funcs.get('main').params.length) throw new CompileError('main() takes no parameters');

    const code = [];
    code.push('; ---- generated by the Turtle compiler ----');
    code.push('_start:');
    code.push(`        li   sp, ${STACK_TOP}`);
    code.push('        call f_main');
    code.push('_halt:  halt');
    for (const f of prog.funcs) code.push('', new FuncGen(this, f).generate());
    code.push(RUNTIME);
    code.push('.data');
    code.push(...this.data);
    return code.join('\n') + '\n';
  }
}

/** Compile Turtle source to N16 assembly text. */
export function compileToAsm(source, opts) {
  return new CodeGen(parse(source), opts).generate();
}
