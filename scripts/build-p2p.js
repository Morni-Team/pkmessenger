'use strict';

// Direktverbindung (vibeworks #219): bündelt
//  - build/p2p-host/   verstecktes P2P-Fenster am PC (WebRTC + Nostr-Vermittlung)
//  - build/pages/      Helfer-Seite für GitHub Pages (kostenlos, kein eigener Server): help-web + p2p.js
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const common = { bundle: true, format: 'iife', platform: 'browser', target: ['chrome120', 'safari16', 'firefox115'], minify: true, legalComments: 'none', logLevel: 'warning' };

async function buildP2P() {
  const host = path.join(ROOT, 'build', 'p2p-host');
  fs.rmSync(host, { recursive: true, force: true });
  fs.mkdirSync(host, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'p2p-host', 'index.html'), path.join(host, 'index.html'));
  await esbuild.build({ ...common, entryPoints: [path.join(ROOT, 'src', 'p2p-host', 'host.js')], outfile: path.join(host, 'host.js') });

  const pages = path.join(ROOT, 'build', 'pages');
  const help = path.join(pages, 'help');
  fs.rmSync(pages, { recursive: true, force: true });
  fs.mkdirSync(help, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'help-web', 'nacl.js'), path.join(help, 'nacl.js'));
  // #152: Werbeblocker sperren gern Dateien mit „p2p“ im Namen → Direktverbindungs-Code steckt auf der Pages-Seite
  // in DERSELBEN Datei wie die Seite (app.js). Es gibt kein eigenes p2p.js mehr, das man blockieren könnte.
  const p2p = await esbuild.build({ ...common, entryPoints: [path.join(ROOT, 'src', 'help-web', 'p2p-entry.js')], write: false });
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'help-web', 'app.js'), 'utf8');
  fs.writeFileSync(path.join(help, 'app.js'), `${p2p.outputFiles[0].text}\n${appSrc}`);
  const html = fs.readFileSync(path.join(ROOT, 'src', 'help-web', 'index.html'), 'utf8');
  const pageHtml = html.replace(/\s*<script src="p2p\.js"><\/script>/, '');
  if (pageHtml === html) throw new Error('index.html: <script src="p2p.js"> nicht gefunden');
  fs.writeFileSync(path.join(help, 'index.html'), pageHtml);
  fs.writeFileSync(
    path.join(pages, 'index.html'),
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PKMessenger</title>' +
      '<p style="font-family:system-ui;padding:2rem">PKMessenger – Fernhilfe. Den Link bekommst du von der Person, der du helfen sollst. ' +
      '<a href="https://github.com/Morni-Team/pkmessenger">Projekt auf GitHub</a></p>\n',
  );
}

module.exports = { buildP2P };
if (require.main === module) {
  buildP2P().catch((err) => {
    console.error('P2P-Build fehlgeschlagen:', err.message);
    process.exit(1);
  });
}
