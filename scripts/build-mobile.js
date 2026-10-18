'use strict';

// Baut die Oberfläche der Android-App (Issue #56) nach mobile/www (Capacitor kopiert sie in die APK).
// Gleiche React-Oberfläche wie am PC + Brücke (src/mobile) statt Electron-Preload.
//   node scripts/build-mobile.js          → Release-Build
//   node scripts/build-mobile.js --demo   → mit simuliertem Discord (nur für Bildtests am PC, nie in der Release-APK)
//   node scripts/build-mobile.js --autoplay → Demo + automatischer Durchlauf für den Emulator-Test der CI
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'mobile', 'www');
const autoplay = process.argv.includes('--autoplay'); // Emulator-Test der CI
const demo = autoplay || process.argv.includes('--demo');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** API-Namen → IPC-Kanal und erlaubte Ereignisse direkt aus preload.js (eine Quelle, kein Abschreiben) */
function readPreload() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  const map = Object.fromEntries([...src.matchAll(/^\s+(\w+): call\('(pk:[\w-]+)'\)/gm)].map((m) => [m[1], m[2]]));
  const ev = /EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  const events = [...(ev?.[1] || '').matchAll(/'([\w:-]+)'/g)].map((m) => m[1]);
  if (Object.keys(map).length < 50 || events.length < 10) throw new Error('preload.js konnte nicht gelesen werden');
  return { map, events };
}

function repoOf(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  const m = /^(?:github:)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(raw || '');
  return m && m[1] !== 'DEIN-GITHUB-NAME' ? `${m[1]}/${m[2]}` : null;
}

// src/main/discord.js lädt './env' (Dateisystem) → auf Android der Ersatz ohne .env
const envShim = {
  name: 'pk-env-shim',
  setup(b) {
    b.onResolve({ filter: /^\.\/env$/ }, (args) => (args.importer.includes(`${path.sep}src${path.sep}main${path.sep}`) ? { path: path.join(ROOT, 'src', 'mobile', 'env-shim.js') } : undefined));
  },
};

// #177: Sprache gibt es am Handy nicht – den KI-Rauschfilter (WASM, ~350 KB) nicht ins Android-Bündel packen
const denoiseStub = {
  name: 'pk-denoise-stub',
  setup(b) {
    b.onResolve({ filter: /^@sapphi-red\/web-noise-suppressor/ }, () => ({ path: 'denoise-stub', namespace: 'pk-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'pk-stub' }, () => ({ contents: 'export default new Uint8Array(0); export const RnnoiseWorkletNode = null; export const GtcrnWorkletNode = null;', loader: 'js' }));
  },
};

async function main() {
  const { map, events } = readPreload();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'mobile', 'index.html'), path.join(OUT, 'index.html'));
  // Styles: PC-Styles + Handy-Layout
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src', 'mobile', 'mobile.css'), 'utf8');
  fs.writeFileSync(path.join(OUT, 'styles.src.css'), css);

  const common = {
    bundle: true,
    platform: 'browser',
    target: ['chrome120'], // Android System WebView (aktuelle Geräte aktualisieren sie über den Play Store)
    minify: !demo,
    legalComments: 'none',
    logLevel: 'warning',
    nodePaths: [path.join(ROOT, 'mobile', 'node_modules'), path.join(ROOT, 'node_modules')],
  };
  await esbuild.build({
    ...common,
    entryPoints: { app: path.join(ROOT, 'src', 'mobile', autoplay ? 'index-autoplay.js' : demo ? 'index-demo.js' : 'index.js') },
    outdir: OUT,
    format: 'iife',
    jsx: 'automatic',
    plugins: [envShim, denoiseStub],
    define: {
      'process.env.NODE_ENV': JSON.stringify(demo ? 'development' : 'production'),
      __PK_API_MAP__: JSON.stringify(map),
      __PK_EVENT_TYPES__: JSON.stringify(events),
      __PK_VERSION__: JSON.stringify(pkg.version),
      __PK_REPO__: JSON.stringify(repoOf(pkg.repository)),
      __PK_DEV__: JSON.stringify(demo),
    },
  });
  await esbuild.build({ ...common, entryPoints: { styles: path.join(OUT, 'styles.src.css') }, outdir: OUT, loader: { '.css': 'css' } });
  fs.rmSync(path.join(OUT, 'styles.src.css'));
  const size = (f) => `${Math.round(fs.statSync(path.join(OUT, f)).size / 1024)} KB`;
  console.log(`Android-Oberfläche gebaut (${demo ? 'DEMO' : 'Release'}, v${pkg.version}): app.js ${size('app.js')}, styles.css ${size('styles.css')}, ${Object.keys(map).length} API-Funktionen`);
}

main().catch((err) => {
  console.error('Android-Build fehlgeschlagen:', err.message);
  process.exit(1);
});
