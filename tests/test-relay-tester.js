'use strict';

// #120: „Verbindung testen" für den eigenen Relay. Simuliert: gesunder Relay, falscher Server, HTTP-Fehler,
// DNS/Zertifikat/Zeitüberschreitung, WebSocket schließt/antwortet nicht. Keine echten Netzwerkzugriffe.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRelayTester, explain } = require('../src/main/relay-test');

const okFetch = (body = { ok: true, service: 'pkmessenger-relay' }, status = 200) => async (url) => {
  okFetch.last = url;
  return { ok: status < 400, status, json: async () => body };
};

function wsFactory(behaviour) {
  return class FakeWS extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      FakeWS.made = this;
      this.sent = [];
      setImmediate(() => {
        if (behaviour === 'error') return this.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
        this.emit('open');
      });
    }
    send(s) {
      this.sent.push(JSON.parse(s));
      if (behaviour === 'join') setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ relay: 'joined', peer: false }))));
      if (behaviour === 'close') setImmediate(() => this.emit('close', 1008, Buffer.from('bad-room')));
    }
    close() {
      this.closed = true;
    }
  };
}

test('Gesunder Relay: beide Schritte grün, Test-Raum nur als „host" mit Zufalls-ID, Verbindung wieder zu', async () => {
  const WS = wsFactory('join');
  const r = await createRelayTester({ fetchImpl: okFetch(), WebSocketImpl: WS }).test('wss://relay.example.de/ws');
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => [s.name, s.ok]), [['Server erreichbar', true], ['WebSocket', true]]);
  assert.equal(okFetch.last, 'https://relay.example.de/health');
  assert.equal(WS.made.url, 'wss://relay.example.de/ws');
  assert.equal(WS.made.sent[0].role, 'host');
  assert.match(WS.made.sent[0].room, /^test-[\w-]{8,}$/);
  assert.equal(WS.made.closed, true);
});

test('Falscher Server / HTTP-Fehler → verständliche Meldung, kein WebSocket-Versuch', async () => {
  const WS = wsFactory('join');
  WS.made = null;
  let r = await createRelayTester({ fetchImpl: okFetch({ hello: 'nginx' }), WebSocketImpl: WS }).test('wss://x.example/ws');
  assert.equal(r.ok, false);
  assert.match(r.steps[0].detail, /kein PKMessenger-Relay/);
  assert.equal(WS.made, null);
  r = await createRelayTester({ fetchImpl: okFetch({}, 502), WebSocketImpl: WS }).test('wss://x.example/ws');
  assert.match(r.steps[0].detail, /HTTP 502/);
});

test('Netzwerkfehler werden auf Deutsch erklärt (DNS, Zertifikat, Zeitüberschreitung, abgelehnt)', async () => {
  const fail = (code, message = 'fetch failed') => async () => {
    throw Object.assign(new Error(message), { cause: { code } });
  };
  const t = (f) => createRelayTester({ fetchImpl: f, WebSocketImpl: wsFactory('join') }).test('wss://x.example/ws');
  assert.match((await t(fail('ENOTFOUND'))).steps[0].detail, /Domain nicht gefunden/);
  assert.match((await t(fail('ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR'))).steps[0].detail, /Zertifikat/);
  assert.match((await t(fail('ECONNREFUSED'))).steps[0].detail, /lehnt die Verbindung ab/);
  assert.match((await t(fail('UND_ERR_CONNECT_TIMEOUT'))).steps[0].detail, /Zeitüberschreitung/);
  assert.match(explain(new Error('irgendwas')), /irgendwas/);
});

test('WebSocket-Probleme: Server schließt sofort bzw. Verbindungsfehler', async () => {
  let r = await createRelayTester({ fetchImpl: okFetch(), WebSocketImpl: wsFactory('close') }).test('wss://x.example/ws');
  assert.equal(r.ok, false);
  assert.match(r.steps[1].detail, /beendet \(1008 bad-room\)/);
  r = await createRelayTester({ fetchImpl: okFetch(), WebSocketImpl: wsFactory('error') }).test('wss://x.example/ws');
  assert.match(r.steps[1].detail, /Domain nicht gefunden/);
});

test('Ungültige Adresse → sofort abgelehnt, ohne Netz', async () => {
  let called = false;
  const r = await createRelayTester({ fetchImpl: async () => ((called = true), {}) }).test('http://unsicher.example');
  assert.equal(r.ok, false);
  assert.equal(r.steps[0].name, 'Adresse');
  assert.equal(called, false);
  assert.equal((await createRelayTester().test('')).ok, false);
});

test('#151 „Verbindung testen“: zuerst der kostenlose Weg (Vermittler + Helfer-Seite), Server nur optional', async () => {
  const { EventEmitter } = require('node:events');
  class WS extends EventEmitter {
    constructor(url) {
      super();
      setImmediate(() => (url.includes('tot') ? this.emit('error', new Error('x')) : this.emit('open')));
    }
    close() {}
  }
  const fetchImpl = async (url) => ({ ok: url.includes('github.io'), status: url.includes('github.io') ? 200 : 502, json: async () => ({}) });
  const t = createRelayTester({ fetchImpl, WebSocketImpl: WS });
  const d = await t.testDirect({ relays: ['wss://a.example', 'wss://tot.example'], page: 'https://x.github.io/help/' });
  assert.equal(d.ok, true);
  assert.match(d.steps[0].detail, /1 von 2 erreichbar/);
  const none = await t.testDirect({ relays: ['wss://tot.example'], page: 'https://x.github.io/help/' });
  assert.equal(none.ok, false);
  assert.match(none.steps[0].detail, /Firewall, ein VPN/);
});
