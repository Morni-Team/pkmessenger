'use strict';

// #160: Datenschutz beim ersten Start – ohne Zustimmung kein Start. Der Text muss zur App passen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PRIVACY_SECTIONS, PRIVACY_VERSION } = require('../src/shared/privacy-text');
const { buildHandlers } = require('../src/main/ipc');

test('Datenschutz-Text: vollständig, ehrlich (keine Telemetrie, nichts aufgenommen, Berichte nie automatisch)', () => {
  assert.ok(Number.isInteger(PRIVACY_VERSION) && PRIVACY_VERSION >= 1);
  const all = PRIVACY_SECTIONS.map((s) => `${s.title} ${s.text}`).join(' ');
  for (const must of [/keine Telemetrie/, /Token/, /verschlüsselt/, /KI/, /Fernhilfe/, /nichts aufgenommen/, /NIE automatisch/, /löschen/]) assert.match(all, must);
});

test('App startet nur nach Zustimmung; „Ablehnen“ beendet die App über IPC', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'App.jsx'), 'utf8');
  assert.match(app, /if \(!privacyOk\) screen = <PrivacyConsent/);
  const comp = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'components', 'PrivacyConsent.jsx'), 'utf8');
  assert.match(comp, /disabled=\{!readToEnd\}/); // erst nach dem Lesen
  let quit = 0;
  const h = buildHandlers({ quitApp: () => (quit += 1), store: { get: () => ({}) } });
  assert.equal(h['pk:quit'](), true);
  return new Promise((r) => setTimeout(() => (assert.equal(quit, 1), r()), 80));
});
