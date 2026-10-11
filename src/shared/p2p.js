'use strict';

// Direktverbindung Helfer ↔ PC (vibeworks #219, Wunsch JONIMONI09 in #124): WebRTC-Datenkanal wie bei Video-Anrufen.
// Die beiden Seiten finden sich über ÖFFENTLICHE Nostr-Relays (hunderte, kostenlos, kein eigener Server nötig).
// - Die Relays sehen nur Datensalat: jede Signal-Nachricht ist mit dem Schlüssel aus dem Link verschlüsselt (secretbox).
// - Ephemere Nostr-Ereignisse (Art 20000–29999) werden von Relays nicht gespeichert.
// - Danach laufen die Daten DIREKT zwischen den Geräten (DTLS-verschlüsselt) – plus unsere eigene secretbox-Schicht.
// - Klappt die Direktverbindung nicht (z. B. strenge Firmen-/Mobilfunk-NAT), nimmt der Aufrufer den Relay als Rückfall.
// Läuft im Browser (Helfer-Seite) und im versteckten P2P-Fenster am PC. Keine Node-APIs.

const nacl = require('tweetnacl');
const { schnorr } = require('@noble/curves/secp256k1');
const { sha256 } = require('@noble/hashes/sha256');
const { bytesToHex } = require('@noble/hashes/utils');

const NOSTR_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://nostr.mom'];
const KIND = 25097; // ephemer: wird nicht gespeichert
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const MAX_SIGNAL = 16 * 1024;
const MAX_FRAME = 64 * 1024;
const HELLO_EVERY_MS = 3000;
const ICE_WAIT_MS = 3000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 1) s += String.fromCharCode(u8[i]);
  return btoa(s);
};
const unb64 = (s) => {
  try {
    return Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
};

/** Thema (Treffpunkt) aus dem Schlüssel ableiten – wer den Link nicht hat, findet den Raum nicht. */
function topicOf(key) {
  const tag = enc.encode('pkmessenger-p2p-v1:');
  const all = new Uint8Array(tag.length + key.length);
  all.set(tag);
  all.set(key, tag.length);
  return bytesToHex(sha256(all));
}

function seal(obj, key) {
  const n = nacl.randomBytes(nacl.secretbox.nonceLength);
  return b64(n) + '.' + b64(nacl.secretbox(enc.encode(JSON.stringify(obj)), n, key));
}
function unseal(text, key) {
  if (typeof text !== 'string' || text.length > MAX_SIGNAL * 2) return null;
  const [n, c] = text.split('.');
  const nb = unb64(n);
  if (nb.length !== nacl.secretbox.nonceLength) return null;
  const plain = nacl.secretbox.open(unb64(c), nb, key);
  if (!plain) return null;
  try {
    return JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
}

/** Signiertes Nostr-Ereignis (NIP-01) mit einem Wegwerf-Schlüssel. */
function makeEvent(sk, content, topic, nowMs) {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const created_at = Math.floor(nowMs / 1000);
  const tags = [['t', topic]];
  const id = bytesToHex(sha256(enc.encode(JSON.stringify([0, pubkey, created_at, KIND, tags, content]))));
  return { id, pubkey, created_at, kind: KIND, tags, content, sig: bytesToHex(schnorr.sign(id, sk)) };
}

/**
 * Signal-Kanal über mehrere Nostr-Relays gleichzeitig (fällt einer aus, gehen die anderen).
 * onSignal(msg) bekommt nur entschlüsselte Nachrichten der GEGENSEITE.
 */
function createSignal({ key, role, onSignal, relays = NOSTR_RELAYS, WebSocketImpl = globalThis.WebSocket, now = () => Date.now() }) {
  const topic = topicOf(key);
  const sk = schnorr.utils.randomPrivateKey();
  const me = bytesToHex(schnorr.getPublicKey(sk));
  const sockets = [];
  const seen = new Set();
  let closed = false;
  const subId = 'pk' + bytesToHex(nacl.randomBytes(6));

  for (const url of relays) {
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch {
      continue;
    }
    sockets.push(ws);
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify(['REQ', subId, { kinds: [KIND], '#t': [topic], since: Math.floor(now() / 1000) - 60 }]));
      } catch {
        /* Relay weg – die anderen reichen */
      }
    };
    ws.onmessage = (ev) => {
      if (closed || typeof ev.data !== 'string' || ev.data.length > MAX_SIGNAL * 3) return;
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!Array.isArray(m) || m[0] !== 'EVENT' || m[1] !== subId) return;
      const e = m[2];
      if (!e || e.kind !== KIND || e.pubkey === me || seen.has(e.id)) return;
      seen.add(e.id);
      const msg = unseal(e.content, key); // nur wer den Schlüssel hat, kann etwas schicken
      if (!msg || msg.from === role || typeof msg.type !== 'string') return;
      if (typeof msg.t !== 'number' || Math.abs(now() - msg.t) > 2 * 60 * 1000) return;
      onSignal(msg);
    };
    ws.onerror = () => {};
  }

  function send(obj) {
    if (closed) return 0;
    const content = seal({ ...obj, from: role, t: now() }, key);
    const frame = JSON.stringify(['EVENT', makeEvent(sk, content, topic, now())]);
    let sent = 0;
    for (const ws of sockets) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(frame);
        sent += 1;
      } catch {
        /* nächster */
      }
    }
    return sent;
  }
  function close() {
    closed = true;
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        /* egal */
      }
    }
  }
  return { send, close, topic, openCount: () => sockets.filter((w) => w.readyState === 1).length };
}

/** Warten, bis alle Netzwege gesammelt sind (ohne „Trickle“ → nur je EINE Signal-Nachricht pro Seite). */
function gathered(pc, ms = ICE_WAIT_MS) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

/**
 * PC-Seite: wartet auf einen Helfer, baut die Direktverbindung auf und beantwortet Anfragen.
 * onRequest(path, body) → Promise<antwort> (dieselbe rpc-Logik wie LAN und Relay).
 */
function createP2PHost({ key, onRequest, onState = () => {}, RTC = globalThis.RTCPeerConnection, signalOpts = {} }) {
  let pc = null;
  let peerSid = null;
  let busy = false;
  const signal = createSignal({ key, role: 'host', onSignal: handle, ...signalOpts });

  async function handle(msg) {
    if (msg.type === 'hello' && typeof msg.sid === 'string' && msg.sid.length <= 40) {
      if (busy && msg.sid !== peerSid) return; // nur ein Helfer gleichzeitig
      if (busy) return;
      busy = true;
      peerSid = msg.sid;
      try {
        pc = new RTC({ iceServers: ICE_SERVERS });
        const dc = pc.createDataChannel('pk', { ordered: true });
        wire(dc);
        pc.addEventListener('connectionstatechange', () => {
          onState(pc.connectionState);
          if (['failed', 'closed'].includes(pc.connectionState)) reset();
        });
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc);
        signal.send({ type: 'offer', sid: peerSid, sdp: pc.localDescription.sdp });
        onState('angeboten');
      } catch {
        reset();
      }
      return;
    }
    if (msg.type === 'answer' && pc && msg.sid === peerSid && typeof msg.sdp === 'string' && msg.sdp.length < MAX_SIGNAL) {
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } catch {
        reset();
      }
    }
  }

  function wire(dc) {
    dc.onopen = () => onState('verbunden');
    dc.onclose = () => {
      onState('getrennt');
      reset();
    };
    dc.onmessage = async (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > MAX_FRAME) return;
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!m || typeof m.id !== 'string' || typeof m.path !== 'string') return;
      let reply = null;
      try {
        reply = await onRequest(m.path, m.body);
      } catch {
        reply = { error: 'Fehler.' };
      }
      try {
        if (dc.readyState === 'open') dc.send(JSON.stringify({ id: m.id, reply }));
      } catch {
        /* Verbindung weg */
      }
    };
  }

  function reset() {
    busy = false;
    peerSid = null;
    const p = pc;
    pc = null;
    if (p) {
      try {
        p.close();
      } catch {
        /* egal */
      }
    }
  }
  function close() {
    reset();
    signal.close();
  }
  return { close, signal, _handle: handle };
}

/**
 * Helfer-Seite: Direktverbindung zum PC aufbauen. → Promise<{ send(path, body) → Promise<antwort>, close() }>
 * Bricht nach timeoutMs ab (dann nimmt die Seite den Relay als Rückfall).
 */
function connectP2P({ key, RTC = globalThis.RTCPeerConnection, timeoutMs = 20000, signalOpts = {}, onState = () => {} }) {
  return new Promise((resolve, reject) => {
    const sid = bytesToHex(nacl.randomBytes(8));
    let pc = null;
    let done = false;
    let helloTimer = null;
    let timer = null;
    const pending = {};
    let nextId = 1;
    const signal = createSignal({ key, role: 'guest', onSignal: handle, ...signalOpts });
    const fail = (why) => {
      if (done) return;
      done = true;
      clearInterval(helloTimer);
      clearTimeout(timer);
      signal.close();
      if (pc) try { pc.close(); } catch { /* egal */ }
      reject(new Error(why));
    };
    timer = setTimeout(() => fail('Direktverbindung nicht möglich.'), timeoutMs);
    helloTimer = setInterval(() => signal.send({ type: 'hello', sid }), HELLO_EVERY_MS);
    setTimeout(() => signal.send({ type: 'hello', sid }), 600); // erst die Relays verbinden lassen
    onState('suche');

    async function handle(msg) {
      if (done || pc || msg.type !== 'offer' || msg.sid !== sid || typeof msg.sdp !== 'string' || msg.sdp.length > MAX_SIGNAL) return;
      clearInterval(helloTimer);
      onState('verbinde');
      try {
        pc = new RTC({ iceServers: ICE_SERVERS });
        pc.addEventListener('datachannel', (ev) => wire(ev.channel));
        pc.addEventListener('connectionstatechange', () => {
          if (pc && pc.connectionState === 'failed') fail('Direktverbindung nicht möglich.');
        });
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await gathered(pc);
        signal.send({ type: 'answer', sid, sdp: pc.localDescription.sdp });
      } catch {
        fail('Direktverbindung nicht möglich.');
      }
    }

    function wire(dc) {
      dc.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        const p = m && pending[m.id];
        if (p) {
          clearTimeout(p.timer);
          delete pending[m.id];
          p.resolve(m.reply);
        }
      };
      dc.onopen = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.close(); // Vermittler nicht mehr nötig
        onState('verbunden');
        resolve({
          send(path, body) {
            return new Promise((res) => {
              const id = String(nextId++);
              const t = setTimeout(() => {
                delete pending[id];
                res(null);
              }, 10000);
              pending[id] = { resolve: res, timer: t };
              try {
                dc.send(JSON.stringify({ id, path, body }));
              } catch {
                clearTimeout(t);
                delete pending[id];
                res(null);
              }
            });
          },
          close() {
            try { pc.close(); } catch { /* egal */ }
          },
          onClose(cb) {
            dc.onclose = cb;
          },
        });
      };
    }
  });
}

module.exports = { createSignal, createP2PHost, connectP2P, topicOf, makeEvent, seal, unseal, NOSTR_RELAYS, KIND, ICE_SERVERS };
