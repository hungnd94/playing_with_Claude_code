// backend.js — Turtle code generation with a graph-colouring register allocator.
//
// Code for each function is first generated as an IR that uses an unlimited
// supply of virtual registers. Then a Chaitin-Briggs allocator maps them onto
// the five allocatable machine registers r1..r5:
//   1. liveness analysis over the control-flow graph
//   2. an interference graph (two values that are live at the same time
//      cannot share a register)
//   3. conservative move coalescing (Briggs / George), so `x = y` usually
//      costs nothing
//   4. simplify / select colouring, biased towards move partners
//   5. spilling of the cheapest values (by loop-weighted use count) when the
//      graph cannot be coloured, then try again
// Finally the IR is printed as N16 assembly, with a little peephole cleanup.

export class CompileError extends Error {
  constructor(msg, line) {
    super(line !== undefined ? `line ${line}: ${msg}` : msg);
    this.line = line;
  }
}

export const s16 = (x) => (x << 16) >> 16;
export const u16 = (x) => x & 0xffff;

export const ALU_MNEMONIC = {
  '+': 'add', '-': 'sub', '*': 'mul', '&': 'and', '|': 'or', '^': 'xor',
  '<<': 'shl', '>>': 'sra', '>>>': 'shr',
};
const COMMUTATIVE = new Set(['+', '*', '&', '|', '^']);
const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);

const SP = 6;
const COLORS = [1, 2, 3, 4, 5];
const K = COLORS.length;
const isAlloc = (r) => typeof r === 'number' && ((r >= 1 && r <= 5) || r >= 8);
const isV = (r) => typeof r === 'number' && r >= 8;

// ------------------------------------------------------------ IR generation

export class FuncGen {
  constructor(cg, fn) {
    this.cg = cg;
    this.fn = fn;
    this.name = fn.name;
    this.code = [];
    this.nextV = 8;
    this.depth = 0;
    this.scopes = [new Map()];
    this.loops = [];
    this.makesCalls = false;
    this.retLabel = `.Lret_${fn.name}`;
    this.lastLoc = undefined;
    this.params = []; // vreg per parameter
  }

  newV() { return this.nextV++; }
  emit(ins) { ins.depth = this.depth; this.code.push(ins); return ins; }
  label(name) { this.code.push({ k: 'label', name }); }
  newLabel() { return `.L${this.cg.labelCounter++}`; }
  loc(line) {
    if (line !== undefined && line !== this.lastLoc) { this.code.push({ k: 'loc', line }); this.lastLoc = line; }
  }

  // ---------------- values: { lit: string } | { v: register }
  reg(val) {
    if (val.v !== undefined) return val.v;
    if (String(val.lit) === '0') return 0; // r0 is always zero
    const d = this.newV();
    this.emit({ k: 'li', d, lit: String(val.lit) });
    return d;
  }
  opB(val) { return val.v !== undefined ? val.v : { lit: String(val.lit) }; }
  toDest(val, dest) {
    if (dest === undefined) return val;
    if (val.v !== undefined) { if (val.v !== dest) this.emit({ k: 'mov', d: dest, a: val.v }); }
    else this.emit({ k: 'li', d: dest, lit: String(val.lit) });
    return { v: dest };
  }
  alu(op, a, b, dest) {
    const d = dest ?? this.newV();
    this.emit({ k: 'alu', op, d, a, b });
    return { v: d };
  }

  // ---------------- names
  pushScope() { this.scopes.push(new Map()); }
  popScope() { this.scopes.pop(); }
  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i].get(name);
      if (v) return v;
    }
    return this.cg.globalsByName.get(name) || null;
  }
  declare(name, line, reg = this.newV()) {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.has(name)) throw new CompileError(`'${name}' is already declared in this scope`, line);
    const v = { kind: 'local', reg };
    scope.set(name, v);
    return v;
  }
  isMem(e) { return e.k === 'name' && e.name === 'mem' && !this.lookup('mem'); }
  constValue(e) { return this.cg.constValue(e, this); }

  // ---------------- expressions
  expr(e, dest) {
    const c = this.constValue(e);
    if (c !== null) return this.toDest({ lit: String(s16(c)) }, dest);
    switch (e.k) {
      case 'str': return this.toDest({ lit: this.cg.stringLiteral(e.v) }, dest);
      case 'name': {
        const v = this.lookup(e.name);
        if (!v) throw new CompileError(`unknown name '${e.name}'`, e.line);
        if (v.kind === 'local') return this.toDest({ v: v.reg }, dest);
        if (v.kind === 'global') {
          const d = dest ?? this.newV();
          this.emit({ k: 'ld', d, base: null, off: v.label });
          return { v: d };
        }
        if (v.kind === 'array' || v.kind === 'func') return this.toDest({ lit: v.label }, dest);
        throw new CompileError(`'${e.name}' is not a value`, e.line);
      }
      case 'unary': return this.unary(e, dest);
      case 'bin': return this.binary(e, dest);
      case 'index': {
        const a = this.address(e, true);
        const d = dest ?? this.newV();
        this.emit({ k: 'ld', d, ...a });
        return { v: d };
      }
      case 'call': return this.call(e, dest, true);
    }
    throw new CompileError(`cannot evaluate ${e.k}`, e.line);
  }

  /**
   * Address of e (an index expression) as { base, off } or { base, offReg }.
   * base: register or null; off: literal text. offReg only when allowReg.
   */
  address(e, allowReg) {
    let baseLit = null, baseV = null;
    if (this.isMem(e.base)) baseLit = '0';
    else {
      const b = this.expr(e.base);
      if (b.lit !== undefined) baseLit = String(b.lit); else baseV = b.v;
    }
    // split a constant term off the index: a[i + 3] -> [ri + a + 3]
    let idx = e.index, k = 0;
    const ci = this.constValue(idx);
    if (ci !== null) { idx = null; k = s16(ci); }
    else if (idx.k === 'bin' && (idx.op === '+' || idx.op === '-')) {
      const cr = this.constValue(idx.r);
      const cl = idx.op === '+' ? this.constValue(idx.l) : null;
      if (cr !== null) { k = idx.op === '+' ? s16(cr) : s16(-cr); idx = idx.l; }
      else if (cl !== null) { k = s16(cl); idx = idx.r; }
    }
    const lit = (base) => (k ? (base === '0' ? String(k) : `${base} + ${k}`) : base);
    if (idx === null) {
      return baseV !== null ? { base: baseV, off: String(k) } : { base: null, off: lit(baseLit) };
    }
    const iv = this.reg(this.expr(idx));
    if (baseLit !== null) return { base: iv, off: lit(baseLit) };
    if (allowReg && k === 0) return { base: baseV, offReg: iv };
    const t = this.alu('add', baseV, iv).v;
    return { base: t, off: String(k) };
  }

  unary(e, dest) {
    if (e.op === '&') {
      if (e.e.k !== 'name') throw new CompileError('& needs a global name', e.line);
      const v = this.lookup(e.e.name);
      if (!v || !['global', 'array', 'func'].includes(v.kind)) throw new CompileError('& only works on globals and functions', e.line);
      return this.toDest({ lit: v.label }, dest);
    }
    if (e.op === '!') return this.boolValue(e, dest);
    const a = this.reg(this.expr(e.e));
    if (e.op === '-') return this.alu('sub', 0, a, dest);
    return this.alu('xor', a, { lit: '-1' }, dest); // ~
  }

  binary(e, dest) {
    const op = e.op;
    if (op === '&&' || op === '||' || COMPARE.has(op)) return this.boolValue(e, dest);
    if (op === '/' || op === '%') return this.divmod(e, dest);
    let l = e.l, r = e.r;
    const cr = this.constValue(r);
    if (op === '-' && cr !== null) return this.binary({ ...e, op: '+', r: { k: 'num', v: -cr, line: e.line } }, dest);
    // a & ~b -> andn
    if (op === '&' && cr === null && this.constValue(l) === null) {
      if (r.k === 'unary' && r.op === '~') return this.raw2('andn', l, r.e, dest);
      if (l.k === 'unary' && l.op === '~') return this.raw2('andn', r, l.e, dest);
    }
    if (COMMUTATIVE.has(op) && this.constValue(l) !== null) [l, r] = [r, l];
    return this.raw2(ALU_MNEMONIC[op], l, r, dest);
  }

  raw2(mnemonic, l, r, dest) {
    const a = this.reg(this.expr(l));
    const b = this.opB(this.expr(r));
    return this.alu(mnemonic, a, b, dest);
  }

  divmod(e, dest) {
    const ce = this.constValue(e.r);
    if (ce !== null && ce > 0 && ce < 0x8000 && (ce & (ce - 1)) === 0) {
      const k = Math.log2(ce);
      if (k === 0) return e.op === '/' ? this.expr(e.l, dest) : this.toDest({ lit: '0' }, dest);
      // round toward zero: add (2^k - 1) to negative numbers before shifting
      const x = this.reg(this.expr(e.l));
      const t = this.alu('sra', x, { lit: '15' }).v;
      this.alu('shr', t, { lit: String(16 - k) }, t);
      this.alu('add', t, x, t);
      if (e.op === '/') return this.alu('sra', t, { lit: String(k) }, dest);
      this.alu('and', t, { lit: String(u16(-ce)) }, t);
      return this.alu('sub', x, t, dest);
    }
    return this.callNamed(e.op === '/' ? '__div' : '__mod', [e.l, e.r], dest, true);
  }

  /** 0/1 value of a boolean expression. */
  boolValue(e, dest) {
    const op = e.op;
    if (op === '!' ) {
      const a = this.reg(this.expr(e.e));
      return this.alu('sltu', a, { lit: '1' }, dest);
    }
    if (op === '==' || op === '!=') {
      const t = this.diff(e.l, e.r);
      return op === '==' ? this.alu('sltu', t, { lit: '1' }, dest) : this.alu('sltu', 0, t, dest);
    }
    if (op === '<' || op === '>' || op === '<=' || op === '>=') {
      const { t, negate } = this.less(e);
      if (negate) return this.alu('xor', t, { lit: '1' }, dest);
      return this.toDest({ v: t }, dest);
    }
    // && ||
    const d = dest ?? this.newV();
    const lfalse = this.newLabel(), lend = this.newLabel();
    this.cond(e, lfalse, false);
    this.emit({ k: 'li', d, lit: '1' });
    this.emit({ k: 'jmp', label: lend });
    this.label(lfalse);
    this.emit({ k: 'li', d, lit: '0' });
    this.label(lend);
    return { v: d };
  }

  /** register holding l - r (zero iff equal) */
  diff(l, r) {
    if (this.constValue(l) !== null) [l, r] = [r, l];
    const a = this.reg(this.expr(l));
    const b = this.opB(this.expr(r));
    return this.alu('sub', a, b).v;
  }

  /** for < <= > >=: t = slt(x, y), expression truth = negate ? !t : t */
  less(e) {
    let x, y, negate;
    switch (e.op) {
      case '<': x = e.l; y = e.r; negate = false; break;
      case '>=': x = e.l; y = e.r; negate = true; break;
      case '>': x = e.r; y = e.l; negate = false; break;
      case '<=': x = e.r; y = e.l; negate = true; break;
    }
    const cx = this.constValue(x);
    if (cx !== null && this.constValue(y) === null && s16(cx) < 32767) {
      // k < y  ==  !(y < k + 1)
      x = y; y = { k: 'num', v: s16(cx) + 1 }; negate = !negate;
    }
    const a = this.reg(this.expr(x));
    const b = this.opB(this.expr(y));
    return { t: this.alu('slt', a, b).v, negate };
  }

  /** Jump to label when the truth of e equals `when`. */
  cond(e, label, when) {
    const c = this.constValue(e);
    if (c !== null) { if ((c !== 0) === when) this.emit({ k: 'jmp', label }); return; }
    if (e.k === 'unary' && e.op === '!') return this.cond(e.e, label, !when);
    if (e.k === 'bin') {
      const op = e.op;
      if (op === '&&' || op === '||') {
        if (when === (op === '||')) {
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
        const ifZero = (op === '==') === when;
        const cr = this.constValue(e.r), cl = this.constValue(e.l);
        const other = cr === 0 ? e.l : cl === 0 ? e.r : null;
        const t = other ? this.reg(this.expr(other)) : this.diff(e.l, e.r);
        this.emit({ k: 'jcc', op: ifZero ? 'jz' : 'jnz', a: t, label });
        return;
      }
      if (op === '<' || op === '>' || op === '<=' || op === '>=') {
        if (this.constValue(e.r) === 0) {
          const t = this.reg(this.expr(e.l));
          const jop = when ? { '<': 'jlt', '>=': 'jge', '>': 'jgt', '<=': 'jle' }[op]
            : { '<': 'jge', '>=': 'jlt', '>': 'jle', '<=': 'jgt' }[op];
          this.emit({ k: 'jcc', op: jop, a: t, label });
          return;
        }
        const { t, negate } = this.less(e);
        this.emit({ k: 'jcc', op: when !== negate ? 'jnz' : 'jz', a: t, label });
        return;
      }
    }
    const t = this.reg(this.expr(e));
    this.emit({ k: 'jcc', op: when ? 'jnz' : 'jz', a: t, label });
  }

  // ---------------- calls
  call(e, dest, wantValue) {
    if (e.name === 'mulh' && !this.lookup('mulh')) {
      if (e.args.length !== 2) throw new CompileError('mulh takes 2 arguments', e.line);
      return this.raw2('mulh', e.args[0], e.args[1], dest);
    }
    if (e.name === 'halt' && !this.lookup('halt')) { this.emit({ k: 'raw', text: 'halt', uses: [], defs: [] }); return { lit: '0' }; }
    const f = this.cg.funcs.get(e.name);
    if (!f) throw new CompileError(`unknown function '${e.name}'`, e.line);
    if (f.params.length !== e.args.length) {
      throw new CompileError(`${e.name} expects ${f.params.length} argument(s), got ${e.args.length}`, e.line);
    }
    return this.callNamed(`f_${e.name}`, e.args, dest, wantValue);
  }

  callNamed(label, args, dest, wantValue) {
    this.makesCalls = true;
    const vals = args.map((a) => this.expr(a));
    if (label.startsWith('__')) {
      // runtime helpers: arguments in r1, r2; they clobber r1 and r2 only
      vals.forEach((v, i) => this.toDest(v, i + 1));
      this.emit({ k: 'call', label, uses: [1, 2], defs: [1, 2] });
    } else {
      // arguments are stored just below sp; the callee's frame covers them
      const n = vals.length;
      vals.forEach((v, i) => this.emit({ k: 'st', base: SP, off: String(i - n), src: this.reg(v) }));
      this.emit({ k: 'call', label, uses: [], defs: [1] });
    }
    if (!wantValue) return null;
    const d = dest ?? this.newV();
    this.emit({ k: 'mov', d, a: 1 });
    return { v: d };
  }

  // ---------------- statements
  assign(target, value, line) {
    if (target.k === 'name') {
      const v = this.lookup(target.name);
      if (!v) throw new CompileError(`unknown name '${target.name}'`, line);
      if (v.kind === 'local') { this.expr(value, v.reg); return; }
      if (v.kind === 'global') { this.emit({ k: 'st', base: null, off: v.label, src: this.reg(this.expr(value)) }); return; }
      throw new CompileError(`cannot assign to '${target.name}'`, line);
    }
    if (target.k === 'index') {
      const src = this.reg(this.expr(value));
      const a = this.address(target, false);
      this.emit({ k: 'st', base: a.base, off: a.off, src });
      return;
    }
    throw new CompileError('invalid assignment target', line);
  }

  loopBody(fn) { this.depth++; try { fn(); } finally { this.depth--; } }

  stmt(s) {
    if (s.line !== undefined && s.k !== 'block') this.loc(s.line);
    switch (s.k) {
      case 'block':
        this.pushScope();
        for (const x of s.body) this.stmt(x);
        this.popScope();
        return;
      case 'var': {
        // evaluate before declaring: `var x = x + 1` refers to the outer x
        const reg = this.newV();
        if (s.init) this.expr(s.init, reg); else this.emit({ k: 'li', d: reg, lit: '0' });
        this.declare(s.name, s.line, reg);
        return;
      }
      case 'assign': {
        const value = s.op === '=' ? s.value : { k: 'bin', op: s.op.slice(0, -1), l: s.target, r: s.value, line: s.line };
        this.assign(s.target, value, s.line);
        return;
      }
      case 'expr': this.call(s.e, undefined, false); return;
      case 'if': {
        const lelse = this.newLabel();
        this.cond(s.cond, lelse, false);
        this.stmt(s.then);
        if (s.els) {
          const lend = this.newLabel();
          this.emit({ k: 'jmp', label: lend });
          this.label(lelse);
          this.stmt(s.els);
          this.label(lend);
        } else this.label(lelse);
        return;
      }
      case 'while': case 'dowhile': {
        const lbody = this.newLabel(), lcond = this.newLabel(), lend = this.newLabel();
        const always = this.constValue(s.cond);
        if (s.k === 'while') {
          if (always === 0) return;
          if (always === null) this.emit({ k: 'jmp', label: lcond });
        }
        this.loopBody(() => {
          this.label(lbody);
          this.loops.push({ brk: lend, cont: lcond });
          this.stmt(s.body);
          this.loops.pop();
          this.label(lcond);
          this.loc(s.line);
          this.cond(s.cond, lbody, true);
        });
        this.label(lend);
        return;
      }
      case 'for': {
        this.pushScope();
        if (s.init) this.stmt(s.init);
        const lbody = this.newLabel(), lcont = this.newLabel(), lcond = this.newLabel(), lend = this.newLabel();
        if (s.cond) this.emit({ k: 'jmp', label: lcond });
        this.loopBody(() => {
          this.label(lbody);
          this.loops.push({ brk: lend, cont: lcont });
          this.stmt(s.body);
          this.loops.pop();
          this.label(lcont);
          if (s.step) this.stmt(s.step);
          this.label(lcond);
          this.loc(s.line);
          if (s.cond) this.cond(s.cond, lbody, true);
          else this.emit({ k: 'jmp', label: lbody });
        });
        this.label(lend);
        this.popScope();
        return;
      }
      case 'return': {
        if (s.e) this.toDest(this.expr(s.e), 1);
        else if (this.returnsValue) this.emit({ k: 'li', d: 1, lit: '0' });
        this.emit({ k: 'jmp', label: this.retLabel });
        return;
      }
      case 'break': case 'continue': {
        const loop = this.loops[this.loops.length - 1];
        if (!loop) throw new CompileError(`${s.k} outside a loop`, s.line);
        this.emit({ k: 'jmp', label: s.k === 'break' ? loop.brk : loop.cont });
        return;
      }
      case 'asm':
        for (const line of s.lines) {
          const regs = new Set();
          const text = line.replace(/\{(\w+)\}/g, (m, name) => {
            const v = this.lookup(name);
            if (!v) throw new CompileError(`asm: unknown name '${name}'`, s.line);
            if (v.kind === 'local') { regs.add(v.reg); return `{${v.reg}}`; }
            if (v.label) return v.label;
            throw new CompileError(`asm: cannot reference '${name}'`, s.line);
          });
          for (const m of text.matchAll(/\br([1-5])\b/g)) regs.add(Number(m[1]));
          if (/\b(call|jal)\b/.test(text)) this.makesCalls = true;
          this.emit({ k: 'raw', text, uses: [...regs], defs: [...regs] });
        }
        return;
    }
    throw new CompileError(`unknown statement ${s.k}`, s.line);
  }

  generate() {
    const fn = this.fn;
    const seen = new Set();
    this.loc(fn.line);
    fn.params.forEach((p, i) => {
      if (seen.has(p)) throw new CompileError(`duplicate parameter '${p}'`, fn.line);
      seen.add(p);
      const v = this.declare(p, fn.line);
      this.params.push(v.reg);
      this.emit({ k: 'ld', d: v.reg, base: SP, off: { param: i }, paramLoad: i });
    });
    this.returnsValue = containsValueReturn(fn.body);
    this.stmt(fn.body);
    if (this.returnsValue) this.emit({ k: 'li', d: 1, lit: '0' }); // falling off the end returns 0
    this.code.push({ k: 'label', name: this.retLabel });
    this.code.push({ k: 'ret', uses: this.returnsValue ? [1] : [] });
    return allocate(this);
  }
}

function containsValueReturn(s) {
  if (!s) return false;
  switch (s.k) {
    case 'return': return !!s.e;
    case 'block': return s.body.some(containsValueReturn);
    case 'if': return containsValueReturn(s.then) || containsValueReturn(s.els);
    case 'while': case 'dowhile': case 'for': return containsValueReturn(s.body);
  }
  return false;
}

// ------------------------------------------------------------ register allocation

function regFields(ins) {
  switch (ins.k) {
    case 'alu': return { uses: typeof ins.b === 'number' ? [ins.a, ins.b] : [ins.a], defs: [ins.d] };
    case 'li': return { uses: [], defs: [ins.d] };
    case 'mov': return { uses: [ins.a], defs: [ins.d] };
    case 'ld': return { uses: [ins.base, ins.offReg].filter((r) => typeof r === 'number'), defs: [ins.d] };
    case 'st': return { uses: [ins.base, ins.src].filter((r) => typeof r === 'number'), defs: [] };
    case 'jcc': return { uses: [ins.a], defs: [] };
    case 'call': case 'raw': return { uses: ins.uses, defs: ins.defs };
    case 'ret': return { uses: ins.uses, defs: [] };
  }
  return { uses: [], defs: [] };
}

/** Rename registers inside an instruction (uses and/or defs). */
function renameIns(ins, fUse, fDef) {
  const u = (r) => (typeof r === 'number' ? fUse(r) : r);
  switch (ins.k) {
    case 'alu': ins.a = u(ins.a); if (typeof ins.b === 'number') ins.b = u(ins.b); ins.d = fDef(ins.d); break;
    case 'li': ins.d = fDef(ins.d); break;
    case 'mov': ins.a = u(ins.a); ins.d = fDef(ins.d); break;
    case 'ld': ins.base = u(ins.base); ins.offReg = u(ins.offReg); ins.d = fDef(ins.d); break;
    case 'st': ins.base = u(ins.base); ins.src = u(ins.src); break;
    case 'jcc': ins.a = u(ins.a); break;
    case 'raw': {
      const map = new Map();
      ins.uses = ins.uses.map((r) => { const n = u(r); map.set(r, n); return n; });
      ins.defs = ins.defs.map((r) => { const n = map.get(r) ?? fDef(r); return n; });
      ins.text = ins.text.replace(/\{(\d+)\}/g, (m, r) => `{${map.get(Number(r)) ?? r}}`);
      break;
    }
  }
}

function liveness(code) {
  const n = code.length;
  const labelAt = new Map();
  code.forEach((ins, i) => { if (ins.k === 'label') labelAt.set(ins.name, i); });
  const succ = code.map((ins, i) => {
    if (ins.k === 'jmp') return [labelAt.get(ins.label)];
    if (ins.k === 'jcc') return [labelAt.get(ins.label), i + 1];
    if (ins.k === 'ret') return [];
    return i + 1 < n ? [i + 1] : [];
  });
  const ud = code.map((ins) => {
    const f = regFields(ins);
    return { uses: f.uses.filter(isAlloc), defs: f.defs.filter(isAlloc) };
  });
  const liveIn = code.map(() => new Set());
  const liveOut = code.map(() => new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = n - 1; i >= 0; i--) {
      const out = liveOut[i];
      for (const s of succ[i]) for (const r of liveIn[s]) if (!out.has(r)) { out.add(r); changed = true; }
      const inn = liveIn[i];
      for (const r of ud[i].uses) if (!inn.has(r)) { inn.add(r); changed = true; }
      const defs = ud[i].defs;
      for (const r of out) if (!defs.includes(r) && !inn.has(r)) { inn.add(r); changed = true; }
    }
  }
  return { liveOut, ud };
}

function allocate(fg) {
  let code = fg.code;
  const spillSlot = new Map(); // vreg -> slot descriptor
  let nSlots = 0;
  const noSpill = new Set();

  for (let round = 0; ; round++) {
    if (round > 50) throw new CompileError(`register allocation did not converge in ${fg.name}`);
    const { liveOut, ud } = liveness(code);

    // ---- interference graph
    const adj = new Map();
    const node = (r) => { if (!adj.has(r)) adj.set(r, new Set()); return adj.get(r); };
    COLORS.forEach(node);
    const edge = (a, b) => { if (a !== b) { node(a).add(b); node(b).add(a); } };
    const cost = new Map();
    const moves = [];
    code.forEach((ins, i) => {
      const w = 8 ** Math.min(ins.depth || 0, 6);
      for (const r of [...ud[i].uses, ...ud[i].defs]) { node(r); if (isV(r)) cost.set(r, (cost.get(r) || 0) + w); }
      for (const d of ud[i].defs) {
        for (const l of liveOut[i]) {
          if (ins.k === 'mov' && l === ins.a) continue;
          edge(d, l);
        }
      }
      if (ins.k === 'mov' && isAlloc(ins.d) && isAlloc(ins.a) && ins.d !== ins.a) moves.push(ins);
    });

    // ---- conservative coalescing
    const alias = new Map();
    const find = (r) => { while (alias.has(r)) r = alias.get(r); return r; };
    const deg = (r) => (r <= 5 ? Infinity : adj.get(r).size);
    const merge = (keep, gone) => {
      alias.set(gone, keep);
      for (const t of adj.get(gone)) { adj.get(t).delete(gone); edge(keep, t); }
      adj.delete(gone);
      if (isV(keep)) cost.set(keep, (cost.get(keep) || 0) + (cost.get(gone) || 0));
      if (noSpill.has(gone)) noSpill.add(keep);
    };
    let again = true;
    while (again) {
      again = false;
      for (const m of moves) {
        let a = find(m.d), b = find(m.a);
        if (a === b) continue;
        if (b <= 5) [a, b] = [b, a]; // keep a precoloured register as `a`
        if (b <= 5) continue; // two different machine registers
        if (adj.get(a).has(b)) continue;
        let ok;
        if (a <= 5) {
          // George: every neighbour of b already interferes with a, or is insignificant
          ok = [...adj.get(b)].every((t) => t <= 5 || deg(t) < K || adj.get(t).has(a));
        } else {
          // Briggs: the merged node has fewer than K significant neighbours
          const nb = new Set([...adj.get(a), ...adj.get(b)]);
          let significant = 0;
          for (const t of nb) if (deg(t) >= K) significant++;
          ok = significant < K;
        }
        if (ok) { merge(a, b); again = true; }
      }
    }

    // ---- simplify / select
    const vnodes = [...adj.keys()].filter(isV);
    const curDeg = new Map(vnodes.map((v) => [v, adj.get(v).size]));
    const removed = new Set();
    const stack = [];
    const remaining = new Set(vnodes);
    while (remaining.size) {
      let pick = null;
      for (const v of remaining) if (curDeg.get(v) < K) { pick = v; break; }
      if (pick === null) {
        let best = Infinity;
        for (const v of remaining) {
          const c = noSpill.has(v) ? Infinity : (cost.get(v) || 0) / (curDeg.get(v) + 1);
          if (pick === null || c < best) { best = c; pick = v; }
        }
      }
      remaining.delete(pick);
      removed.add(pick);
      stack.push(pick);
      for (const t of adj.get(pick)) if (isV(t) && !removed.has(t)) curDeg.set(t, curDeg.get(t) - 1);
    }
    const color = new Map(COLORS.map((c) => [c, c]));
    const partners = new Map();
    for (const m of moves) {
      const a = find(m.d), b = find(m.a);
      if (a === b) continue;
      if (!partners.has(a)) partners.set(a, []);
      if (!partners.has(b)) partners.set(b, []);
      partners.get(a).push(b);
      partners.get(b).push(a);
    }
    const spilled = [];
    while (stack.length) {
      const v = stack.pop();
      const used = new Set();
      for (const t of adj.get(v)) if (color.has(t)) used.add(color.get(t));
      let c;
      for (const p of partners.get(v) || []) { const pc = color.get(p); if (pc !== undefined && !used.has(pc)) { c = pc; break; } }
      if (c === undefined) c = COLORS.find((x) => !used.has(x));
      if (c === undefined) spilled.push(v); else color.set(v, c);
    }

    if (!spilled.length) {
      const regOf = (r) => (typeof r !== 'number' ? r : r >= 8 ? color.get(find(r)) : r);
      for (const ins of code) renameIns(ins, regOf, regOf);
      return emitFunction(fg, code, nSlots, spillSlot);
    }

    // ---- spill: give each spilled value a frame slot (a parameter keeps its own)
    const spillSet = new Set();
    for (const s of spilled) {
      // every original vreg coalesced into s is spilled together
      for (const r of [...cost.keys(), ...alias.keys()]) if (isV(r) && find(r) === s) spillSet.add(r);
      spillSet.add(s);
    }
    const slotOf = new Map();
    for (const r of spillSet) {
      const pi = fg.params.indexOf(r);
      slotOf.set(r, pi >= 0 ? { param: pi } : { slot: nSlots++ });
      spillSlot.set(r, slotOf.get(r));
    }
    const out = [];
    for (const ins of code) {
      if (ins.k === 'ld' && ins.paramLoad !== undefined && spillSet.has(ins.d)) continue; // already home
      const f = regFields(ins);
      const touches = [...f.uses, ...f.defs].some((r) => spillSet.has(r));
      if (!touches) { out.push(ins); continue; }
      // mov to/from a spilled value becomes a single load / store
      if (ins.k === 'mov' && spillSet.has(ins.a) && !spillSet.has(ins.d)) {
        out.push({ k: 'ld', d: ins.d, base: SP, off: slotOf.get(ins.a), depth: ins.depth }); continue;
      }
      if (ins.k === 'mov' && spillSet.has(ins.d) && !spillSet.has(ins.a)) {
        out.push({ k: 'st', base: SP, off: slotOf.get(ins.d), src: ins.a, depth: ins.depth }); continue;
      }
      const temp = new Map();
      const tmp = (r) => {
        if (!temp.has(r)) { const t = fg.newV(); noSpill.add(t); temp.set(r, t); }
        return temp.get(r);
      };
      const loads = [];
      const stores = [];
      renameIns(ins,
        (r) => {
          if (!spillSet.has(r)) return r;
          const t = tmp(r);
          if (!loads.some((l) => l.d === t)) loads.push({ k: 'ld', d: t, base: SP, off: slotOf.get(r), depth: ins.depth });
          return t;
        },
        (r) => {
          if (!spillSet.has(r)) return r;
          const t = tmp(r);
          stores.push({ k: 'st', base: SP, off: slotOf.get(r), src: t, depth: ins.depth });
          return t;
        });
      out.push(...loads, ins, ...stores);
    }
    code = out;
  }
}

// ------------------------------------------------------------ printing

function emitFunction(fg, code, nSlots, spillSlot) {
  const used = new Set();
  for (const ins of code) {
    const f = regFields(ins);
    for (const r of f.defs) if (r >= 2 && r <= 5) used.add(r);
  }
  const saved = [...used].sort();
  if (fg.makesCalls) saved.unshift(7);
  const nParams = fg.fn.params.length;
  const F = nSlots + saved.length + nParams;
  const slotText = (off) => {
    if (typeof off === 'string') return off;
    if (off.param !== undefined) return String(F - nParams + off.param);
    return String(off.slot);
  };
  const r = (n) => (n === SP ? 'sp' : `r${n}`);
  const mem = (base, off, offReg) => {
    if (base === null || base === undefined) return `[${slotText(off)}]`;
    if (offReg !== undefined && offReg !== null) return `[${r(base)} + ${r(offReg)}]`;
    const o = slotText(off);
    if (o === '0') return `[${r(base)}]`;
    return o.startsWith('-') ? `[${r(base)} - ${o.slice(1)}]` : `[${r(base)} + ${o}]`;
  };
  const lines = [];
  const pad = (s) => s.padEnd(4);
  for (const ins of code) {
    switch (ins.k) {
      case 'label': lines.push(`${ins.name}:`); break;
      case 'loc': lines.push(`.loc ${ins.line}`); break;
      case 'alu': lines.push(`        ${pad(ins.op)} ${r(ins.d)}, ${r(ins.a)}, ${typeof ins.b === 'number' ? r(ins.b) : ins.b.lit}`); break;
      case 'li': lines.push(`        li   ${r(ins.d)}, ${ins.lit}`); break;
      case 'mov': if (ins.d !== ins.a) lines.push(`        mov  ${r(ins.d)}, ${r(ins.a)}`); break;
      case 'ld': lines.push(`        ld   ${r(ins.d)}, ${mem(ins.base, ins.off, ins.offReg)}`); break;
      case 'st': lines.push(`        st   ${mem(ins.base, ins.off)}, ${r(ins.src)}`); break;
      case 'jcc': lines.push(`        ${pad(ins.op)} ${r(ins.a)}, ${ins.label}`); break;
      case 'jmp': lines.push(`        jmp  ${ins.label}`); break;
      case 'call': lines.push(`        call ${ins.label}`); break;
      case 'raw': lines.push('        ' + ins.text.replace(/\{(\d+)\}/g, (m, n) => r(Number(n)))); break;
      case 'ret': break;
    }
  }
  let body = peephole(lines);
  // drop stores to spill slots that are never loaded back
  const slotOfLine = (l) => { const m = /\[sp(?: \+ (\d+))?\]/.exec(l); return m ? Number(m[1] || 0) : -1; };
  const loaded = new Set(body.filter((l) => /^\s+ld\s/.test(l)).map(slotOfLine));
  body = body.filter((l) => {
    if (!/^\s+st\s+\[sp/.test(l) || /\[sp - /.test(l)) return true;
    const slot = slotOfLine(l);
    return slot >= nSlots || loaded.has(slot);
  });
  const pro = [`f_${fg.name}:`];
  if (F) pro.push(`        sub  sp, sp, ${F}`);
  saved.forEach((reg, i) => pro.push(`        st   [sp + ${nSlots + i}], r${reg}`));
  const epi = [];
  saved.forEach((reg, i) => epi.push(`        ld   r${reg}, [sp + ${nSlots + i}]`));
  if (F) epi.push(`        add  sp, sp, ${F}`);
  epi.push('        ret');
  void spillSlot;
  return [...pro, ...body, ...epi].join('\n');
}

function peephole(lines) {
  let out = lines;
  for (let pass = 0; pass < 3; pass++) {
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const l = out[i];
      // jmp to the label that immediately follows (skipping .loc lines)
      const jm = /^\s+jmp\s+(\S+)$/.exec(l);
      if (jm) {
        let j = i + 1;
        while (j < out.length && out[j].startsWith('.loc')) j++;
        if (j < out.length && out[j] === `${jm[1]}:`) continue;
      }
      // store followed by a load of the same slot (only .loc lines between)
      const sm = /^\s+st\s+(\[sp[^\]]*\]), (r\d)$/.exec(l);
      if (sm) {
        let j = i + 1;
        while (j < out.length && out[j].startsWith('.loc')) j++;
        const lm = j < out.length ? /^\s+ld\s+(r\d), (\[sp[^\]]*\])$/.exec(out[j]) : null;
        if (lm && sm[1] === lm[2]) {
          next.push(l, ...out.slice(i + 1, j));
          if (lm[1] !== sm[2]) next.push(`        mov  ${lm[1]}, ${sm[2]}`);
          i = j;
          continue;
        }
      }
      next.push(l);
    }
    out = next;
  }
  return out;
}
