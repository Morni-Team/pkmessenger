'use strict';

// Fernhilfe (Issue #79): Der Helfer darf NIE Chats/Namen/Nachrichten sehen und keine Sicherheits-Felder bedienen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactView, allowHelperAction, scrub, BLACK } = require('../src/shared/help-redact');

test('Im Chat-Bereich ist für den Helfer alles verborgen', () => {
  const v = redactView({ screen: 'workspace', fields: [{ id: 'composer', label: 'Nachricht schreiben' }] });
  assert.equal(v.hidden, true);
  assert.match(v.note, /verborgen/);
});

test('scrub entfernt Nachrichten, Namen und Geheimnisse, lässt Harmloses stehen', () => {
  const data = {
    botToken: 'MTxx.secret.value',
    appPassword: 'geheim',
    channels: [{ id: '1', name: 'allgemein', preview: 'Hallo Welt', unread: 3 }],
    author: { username: 'Anna', id: '555' },
    step: 'token',
    count: 7,
  };
  const s = scrub(data);
  assert.equal(s.botToken, BLACK);
  assert.equal(s.appPassword, BLACK);
  assert.equal(s.channels[0].name, BLACK);
  assert.equal(s.channels[0].preview, BLACK);
  assert.equal(s.channels[0].unread, 3); // Zahlen bleiben
  assert.equal(s.channels[0].id, '1');
  assert.equal(s.author.username, BLACK);
  assert.equal(s.author.id, '555');
  assert.equal(s.step, 'token'); // kurzer harmloser Status bleibt
  assert.equal(s.count, 7);
});

test('Einrichtungs-Ansicht: Status sichtbar, Token-Feld als verborgen markiert, Cursor als Anteil (0…1, #158)', () => {
  const v = redactView({
    screen: 'setup',
    setup: { step: 'intent', botToken: 'MTxx.secret' },
    fields: [
      { id: 'token-input', label: 'Bot-Token einfügen' },
      { id: 'wizard-next', label: 'Weiter' },
    ],
    cursor: { x: 0.12345, y: 0.40216 },
  });
  assert.equal(v.hidden, false);
  assert.equal(v.setup.botToken, BLACK);
  assert.equal(v.setup.step, 'intent');
  const tokenField = v.fields.find((f) => f.id === 'token-input');
  assert.equal(tokenField.secret, true);
  assert.match(tokenField.label, /verborgen/);
  assert.equal(v.fields.find((f) => f.id === 'wizard-next').secret, false);
  assert.deepEqual(v.cursor, { x: 0.123, y: 0.402 });
});

test('Helfer-Aktionen: nur sichtbare, nicht-geheime Ziele; Sicherheits-Felder nie', () => {
  const view = {
    screen: 'setup',
    fields: [
      { id: 'wizard-next', label: 'Weiter' },
      { id: 'servername', label: 'Servername' },
      { id: 'token-input', label: 'Bot-Token', secret: true },
    ],
  };
  assert.equal(allowHelperAction({ type: 'click', target: 'wizard-next' }, { view }).ok, true);
  assert.equal(allowHelperAction({ type: 'type', target: 'servername', text: 'Mein Server' }, { view }).ok, true);
  assert.equal(allowHelperAction({ type: 'click', target: 'token-input' }, { view }).ok, false);
  assert.equal(allowHelperAction({ type: 'type', target: 'token-input', text: 'x' }, { view }).ok, false);
  assert.equal(allowHelperAction({ type: 'click', target: 'gibtsnicht' }, { view }).ok, false);
  assert.equal(allowHelperAction({ type: 'evil', target: 'wizard-next' }, { view }).ok, false);
});

test('Aktionen blockiert: Hilfe aus, nur Zusehen, oder im Chat', () => {
  const view = { screen: 'setup', fields: [{ id: 'wizard-next', label: 'Weiter' }] };
  assert.match(allowHelperAction({ type: 'click', target: 'wizard-next' }, { view, enabled: false }).reason, /aus/);
  assert.match(allowHelperAction({ type: 'click', target: 'wizard-next' }, { view, controlAllowed: false }).reason, /Zusehen/);
  assert.match(allowHelperAction({ type: 'click', target: 'wizard-next' }, { view: { screen: 'workspace' } }).reason, /Chat/);
});
