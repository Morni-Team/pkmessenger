'use strict';

// Bündelt die React-Oberfläche mit esbuild nach build/renderer (kein Dev-Server, keine Node-APIs im Renderer).
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { buildP2P } = require('./build-p2p');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const OUT = path.join(ROOT, 'build', 'renderer');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'index.html'), path.join(OUT, 'index.html'));
  // #177: KI-Rauschfilter – fertige AudioWorklet-Skripte aus dem Paket als eigene Dateien (CSP: script-src 'self')
  for (const [name, file] of [['rnnoise-worklet.js', 'rnnoiseWorklet.js'], ['gtcrn-worklet.js', 'gtcrnWorklet.js']]) {
    fs.copyFileSync(require.resolve(`@sapphi-red/web-noise-suppressor/${file}`), path.join(OUT, name));
  }

  const options = {
    entryPoints: {
      app: path.join(SRC, 'index.jsx'),
      styles: path.join(SRC, 'styles.css'),
      // AudioWorklet muss eine eigene Datei sein (CSP: script-src 'self')
      'voice-worklet': path.join(SRC, 'voice', 'capture-worklet.js'),
    },
    outdir: OUT,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome152'],
    jsx: 'automatic',
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    legalComments: 'none',
    loader: { '.wasm': 'binary' }, // #177: WASM des Rauschfilters steckt im Bundle (CSP: connect-src 'none' → kein fetch)
    define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
    logLevel: 'info',
  };

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('Renderer-Build beobachtet Änderungen …');
  } else {
    await esbuild.build(options);
  }
  await buildP2P(); // Direktverbindung (vibeworks #219)
}

main().catch((err) => {
  console.error('Renderer-Build fehlgeschlagen:', err.message);
  process.exit(1);
});
