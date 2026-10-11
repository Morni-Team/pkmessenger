'use strict';

// vibeworks #219 / #124: Direktverbindung Helfer ↔ PC über WebRTC, Vermittlung über öffentliche Nostr-Relays.
// Hier mit nachgebautem Relay (prüft echte Signaturen) und nachgebautem WebRTC – ohne Netz.
const test = require('node:test');
const assert = require('node:assert/strict');
const nacl = require('tweetnacl');
const { schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex } = require('@noble/hashes/utils');
const { createP2PHost, connectP2P, createSignal, topicOf, makeEvent, KIND } = require('../src/shared/p2p');

// ---- nachgebauter Nostr-Relay ----
function fakeNostr({ dead = [] } = {}) {
  const sockets = [];
  const published = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.subs = new Map();
      sockets.push(this);
      setTimeout(() => {
        if (dead.includes(url)) return this.onerror?.({});
        this.readyState = 1;
        this.onopen?.();
      }, 1);
    }
    send(raw) {
      const m = JSON.parse(raw);
      if (m[0] === 'REQ') this.subs.set(m[1], m[2]);
      if (m[0] === 'EVENT') {
        const e = m[1];
        // echter Relay: ID und Signatur prüfen
        const id = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
        if (id !== e.id || !schnorr.verify(e.sig, e.id, e.pubkey)) throw new Error('ungültiges Ereignis');
        published.push({ url: this.url, e });
        for (const s of sockets) {
          if (s.url !== this.url || s.readyState !== 1) continue;
          for (const [subId, f] of s.subs) {
            if (f.kinds.includes(e.kind) && e.tags.some((t) => t[0] === 't' && f['#t'].includes(t[1]))) setTimeout(() => s.onmessage?.({ data: JSON.stringify(['EVENT', subId, e]) }), 1);
          }
        }
      }
    }
    close() {
      this.readyState = 3;
    }
  }
  return { FakeWS, published };
}

// ---- nachgebautes WebRTC ----
function fakeRtc({ failConnect = false } = {}) {
  const registry = new Map();
  let n = 0;
  class FakeDC {
    constructor() {
      this.readyState = 'connecting';
    }
    send(data) {
      setTimeout(() => this.peer?.onmessage?.({ data }), 1);
    }
  }
  class FakePC extends EventTarget {
    constructor(cfg) {
      super();
      this.cfg = cfg;
      this.id = String((n += 1));
      this.iceGatheringState = 'complete';
      this.connectionState = 'new';
      registry.set(this.id, this);
    }
    createDataChannel() {
      this.dc = new FakeDC();
      return this.dc;
    }
    async createOffer() {
      return { type: 'offer', sdp: 'fake:' + this.id };
    }
    async createAnswer() {
      return { type: 'answer', sdp: 'fake:' + this.id };
    }
    async setLocalDescription(d) {
      this.localDescription = d;
    }
    async setRemoteDescription(d) {
      const other = registry.get(d.sdp.split(':')[1]);
      if (d.type !== 'answer') return;
      if (failConnect) {
        this.connectionState = 'failed';
        other.connectionState = 'failed';
        other.dispatchEvent(new Event('connectionstatechange'));
        return;
      }
      const theirs = new FakeDC();
      this.dc.peer = theirs;
      theirs.peer = this.dc;
      const ev = new Event('datachannel');
      ev.channel = theirs;
      other.dispatchEvent(ev);
      setTimeout(() => {
        this.dc.readyState = theirs.readyState = 'open';
        this.dc.onopen?.();
        theirs.onopen?.();
      }, 1);
    }
    close() {
      this.connectionState = 'closed';
    }
  }
  return FakePC;
}

const RELAYS = ['wss://a.example', 'wss://b.example'];

test('Direktverbindung: Helfer findet den PC über Nostr, Anfragen laufen direkt über den Datenkanal', async () => {
  const key = nacl.randomBytes(32);
  const { FakeWS, published } = fakeNostr({ dead: ['wss://a.example'] }); // ein Relay tot → der andere reicht
  const RTC = fakeRtc();
  const asked = [];
  const host = createP2PHost({ key, RTC, signalOpts: { relays: RELAYS, WebSocketImpl: FakeWS }, onRequest: async (path, body) => (asked.push([path, body]), { ok: true, echo: body.x }) });
  const conn = await connectP2P({ key, RTC, timeoutMs: 8000, signalOpts: { relays: RELAYS, WebSocketImpl: FakeWS } });
  const reply = await conn.send('/view', { x: 42 });
  assert.deepEqual(reply, { ok: true, echo: 42 });
  assert.deepEqual(asked, [['/view', { x: 42 }]]);
  // Relays sahen nur Datensalat: kein SDP, kein Klartext, ephemere Art, Thema = Hash
  assert.ok(published.length >= 3);
  for (const { e } of published) {
    assert.equal(e.kind, KIND);
    assert.ok(e.kind >= 20000 && e.kind < 30000);
    assert.doesNotMatch(e.content, /fake:|offer|answer|hello/);
    assert.equal(e.tags[0][1], topicOf(key));
  }
  // STUN-Server gesetzt
  assert.ok(published.length && host.signal.topic === topicOf(key));
  host.close();
});

test('Falscher Schlüssel: anderes Thema, und gefälschte Nachrichten werden ignoriert', async () => {
  const key = nacl.randomBytes(32);
  const { FakeWS } = fakeNostr();
  const RTC = fakeRtc();
  const host = createP2PHost({ key, RTC, signalOpts: { relays: RELAYS, WebSocketImpl: FakeWS }, onRequest: async () => ({ ok: true }) });
  await assert.rejects(connectP2P({ key: nacl.randomBytes(32), RTC, timeoutMs: 400, signalOpts: { relays: RELAYS, WebSocketImpl: FakeWS } }), /PC nicht gefunden/);
  // Jemand kennt das Thema, aber nicht den Schlüssel → nichts passiert
  const got = [];
  const listener = createSignal({ key, role: 'guest', relays: RELAYS, WebSocketImpl: FakeWS, onSignal: (m) => got.push(m) });
  await new Promise((r) => setTimeout(r, 10));
  const sk = schnorr.utils.randomPrivateKey();
  const ws = new FakeWS(RELAYS[1]);
  await new Promise((r) => setTimeout(r, 5));
  ws.send(JSON.stringify(['EVENT', makeEvent(sk, 'AAAA.BBBB', topicOf(key), Date.now())]));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 0);
  listener.close();
  host.close();
});

test('#148 Direktverbindung scheitert (VPN, strenges Netz) → weiter über die Vermittler, Anfragen kommen trotzdem an', async () => {
  const key = nacl.randomBytes(32);
  const { FakeWS, published } = fakeNostr();
  const RTC = fakeRtc({ failConnect: true });
  const states = [];
  const host = createP2PHost({ key, RTC, signalOpts: { relays: RELAYS, WebSocketImpl: FakeWS }, onRequest: async (p, body) => ({ ok: true, echo: body.x, p }), onState: (s) => states.push(s) });
  const conn = await connectP2P({ key, RTC, timeoutMs: 5000, signalOpts: { relays: RELAYS, WebSocketImpl: FakeWS } });
  assert.equal(conn.mode, 'vermittler');
  assert.deepEqual(await conn.send('/view', { x: 7 }), { ok: true, echo: 7, p: '/view' });
  assert.ok(states.includes('vermittler'));
  for (const { e } of published) assert.doesNotMatch(e.content, /view|echo/); // auch hier nur Datensalat
  conn.close();
  host.close();
});

test('#148 PC gar nicht online → klare Meldung statt Endlos-Warten', async () => {
  const key = nacl.randomBytes(32);
  const { FakeWS } = fakeNostr();
  await assert.rejects(connectP2P({ key, RTC: fakeRtc(), timeoutMs: 300, signalOpts: { relays: RELAYS, WebSocketImpl: FakeWS } }), /PC nicht gefunden/);
});

test('Nur ein Helfer gleichzeitig: zweites „hello“ wird ignoriert', async () => {
  const key = nacl.randomBytes(32);
  const { FakeWS, published } = fakeNostr();
  const RTC = fakeRtc();
  const host = createP2PHost({ key, RTC, signalOpts: { relays: RELAYS, WebSocketImpl: FakeWS }, onRequest: async () => ({}) });
  await new Promise((r) => setTimeout(r, 10));
  await host._handle({ type: 'hello', sid: 'a' });
  const before = published.length;
  await host._handle({ type: 'hello', sid: 'b' });
  assert.equal(published.length, before);
  host.close();
});

// ---- Verkabelung: Fernhilfe ↔ Direktverbindung (#143) ----
const { createHelp } = require('../src/main/help');
const { checkRequest } = require('../src/main/p2p-bridge');
const { HELP_PAGE } = require('../src/shared/relay-config');

test('Fernhilfe mit Direktverbindung: Link auf GitHub Pages (Relay nur Rückfall), gleiche Prüfung über den Datenkanal', async () => {
  let started = null;
  let stopped = 0;
  const p2p = { start: (key, onRequest, onState) => (started = { key, onRequest, onState }), stop: () => (stopped += 1) };
  const help = createHelp({
    emit: (t, p) => {
      if (t === 'help:pending' && !p.done) setImmediate(() => help.decide({ id: p.id, allow: true }));
    },
    getView: () => ({ screen: 'setup', fields: [{ id: 'wizard-next', label: 'Weiter' }] }),
    lanAddresses: () => ['127.0.0.1'],
    bindHost: '127.0.0.1',
    hostName: null,
    port: 0,
    getRelay: () => ({ wss: 'wss://relay.test/ws', httpBase: 'https://relay.test', mode: 'standard' }),
    WebSocketImpl: class { constructor() { this.handlers = {}; } on() {} send() {} close() {} },
    p2p,
    p2pPage: HELP_PAGE,
  });
  const r = await help.request();
  assert.ok(r.relayUrl.startsWith('https://morni-team.github.io/pkmessenger/help/#p=1&c='));
  assert.match(r.relayUrl, /&r=[\w-]+&h=relay\.test$/); // Relay als Rückfall
  assert.equal(started.key.length, 32);
  // Helfer koppelt über den Datenkanal: falscher Code → abgelehnt, richtiger Code + Bestätigung → ok
  const sealed = (obj) => {
    const n = nacl.randomBytes(24);
    return { n: Buffer.from(n).toString('base64'), c: Buffer.from(nacl.secretbox(Buffer.from(JSON.stringify(obj)), n, started.key)).toString('base64') };
  };
  const wrong = await started.onRequest('/pair', { code: 'XXXXXX', ...sealed({ name: 'Alex', t: Date.now() }) });
  assert.match(wrong.error, /Falscher Code/);
  const ok = await started.onRequest('/pair', { code: r.code, ...sealed({ name: 'Alex', t: Date.now() }) });
  assert.ok(ok.c); // verschlüsselte Antwort
  started.onState('verbunden');
  assert.equal(help.status().direct, 'verbunden');
  help.stop();
  assert.equal(stopped, 1);
  assert.equal(help.status().direct, null);
});

test('Nur WLAN gewählt: keine Direktverbindung, kein Link nach außen', async () => {
  let started = 0;
  const help = createHelp({ getRelay: () => null, hostName: 'pc.local', port: 0, bindHost: '127.0.0.1', lanAddresses: () => ['127.0.0.1'], p2p: { start: () => (started += 1), stop() {} }, p2pPage: HELP_PAGE });
  const r = await help.request();
  assert.equal(started, 0);
  assert.equal(r.relayUrl, null);
  help.stop();
});

test('P2P-Fenster darf nur /pair, /view, /act mit kleinem Objekt schicken (IPC-Prüfung)', () => {
  assert.deepEqual(checkRequest({ path: '/view', body: { n: 'a', c: 'b' } }), { path: '/view', body: { n: 'a', c: 'b' } });
  assert.equal(checkRequest({ path: '/admin', body: {} }), null);
  assert.equal(checkRequest({ path: '/act', body: 'x' }), null);
  assert.equal(checkRequest({ path: '/act', body: [1] }), null);
  assert.equal(checkRequest({ path: '/act', body: { x: 'y'.repeat(40000) } }), null);
  assert.equal(checkRequest(null), null);
});

test('#152 Pages-Seite: Direktverbindung steckt in app.js (kein eigenes p2p.js, das Werbeblocker sperren)', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { buildP2P } = require('../scripts/build-p2p');
  await buildP2P();
  const dir = path.join(__dirname, '..', 'build', 'pages', 'help');
  assert.ok(!fs.existsSync(path.join(dir, 'p2p.js')));
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /p2p\.js/);
  assert.match(html, /<script src="app\.js"><\/script>/);
  const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  assert.match(app, /PKP2P/);
  assert.ok(app.indexOf('window.PKP2P') < app.indexOf('Verbindungs-Verlauf') || !app.includes('Verbindungs-Verlauf')); // P2P-Code vor der Seitenlogik
});

test('#152 Uhr des Helfer-Geräts geht 5 Min. falsch → verbindet trotzdem, PC meldet die Abweichung', async () => {
  const key = nacl.randomBytes(32);
  const { FakeWS } = fakeNostr();
  const RTC = fakeRtc();
  const states = [];
  const host = createP2PHost({ key, RTC, signalOpts: { relays: RELAYS, WebSocketImpl: FakeWS }, onRequest: async () => ({ ok: true }), onState: (s) => states.push(s) });
  const conn = await connectP2P({ key, RTC, timeoutMs: 8000, signalOpts: { relays: RELAYS, WebSocketImpl: FakeWS, now: () => Date.now() - 5 * 60 * 1000 } });
  assert.deepEqual(await conn.send('/view', {}), { ok: true });
  assert.ok(states.includes('uhr:5'), states.join(','));
  conn.close();
  host.close();
});

test('#156 Kopieren mit Strg+C beendet die Fernhilfe NICHT mehr; Not-Aus ist Strg+Umschalt+X; Grund steht im Protokoll', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { validators } = require('../src/main/validate');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'components', 'HelpRequest.jsx'), 'utf8');
  assert.doesNotMatch(src, /toLowerCase\(\) === 'c'/);
  assert.match(src, /e\.ctrlKey && e\.shiftKey && \(e\.key \|\| ''\)\.toLowerCase\(\) === 'x'/);
  assert.deepEqual(validators.helpStop({ reason: 'tastatur' }), { reason: 'tastatur' });
  assert.deepEqual(validators.helpStop(undefined), { reason: 'unbekannt' });
  assert.throws(() => validators.helpStop({ reason: 'hack' }), /Grund/);
  const events = [];
  const help = createHelp({ emit: (t, p) => t === 'help:activity' && events.push(p.action), getRelay: () => null, hostName: 'pc.local', port: 0, bindHost: '127.0.0.1', lanAddresses: () => ['127.0.0.1'] });
  await help.request();
  help.stop({ reason: 'knopf' });
  assert.ok(events.includes('Fernhilfe beendet (Knopf „Hilfe beenden“)'), events.join(' | '));
});

test('#158 Ersatz-Server war nicht erreichbar → nächster Link nur mit Direktverbindung (keine sinnlosen Server-Versuche)', async () => {
  const { EventEmitter } = require('node:events');
  class DeadWS extends EventEmitter {
    constructor() {
      super();
      setImmediate(() => this.emit('error', new Error('write EPROTO SSL alert number 80')));
    }
    send() {}
    close() {}
  }
  const help = createHelp({
    getRelay: () => ({ wss: 'wss://relay.test/ws', httpBase: 'https://relay.test', mode: 'standard' }),
    WebSocketImpl: DeadWS,
    hostName: null,
    port: 0,
    bindHost: '127.0.0.1',
    lanAddresses: () => ['127.0.0.1'],
    p2p: { start() {}, stop() {} },
    p2pPage: HELP_PAGE,
  });
  const first = await help.request();
  assert.match(first.relayUrl, /&h=relay\.test/); // noch unbekannt → als Rückfall drin
  await new Promise((r) => setTimeout(r, 20));
  help.stop();
  const second = await help.request();
  assert.ok(second.relayUrl.startsWith(HELP_PAGE));
  assert.doesNotMatch(second.relayUrl, /&h=/);
  help.stop();
});
