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

import { FuncGen, CompileError, s16, u16 } from './backend.js';

export { CompileError };

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
