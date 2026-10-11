'use strict';

// Fernzugang unterwegs über den selbst gehosteten Relay (#104/#105). Ein Fake-WebSocket spielt den Relay:
// der PC verbindet sich ausgehend als „host", das Handy schickt Frames {id, path, body}, die App antwortet {id, reply}.
// Geprüft: gleiche Sicherheit wie im WLAN (Einmal-Code, Passwort, Bestätigung am PC, Geräteschlüssel, Sitzung,
// Wiederholungsschutz), Unterwegs-Link ohne IP, Neuverbindung, neuer Raum, sauberes Abschalten.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRemote, seal, unseal } = require('../src/main/remote');
const { validators } = require('../src/main/validate');

class FakeWS extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWS.all.push(this);
    setImmediate(() => this.emit('open'));
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed = true;
    this.emit('close');
  }
  // Relay → App
  deliver(obj) {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }
  // Relay trennt von sich aus (Neustart, Raum abgelaufen)
  drop() {
    this.emit('close');
  }
}
FakeWS.all = [];
const last = () => FakeWS.all.at(-1);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function setup({ relay = true, approve = true } = {}) {
  FakeWS.all = [];
  const data = { remote: { port: 0 } };
  const store = { get: () => ({ ...data }), set: (k, v) => (data[k] = v) };
  let vaultRaw = null;
  const vault = { get: () => vaultRaw, set: (v) => (vaultRaw = v), clear: () => (vaultRaw = null) };
  const sent = [];
  const timers = [];
  const service = {
    listGuilds: () => [{ id: '222222222222222222', name: 'Testserver' }],
    listChannels: async () => [],
    listDMs: async () => [],
    getMessages: async () => ({ messages: [] }),
    sendMessage: async (p) => (sent.push(p), { id: '2' }),
    getStatus: () => ({ bot: { displayName: 'PK' } }),
  };
  let relayCfg = relay ? { wss: 'wss://relay.test/ws', httpBase: 'https://relay.test' } : null;
  const remote = createRemote({
    service,
    validators,
    store,
    vault,
    emit: (t, p) => {
      if (t === 'remote:pending' && !p.done) setImmediate(() => remote.decide({ id: p.id, allow: approve }));
    },
    webDir: path.join(__dirname, '..', 'src', 'remote-web'),
    naclPath: require.resolve('tweetnacl/nacl-fast.min.js'),
    lanAddresses: () => ['127.0.0.1'],
    bindHost: '127.0.0.1',
    hostName: null, // PC-Name taugt nicht → nur der Unterwegs-Link
    getRelay: () => relayCfg,
    WebSocketImpl: FakeWS,
    setTimeoutImpl: (fn, ms) => {
      const t = { fn, ms, unref() {} };
      timers.push(t);
      return t;
    },
  });
  return { remote, store, data, sent, timers, setRelay: (v) => (relayCfg = v) };
}

async function enable(ctx) {
  ctx.remote.setPassword({ password: 'geheim12345' });
  await ctx.remote.setEnabled({ on: true });
  await tick();
  const ws = last();
  ws.deliver({ relay: 'joined', peer: false });
  return ws;
}

// Handy schickt über den Relay einen Frame und wartet auf die Antwort der App
async function frame(ws, id, p, body) {
  ws.deliver({ id, path: p, body });
  for (let i = 0; i < 50; i++) {
    await tick(5);
    const r = ws.sent.find((m) => m.id === id);
    if (r) return r.reply;
  }
  throw new Error(`keine Antwort auf ${id}`);
}

test('PC verbindet sich ausgehend als host in einen festen, zufälligen Raum; Status zeigt „erreichbar“', async () => {
  const ctx = setup();
  const ws = await enable(ctx);
  assert.equal(ws.url, 'wss://relay.test/ws');
  const join = ws.sent[0];
  assert.equal(join.role, 'host');
  assert.match(join.room, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(ctx.data.remote.relayRoom, join.room); // Raum bleibt gleich (Geräte finden den PC wieder)
  assert.deepEqual(ctx.remote.status().relay, { configured: true, connected: true, base: 'https://relay.test', error: null });
  await ctx.remote.stop();
});

test('Unterwegs koppeln + anmelden + Nachricht senden – gleiche Prüfungen wie im WLAN', async () => {
  const ctx = setup();
  const ws = await enable(ctx);
  const room = ws.sent[0].room;
  const p = ctx.remote.createPairing();
  assert.equal(p.url, null); // kein WLAN-Link ohne tauglichen PC-Namen
  assert.match(p.relayUrl, /^https:\/\/relay\.test\/remote\/#p=[\w-]+&k=[\w-]+&r=[\w-]+$/);
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(p.relayUrl)); // keine IP im Link
  const h = new URLSearchParams(p.relayUrl.split('#')[1]);
  assert.equal(h.get('r'), room);
  const pairKey = new Uint8Array(Buffer.from(h.get('k'), 'base64url'));

  // falsches Passwort → abgelehnt
  let r = unseal(await frame(ws, '1', '/api/pair', { p: h.get('p'), ...seal({ password: 'falsch!!!', name: 'Handy', t: Date.now() }, pairKey) }), pairKey);
  assert.equal(r.error, 'Falsches Passwort.');
  // richtiges Passwort → Bestätigung am PC → Gerät
  r = unseal(await frame(ws, '2', '/api/pair', { p: h.get('p'), ...seal({ password: 'geheim12345', name: 'Handy', t: Date.now() }, pairKey) }), pairKey);
  assert.ok(r.deviceId && r.deviceKey);
  const devKey = new Uint8Array(Buffer.from(r.deviceKey, 'base64'));
  // Einmal-Code ist verbraucht
  const again = await frame(ws, '3', '/api/pair', { p: h.get('p'), ...seal({ password: 'geheim12345', t: Date.now() }, pairKey) });
  assert.match(again.error, /abgelaufen oder schon benutzt/);

  // Anmelden mit Passwort → Sitzung
  const login = unseal(await frame(ws, '4', '/api', { d: r.deviceId, ...seal({ op: 'login', args: { password: 'geheim12345' }, t: Date.now() }, devKey) }), devKey);
  assert.ok(login.session);
  // Senden geht als Bot, ohne Pings
  const sealed = seal({ op: 'send', args: { channelId: '444444444444444401', content: 'Hallo von unterwegs' }, session: login.session, t: Date.now() }, devKey);
  const sendRes = unseal(await frame(ws, '5', '/api', { d: r.deviceId, ...sealed }), devKey);
  assert.ok(sendRes.data);
  assert.equal(ctx.sent[0].content, 'Hallo von unterwegs');
  assert.deepEqual(ctx.sent[0].mentions, { users: [], roles: [], everyone: false });
  // Wiederholung desselben Pakets (Replay) → abgelehnt
  const replay = await frame(ws, '6', '/api', { d: r.deviceId, ...sealed });
  assert.equal(replay.error, 'Ungültige Anfrage.');
  // Ohne Sitzung → nichts
  const noSess = unseal(await frame(ws, '7', '/api', { d: r.deviceId, ...seal({ op: 'guilds', t: Date.now() }, devKey) }), devKey);
  assert.equal(noSess.relogin, true);
  // Unbekanntes Gerät / Müll → sauber abgewiesen, kein Absturz
  assert.equal((await frame(ws, '8', '/api', { d: 'gibtsnicht' })).unpaired, true);
  assert.equal((await frame(ws, '9', '/api', null)).error, 'Ungültige Anfrage.');
  assert.deepEqual(await frame(ws, '10', '/etc/passwd', {}), {});
  // Kaputte Frames werden ignoriert
  ws.emit('message', Buffer.from('kein json'));
  ws.deliver({ id: 5, path: '/api' });
  await ctx.remote.stop();
});

test('Relay weg → PC verbindet sich von selbst neu (mit wachsender Pause); Abschalten beendet alles', async () => {
  const ctx = setup();
  const ws = await enable(ctx);
  ws.drop(); // Relay-Neustart / Raum abgelaufen
  assert.equal(ctx.remote.status().relay.connected, false);
  assert.equal(ctx.timers.length, 1);
  assert.equal(ctx.timers[0].ms, 2000);
  ctx.timers[0].fn(); // Neuverbindung
  await tick();
  assert.equal(FakeWS.all.length, 2);
  assert.equal(last().sent[0].room, ws.sent[0].room); // derselbe Raum
  last().drop();
  assert.equal(ctx.timers[1].ms, 4000); // Pause wächst
  await ctx.remote.setEnabled({ on: false });
  assert.equal(ctx.remote.status().relay.connected, false);
  const before = FakeWS.all.length;
  ctx.timers[1].fn(); // ein alter Timer feuert trotzdem → keine neue Verbindung, weil Fernzugang aus ist
  await tick();
  assert.equal(FakeWS.all.length, before);
});

test('Neuer Relay-Raum macht alte Unterwegs-Links ungültig; Relay-Adresse ändern verbindet neu', async () => {
  const ctx = setup();
  const ws = await enable(ctx);
  const oldRoom = ws.sent[0].room;
  ctx.remote.setOptions({ newRoom: true });
  await tick();
  assert.equal(ws.closed, true);
  const fresh = last();
  assert.notEqual(fresh.sent[0].room, oldRoom);
  ctx.setRelay({ wss: 'wss://anderer.test/ws', httpBase: 'https://anderer.test' });
  ctx.remote.refreshRelay();
  await tick();
  assert.equal(last().url, 'wss://anderer.test/ws');
  await ctx.remote.stop();
});

test('Ohne Relay-Adresse: kein Relay, und ohne PC-Namen gibt es auch keinen Link', async () => {
  const ctx = setup({ relay: false });
  ctx.remote.setPassword({ password: 'geheim12345' });
  await ctx.remote.setEnabled({ on: true });
  await tick();
  assert.equal(FakeWS.all.length, 0);
  assert.deepEqual(ctx.remote.status().relay, { configured: false, connected: false, base: null, error: null });
  assert.throws(() => ctx.remote.createPairing(), /taugt nicht/);
  await ctx.remote.stop();
});

test('Validierung: Option „neuer Raum" nur als true, mindestens eine Option', () => {
  assert.deepEqual(validators.remoteOptions({ newRoom: true }), { newRoom: true });
  assert.deepEqual(validators.remoteOptions({ requireApproval: false }), { requireApproval: false });
  assert.throws(() => validators.remoteOptions({}));
  assert.throws(() => validators.remoteOptions({ newRoom: 'ja' }));
  assert.throws(() => validators.remoteOptions({ requireApproval: 'ja' }));
});

test('#138: Relay dauerhaft kaputt → Warnung nur einmal, dann höchstens alle 30 Min.; Abstand wächst bis 10 Min.; „wieder verbunden“', async () => {
  FakeWS.all = [];
  const logs = [];
  const logger = { warn: (s, m) => logs.push(['warn', m]), info: (s, m) => logs.push(['info', m]), error() {} };
  let t = 1_000_000;
  const timers = [];
  const data = { remote: { port: 0 } };
  const store = { get: () => ({ ...data }), set: (k, v) => (data[k] = v) };
  let raw = null;
  const remote = createRemote({
    service: { listGuilds: () => [], getStatus: () => ({ bot: null }) },
    validators,
    store,
    vault: { get: () => raw, set: (v) => (raw = v), clear: () => (raw = null) },
    logger,
    now: () => t,
    webDir: path.join(__dirname, '..', 'src', 'remote-web'),
    naclPath: require.resolve('tweetnacl/nacl-fast.min.js'),
    lanAddresses: () => ['127.0.0.1'],
    bindHost: '127.0.0.1',
    getRelay: () => ({ wss: 'wss://relay.test/ws', httpBase: 'https://relay.test' }),
    WebSocketImpl: FakeWS,
    setTimeoutImpl: (fn, ms) => {
      const x = { fn, ms, unref() {} };
      timers.push(x);
      return x;
    },
  });
  remote.setPassword({ password: 'geheim12345' });
  await remote.setEnabled({ on: true });
  const tlsErr = Object.assign(new Error('write EPROTO SSL alert number 80'), { code: 'EPROTO' });
  for (let i = 0; i < 20; i += 1) {
    last().emit('error', tlsErr);
    last().drop();
    t += 60_000;
    timers.at(-1).fn(); // nächster Versuch
  }
  const warns = logs.filter((l) => l[0] === 'warn');
  assert.ok(warns.length <= 2, `zu viele Warnungen: ${warns.length}`);
  assert.match(warns[0][1], /HTTPS-Zertifikat/);
  assert.equal(remote.status().relay.error.includes('Zertifikat'), true);
  assert.equal(timers.at(-1).ms, 10 * 60000); // nach vielen Fehlschlägen nur noch alle 10 Minuten
  // Server wieder da
  last().deliver({ relay: 'joined', peer: false });
  assert.ok(logs.some((l) => l[0] === 'info' && /wieder verbunden/.test(l[1])));
  assert.equal(remote.status().relay.error, null);
  await remote.stop();
});
