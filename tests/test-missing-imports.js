'use strict';

// #137: „checkLink is not defined“ – eine Funktion aus src/shared wurde benutzt, aber nie importiert. esbuild merkt das
// nicht (es wäre ja eine globale Variable), der Fehler kam erst beim Klick. Dieser Test findet solche Lücken in ALLEN
// Oberflächen-Dateien: Jede benutzte Funktion, die ein Modul in src/shared exportiert, muss importiert oder selbst definiert sein.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SHARED = path.join(ROOT, 'src', 'shared');
const RENDERER = path.join(ROOT, 'src', 'renderer');

function sharedExports() {
  const names = new Set();
  for (const f of fs.readdirSync(SHARED).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(SHARED, f), 'utf8');
    const m = /module\.exports\s*=\s*\{([^}]*)\}/.exec(src);
    if (m) for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim();
      if (/^[a-z][A-Za-z0-9]+$/.test(name)) names.add(name);
    }
  }
  return names;
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.jsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

test('Jede benutzte Shared-Funktion ist importiert oder selbst definiert (sonst Absturz erst beim Klick)', () => {
  const exported = sharedExports();
  assert.ok(exported.has('checkLink'));
  const problems = [];
  for (const file of files(RENDERER)) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const imported = new Set();
    for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s+['"][^'"]+['"]/g)) for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) imported.add(n[0]);
    for (const name of exported) {
      const used = new RegExp(String.raw`(?<![\w$.])${name}\s*\(`).test(src);
      if (!used || imported.has(name)) continue;
      const defined = new RegExp(String.raw`(function\s+${name}\b|(const|let|var)\s+${name}\b|[{,]\s*${name}\s*[,}=]|\(\s*${name}\b)`).test(src);
      if (!defined) problems.push(`${path.relative(ROOT, file)}: ${name}`);
    }
  }
  assert.deepEqual(problems, []);
});
