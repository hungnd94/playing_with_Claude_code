// toolchain.js — Turtle source -> N16 machine image, with a source map.

import { compileToAsm } from './compiler.js';
import { assemble } from './asm.js';

export class BuildError extends Error {
  constructor(message, file, line) {
    super(message);
    this.file = file;
    this.line = line;
  }
}

/**
 * Build a program. `lib` is prepended (the standard library).
 * Returns { image, asm, files, lineInfo(pc), functionAt(pc) }.
 * Compile errors are thrown as BuildError with file-relative line numbers.
 */
export function build(source, { lib = '', name = 'program.tt', libName = 'lib.tt' } = {}) {
  const libLines = lib ? lib.split('\n').length : 0;
  const full = lib ? `${lib}\n${source}` : source;
  const files = lib
    ? [{ name: libName, first: 1, count: libLines, text: lib }, { name, first: libLines + 1, count: source.split('\n').length, text: source }]
    : [{ name, first: 1, count: source.split('\n').length, text: source }];
  const locate = (l) => {
    for (const f of files) if (l >= f.first && l < f.first + f.count) return { file: f.name, line: l - f.first + 1 };
    return null;
  };
  let asm;
  try {
    asm = compileToAsm(full);
  } catch (e) {
    const where = e.line !== undefined ? locate(e.line) : null;
    const msg = e.message.replace(/^line \d+: /, '');
    throw new BuildError(where ? `${where.file} line ${where.line}: ${msg}` : msg, where?.file, where?.line);
  }
  const image = assemble(asm);
  /** Map a ROM address to { file, line } (1-based line within that file). */
  const lineInfo = (pc) => {
    const l = image.srcLine[pc];
    return l === undefined || l < 0 ? null : locate(l);
  };
  // function entry points, for "which function is running"
  const entries = [...image.labels].filter(([k]) => k.startsWith('f_')).map(([k, v]) => [v, k.slice(2)]).sort((a, b) => a[0] - b[0]);
  const functionAt = (pc) => {
    let best = null;
    for (const [addr, fname] of entries) { if (addr <= pc) best = fname; else break; }
    return best;
  };
  return { image, asm, files, lineInfo, functionAt };
}
