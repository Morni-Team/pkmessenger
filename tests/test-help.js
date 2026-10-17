'use strict';

// Fernhilfe (Issue #79): Kopplung per Einmal-Code + Bestätigung, geschwärzte Sicht, nur erlaubte Aktionen,
// nur ein Helfer, Beenden schließt sofort. Echter HTTP-Server auf 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const nacl = require('tweetnacl');
const { createHelp, isPrivateIp } = require('../src/main/help');

const b64 = (u8) => Buffer.from(u8).toString('base64');
const seal = (obj, key) => {
  const n = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { n: b64(n), c: b64(nacl.secretbox(Buffer.from(JSON.stringify(obj)), n, key)) };
};
const unseal = (msg, key) => {
  if (!msg?.c) return msg;
  const plain = nacl.secretbox.open(new Uint8Array(Buffer.from(msg.c, 'base64')), new Uint8Array(Buffer.from(msg.n, 'base64')), key);
  return plain ? JSON.parse(Buffer.from(plain).toString('utf8')) : null;
};
const post = async (base, path, body) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
// Schlüssel steckt im Link hinter „#c=“ (wie im echten Fluss der Helfer ihn aus dem QR bekommt)
const keyFromUrl = (url) => new Uint8Array(Buffer.from(new URL(url).hash.replace('#c=', ''), 'base64'));

function setup({ approve = true, perms = undefined, extra = {}, view = { screen: 'setup', fields: [{ id: 'wizard-next', label: 'Weiter' }, { id: 'token-input', label: 'Bot-Token', secret: true }] } } = {}) {
  const events = [];
  const applied = [];
  let current = view;
  const help = createHelp({
    emit: (t, p) => {
      events.push({ t, p });
      if (t === 'help:pending' && !p.done) setImmediate(() => help.decide({ id: p.id, allow: approve, perms }));
    },
    getView: () => current,
    applyAction: (a) => applied.push(a),
    lanAddresses: () => ['127.0.0.1'],
    hostName: 'test.local',
    port: 0,
    ...extra,
  });
  return { help, events, applied, setView: (v) => (current = v) };
}

async function start(ctx) {
  const info = await ctx.help.request();
  const key = keyFromUrl(info.url);
  const base = `http://127.0.0.1:${info.port}`;
  return { ...info, key, base };
}
async function pairOk(ctx, s, name = 'Annas Helfer') {
  const res = await post(s.base, '/pair', { code: s.code, ...seal({ name, t: Date.now() }, s.key) });
  return unseal(res, s.key);
}

test('Nur private Netze', () => {
  assert.equal(isPrivateIp('192.168.1.5'), true);
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('Ab Werk aus; „Hilfe anfordern“ startet Server + Einmal-Code ohne IP im Link', async () => {
  const ctx = setup();
  assert.equal(ctx.help.status().running, false);
  const s = await start(ctx);
  assert.match(s.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(ctx.help.status().waitingForHelper, true);
  assert.match(s.url, /^http:\/\/test\.local:\d+\/help\//);
  assert.doesNotMatch(s.url.split('#')[0], /\d+\.\d+\.\d+\.\d+/);
  ctx.help.stop();
  assert.equal(ctx.help.status().running, false);
});

test('Koppeln: Code + Bestätigung → verbunden; falscher Code abgelehnt', async () => {
  const ctx = setup();
  const s = await start(ctx);
  assert.match((await post(s.base, '/pair', { code: 'WRONG1', ...seal({ name: 'X', t: Date.now() }, s.key) })).error, /Falscher Code/);
  const ok = await pairOk(ctx, s);
  assert.equal(ok.ok, true);
  assert.equal(ctx.help.status().connected, true);
  // Code ist verbraucht → zweite Kopplung scheitert
  assert.match((await post(s.base, '/pair', { code: s.code, ...seal({ name: 'Y', t: Date.now() }, s.key) })).error, /abgelaufen|bereits/);
  ctx.help.stop();
});

test('Ablehnung am PC → keine Verbindung', async () => {
  const ctx = setup({ approve: false });
  const s = await start(ctx);
  assert.match((await pairOk(ctx, s)).error, /abgelehnt|keine Antwort/);
  assert.equal(ctx.help.status().connected, false);
  ctx.help.stop();
});

test('Verbundener Helfer: geschwärzte Sicht, erlaubte Aktion, Geheimnis-Feld & Chat gesperrt, Wiederholung abgewiesen', async () => {
  const ctx = setup();
  const s = await start(ctx);
  await pairOk(ctx, s);
  const call = async (path, payload) => {
    const body = seal({ ...payload, t: Date.now() }, s.key);
    const r = await post(s.base, path, body);
    return { body, out: unseal(r, s.key) };
  };
  // Sicht: Einrichtung sichtbar, Token-Feld als geheim markiert
  const { out: view } = await call('/view', {});
  assert.equal(view.view.hidden, false);
  assert.equal(view.view.fields.find((f) => f.id === 'token-input').secret, true);
  // erlaubte Aktion kommt an
  const { body, out: act } = await call('/act', { action: { type: 'click', target: 'wizard-next' } });
  assert.equal(act.ok, true);
  assert.deepEqual(ctx.applied.at(-1), { type: 'click', target: 'wizard-next' });
  // Token-Feld: abgelehnt, nichts angewandt
  assert.match((await call('/act', { action: { type: 'click', target: 'token-input' } })).out.rejected, /Sicherheits|erlaubt/);
  assert.equal(ctx.applied.length, 1);
  // exakt gleiche Anfrage nochmal (Wiederholung) → abgewiesen
  assert.match((await post(s.base, '/act', body)).error, /Wiederhol|Ungültig/);
  // Nutzer wechselt in den Chat → Helfer sieht nichts, Aktionen gesperrt
  ctx.setView({ screen: 'workspace', fields: [] });
  assert.equal((await call('/view', {})).out.view.hidden, true);
  assert.match((await call('/act', { action: { type: 'click', target: 'wizard-next' } })).out.rejected, /Chat/);
  ctx.help.stop();
});

test('Nur Zusehen: Mitsteuern gesperrt', async () => {
  const ctx = setup();
  const s = await start(ctx);
  await pairOk(ctx, s);
  ctx.help.setControl({ on: false });
  const call = (path, payload) => post(s.base, path, seal({ ...payload, t: Date.now() }, s.key)).then((r) => unseal(r, s.key));
  assert.match((await call('/act', { action: { type: 'click', target: 'wizard-next' } })).rejected, /Zusehen/);
  assert.equal(ctx.applied.length, 0);
  ctx.help.stop();
});

test('Beenden schließt den Server sofort', async () => {
  const ctx = setup();
  const s = await start(ctx);
  await pairOk(ctx, s);
  ctx.help.stop();
  assert.equal(ctx.help.status().running, false);
  await assert.rejects(fetch(`${s.base}/view`, { method: 'POST', body: '{}' }));
});

// #170: Der Nutzer kreuzt an, was der Helfer darf
const TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAx.GxYzAB.abcdefghijklmnopqrstuvwxyz0123456789AB';
const LOGS = [
  `${new Date().toISOString()} INFO [help] Hilfe angefordert`,
  `${new Date().toISOString()} ERROR [discord] login failed token=${TOKEN}`,
  `${new Date().toISOString()} WARN [discord] Kanal „geheim-chat“ nicht sichtbar`,
];
const CHECK = { ready: true, items: [{ id: 'token', ok: true, text: 'Bot-Token gültig, angemeldet als SuperBot' }, { id: 'content', ok: true, text: 'Erlaubnis „Message Content Intent“ (Nachrichten lesen)' }, { id: 'guild:1', ok: false, text: '„Annas Server“: 1 von 3 Kanälen sichtbar', fix: 'Rolle geben' }] };

test('Rechte: ohne Haken kein Protokoll, keine Prüfung, kein Bild', async () => {
  let shots = 0;
  const ctx = setup({ perms: { screen: false, control: true, logs: false, tests: false }, extra: { getLogs: () => LOGS, runCheck: async () => CHECK, captureScreen: async () => (shots++, { img: 'data:x', w: 1, h: 1 }) } });
  const s = await start(ctx);
  await pairOk(ctx, s);
  const call = (path, payload) => post(s.base, path, seal({ ...payload, t: Date.now() }, s.key)).then((r) => unseal(r, s.key));
  assert.match((await call('/logs', {})).rejected, /nicht freigegeben/);
  assert.match((await call('/diag', {})).rejected, /nicht freigegeben/);
  assert.equal((await call('/screen', {})).screen, null);
  assert.equal(shots, 0);
  const v = await call('/view', {});
  assert.equal(v.screen, false);
  assert.deepEqual(v.perms, { screen: false, control: true, logs: false, tests: false });
  ctx.help.stop();
});

test('Rechte: mit Haken Protokoll (gefiltert, ohne Token/Namen) und Prüfung (ohne Namen); jederzeit wieder entziehbar', async () => {
  const ctx = setup({ perms: { screen: true, control: false, logs: true, tests: true }, extra: { getLogs: () => LOGS, runCheck: async () => CHECK } });
  const s = await start(ctx);
  await pairOk(ctx, s);
  const call = (path, payload) => post(s.base, path, seal({ ...payload, t: Date.now() }, s.key)).then((r) => unseal(r, s.key));
  const all = (await call('/logs', { filter: { level: 'info' } })).logs;
  assert.equal(all.length, 3);
  assert.ok(!JSON.stringify(all).includes(TOKEN.split('.')[0]));
  assert.ok(!JSON.stringify(all).includes('geheim-chat'));
  const errs = (await call('/logs', { filter: { level: 'error' } })).logs;
  assert.equal(errs.length, 1);
  assert.match(errs[0], /ERROR \[discord\]/);
  assert.equal((await call('/logs', { filter: { area: 'help' } })).logs.length, 1);
  const diag = (await call('/diag', {})).diag;
  assert.equal(diag.items.length, 3);
  assert.ok(!JSON.stringify(diag).includes('SuperBot'));
  assert.ok(!JSON.stringify(diag).includes('Annas Server'));
  assert.match(diag.items[1].text, /Message Content Intent/); // feste Begriffe bleiben lesbar
  // Mitsteuern war nicht angekreuzt
  assert.match((await call('/act', { action: { type: 'click', target: 'wizard-next' } })).rejected, /Zusehen/);
  // Nutzer entzieht das Protokoll während der Hilfe
  ctx.help.setPerms({ logs: false });
  assert.match((await call('/logs', {})).rejected, /nicht freigegeben/);
  assert.equal(ctx.help.status().perms.tests, true);
  assert.ok(ctx.help.status().activity.some((a) => /Protokoll abgerufen/.test(a.action)));
  ctx.help.stop();
  assert.deepEqual(ctx.help.status().perms, { screen: true, control: true, logs: false, tests: false }); // nach dem Beenden wieder ab Werk
});

test('IPC: Zulassen braucht das App-Passwort (falls gesetzt); „Mithelfen“-Haken schaltet wirklich EIN', async () => {
  const { buildHandlers, wrap } = require('../src/main/ipc');
  const decided = [];
  const controls = [];
  const help = { decide: (d) => (decided.push(d), true), setControl: (c) => (controls.push(c), {}), setPerms: (p) => p, status: () => ({}) };
  let lockOn = true;
  const appLock = { status: () => ({ enabled: lockOn }), verify: (pw) => { if (pw !== 'richtig') throw Object.assign(new Error('Falsches Passwort.'), { code: 'LOCK' }); }, verifyHello: async () => ({}) };
  const h = buildHandlers({ service: {}, store: { get: () => ({}) }, help, appLock, hello: { verify: async () => true } });
  const call = (ch, p) => wrap(h[ch], () => true, ch)({}, p);
  assert.equal((await call('pk:help-decide', { id: 'abcd1234', allow: true, perms: { logs: true } })).ok, false);
  assert.equal((await call('pk:help-decide', { id: 'abcd1234', allow: true, password: 'falsch' })).ok, false);
  assert.equal(decided.length, 0);
  assert.equal((await call('pk:help-decide', { id: 'abcd1234', allow: true, password: 'richtig', perms: { logs: true } })).ok, true);
  assert.deepEqual(decided[0], { id: 'abcd1234', allow: true, perms: { logs: true } });
  assert.equal((await call('pk:help-decide', { id: 'abcd1234', allow: true, hello: true })).ok, true);
  assert.equal((await call('pk:help-decide', { id: 'abcd1234', allow: false })).ok, true); // Ablehnen geht immer
  assert.equal((await call('pk:help-decide', { id: 'abcd1234', allow: true, perms: { evil: 1, logs: 'ja' } })).ok, false);
  lockOn = false;
  assert.equal((await call('pk:help-decide', { id: 'abcd1234', allow: true })).ok, true);
  await call('pk:help-control', { on: true });
  await call('pk:help-control', { on: false });
  assert.deepEqual(controls, [{ on: true }, { on: false }]);
});
