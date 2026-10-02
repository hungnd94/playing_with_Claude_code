// toolchain.js — Turtle source -> N16 machine image, with a source map.

import { compileToAsm } from './compiler.js';
import { assemble } from './asm.js';

/**
 * Build a program. `lib` is prepended (the standard library).
 * Returns { image, asm, source, files: [{name, start, lines}], lineInfo(pc) }.
 */
export function build(source, { lib = '', name = 'program.tt', libName = 'lib.tt' } = {}) {
  const libLines = lib ? lib.split('\n').length : 0;
  const full = lib ? `${lib}\n${source}` : source;
  const asm = compileToAsm(full);
  const image = assemble(asm);
  const files = lib
    ? [{ name: libName, first: 1, count: libLines, text: lib }, { name, first: libLines + 1, count: source.split('\n').length, text: source }]
    : [{ name, first: 1, count: source.split('\n').length, text: source }];
  /** Map a ROM address to { file, line } (1-based line within that file). */
  const lineInfo = (pc) => {
    const l = image.srcLine[pc];
    if (l === undefined || l < 0) return null;
    for (const f of files) if (l >= f.first && l < f.first + f.count) return { file: f.name, line: l - f.first + 1 };
    return null;
  };
  return { image, asm, files, lineInfo };
}
