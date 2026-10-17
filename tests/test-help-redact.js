'use strict';

// Fernhilfe (Issue #79): Der Helfer darf NIE Chats/Namen/Nachrichten sehen und keine Sicherheits-Felder bedienen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactView, allowHelperAction, scrub, looksSecret, BLACK } = require('../src/shared/help-redact');

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
      { id: 'token-input', label: 'Bot-Token einfügen', isText: true },
      { id: 'wizard-next', label: 'Weiter', isText: false },
    ],
    cursor: { x: 0.12345, y: 0.40216 },
  });
  assert.equal(v.hidden, false);
  assert.equal(v.setup.botToken, BLACK);
  assert.equal(v.setup.step, 'intent');
  const tokenField = v.fields.find((f) => f.id === 'token-input');
  assert.equal(tokenField.secret, true);
  assert.equal(tokenField.isText, true);
  assert.match(tokenField.label, /verborgen/);
  const nextField = v.fields.find((f) => f.id === 'wizard-next');
  assert.equal(nextField.secret, false);
  assert.equal(nextField.isText, false);
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

// #170: „Helfer kann den Bot-Token sehen, wenn der Nutzer ihn aufdeckt“
test('Token am Inhalt erkannt: Feld-Beschriftung und Status-Werte werden geschwärzt', () => {
  const token = 'MTAwMDAwMDAwMDAwMDAwMDAx.GxYzAB.abcdefghijklmnopqrstuvwxyz0123456789AB';
  const v = redactView({
    screen: 'settings',
    setup: { hint: token, step: 'token' },
    fields: [
      { id: 'h3', label: token, isText: true },
      { id: 'h4', label: 'pkmessenger://login?v=1#d=QUJDREVGR0hJSktMTU5PUFFSU1RVVldY' },
      { id: 'h5', label: 'Speichern & verbinden' },
    ],
    allowed: { x: 0, y: 0, w: 1, h: 1 },
  });
  assert.equal(v.setup.hint, BLACK);
  assert.equal(v.setup.step, 'token');
  assert.deepEqual(
    v.fields.map((f) => [f.id, f.secret]),
    [['h3', true], ['h4', true], ['h5', false]],
  );
  assert.ok(!JSON.stringify(v).includes(token.split('.')[0]));
  assert.equal(allowHelperAction({ type: 'click', target: 'h3' }, { view: { screen: 'settings', fields: [{ id: 'h3', label: token }] } }).ok, false);
});

test('looksSecret: Token, Anmelde-Link und lange Schlüssel ja – normale Texte nein', () => {
  assert.equal(looksSecret('MTAwMDAwMDAwMDAwMDAwMDAx.GxYzAB.abcdefghijklmnopqrstuvwxyz0123'), true);
  assert.equal(looksSecret('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD'), true);
  assert.equal(looksSecret('Bot-Token aus dem Developer Portal'), false);
  assert.equal(looksSecret('wss://relay.example.com/ws'), false);
  assert.equal(looksSecret('Speichern & verbinden'), false);
});

test('IPC: „Anderes Gerät anmelden“ und Kopplungs-QR sind während der Fernhilfe gesperrt', async () => {
  const { buildHandlers, wrap } = require('../src/main/ipc');
  let hs = { connected: true, waitingForHelper: false };
  const tokenStore = { load: () => ({ status: 'ok', token: 'MTAwMDAwMDAwMDAwMDAwMDAx.GxYzAB.abcdefghijklmnopqrstuvwxyz0123456789AB' }), info: () => ({ stored: true }) };
  let paired = 0;
  const remote = { createPairingWithQr: () => (paired += 1, { qr: 'data:', url: 'x' }), status: () => ({}) };
  const h = buildHandlers({ service: {}, store: { get: () => ({}) }, tokenStore, remote, help: { status: () => hs } });
  const call = (ch) => wrap(h[ch], () => true, ch)({}, undefined);
  const blocked = await call('pk:token-share');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error.message, /Fernhilfe/);
  assert.equal((await call('pk:remote-pair')).ok, false);
  assert.equal(paired, 0);
  hs = { connected: false, waitingForHelper: true };
  assert.equal((await call('pk:token-share')).ok, false);
  hs = { connected: false, waitingForHelper: false };
  assert.equal((await call('pk:token-share')).ok, true);
  assert.equal((await call('pk:remote-pair')).ok, true);
  assert.equal(paired, 1);
});
