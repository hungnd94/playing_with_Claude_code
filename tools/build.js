// build.js — bundle the simulator, toolchain, programs and UI into one HTML file.
//
//   node tools/build.js
//
// Writes dist/index.html (a complete standalone page) and dist/artifact.html
// (the same page without the document skeleton, for publishing).
// The bundler is tiny: each ES module is wrapped in a function scope, and
// `import { a } from './x.js'` becomes `const { a } = __m.x`.

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const sources = new Map(); // module id -> { file, code }
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*'([^']+)';|import\s*\*\s*as\s*(\w+)\s*from\s*'([^']+)';/g;

function moduleId(fromFile, spec) {
  return path.basename(path.resolve(path.dirname(fromFile), spec), '.js');
}

function collect(file) {
  const id = path.basename(file, '.js');
  if (sources.has(id)) return;
  const code = file === 'GENERATED/programs.js' ? programsModule() : read(file);
  sources.set(id, { file, code, deps: [] });
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[2] || m[4];
    const dep = moduleId(file, spec);
    sources.get(id).deps.push(dep);
    const depFile = dep === 'programs' ? 'GENERATED/programs.js' : path.join(path.dirname(file), spec);
    collect(path.normalize(depFile));
  }
}

function programsModule() {
  const dir = path.join(root, 'programs');
  const progs = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tt')).sort()) progs[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  return `export const PROGRAMS = ${JSON.stringify(progs)};\n`;
}

function transform(id) {
  const { file, code } = sources.get(id);
  const exportsList = [];
  let out = code.replace(IMPORT_RE, (m, names, spec, star, spec2) => {
    const dep = moduleId(file, spec || spec2);
    if (star) return `const ${star} = __m[${JSON.stringify(dep)}];`;
    const parts = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': '));
    return `const { ${parts.join(', ')} } = __m[${JSON.stringify(dep)}];`;
  });
  out = out.replace(/^export\s*\{([^}]*)\};?\s*$/gm, (m, names) => {
    names.split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => exportsList.push(n));
    return '';
  });
  out = out.replace(/^export\s+(async\s+function|function|class|const|let|var)\s+(\w+)/gm, (m, kw, name) => {
    exportsList.push(name);
    return `${kw} ${name}`;
  });
  return `__m[${JSON.stringify(id)}] = (() => {\n${out}\nreturn { ${[...new Set(exportsList)].join(', ')} };\n})();\n`;
}

collect('web/app.js');

// every imported name must be exported by its module (catches bundler blind spots)
const exportedNames = new Map();
for (const [id, { code }] of sources) {
  const names = new Set();
  for (const m of code.matchAll(/^export\s+(?:async\s+function|function|class|const|let|var)\s+(\w+)(.*)$/gm)) {
    names.add(m[1]);
    if (/^\s*=.*,\s*\w+\s*=/.test(m[2]) && !/[({]/.test(m[2].split(',')[0])) throw new Error(`${id}: split 'export const a = 1, b = 2' into separate lines`);
  }
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) m[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => names.add(n));
  exportedNames.set(id, names);
}
for (const [id, { file, code }] of sources) {
  for (const m of code.matchAll(IMPORT_RE)) {
    if (!m[1]) continue;
    const dep = moduleId(file, m[2]);
    for (const part of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const name = part.split(/\s+as\s+/)[0];
      if (!exportedNames.get(dep).has(name)) throw new Error(`${id} imports '${name}' but ${dep} does not export it`);
    }
  }
}
// topological order
const order = [];
const seen = new Set();
const visit = (id) => {
  if (seen.has(id)) return;
  seen.add(id);
  for (const d of sources.get(id).deps) visit(d);
  order.push(id);
};
visit('app');
const bundle = `(() => {\n"use strict";\nconst __m = {};\n${order.map(transform).join('\n')}\n})();\n`;

const page = read('web/page.html').replace('<!--BUNDLE-->', () => `<script>\n${bundle}</script>`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/artifact.html'), page);
const standalone = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${page}\n</body>\n</html>\n`;
fs.writeFileSync(path.join(root, 'dist/index.html'), standalone);
console.log(`bundled ${order.length} modules (${order.join(', ')}): ${(page.length / 1024).toFixed(0)} KB`);
