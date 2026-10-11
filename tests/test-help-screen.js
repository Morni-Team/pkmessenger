'use strict';

// #158: Der Helfer sieht ein echtes Bild der App – aber nur den erlaubten Bereich. Alles andere wird im Hauptprozess
// geschwärzt, bevor das Bild den PC verlässt. Im Chat-Bereich gibt es gar kein Bild.
const test = require('node:test');
const assert = require('node:assert/strict');
const { captureForHelper, maskBitmap, rectsToHide, outside } = require('../src/main/help-screen');
const { redactView, allowHelperAction } = require('../src/shared/help-redact');

// Mini-„nativeImage“: Bitmap im Speicher, damit wir prüfen können, welche Pixel geschwärzt wurden
function fakeImage(width, height, fill = 200) {
  const buf = Buffer.alloc(width * height * 4, fill);
  return { getSize: () => ({ width, height }), toBitmap: () => buf, isEmpty: () => false, buf };
}
const fakeNative = {
  createFromBitmap: (buf, size) => ({ buf, getSize: () => size, resize: function () { return this; }, toJPEG: () => Buffer.from('jpeg') }),
};
const px = (buf, w, x, y) => buf[(y * w + x) * 4];

test('Außerhalb des Einstellungs-Fensters, private Stellen und Geheimnis-Felder werden schwarz – der Rest bleibt', async () => {
  const img = fakeImage(100, 100);
  let captured = null;
  const view = {
    screen: 'settings',
    allowed: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 },
    masks: [{ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }], // z. B. eine Benachrichtigung mit Nachrichtentext
    fields: [
      { id: 'h1', label: 'Weiter', rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.05 } },
      { id: 'h2', label: 'App-Passwort', secret: true, rect: { x: 0.6, y: 0.7, w: 0.1, h: 0.05 } },
    ],
  };
  const out = await captureForHelper({ view, capture: async () => ((captured = img), img), nativeImage: fakeNative });
  assert.match(out.img, /^data:image\/jpeg;base64,/);
  const b = captured.buf;
  assert.notEqual(px(b, 100, 10, 10), 200); // außerhalb (Chats dahinter) → schwarz
  assert.notEqual(px(b, 100, 90, 50), 200);
  assert.notEqual(px(b, 100, 35, 35), 200); // private Stelle → schwarz
  assert.notEqual(px(b, 100, 65, 72), 200); // Passwort-Feld → schwarz
  assert.equal(px(b, 100, 55, 52), 200); // normaler Knopf → sichtbar
  assert.equal(px(b, 100, 50, 40), 200);
});

test('Chat-Bereich oder unbekannter Bereich: gar kein Bild', async () => {
  let called = false;
  const cap = async () => ((called = true), fakeImage(10, 10));
  assert.equal(await captureForHelper({ view: { screen: 'workspace', allowed: { x: 0, y: 0, w: 1, h: 1 } }, capture: cap, nativeImage: fakeNative }), null);
  assert.equal(await captureForHelper({ view: { screen: 'settings' }, capture: cap, nativeImage: fakeNative }), null); // ohne erlaubten Bereich
  assert.equal(called, false);
  // falsches Bitmap-Format → lieber kein Bild
  const odd = { getSize: () => ({ width: 10, height: 10 }), toBitmap: () => Buffer.alloc(7), isEmpty: () => false };
  assert.equal(await captureForHelper({ view: { screen: 'setup', allowed: { x: 0, y: 0, w: 1, h: 1 } }, capture: async () => odd, nativeImage: fakeNative }), null);
});

test('Rechtecke: außerhalb in 4 Teile, kaputte Werte fliegen raus, ohne erlaubten Bereich alles schwarz', () => {
  assert.equal(outside({ x: 0.2, y: 0.2, w: 0.6, h: 0.6 }).length, 4);
  assert.equal(outside({ x: 0, y: 0, w: 1, h: 1 }).length, 0);
  assert.deepEqual(rectsToHide({ allowed: null }), [{ x: 0, y: 0, w: 1, h: 1 }]);
  const v = redactView({ screen: 'settings', allowed: { x: 0, y: 0, w: 5, h: 1 }, masks: [{ x: 'a' }, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }], cursor: { x: 0.5, y: 2 } });
  assert.equal(v.allowed, null); // w: 5 ist kein Anteil
  assert.equal(v.masks.length, 1);
  assert.equal(v.cursor, null);
  const buf = Buffer.alloc(4 * 4 * 4, 255);
  maskBitmap(buf, 4, 4, [{ x: 0, y: 0, w: 0.5, h: 0.5 }]);
  assert.equal(buf[0], 17);
  assert.equal(buf[(3 * 4 + 3) * 4], 255);
});

test('Maus: als Anteil 0…1 (passt bei jeder Größe); Helfer-Maus nur mit gültigen Werten', () => {
  const v = redactView({ screen: 'settings', cursor: { x: 0.25, y: 0.75 } });
  assert.deepEqual(v.cursor, { x: 0.25, y: 0.75 });
  assert.equal(redactView({ screen: 'workspace', cursor: { x: 0.25, y: 0.75 } }).cursor, null); // im Chat nie
  const view = { screen: 'settings', fields: [] };
  assert.equal(allowHelperAction({ type: 'cursor', x: 0.5, y: 0.5 }, { view }).ok, true);
  assert.equal(allowHelperAction({ type: 'cursor', x: 800, y: 600 }, { view }).ok, false);
});

test('#160 Neue Helfer-Aktionen: Einstellungen öffnen + Chat auch im Chat-Bereich, Zeichnen nur außerhalb, alles geprüft', () => {
  const chatView = { screen: 'workspace' };
  const settingsView = { screen: 'settings', fields: [] };
  assert.equal(allowHelperAction({ type: 'open-settings' }, { view: chatView }).ok, true);
  assert.equal(allowHelperAction({ type: 'chat', text: 'Hallo!' }, { view: chatView }).ok, true);
  assert.equal(allowHelperAction({ type: 'chat', text: 'Hallo!' }, { view: chatView, controlAllowed: false }).ok, true); // nur Zusehen: chatten geht
  assert.equal(allowHelperAction({ type: 'open-settings' }, { view: chatView, controlAllowed: false }).ok, false);
  assert.equal(allowHelperAction({ type: 'chat', text: 'x'.repeat(301) }, { view: chatView }).ok, false);
  assert.equal(allowHelperAction({ type: 'chat', text: '   ' }, { view: chatView }).ok, false);
  assert.equal(allowHelperAction({ type: 'draw', points: [[0.1, 0.1], [0.2, 0.2]] }, { view: settingsView }).ok, true);
  assert.equal(allowHelperAction({ type: 'draw', points: [[0.1, 0.1], [0.2, 0.2]] }, { view: chatView }).ok, false); // im Chat nie
  assert.equal(allowHelperAction({ type: 'draw', points: [[0.1, 0.1]] }, { view: settingsView }).ok, false);
  assert.equal(allowHelperAction({ type: 'draw', points: Array.from({ length: 201 }, () => [0.5, 0.5]) }, { view: settingsView }).ok, false);
  assert.equal(allowHelperAction({ type: 'draw', points: [[0.1, 0.1], [5, 0.2]] }, { view: settingsView }).ok, false);
  assert.equal(allowHelperAction({ type: 'clear-draw' }, { view: settingsView }).ok, true);
});

test('#160 Hilfe-Chat: Helfer-Nachricht kommt als Chat an (nicht als Klick), Nutzer antwortet, Verlauf endet mit der Hilfe', async () => {
  const nacl = require('tweetnacl');
  const { createHelp } = require('../src/main/help');
  const { validators } = require('../src/main/validate');
  const events = [];
  const applied = [];
  const help = createHelp({
    emit: (t, p) => {
      events.push([t, p]);
      if (t === 'help:pending' && !p.done) setImmediate(() => help.decide({ id: p.id, allow: true }));
    },
    getView: () => ({ screen: 'workspace' }),
    applyAction: (a) => applied.push(a),
    getRelay: () => null,
    hostName: 'pc.local',
    port: 0,
    bindHost: '127.0.0.1',
    lanAddresses: () => ['127.0.0.1'],
  });
  const r = await help.request();
  const key = new Uint8Array(Buffer.from(new URL(r.url).hash.replace('#c=', ''), 'base64url'));
  const seal = (obj) => {
    const n = nacl.randomBytes(24);
    return { n: Buffer.from(n).toString('base64'), c: Buffer.from(nacl.secretbox(Buffer.from(JSON.stringify(obj)), n, key)).toString('base64') };
  };
  const base = `http://127.0.0.1:${help._test.handleAddress().port}`;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  await post('/pair', { code: r.code, ...seal({ name: 'Alex', t: Date.now() }) });
  await post('/act', seal({ t: Date.now(), action: { type: 'chat', text: 'Klick mal auf Einstellungen' } }));
  assert.equal(applied.length, 0); // Chat ist keine Aktion in der Oberfläche
  assert.ok(events.some(([t, p]) => t === 'help:chat' && p.from === 'helfer' && p.text === 'Klick mal auf Einstellungen'));
  assert.deepEqual(validators.helpChat({ text: '  Okay!  ' }), { text: 'Okay!' });
  assert.throws(() => validators.helpChat({ text: '' }), /1 bis 300/);
  const res = help.chat({ text: 'Okay!' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.chat.map((m) => m.from), ['helfer', 'nutzer']);
  await post('/act', seal({ t: Date.now(), action: { type: 'open-settings' } })); // geht auch aus dem Chat-Bereich
  assert.deepEqual(applied, [{ type: 'open-settings' }]);
  help.stop();
  assert.deepEqual(help.chatLog(), []);
});

test('#161 Scrollen am Mauspunkt geprüft; Maus trägt den Helfer-Namen; unverändertes Bild wird nicht erneut geschickt', async () => {
  const view = { screen: 'settings', fields: [] };
  assert.equal(allowHelperAction({ type: 'scroll', dir: 'down', x: 0.5, y: 0.7 }, { view }).ok, true);
  assert.equal(allowHelperAction({ type: 'scroll', dir: 'down' }, { view }).ok, true);
  assert.equal(allowHelperAction({ type: 'scroll', dir: 'down', x: 4, y: 0.7 }, { view }).ok, false);
  assert.equal(allowHelperAction({ type: 'scroll', dir: 'down', x: 0.5, y: 0.5 }, { view: { screen: 'workspace' } }).ok, false); // im Chat nie

  const nacl = require('tweetnacl');
  const { createHelp } = require('../src/main/help');
  const applied = [];
  let shots = 0;
  const help = createHelp({
    emit: (t, p) => t === 'help:pending' && !p.done && setImmediate(() => help.decide({ id: p.id, allow: true })),
    getView: () => ({ screen: 'settings', allowed: { x: 0, y: 0, w: 1, h: 1 }, fields: [] }),
    applyAction: (a) => applied.push(a),
    captureScreen: async () => ((shots += 1), { img: 'data:image/jpeg;base64,AAAA', w: 10, h: 10 }),
    getRelay: () => null,
    hostName: 'pc.local',
    port: 0,
    bindHost: '127.0.0.1',
    lanAddresses: () => ['127.0.0.1'],
  });
  const r = await help.request();
  const key = new Uint8Array(Buffer.from(new URL(r.url).hash.replace('#c=', ''), 'base64url'));
  const seal = (obj) => {
    const n = nacl.randomBytes(24);
    return { n: Buffer.from(n).toString('base64'), c: Buffer.from(nacl.secretbox(Buffer.from(JSON.stringify(obj)), n, key)).toString('base64') };
  };
  const open = (m) => JSON.parse(Buffer.from(nacl.secretbox.open(new Uint8Array(Buffer.from(m.c, 'base64')), new Uint8Array(Buffer.from(m.n, 'base64')), key)).toString());
  const base = `http://127.0.0.1:${help._test.handleAddress().port}`;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  await post('/pair', { code: r.code, ...seal({ name: 'Alex', t: Date.now() }) });
  await post('/act', seal({ t: Date.now(), action: { type: 'cursor', x: 0.4, y: 0.6 } }));
  assert.deepEqual(applied[0], { type: 'cursor', x: 0.4, y: 0.6, name: 'Alex' });
  const first = open(await post('/screen', seal({ t: Date.now(), have: 0 })));
  assert.equal(first.screen.img, 'data:image/jpeg;base64,AAAA');
  await new Promise((x) => setTimeout(x, 300));
  const again = open(await post('/screen', seal({ t: Date.now(), have: first.screen.id })));
  assert.deepEqual(again.screen, { same: true, id: first.screen.id }); // nur „gleich“ statt Bild
  assert.ok(shots >= 2);
  help.stop();
});

test('#160 Zusammenfassung nach der Hilfe: Klicks mit Beschriftung, nie eingegebener Text; nur einmal; leer → keine', async () => {
  const nacl = require('tweetnacl');
  const { createHelp } = require('../src/main/help');
  const events = [];
  const view = { screen: 'settings', fields: [{ id: 'h1', label: 'Aussehen' }, { id: 'h2', label: 'Servername' }, { id: 'h3', label: 'App-Passwort', secret: true }] };
  const help = createHelp({
    emit: (t, p) => {
      events.push([t, p]);
      if (t === 'help:pending' && !p.done) setImmediate(() => help.decide({ id: p.id, allow: true }));
    },
    getView: () => view,
    applyAction: () => {},
    getRelay: () => null,
    hostName: 'pc.local',
    port: 0,
    bindHost: '127.0.0.1',
    lanAddresses: () => ['127.0.0.1'],
  });
  const r = await help.request();
  const key = new Uint8Array(Buffer.from(new URL(r.url).hash.replace('#c=', ''), 'base64url'));
  const seal = (obj) => {
    const n = nacl.randomBytes(24);
    return { n: Buffer.from(n).toString('base64'), c: Buffer.from(nacl.secretbox(Buffer.from(JSON.stringify(obj)), n, key)).toString('base64') };
  };
  const base = `http://127.0.0.1:${help._test.handleAddress().port}`;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  await post('/pair', { code: r.code, ...seal({ name: 'Alex', t: Date.now() }) });
  const act = (action) => post('/act', seal({ t: Date.now(), action }));
  await act({ type: 'click', target: 'h1' });
  await act({ type: 'type', target: 'h2', text: 'Geheimer Servername 123' });
  await act({ type: 'click', target: 'h3' }); // abgelehnt → nicht in der Liste
  await act({ type: 'cursor', x: 0.5, y: 0.5 }); // Maus → nicht in der Liste
  await act({ type: 'draw', points: [[0.1, 0.1], [0.2, 0.2]] });
  await act({ type: 'draw', points: [[0.1, 0.1], [0.2, 0.2]] });
  await act({ type: 'chat', text: 'Fertig!' });
  help.stop({ reason: 'knopf' });
  const sums = events.filter(([t]) => t === 'help:summary').map(([, p]) => p);
  assert.equal(sums.length, 1);
  const s = sums[0];
  assert.equal(s.helper, 'Alex');
  assert.equal(s.chats, 1);
  assert.deepEqual(s.actions.map((a) => `${a.text}|${a.label}|${a.count || 1}`), ['Geklickt|Aussehen|1', 'Eingegeben in|Servername|1', 'Gezeichnet||2']);
  assert.doesNotMatch(JSON.stringify(s), /Geheimer Servername/); // eingegebener Text taucht nie auf
  help.stop();
  assert.equal(events.filter(([t]) => t === 'help:summary').length, 1); // nicht doppelt
});
