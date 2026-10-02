// app.js — the page: boots the computer from gates and shows every layer.

import { buildCPU } from '../src/cpu.js';
import { optimize } from '../src/netlist.js';
import { buildWasm, WasmMachine, planBlocks, DEFAULT_BLOCKS } from '../src/wasm.js';
import { Interpreter, FastMachine } from '../src/sim.js';
import { build } from '../src/toolchain.js';
import { loadImage } from '../src/asm.js';
import { disassemble, decode, Emulator, IO_FRAME, IO_KEYS, IO_RANDOM, IO_MODE, IO_SOUND } from '../src/isa.js';
import { render } from '../src/display.js';
import { K_NAND, K_DFF, K_MEM } from '../src/hdl.js';
import { PROGRAMS } from './programs.js';
import { innerNetlist, innerSource } from '../src/selfsim.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const hex4 = (x) => x.toString(16).toUpperCase().padStart(4, '0');
const s16 = (x) => (x << 16) >> 16;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROGRAM_ORDER = [
  ['tetris.tt', 'Tetris'],
  ['life.tt', 'Life'],
  ['mandel.tt', 'Mandelbrot'],
  ['itself.tt', 'Itself'],
  ['hello.tt', 'Hello'],
];
const MONO = [0x120b04, 0xffb547];
const BLURBS = {
  'tetris.tt': 'The computer plays until you press <b>Enter</b>. Its AI tries every drop and scores the board by height, holes and bumpiness, all computed from bit masks.',
  'life.tt': 'Conway\'s Life, 16 cells per instruction with bit-sliced adders. Life is Turing-complete: glider streams can be arranged into NAND gates. So these are <b>NAND gates simulating a universe that can build NAND gates</b>.',
  'mandel.tt': 'The Mandelbrot set in 4.12 fixed point, one hardware multiply per square, then palette cycling and zooms. A frame takes a few million clock cycles.',
  'itself.tt': 'A gate-level simulator written in Turtle, running a smaller copy of this processor: 2,140 NAND gates, no multiplier. Its wires live in video memory, so <b>the screen is the inner processor</b>, one dash per wire, at about 40 inner clock cycles a second.',
  'hello.tt': 'The first program that ran on this processor: text, the sixteen colours, and signed numbers in decimal.',
};

// ------------------------------------------------------------------ state
const S = window.__atwd = {
  nl: null, machine: null, interp: null, circuit: null,
  programs: {}, current: 'tetris.tt', edited: {},
  running: true, hz: 0, cycAcc: 0, frameAcc: 0, last: 0,
  keys: 0, padKeys: 0,
  heat: null, prev: null, consumers: null,
  profile: null, rateCycles: 0, rateTime: 0, clockRate: 0, toggleRate: 0, togglesPerCycle: 0,
  lastPanels: 0, followUntil: 0, asmFollowUntil: 0,
  prevRegs: new Uint16Array(8),
};

// ------------------------------------------------------------------ boot
const bootlog = $('bootlog');
function log(text, ms) {
  const line = document.createElement('div');
  line.innerHTML = esc(text) + (ms !== undefined ? ` <span class="t">${ms.toFixed(0)} ms</span>` : '');
  bootlog.appendChild(line);
}
const timed = (fn) => { const t = performance.now(); const r = fn(); return [r, performance.now() - t]; };

async function boot() {
  const t0 = performance.now();
  log('N16 ALL-THE-WAY-DOWN COMPUTER');
  log('');
  await sleep(150);
  const [circuit, t1] = timed(() => buildCPU());
  const st = circuit.stats();
  log(`wiring ${fmt(st.nands)} NAND gates + ${st.dffs} flip-flops`, t1);
  await sleep(60);
  const [nl, t2] = timed(() => optimize(circuit));
  log(`logic optimisation: ${fmt(nl.gateCount())} gates remain`, t2);
  await sleep(60);
  const t3s = performance.now();
  const bytes = buildWasm(nl);
  let machine;
  try {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    machine = new WasmMachine(nl, instance);
    log(`netlist -> ${(bytes.length / 1024).toFixed(0)} KB of WebAssembly`, performance.now() - t3s);
  } catch (e) {
    machine = new FastMachine(nl, planBlocks, DEFAULT_BLOCKS);
    log('WebAssembly is blocked here: using the JavaScript gate evaluator (slower)', performance.now() - t3s);
  }
  await sleep(60);
  const [inner, ti] = timed(() => innerNetlist());
  S.innerSource = innerSource(inner);
  log(`inner processor for itself.tt: ${fmt(inner.gateCount())} gates`, ti);
  await sleep(40);
  for (const [file] of PROGRAM_ORDER) {
    const [p, tc] = timed(() => buildProgram(file, PROGRAMS[file]));
    S.programs[file] = p;
    log(`turtle compiler: ${file} -> ${fmt(p.image.romSize)} words`, tc);
    await sleep(40);
  }
  S.circuit = circuit;
  S.nl = nl;
  S.bytes = bytes;
  S.machine = machine;
  S.interp = new Interpreter(nl, S.machine.mems);
  S.heat = new Float32Array(nl.size);
  S.prev = new Uint8Array(nl.size);
  S.consumers = consumersOf(nl);
  const total = performance.now() - t0;
  log('');
  log('power on.');
  $('lede-gates').textContent = fmt(nl.gateCount());
  $('die-count').textContent = `${fmt(nl.gateCount())} NAND · ${nl.dffs.length} flip-flops`;
  $('boot-total').textContent = `${total.toFixed(0)} ms, just now`;
  fillStack(st, nl, bytes.length);
  die = new Die(nl, $('die'), $('die-ink'), $('die-tip'));
  buildLegend();
  buildTabs();
  loadProgram(S.current);
  startVerifier();
  await sleep(700);
  bootlog.classList.add('gone');
  S.last = performance.now();
  requestAnimationFrame(tick);
}

function consumersOf(nl) {
  const c = Array.from({ length: nl.size }, () => []);
  for (let n = 2; n < nl.size; n++) {
    if (nl.kind[n] === K_NAND) { c[nl.in0[n]].push(n); if (nl.in1[n] !== nl.in0[n]) c[nl.in1[n]].push(n); }
  }
  nl.readPorts.forEach((p) => p.addr.forEach((a) => c[a].push(-1)));
  nl.dffs.forEach((f) => c[f.d].push(-2));
  nl.writePorts.forEach((p) => [...p.addr, ...p.data, p.we].forEach((a) => c[a].push(-3)));
  return c;
}

// ------------------------------------------------------------------ programs
function buildProgram(file, text) {
  const libs = [{ name: 'lib.tt', text: PROGRAMS['lib.tt'] }];
  if (file === 'itself.tt') libs.push({ name: 'netlist.tt', text: S.innerSource });
  return build(text, { libs, name: file });
}

function buildTabs() {
  const box = $('progs');
  box.innerHTML = '';
  for (const [file, label] of PROGRAM_ORDER) {
    const b = document.createElement('button');
    b.textContent = label;
    b.setAttribute('role', 'tab');
    b.dataset.file = file;
    b.addEventListener('click', () => loadProgram(file));
    box.appendChild(b);
  }
}

function loadProgram(file) {
  S.current = file;
  const p = S.programs[file];
  const m = S.machine;
  loadImage(p.image, m.mems.rom, m.mems.ram);
  m.reset();
  S.heat.fill(0);
  S.profile = new Float32Array(Math.max(p.image.romSize, 1));
  S.prevRegs.fill(0);
  for (const b of $('progs').children) b.setAttribute('aria-selected', String(b.dataset.file === file));
  $('pad').classList.toggle('on', file === 'tetris.tt');
  $('blurb').innerHTML = S.edited[file] ? 'Your edited version of this program, compiled in this page.' : BLURBS[file] || '';
  $('prog-file').textContent = file + (S.edited[file] ? ' (edited)' : '');
  $('asm-size').textContent = `${fmt(p.image.romSize)} words of ROM`;
  setEditing(false);
  renderSource();
  renderAsm();
  sampleOnce();
  drawAll(true);
}

// ------------------------------------------------------------------ run loop
const BUDGET_MS = 9;
let chunk = 1500;

function tick(now) {
  const dt = Math.min(100, now - S.last);
  S.last = now;
  const ram = S.machine.mems.ram;
  if (S.running) {
    S.frameAcc += dt;
    while (S.frameAcc >= 1000 / 60) { ram[IO_FRAME] = (ram[IO_FRAME] + 1) & 0xffff; S.frameAcc -= 1000 / 60; }
  }
  ram[IO_KEYS] = S.keys | S.padKeys;
  ram[IO_RANDOM] = (Math.random() * 65536) | 0;

  if (S.running) {
    if (S.hz === 0) {
      const t0 = performance.now();
      let n = 0;
      while (performance.now() - t0 < BUDGET_MS) {
        const c = chunk + ((Math.random() * chunk) | 0); // jitter: unbiased PC samples
        S.machine.run(c);
        n += c;
        profileSample();
      }
      const spent = performance.now() - t0;
      chunk = Math.max(300, Math.min(20000, Math.round((n / spent) * 0.6)));
      n += sample(12);
      rate(n, dt);
    } else {
      S.cycAcc += (S.hz * dt) / 1000;
      let n = Math.floor(S.cycAcc);
      S.cycAcc -= n;
      let done = 0;
      if (n > 40) { S.machine.run(n - 24); done += n - 24; n = 24; profileSample(); }
      if (n > 0) done += sample(n);
      else decayHeat(0.9);
      rate(done, dt);
    }
  }
  drawAll(false);
  requestAnimationFrame(tick);
}

function rate(cycles, dt) {
  S.rateCycles += cycles;
  S.rateTime += dt;
  if (S.rateTime >= 500) {
    S.clockRate = (S.rateCycles * 1000) / S.rateTime;
    S.rateCycles = 0;
    S.rateTime = 0;
  }
}

/**
 * Run k cycles on the gate interpreter instead of the wasm machine, so that
 * every gate's value is visible. Records which gates switched.
 */
function sample(k) {
  const { machine, interp, nl, heat, prev } = S;
  const st = machine.state, is = interp.state;
  for (let i = 0; i < st.length; i++) is[i] = st[i];
  decayHeat(0.8);
  let toggles = 0;
  const v = interp.v;
  for (let c = 0; c < k; c++) {
    if (c > 0 || k === 1) profileSample(is);
    interp.clock();
    for (let n = 2; n < nl.size; n++) {
      if (v[n] !== prev[n]) {
        prev[n] = v[n];
        heat[n] = 1;
        if (c > 0) toggles++;
      }
    }
  }
  for (let i = 0; i < st.length; i++) st[i] = is[i];
  machine.cycles += k;
  if (k > 1) {
    const tpc = toggles / (k - 1);
    S.togglesPerCycle = S.togglesPerCycle ? S.togglesPerCycle * 0.9 + tpc * 0.1 : tpc;
  }
  interp.evaluate(); // show the values for the cycle about to run
  return k;
}

function sampleOnce() {
  const { machine, interp } = S;
  for (let i = 0; i < machine.state.length; i++) interp.state[i] = machine.state[i];
  interp.evaluate();
  S.prev.set(interp.v);
}

function decayHeat(f) {
  const h = S.heat;
  for (let i = 0; i < h.length; i++) h[i] *= f;
}

function pcOf(state) {
  const bus = S.nl.probes.get('pc');
  let x = 0;
  for (let i = 0; i < 16; i++) x |= (state[S.nl.in0[bus[i]]] & 1) << i;
  return x;
}

function profileSample(state) {
  const pc = pcOf(state || S.machine.state);
  if (pc < S.profile.length) S.profile[pc] += 1;
}

// ------------------------------------------------------------------ drawing
const screen = $('screen');
const sctx = screen.getContext('2d');
let screenImg = null;

function drawScreen() {
  const ram = S.machine.mems.ram;
  const color = ram[IO_MODE] & 1;
  const w = color ? 128 : 256, h = color ? 96 : 192;
  if (screen.width !== w) { screen.width = w; screen.height = h; screenImg = null; }
  if (!screenImg) screenImg = sctx.createImageData(w, h);
  render(ram, screenImg.data, MONO);
  sctx.putImageData(screenImg, 0, 0);
  $('mode-label').textContent = color ? '128 × 96 · 16 colours' : '256 × 192 · mono';
}

function drawAll(force) {
  drawScreen();
  updateSound();
  verifyStep(1.5);
  die.draw(S.interp.v, S.heat);
  const now = performance.now();
  const slow = S.hz !== 0 && S.hz <= 100;
  if (force || slow || !S.running || now - S.lastPanels > 110) {
    S.lastPanels = now;
    updateStats();
    updateSource();
    updateAsm();
    updateCPU();
    for (let i = 0; i < S.profile.length; i++) S.profile[i] *= 0.97;
  }
}

function updateStats() {
  const r = S.clockRate;
  $('st-clock').textContent = !S.running ? 'paused' : r >= 1e6 ? `${(r / 1e6).toFixed(2)} MHz` : r >= 1e3 ? `${(r / 1e3).toFixed(1)} kHz` : `${r.toFixed(0)} Hz`;
  $('st-cycles').textContent = fmt(S.machine.cycles);
  const sw = S.togglesPerCycle * (S.running ? r : 0);
  $('st-evals').textContent = sw >= 1e9 ? `${(sw / 1e9).toFixed(2)} G` : sw >= 1e6 ? `${(sw / 1e6).toFixed(1)} M` : sw >= 1e3 ? `${(sw / 1e3).toFixed(1)} k` : sw.toFixed(0);
  const pc = S.machine.reg('pc');
  $('st-fn').textContent = (S.programs[S.current].functionAt(pc) || '–') + '()';
}

// ------------------------------------------------------------------ source view
const KW = /\b(fn|var|const|if|else|while|for|return|break|continue|do|true|false|mem|asm)\b/g;
function highlightTurtle(line) {
  const ci = line.indexOf('//');
  const code = ci >= 0 ? line.slice(0, ci) : line;
  const comment = ci >= 0 ? line.slice(ci) : '';
  const parts = code.split(/("(?:\\.|[^"])*"|'(?:\\.|[^'])')/);
  const html = parts.map((p, i) => {
    if (i % 2) return `<span class="str">${esc(p)}</span>`;
    return esc(p).replace(/\b(0x[0-9a-fA-F_]+|0b[01_]+|\d+)\b/g, '<span class="num">$1</span>').replace(KW, '<span class="kw">$1</span>');
  }).join('');
  return html + (comment ? `<span class="cm">${esc(comment)}</span>` : '');
}

let srcRows = [];
let srcFile = null;
function renderSource() {
  const p = S.programs[S.current];
  srcFile = p.files[p.files.length - 1];
  const box = $('src');
  box.innerHTML = srcFile.text.split('\n').map((l, i) =>
    `<div class="ln"><span class="no">${i + 1}</span><span class="heat"></span><span class="tx">${highlightTurtle(l) || ' '}</span></div>`).join('');
  srcRows = [...box.children];
}

let lastSrcLine = -1;
function updateSource() {
  const p = S.programs[S.current];
  const pc = S.machine.reg('pc');
  const info = p.lineInfo(pc);
  const fn = p.functionAt(pc);
  const where = $('where');
  if (info) where.innerHTML = `pc ${hex4(pc)} → <b>${esc(info.file)}:${info.line}</b> in ${esc(fn || '?')}()`;
  // profile: hits per source line of this file
  const hits = new Float32Array(srcRows.length + 1);
  const img = p.image;
  for (let a = 0; a < S.profile.length; a++) {
    const h = S.profile[a];
    if (h < 0.01) continue;
    const li = p.lineInfo(a);
    if (li && li.file === srcFile.name) hits[li.line - 1] += h;
  }
  let max = 0;
  for (const h of hits) if (h > max) max = h;
  srcRows.forEach((row, i) => {
    const bar = row.children[1];
    const f = max ? hits[i] / max : 0;
    bar.style.opacity = f > 0.002 ? String(0.25 + 0.75 * f) : '0';
    bar.style.width = `${Math.max(2, f * 100)}%`;
  });
  void img;
  const cur = info && info.file === srcFile.name ? info.line - 1 : -1;
  if (cur !== lastSrcLine) {
    if (lastSrcLine >= 0 && srcRows[lastSrcLine]) srcRows[lastSrcLine].classList.remove('cur');
    if (cur >= 0 && srcRows[cur]) srcRows[cur].classList.add('cur');
    lastSrcLine = cur;
    if (cur >= 0 && performance.now() > S.followUntil) scrollIntoBox($('src'), srcRows[cur]);
  }
}

function scrollIntoBox(box, row) {
  if (!row) return;
  const top = row.offsetTop - box.offsetTop;
  if (top < box.scrollTop + 30 || top > box.scrollTop + box.clientHeight - 50) {
    box.scrollTop = top - box.clientHeight / 2;
  }
}

// ------------------------------------------------------------------ assembly view
let asmRows = [];
let asmIndex = null; // original asm line -> display row
function renderAsm() {
  const p = S.programs[S.current];
  const lines = p.asm.split('\n');
  asmIndex = new Int32Array(lines.length).fill(-1);
  const html = [];
  let row = 0;
  lines.forEach((l, i) => {
    if (l.startsWith('.loc') || l.startsWith(';') || !l.trim()) { asmIndex[i] = row - 1; return; }
    asmIndex[i] = row++;
    let h;
    if (/^\S+:/.test(l)) h = `<span class="lbl">${esc(l)}</span>`;
    else if (/^\S+\s*=/.test(l) || l.startsWith('.')) h = `<span class="cm">${esc(l)}</span>`;
    else {
      const m = /^(\s*)(\S+)(.*?)(;.*)?$/.exec(l);
      h = m ? `${m[1]}<span class="kw">${esc(m[2])}</span>${esc(m[3]).replace(/\b(-?\d+)\b/g, '<span class="num">$1</span>')}${m[4] ? `<span class="cm">${esc(m[4])}</span>` : ''}` : esc(l);
    }
    html.push(`<div class="ln"><span class="no"></span><span class="tx">${h}</span></div>`);
  });
  const box = $('asm');
  box.innerHTML = html.join('');
  asmRows = [...box.children];
  // addresses in the gutter
  const img = p.image;
  for (let a = img.romSize - 1; a >= 0; a--) {
    const li = img.asmLine[a];
    if (li >= 0 && asmIndex[li] >= 0 && asmRows[asmIndex[li]]) asmRows[asmIndex[li]].children[0].textContent = hex4(a);
  }
}

let lastAsm = -1;
function updateAsm() {
  const p = S.programs[S.current];
  const pc = S.machine.reg('pc');
  const li = p.image.asmLine[pc];
  const row = li >= 0 ? asmIndex[li] : -1;
  if (row !== lastAsm) {
    if (lastAsm >= 0 && asmRows[lastAsm]) asmRows[lastAsm].classList.remove('cur');
    if (row >= 0 && asmRows[row]) asmRows[row].classList.add('cur');
    lastAsm = row;
    if (performance.now() > S.asmFollowUntil) scrollIntoBox($('asm'), asmRows[row]);
  }
}

// ------------------------------------------------------------------ processor view
function updateCPU() {
  const m = S.machine;
  const pc = m.reg('pc');
  const ins = m.mems.rom[pc], lit = m.mems.rom[(pc + 1) & 0xffff];
  const d = decode(ins);
  const bin = (x, n) => x.toString(2).padStart(n, '0');
  const fields = [
    [bin(d.L, 1), 'L'], [bin(d.cls, 2), ['alu', 'load', 'store', 'jump'][d.cls]], [bin(d.h, 1), 'h'],
    [bin(d.d, 3), 'd'], [bin(d.a, 3), 'a'], [bin(d.b, 3), 'b'], [bin(d.f, 3), 'f'],
  ];
  const regs = [];
  for (let r = 1; r < 8; r++) {
    const v = m.reg(`r${r}`);
    const name = r === 6 ? 'r6 sp' : r === 7 ? 'r7 lr' : `r${r}`;
    const chg = v !== S.prevRegs[r] ? ' chg' : '';
    S.prevRegs[r] = v;
    regs.push(`<span class="rn">${name}</span><span class="hx${chg}">${hex4(v)}</span><span class="dc">${s16(v)}</span>`);
  }
  $('cpu').innerHTML = `
    <div class="regs"><span class="rn">pc</span><span class="hx">${hex4(pc)}</span><span class="dc">${esc(S.programs[S.current].functionAt(pc) || '')}</span></div>
    <div class="bits">${fields.map(([b, l]) => `<span><b>${b}</b><small>${l}</small></span>`).join('')}</div>
    <div class="dis">${esc(disassemble(ins, lit).text)}</div>
    <div class="regs"><span class="rn">r0</span><span class="hx">0000</span><span class="dc">always 0</span>${regs.join('')}</div>`;
}

// ------------------------------------------------------------------ the die
const TINTS = [
  ['N16/ALU/Multiplier', 0xa983f5, 'multiplier'],
  ['N16/ALU/Shifter', 0x5b8def, 'shifter'],
  ['N16/ALU/Logic', 0x7fc96b, 'logic unit'],
  ['N16/ALU/Arith', 0xd6c25a, 'adder'],
  ['N16/ALU', 0xc98fd6, 'ALU control'],
  ['N16/RegFile', 0xd98c4a, 'registers'],
  ['N16/PC', 0xd98c4a, null],
  ['N16/Read', 0x45c2b0, 'register read'],
  ['N16/OperandB', 0x45c2b0, null],
  ['N16/WriteBack', 0x58b7e0, 'write back'],
  ['N16/Decode', 0xe5738f, 'decode'],
  ['N16/Fetch', 0xf0a646, 'fetch & branch'],
  ['N16/Branch', 0xf0a646, null],
  ['', 0x9b93a8, null],
];
const BG = 0x0b0a0e;
const abgr = (rgb) => (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0;
const mix = (a, b, t) => {
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};
const HOT = 0xfff4dc;
const HEAT_LEVELS = 6;

let die = null;

class Die {
  constructor(nl, canvas, ink, tip) {
    this.nl = nl;
    this.canvas = canvas;
    this.ink = ink;
    this.tip = tip;
    this.nodes = nl.scopes.map((s, id) => ({ id, name: s.name, parent: s.parent, kids: [], items: [], size: 0 }));
    for (let n = 2; n < nl.size; n++) {
      const k = nl.kind[n];
      if (k === K_NAND || k === K_DFF) this.nodes[nl.scope[n]].items.push(n);
    }
    for (const nd of this.nodes) if (nd.parent >= 0) this.nodes[nd.parent].kids.push(nd);
    const sizeOf = (nd) => { nd.size = nd.items.length + nd.kids.reduce((s, k) => s + sizeOf(k), 0); return nd.size; };
    sizeOf(this.nodes[0]);
    for (const nd of this.nodes) nd.kids = nd.kids.filter((k) => k.size > 0);
    this.paths = this.nodes.map((nd) => this.pathOf(nd.id));
    // colours per item
    this.tint = new Int32Array(nl.size);
    this.palette = TINTS.map(([, rgb]) => {
      const on = rgb, off = mix(rgb, BG, 0.8);
      const lv = (base) => Array.from({ length: HEAT_LEVELS }, (_, i) => abgr(mix(base, HOT, (i / (HEAT_LEVELS - 1)) * 0.85)));
      return { on: lv(on), off: lv(off) };
    });
    for (let n = 2; n < nl.size; n++) {
      const p = this.paths[nl.scope[n]];
      this.tint[n] = TINTS.findIndex(([pre]) => p === pre || p.startsWith(pre + '/') || (pre && p.startsWith(pre)) || pre === '');
    }
    this.root = this.nodes[0];
    this.hover = -1;
    canvas.addEventListener('mousemove', (e) => this.onMove(e));
    canvas.addEventListener('mouseleave', () => { this.tip.hidden = true; this.hover = -1; });
    canvas.addEventListener('click', (e) => this.onClick(e));
    new ResizeObserver(() => this.relayout()).observe(canvas.parentElement);
    this.relayout();
  }

  pathOf(id) {
    const parts = [];
    for (let s = id; s >= 0; s = this.nodes[s].parent) parts.push(this.nodes[s].name);
    return parts.reverse().join('/');
  }

  itemsOf(node, out = []) {
    out.push(...node.items);
    for (const k of node.kids) this.itemsOf(k, out);
    return out;
  }

  zoom(node) {
    this.root = node;
    this.tip.hidden = true;
    this.relayout();
    this.renderCrumbs();
  }

  renderCrumbs() {
    const chain = [];
    for (let nd = this.root; nd; nd = nd.parent >= 0 ? this.nodes[nd.parent] : null) chain.unshift(nd);
    const box = $('crumbs');
    box.innerHTML = '';
    chain.forEach((nd, i) => {
      if (i) { const sep = document.createElement('i'); sep.textContent = '›'; box.appendChild(sep); }
      const b = document.createElement('button');
      b.textContent = nd.name;
      if (i < chain.length - 1) b.addEventListener('click', () => this.zoom(nd));
      else b.setAttribute('aria-current', 'true');
      box.appendChild(b);
    });
    const n = this.itemsOf(this.root).filter((x) => this.nl.kind[x] === K_NAND).length;
    $('die-caption').textContent = this.schematic
      ? `${this.root.name}: ${n} NAND gate${n === 1 ? '' : 's'}, drawn as a schematic. Wires glow when they carry a 1. Inputs come in from the left; outputs leave on the right. Click a crumb above to zoom out.`
      : this.root === this.nodes[0]
        ? 'Every NAND gate of the processor, grouped by the circuit that contains it. A lit gate outputs 1; a white flash means it just switched. Click a block to zoom in. Small blocks open as a schematic with live wires.'
        : `${this.root.name}: ${fmt(n)} NAND gates. Click a block to zoom further, or a crumb above to zoom out.`;
  }

  relayout() {
    const box = this.canvas.parentElement;
    const W = Math.max(50, Math.round(box.clientWidth));
    const H = Math.max(50, Math.round(box.clientHeight));
    const dpr = window.devicePixelRatio || 1;
    this.W = W; this.H = H; this.dpr = dpr;
    this.canvas.width = W; this.canvas.height = H;
    this.ink.width = Math.round(W * dpr); this.ink.height = Math.round(H * dpr);
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(W, H);
    this.px = new Uint32Array(this.img.data.buffer);
    this.map = new Int32Array(W * H).fill(-1);
    this.boxes = [];
    const total = this.itemsOf(this.root).length;
    this.schematic = total <= 64 && this.root !== this.nodes[0];
    if (this.schematic) this.layoutSchematic();
    else {
      this.place(this.root, 0, 0, W, H, 0);
      this.drawInk();
    }
    if (!this.crumbsDone) { this.renderCrumbs(); this.crumbsDone = true; }
  }

  place(node, x, y, w, h, depth) {
    const box = { node, x, y, w, h, depth, labelled: false };
    this.boxes.push(box);
    let ix = x, iy = y, iw = w, ih = h;
    if (depth > 0 && w >= 6 && h >= 6) { ix += 1; iy += 1; iw -= 2; ih -= 2; }
    if (iw >= 70 && ih >= 46 && depth >= 1 && depth <= 3) { box.labelled = true; iy += 13; ih -= 13; }
    const parts = node.kids.map((k) => ({ node: k, size: k.size }));
    if (node.items.length) parts.push({ items: node.items, size: node.items.length });
    if (!node.kids.length || iw < 8 || ih < 8 || (iw * ih) / node.size < 10) {
      this.grid(this.itemsOf(node), ix, iy, iw, ih);
      return;
    }
    parts.sort((a, b) => b.size - a.size);
    squarify(parts, ix, iy, iw, ih);
    for (const p of parts) {
      const [px, py, pw, ph] = p.rect;
      if (p.items) this.grid(p.items, px, py, pw, ph);
      else this.place(p.node, px, py, pw, ph, depth + 1);
    }
  }

  grid(items, x, y, w, h) {
    const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
    const W = x1 - x0, H = y1 - y0;
    if (W <= 0 || H <= 0 || !items.length) return;
    const n = items.length;
    let cols = Math.max(1, Math.round(Math.sqrt((n * W) / H)));
    cols = Math.min(cols, n);
    const rows = Math.ceil(n / cols);
    const cw = W / cols, ch = H / rows;
    const gap = cw >= 3.5 && ch >= 3.5 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const c = k % cols, r = (k / cols) | 0;
      const ax = x0 + Math.round(c * cw), bx = x0 + Math.round((c + 1) * cw) - gap;
      const ay = y0 + Math.round(r * ch), by = y0 + Math.round((r + 1) * ch) - gap;
      for (let yy = ay; yy < Math.max(by, ay + 1); yy++) {
        const row = yy * this.W;
        for (let xx = ax; xx < Math.max(bx, ax + 1); xx++) this.map[row + xx] = items[k];
      }
    }
  }

  drawInk() {
    const g = this.ink.getContext('2d');
    const d = this.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    g.font = '600 10.5px "IBM Plex Mono", ui-monospace, monospace';
    g.textBaseline = 'top';
    for (const b of this.boxes) {
      if (!b.depth) continue;
      const tint = TINTS[this.tint[this.itemsOf(b.node)[0]]]?.[1] ?? 0x9b93a8;
      const css = '#' + tint.toString(16).padStart(6, '0');
      if (b.labelled) {
        g.globalAlpha = 0.9;
        g.fillStyle = css;
        let label = b.node.name;
        const maxChars = Math.floor((b.w - 8) / 6.4);
        if (label.length > maxChars) label = label.slice(0, Math.max(1, maxChars - 1)) + '…';
        g.fillText(label, b.x + 3, b.y + 2.5);
        g.globalAlpha = 1;
      }
      if (b.depth <= 2 && b.w > 12 && b.h > 12) {
        g.strokeStyle = css;
        g.globalAlpha = b.depth === 1 ? 0.55 : 0.28;
        g.lineWidth = 1;
        g.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
        g.globalAlpha = 1;
      }
    }
  }

  draw(v, heat) {
    if (this.schematic) { this.drawSchematic(v); return; }
    const { px, map, tint, palette } = this;
    const bg = abgr(BG);
    let lastN = -2, lastC = bg;
    for (let i = 0; i < map.length; i++) {
      const n = map[i];
      if (n !== lastN) {
        lastN = n;
        if (n < 0) lastC = bg;
        else {
          const p = palette[tint[n]];
          const lvl = Math.min(HEAT_LEVELS - 1, Math.round(heat[n] * (HEAT_LEVELS - 1)));
          lastC = v[n] ? p.on[lvl] : p.off[lvl];
          if (n === this.hover) lastC = abgr(HOT);
        }
      }
      px[i] = lastC;
    }
    this.ctx.putImageData(this.img, 0, 0);
    if (!this.tip.hidden && this.hover >= 0) this.updateTip();
  }

  itemAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * this.W);
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.H);
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return -1;
    return this.schematic ? this.schemAt((e.clientX - r.left), (e.clientY - r.top)) : this.map[y * this.W + x];
  }

  onMove(e) {
    const n = this.itemAt(e);
    this.hover = n;
    if (n < 0) { this.tip.hidden = true; return; }
    const r = this.canvas.parentElement.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    this.tip.hidden = false;
    this.tipPos = [x, y, r.width, r.height];
    this.updateTip();
  }

  updateTip() {
    const n = this.hover;
    const nl = this.nl;
    const v = S.interp.v;
    const path = this.paths[nl.scope[n]].replace(/^N16\//, '').split('/').join(' › ');
    let body;
    if (nl.kind[n] === K_NAND) {
      const a = nl.in0[n], b = nl.in1[n];
      body = a === b
        ? `NAND #${n} wired as NOT: in ${v[a]} → out <em>${v[n]}</em>`
        : `NAND #${n}: ${v[a]} NAND ${v[b]} = <em>${v[n]}</em>`;
    } else body = `flip-flop #${nl.in0[n]}: holds <em>${v[n]}</em>`;
    this.tip.innerHTML = `${esc(path)}<br>${body}`;
    const [x, y, W, H] = this.tipPos;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = `${Math.min(Math.max(4, x + 14), W - tw - 4)}px`;
    this.tip.style.top = `${y + 18 + th > H ? y - th - 10 : y + 18}px`;
  }

  onClick(e) {
    const n = this.itemAt(e);
    if (n < 0 || this.schematic) return;
    // zoom to the child of the current root that contains this gate
    let s = this.nl.scope[n];
    let child = null;
    while (s >= 0 && s !== this.root.id) { child = this.nodes[s]; s = this.nodes[s].parent; }
    if (child && s === this.root.id) {
      // skip through single-child wrappers
      while (child.kids.length === 1 && !child.items.length) child = child.kids[0];
      this.zoom(child);
    }
  }

  // ---------------- schematic view for small blocks
  layoutSchematic() {
    const nl = this.nl;
    const items = this.itemsOf(this.root);
    const inBlock = new Set(items);
    const gates = items.filter((n) => nl.kind[n] === K_NAND).sort((a, b) => a - b);
    const ffs = items.filter((n) => nl.kind[n] === K_DFF);
    const depth = new Map();
    const ext = [];
    const extSeen = new Set();
    for (const g of gates) {
      for (const i of [nl.in0[g], nl.in1[g]]) {
        if (!inBlock.has(i) && !extSeen.has(i)) { extSeen.add(i); ext.push(i); }
      }
    }
    ffs.forEach((f) => depth.set(f, 0));
    ext.forEach((x) => depth.set(x, 0));
    let maxD = 0;
    for (const g of gates) {
      const d = 1 + Math.max(depth.get(nl.in0[g]) ?? 0, depth.get(nl.in1[g]) ?? 0);
      depth.set(g, d);
      maxD = Math.max(maxD, d);
    }
    const cols = Array.from({ length: maxD + 1 }, () => []);
    [...ext, ...ffs].forEach((x) => cols[0].push(x));
    gates.forEach((g) => cols[depth.get(g)].push(g));
    // barycentre ordering, two sweeps
    const pos = new Map();
    const setPos = () => cols.forEach((c) => c.forEach((n, i) => pos.set(n, (i + 0.5) / c.length)));
    setPos();
    for (let sweep = 0; sweep < 3; sweep++) {
      for (let c = 1; c < cols.length; c++) {
        cols[c].sort((a, b) => bary(a) - bary(b));
        cols[c].forEach((n, i) => pos.set(n, (i + 0.5) / cols[c].length));
      }
      function bary(g) { return ((pos.get(nl.in0[g]) ?? 0.5) + (pos.get(nl.in1[g]) ?? 0.5)) / 2; }
    }
    const outputs = new Set(items.filter((n) => S.consumers[n].some((u) => u < 0 || !inBlock.has(u))));
    const W = this.W, H = this.H;
    const left = Math.min(150, W * 0.24), right = 46;
    const colW = (W - left - right) / Math.max(1, cols.length - 1);
    const maxRows = Math.max(...cols.map((c) => c.length));
    const rowH = (H - 20) / maxRows;
    const size = Math.max(9, Math.min(26, colW * 0.32, rowH * 0.42));
    const place = new Map();
    cols.forEach((c, ci) => {
      const step = (H - 20) / c.length;
      c.forEach((n, i) => {
        const x = ci === 0 ? left - 12 : left + (ci - 0.5) * colW;
        place.set(n, { x, y: 10 + step * (i + 0.5) });
      });
    });
    this.sch = { gates, ffs, ext, place, size, outputs, cols };
  }

  schemAt(x, y) {
    if (!this.sch) return -1;
    let best = -1, bd = 1e9;
    for (const [n, p] of this.sch.place) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = n; }
    }
    return bd < this.sch.size * 1.4 ? best : -1;
  }

  drawSchematic(v) {
    const { gates, ffs, ext, place, size, outputs } = this.sch;
    const nl = this.nl;
    const g = this.ink.getContext('2d');
    const d = this.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    this.ctx.fillStyle = '#0b0a0e';
    this.ctx.fillRect(0, 0, this.W, this.H);
    const on = '#ffb547', off = '#3b3344';
    const s = size;
    const outPin = (n) => {
      const p = place.get(n);
      if (nl.kind[n] === K_NAND) return [p.x + s * 1.25, p.y];
      return [p.x + 4, p.y];
    };
    // wires
    g.lineWidth = 1.6;
    for (const gt of gates) {
      const p = place.get(gt);
      const ins = nl.in0[gt] === nl.in1[gt] ? [[nl.in0[gt], 0]] : [[nl.in0[gt], -0.42], [nl.in1[gt], 0.42]];
      for (const [src, off2] of ins) {
        const sp = place.get(src);
        if (!sp) continue;
        const [x0, y0] = outPin(src);
        const x1 = p.x - s * 0.95, y1 = p.y + off2 * s;
        g.strokeStyle = v[src] ? on : off;
        g.beginPath();
        g.moveTo(x0, y0);
        const mx = (x0 + x1) / 2;
        g.bezierCurveTo(mx, y0, mx, y1, x1, y1);
        g.stroke();
      }
    }
    // outputs leaving the block, each in its own lane on the right
    const outs = [...outputs].sort((a, b) => place.get(a).y - place.get(b).y);
    outs.forEach((n, i) => {
      const [x0, y0] = outPin(n);
      const y1 = ((i + 0.5) / outs.length) * (this.H - 20) + 10;
      const x1 = this.W - 8;
      g.strokeStyle = v[n] ? on : off;
      g.beginPath();
      g.moveTo(x0, y0);
      const mx = Math.max(x0 + 12, x1 - 22);
      g.bezierCurveTo(mx, y0, mx, y1, x1, y1);
      g.stroke();
      g.fillStyle = v[n] ? on : off;
      g.beginPath(); g.moveTo(x1, y1 - 4); g.lineTo(x1 + 6, y1); g.lineTo(x1, y1 + 4); g.fill();
    });
    // gates
    for (const gt of gates) {
      const p = place.get(gt);
      const lit = v[gt];
      g.lineWidth = 1.5;
      g.strokeStyle = gt === this.hover ? '#fff4dc' : lit ? on : '#7d7389';
      g.fillStyle = lit ? '#3a2a12' : '#16131b';
      g.beginPath();
      g.moveTo(p.x - s * 0.95, p.y - s * 0.7);
      g.lineTo(p.x, p.y - s * 0.7);
      g.arc(p.x, p.y, s * 0.7, -Math.PI / 2, Math.PI / 2);
      g.lineTo(p.x - s * 0.95, p.y + s * 0.7);
      g.closePath();
      g.fill(); g.stroke();
      g.beginPath();
      g.arc(p.x + s * 0.7 + s * 0.17, p.y, s * 0.17, 0, Math.PI * 2);
      g.fill(); g.stroke();
    }
    // flip-flops and external inputs on the left
    g.font = '500 10.5px "IBM Plex Mono", ui-monospace, monospace';
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (const n of [...ext, ...ffs]) {
      const p = place.get(n);
      const lit = v[n];
      g.fillStyle = lit ? on : '#7d7389';
      if (nl.kind[n] === K_DFF) {
        g.strokeStyle = lit ? on : '#7d7389';
        g.strokeRect(p.x - 7, p.y - 6, 11, 12);
      } else {
        g.beginPath(); g.arc(p.x, p.y, 3.2, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = '#9b93a8';
      const label = this.netLabel(n);
      g.fillText(`${label} ${lit}`, p.x - 10, p.y);
    }
    g.textAlign = 'left';
  }

  netLabel(n) {
    const nl = this.nl;
    if (nl.kind[n] === K_DFF) return `ff${nl.in0[n]}`;
    if (nl.kind[n] === K_MEM) return `${nl.readPorts[nl.in0[n]].mem}.${nl.in1[n]}`;
    const parts = this.paths[nl.scope[n]].split('/');
    return parts.slice(-2).join('/').slice(-18);
  }
}

function squarify(parts, x, y, w, h) {
  const total = parts.reduce((s, p) => s + p.size, 0);
  const scale = (w * h) / total;
  let rest = parts.map((p) => ({ p, a: p.size * scale }));
  const worst = (row, side) => {
    let s = 0, mx = 0, mn = Infinity;
    for (const r of row) { s += r.a; mx = Math.max(mx, r.a); mn = Math.min(mn, r.a); }
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (rest.length) {
    const side = Math.min(w, h);
    let row = [rest[0]];
    let i = 1;
    let wv = worst(row, side);
    while (i < rest.length) {
      const cand = [...row, rest[i]];
      const nw = worst(cand, side);
      if (nw > wv) break;
      row = cand; wv = nw; i++;
    }
    const area = row.reduce((s, r) => s + r.a, 0);
    if (w >= h) {
      const sw = area / h;
      let yy = y;
      for (const r of row) { const rh = r.a / sw; r.p.rect = [x, yy, sw, rh]; yy += rh; }
      x += sw; w -= sw;
    } else {
      const sh = area / w;
      let xx = x;
      for (const r of row) { const rw = r.a / sh; r.p.rect = [xx, y, rw, sh]; xx += rw; }
      y += sh; h -= sh;
    }
    rest = rest.slice(i);
  }
}

function buildLegend() {
  const counts = new Map();
  const nl = S.nl;
  for (let n = 2; n < nl.size; n++) {
    if (nl.kind[n] !== K_NAND && nl.kind[n] !== K_DFF) continue;
    let t = die.tint[n];
    // fold aliases into their named group
    while (t > 0 && !TINTS[t][2]) t--;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  $('legend').innerHTML = TINTS.map(([, rgb, name], i) => (name && counts.get(i)
    ? `<span><i style="background:#${rgb.toString(16).padStart(6, '0')}"></i>${name} ${fmt(counts.get(i))}</span>` : '')).join('');
}

// ------------------------------------------------------------------ the stack
function fillStack(stats, nl, wasmBytes) {
  const tetris = S.programs['tetris.tt'];
  const rows = [
    ['1', 'NAND gate', 'the only logic primitive: <code>out = not (a and b)</code>'],
    ['2', 'Gate library', 'NOT, AND, OR, XOR, multiplexers, decoders, full adders, each wired from NANDs'],
    ['3', 'N16 processor', `${fmt(stats.nands)} NANDs as designed, ${fmt(nl.gateCount())} after optimisation, plus ${stats.dffs} flip-flops: register file, barrel shifter, signed array multiplier`],
    ['4', 'Simulator', `the netlist compiled to ${(wasmBytes / 1024).toFixed(0)} KB of WebAssembly, every gate a few instructions; idle units skipped exactly`],
    ['5', 'Assembler', 'two passes, labels, constant expressions, a source map back to each line'],
    ['6', 'Turtle compiler', 'parser, register allocation by graph colouring, spilling, peephole cleanup'],
    ['7', 'Programs', `a standard library with a pixel font, then Tetris with an AI (${fmt(tetris.image.romSize)} words), bit-sliced Life, fixed-point Mandelbrot`],
    ['8', 'The machine again', 'a gate-level simulator written in Turtle, running a smaller N16 on this one: NAND gates simulating NAND gates'],
  ];
  $('stack').innerHTML = rows.map(([n, a, b]) => `<li><span class="n">${n}</span><b>${a}</b><span>${b}</span></li>`).join('');
}

// ------------------------------------------------------------------ sound
let audio = null, osc = null, gain = null, lastTone = -1;
function updateSound() {
  if (!audio) return;
  const f = S.running ? S.machine.mems.ram[IO_SOUND] : 0;
  if (f === lastTone) return;
  lastTone = f;
  const t = audio.currentTime;
  if (f >= 20 && f <= 8000) {
    osc.frequency.setValueAtTime(f, t);
    gain.gain.setTargetAtTime(0.045, t, 0.004);
  } else gain.gain.setTargetAtTime(0, t, 0.008);
}
$('sound').addEventListener('click', () => {
  const b = $('sound');
  if (!audio) {
    try {
      audio = new (window.AudioContext || window.webkitAudioContext)();
      osc = audio.createOscillator();
      osc.type = 'square';
      gain = audio.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(audio.destination);
      osc.start();
    } catch (e) { b.textContent = 'No sound here'; return; }
  }
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? 'Sound on' : 'Sound off';
  if (on) { audio.resume(); lastTone = -1; } else { gain.gain.setTargetAtTime(0, audio.currentTime, 0.01); audio.suspend(); }
});

// ------------------------------------------------------------------ live verification
// A second copy of the gate-level machine runs random programs next to the
// behavioural emulator; they must agree after every burst of cycles.
const V = { machine: null, emu: null, left: 0, checked: 0, programs: 0, diffs: 0, visible: false };
async function startVerifier() {
  try {
    const { instance } = await WebAssembly.instantiate(S.bytes, {});
    V.machine = new WasmMachine(S.nl, instance);
  } catch (e) {
    V.machine = new FastMachine(S.nl, planBlocks, DEFAULT_BLOCKS);
  }
  newVerifyProgram();
  new IntersectionObserver((es) => { V.visible = es.some((e) => e.isIntersecting); }).observe($('verify'));
}
function newVerifyProgram() {
  const rom = new Uint16Array(65536), ram = new Uint16Array(65536);
  const edge = [0, 0, 1, 0x7fff, 0x8000, 0xffff, 15, 16];
  for (let i = 0; i < 65536; i++) {
    rom[i] = (Math.random() * 65536) | 0;
    ram[i] = Math.random() < 0.3 ? edge[(Math.random() * edge.length) | 0] : (Math.random() * 65536) | 0;
  }
  V.emu = new Emulator(rom.slice(), ram.slice());
  V.machine.reset();
  V.machine.mems.rom.set(rom);
  V.machine.mems.ram.set(ram);
  V.left = 5000;
}
function verifyStep(ms) {
  if (!V.machine || !V.visible) { $('verify').classList.remove('live'); return; }
  const t0 = performance.now();
  const { emu } = V;
  while (performance.now() - t0 < ms) {
    const n = 1 + ((Math.random() * 64) | 0);
    for (let i = 0; i < n; i++) V.emu.step();
    V.machine.run(n);
    V.checked += n;
    V.left -= n;
    let same = V.machine.reg('pc') === V.emu.pc;
    for (let r = 1; r < 8 && same; r++) same = V.machine.reg(`r${r}`) === V.emu.r[r];
    if (V.left <= 0) {
      const a = V.machine.mems.ram, b = V.emu.ram;
      for (let i = 0; i < 65536 && same; i++) same = a[i] === b[i];
      V.programs++;
      newVerifyProgram();
    }
    if (!same) { V.diffs++; newVerifyProgram(); }
  }
  void emu;
  $('verify').classList.add('live');
  $('verify').classList.toggle('bad', V.diffs > 0);
  $('v-count').textContent = fmt(V.checked);
  $('v-progs').textContent = fmt(V.programs);
  $('v-diff').textContent = fmt(V.diffs);
}

// ------------------------------------------------------------------ controls
function setRunning(on) {
  S.running = on;
  const b = $('run');
  b.textContent = on ? 'Running' : 'Paused';
  b.setAttribute('aria-pressed', String(on));
  if (!on) updateStats();
}

$('run').addEventListener('click', () => setRunning(!S.running));
$('step').addEventListener('click', () => {
  setRunning(false);
  sample(1);
  drawAll(true);
});
$('reset').addEventListener('click', () => loadProgram(S.current));
for (const b of $('clock').children) {
  b.addEventListener('click', () => {
    S.hz = Number(b.dataset.hz);
    S.cycAcc = 0;
    for (const x of $('clock').children) x.setAttribute('aria-pressed', String(x === b));
    if (!S.running) setRunning(true);
  });
}

// keyboard: only while the screen has focus
const KEYMAP = { ArrowLeft: 1, ArrowRight: 2, ArrowUp: 4, ArrowDown: 8, ' ': 16, Enter: 32 };
const bezel = $('bezel');
bezel.addEventListener('focus', () => bezel.classList.add('focused'));
bezel.addEventListener('blur', () => { bezel.classList.remove('focused'); S.keys = 0; });
bezel.addEventListener('keydown', (e) => {
  const k = KEYMAP[e.key];
  if (k) { S.keys |= k; e.preventDefault(); }
});
bezel.addEventListener('keyup', (e) => {
  const k = KEYMAP[e.key];
  if (k) { S.keys &= ~k; e.preventDefault(); }
});
for (const b of $('pad').querySelectorAll('button')) {
  const k = Number(b.dataset.key);
  const down = (e) => { e.preventDefault(); S.padKeys |= k; };
  const up = () => { S.padKeys &= ~k; };
  b.addEventListener('pointerdown', down);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointerleave', up);
  b.addEventListener('pointercancel', up);
}

// scrolling a code panel pauses auto-follow for a while
$('src').addEventListener('wheel', () => { S.followUntil = performance.now() + 4000; }, { passive: true });
$('asm').addEventListener('wheel', () => { S.asmFollowUntil = performance.now() + 4000; }, { passive: true });
$('src').addEventListener('touchstart', () => { S.followUntil = performance.now() + 4000; }, { passive: true });
$('asm').addEventListener('touchstart', () => { S.asmFollowUntil = performance.now() + 4000; }, { passive: true });

// ------------------------------------------------------------------ editor
function setEditing(on) {
  $('editor').hidden = !on;
  $('src').hidden = on;
  $('compile').hidden = !on;
  $('revert').hidden = !on && !S.edited[S.current];
  $('edit').hidden = on;
  if (on) $('editor').value = S.edited[S.current] ?? PROGRAMS[S.current];
  $('err').textContent = '';
}
$('edit').addEventListener('click', () => { setEditing(true); $('editor').focus(); });
$('compile').addEventListener('click', () => {
  const file = S.current;
  const text = $('editor').value;
  try {
    const p = buildProgram(file, text);
    S.programs[file] = p;
    S.edited[file] = text;
    loadProgram(file);
    $('err').textContent = `Compiled: ${fmt(p.image.romSize)} words. Running.`;
  } catch (e) {
    $('err').textContent = e.message;
  }
});
$('revert').addEventListener('click', () => {
  const file = S.current;
  delete S.edited[file];
  S.programs[file] = buildProgram(file, PROGRAMS[file]);
  loadProgram(file);
});
$('editor').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target, a = t.selectionStart;
    t.setRangeText('  ', a, t.selectionEnd, 'end');
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('compile').click();
});

// ------------------------------------------------------------------ the NAND demo
const nandIn = [1, 1];
function drawNand() {
  const q = 1 - (nandIn[0] & nandIn[1]);
  const col = (x) => (x ? 'var(--amber)' : '#4a4255');
  $('wa').setAttribute('stroke', col(nandIn[0]));
  $('wb').setAttribute('stroke', col(nandIn[1]));
  $('wq').setAttribute('stroke', col(q));
  $('ta').textContent = nandIn[0];
  $('tb').textContent = nandIn[1];
  $('tq').textContent = q;
  const r = nandIn[0] * 2 + nandIn[1];
  for (const tr of $('tt').querySelectorAll('tbody tr')) tr.classList.toggle('on', Number(tr.dataset.r) === r);
}
for (const [id, i] of [['pa', 0], ['pb', 1]]) {
  const el = $(id);
  const flip = () => { nandIn[i] ^= 1; drawNand(); };
  el.addEventListener('click', flip);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
}
drawNand();

boot().catch((e) => {
  log('');
  log(`boot failed: ${e.message}`);
  console.error(e);
});
