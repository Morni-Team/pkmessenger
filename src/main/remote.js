'use strict';

// Fernzugang (Issue #46/#50). Ursprünglich nur im WLAN; seit #104/#105 (09.10.2026, OK von JoniMoni + MoinMornhart)
// zusätzlich unterwegs über den SELBST GEHOSTETEN Relay (relay/). Der direkte WLAN-Server bleibt WLAN-only.
// Andere Geräte (z. B. Handy) bedienen den Bot über eine kleine Web-Oberfläche – Nachrichten gehen weiter als BOT raus.
//
// Sicherheit (in dieser Reihenfolge):
// - AB WERK AUS. Läuft nur, wenn der Besitzer ihn einschaltet und ein Fernzugangs-Passwort festgelegt hat.
// - WLAN-Weg: NUR private Netze (192.168.x, 10.x, 172.16–31.x, localhost); Anfragen von außen → 403.
// - Relay-Weg (optional, nur mit eingetragener wss://-Relay-Adresse): Der PC verbindet sich AUSGEHEND – es wird KEIN
//   Port im Internet geöffnet. Der Relay sieht nur verschlüsselte Pakete, nie Schlüssel, Passwort, Token oder Inhalte.
//   Für beide Wege gelten exakt dieselben Prüfungen (gemeinsamer rpc()-Kern unten).
// - Ende-zu-Ende verschlüsselt mit tweetnacl secretbox (XSalsa20-Poly1305). Der Kopplungsschlüssel steht im QR-Code
//   HINTER dem „#“ – Browser schicken diesen Teil nie übers Netz. Jede Anfrage: frische Zufallsnonce + Zeitstempel,
//   Wiederholungen werden abgewiesen.
// - Kopplung nur mit EINMAL-Code (5 Minuten gültig, nach Benutzung verbraucht) + Passwort + Bestätigung am PC.
// - Jede Sitzung braucht das Passwort (Sitzung max. 8 h). 5 Fehlversuche → 5 Minuten Sperre.
// - Der Besitzer sieht alle Geräte (mit IP, Zeit) und jede Aktivität und kann Geräte sofort entfernen.
//   Optional muss er jede Nachricht vorher am PC bestätigen.
// - Geräteschlüssel liegen verschlüsselt im Windows-Tresor (safeStorage), nie in settings.json.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const nacl = require('tweetnacl');
const { isLocalAddress } = require('../shared/ai-limits');

const PAIR_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const APPROVAL_TIMEOUT_MS = 90 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const RATE_PER_MIN = 120;
const MAX_BODY = 64 * 1024;
const MAX_DEVICES = 10;
const DEFAULT_PORT = 47815;

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');

function seal(obj, key) {
  const n = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { n: b64(n), c: b64(nacl.secretbox(Buffer.from(JSON.stringify(obj)), n, key)) };
}
function unseal(msg, key) {
  const n = unb64(msg?.n);
  const c = unb64(msg?.c);
  if (n.length !== nacl.secretbox.nonceLength || !c.length) return null;
  const plain = nacl.secretbox.open(c, n, key);
  if (!plain) return null;
  try {
    return JSON.parse(Buffer.from(plain).toString('utf8'));
  } catch {
    return null;
  }
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}
function samePassword(pw, salt, hash) {
  if (!salt || !hash || typeof pw !== 'string') return false;
  const a = Buffer.from(hashPassword(pw, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const remoteIp = (req) => String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
const isPrivateIp = (ip) => ip === '::1' || isLocalAddress(`http://${ip.includes(':') ? `[${ip}]` : ip}/`);

/**
 * @param {object} o
 * @param {object} o.service   Discord-Dienst (listGuilds, listChannels, getMessages, sendMessage, listDMs)
 * @param {object} o.validators
 * @param {object} o.store     settings.json (nur Einstellungen, keine Schlüssel)
 * @param {object} o.vault     verschlüsselter Speicher für Geräteschlüssel { get(), set(str), clear() }
 * @param {(t:string,p:any)=>void} o.emit
 * @param {string} o.webDir    Ordner der Web-Oberfläche
 */
function createRemote({ service, validators, store, vault, emit = () => {}, logger = null, now = () => Date.now(), webDir, naclPath, lanAddresses = () => [], bindHost = '0.0.0.0', hostName = null, getRelay = () => null, WebSocketImpl = null, setTimeoutImpl = setTimeout }) {
  let server = null;
  const pairings = new Map(); // pairId → { key, expires, used }
  const pending = new Map(); // reqId → { resolve, info }
  const sessions = new Map(); // token → { deviceId, expires }
  const seenNonces = new Map(); // nonce → Ablaufzeit (Wiederholungsschutz)
  const fails = new Map(); // ip|deviceId → { count, until }
  const rate = new Map(); // ip → { count, windowStart }
  const activity = [];

  const cfg = () => ({ enabled: false, port: DEFAULT_PORT, requireApproval: false, salt: null, hash: null, relayRoom: null, ...(store.get().remote || {}) });
  const saveCfg = (patch) => store.set('remote', { ...cfg(), ...patch });
  const loadDevices = () => {
    try {
      const raw = vault.get();
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const saveDevices = (list) => vault.set(JSON.stringify(list));

  function log(entry) {
    const e = { at: now(), ...entry };
    activity.unshift(e);
    activity.length = Math.min(activity.length, 200);
    emit('remote:activity', e);
    logger?.info?.('remote', `${entry.action} ${entry.device || ''} ${entry.ip || ''}`);
    return e;
  }

  function status() {
    const c = cfg();
    return {
      enabled: c.enabled,
      running: Boolean(server?.listening),
      port: c.port,
      hasPassword: Boolean(c.hash),
      requireApproval: c.requireApproval,
      host: hostName || null,
      addresses: lanAddresses(),
      devices: loadDevices().map(({ key: _k, ...d }) => d),
      relay: relayStatus(),
      activity: activity.slice(0, 50),
      pending: [...pending.entries()].map(([id, p]) => ({ id, ...p.info })),
    };
  }

  // ---- Sperren, Rate-Limit, Wiederholungsschutz ----
  function locked(id) {
    const f = fails.get(id);
    return f && f.until > now();
  }
  function fail(id) {
    const f = fails.get(id) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) {
      f.until = now() + LOCK_MS;
      f.count = 0;
    }
    fails.set(id, f);
  }
  function limited(ip) {
    const r = rate.get(ip) || { count: 0, windowStart: now() };
    if (now() - r.windowStart > 60000) {
      r.count = 0;
      r.windowStart = now();
    }
    r.count += 1;
    rate.set(ip, r);
    return r.count > RATE_PER_MIN;
  }
  function freshNonce(n, t) {
    if (!Number.isFinite(t) || Math.abs(now() - t) > CLOCK_SKEW_MS) return false;
    for (const [k, exp] of seenNonces) if (exp < now()) seenNonces.delete(k);
    if (seenNonces.has(n)) return false;
    seenNonces.set(n, now() + 2 * CLOCK_SKEW_MS);
    return true;
  }

  /** Am PC fragen (Kopplung bzw. Nachricht) – wartet höchstens 90 s. */
  function askHost(info) {
    return new Promise((resolve) => {
      const id = rid(8);
      const timer = setTimeout(() => {
        pending.delete(id);
        emit('remote:pending', { id, done: true });
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, {
        info,
        resolve: (ok) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(ok);
        },
      });
      emit('remote:pending', { id, ...info });
    });
  }
  function decide({ id, allow }) {
    const p = pending.get(id);
    if (!p) return false;
    p.resolve(Boolean(allow));
    emit('remote:pending', { id, done: true });
    return true;
  }

  // ---- Einstellungen (vom PC aus) ----
  function setPassword({ password, current }) {
    const c = cfg();
    if (c.hash && !samePassword(current, c.salt, c.hash)) throw Object.assign(new Error('Das bisherige Fernzugangs-Passwort stimmt nicht.'), { code: 'VALIDATION' });
    if (typeof password !== 'string' || password.length < 8) throw Object.assign(new Error('Das Fernzugangs-Passwort braucht mindestens 8 Zeichen.'), { code: 'VALIDATION' });
    const salt = crypto.randomBytes(16).toString('hex');
    saveCfg({ salt, hash: hashPassword(password, salt) });
    sessions.clear(); // alte Sitzungen ungültig
    return status();
  }

  async function setEnabled({ on }) {
    if (on && !cfg().hash) throw Object.assign(new Error('Bitte zuerst ein Fernzugangs-Passwort festlegen.'), { code: 'VALIDATION' });
    saveCfg({ enabled: Boolean(on) });
    if (on) await start();
    else await stop();
    return status();
  }

  function setOptions({ requireApproval, newRoom }) {
    if (typeof requireApproval === 'boolean') saveCfg({ requireApproval });
    if (newRoom) {
      // Neuer Relay-Raum: alte Relay-Links/-Geräte erreichen den PC nicht mehr (z. B. wenn ein Link in falsche Hände kam)
      saveCfg({ relayRoom: null });
      log({ action: 'Neuer Relay-Raum – alte Relay-Links gelten nicht mehr', device: '', ip: '' });
      refreshRelay();
    }
    return status();
  }

  /** Neuen Einmal-Code erzeugen → Link (Schlüssel hinter „#“) für QR-Code. */
  function createPairing() {
    const c = cfg();
    const relay = getRelay();
    if (!c.enabled || (!server?.listening && !relay?.wss)) throw Object.assign(new Error('Fernzugang ist aus.'), { code: 'VALIDATION' });
    if (loadDevices().length >= MAX_DEVICES) throw Object.assign(new Error(`Höchstens ${MAX_DEVICES} Geräte.`), { code: 'VALIDATION', hint: 'Entferne erst ein altes Gerät.' });
    for (const [id, p] of pairings) if (p.expires < now() || p.used) pairings.delete(id);
    const pairId = rid(12);
    const key = nacl.randomBytes(32);
    const expires = now() + PAIR_TTL_MS;
    pairings.set(pairId, { key, expires, used: false });
    // Nie eine IP im Link (Issue #53/#50): nur der Gerätename des PCs über mDNS („name.local“, in Windows eingebaut).
    // Kein Ersatz-Link mit Adresse mehr. Taugt der PC-Name nicht, gibt es keinen Link (Hinweis zum Umbenennen).
    const hash = `#p=${pairId}&k=${Buffer.from(key).toString('base64url')}`;
    // WLAN-Link (nur PC-Name, keine IP) – falls der WLAN-Server läuft und der PC-Name taugt
    const url = hostName && server?.listening ? `http://${hostName}:${server.address().port}/${hash}` : null;
    // Unterwegs-Link über den eigenen Relay (#104/#105): Raum-ID steht im Link, der Schlüssel bleibt hinter „#“
    const relayUrl = relay?.httpBase ? `${relay.httpBase}/remote/${hash}&r=${relayRoom()}` : null;
    if (!url && !relayUrl) {
      pairings.delete(pairId);
      throw Object.assign(new Error('Der Name dieses PCs taugt nicht für den Link.'), {
        code: 'VALIDATION',
        hint: 'Windows-Einstellungen → System → Info → „Diesen PC umbenennen“: nur Buchstaben, Ziffern und Bindestrich. Oder eine Relay-Adresse eintragen (Hilfe & Tour).',
      });
    }
    log({ action: 'Kopplungs-Code erstellt', device: '', ip: '' });
    return { pairId, url, relayUrl, expires, host: hostName };
  }
  function cancelPairing({ pairId }) {
    pairings.delete(pairId);
    return true;
  }

  function removeDevice({ id }) {
    const list = loadDevices();
    const dev = list.find((d) => d.id === id);
    saveDevices(list.filter((d) => d.id !== id));
    for (const [t, s] of sessions) if (s.deviceId === id) sessions.delete(t);
    if (dev) log({ action: 'Gerät entfernt', device: dev.name, ip: '' });
    return status();
  }

  // ---- Aktionen der Geräte (nur über erlaubte, geprüfte Wege) ----
  const OPS = {
    guilds: () => service.listGuilds(),
    channels: (a) => service.listChannels(validators.guildRef(a)),
    dms: () => service.listDMs(),
    messages: (a) => service.getMessages(validators.getMessages({ channelId: a?.channelId, limit: 50, ...(a?.before ? { before: a.before } : {}) })),
  };

  async function handleOp(dev, ip, msg) {
    const { op, args } = msg;
    if (op === 'send') {
      const content = String(args?.content || '').slice(0, 2000);
      if (!content.trim()) throw new Error('Leere Nachricht.');
      const payload = validators.sendMessage({ channelId: args?.channelId, content, mentions: { users: [], roles: [], everyone: false }, files: [], embeds: [], poll: null, replyTo: null, pingReply: false });
      if (cfg().requireApproval) {
        const ok = await askHost({ kind: 'send', device: dev.name, ip, channelId: payload.channelId, preview: content.slice(0, 200) });
        if (!ok) {
          log({ action: 'Nachricht abgelehnt', device: dev.name, ip, detail: content.slice(0, 80) });
          throw new Error('Am PC abgelehnt.');
        }
      }
      const res = await service.sendMessage(payload);
      log({ action: 'Nachricht gesendet', device: dev.name, ip, detail: content.slice(0, 80), channelId: payload.channelId });
      return res;
    }
    if (!OPS[op]) throw new Error('Unbekannte Aktion.');
    const res = await OPS[op](args || {});
    if (op === 'messages') log({ action: 'Chat gelesen', device: dev.name, ip, channelId: args?.channelId, quiet: true });
    return res;
  }

  // ---- HTTP ----
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('zu groß'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(new Error('kein JSON'));
        }
      });
      req.on('error', reject);
    });

  const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/nacl.js': [null, 'text/javascript; charset=utf-8'],
  };
  const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  async function onRequest(req, res) {
    const ip = remoteIp(req);
    if (!isPrivateIp(ip)) {
      res.writeHead(403).end();
      return;
    }
    if (limited(ip)) return json(res, 429, { error: 'Zu viele Anfragen.' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      try {
        const body = fs.readFileSync(file ? path.join(webDir, file) : naclPath);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
        res.end(body);
      } catch {
        res.writeHead(500).end();
      }
      return;
    }
    if (req.method !== 'POST') return json(res, 404, {});
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: 'Ungültige Anfrage.' });
    }
    const { code, obj } = await rpc(url.pathname, body, ip);
    return json(res, code, obj);
  }

  /**
   * Gemeinsamer Kern für WLAN (HTTP) und Relay (WebSocket) → { code, obj }. code zählt nur bei HTTP.
   * Alle Prüfungen (Einmal-Code, Passwort, Sperren, Wiederholungsschutz, Geräteschlüssel, Sitzung) gelten für BEIDE Wege.
   */
  async function rpc(pathname, body, ip) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { code: 400, obj: { error: 'Ungültige Anfrage.' } };

    // Kopplung: Einmal-Code + Passwort + Bestätigung am PC
    if (pathname === '/api/pair') {
      const p = pairings.get(String(body.p || ''));
      if (!p || p.used || p.expires < now()) return { code: 403, obj: { error: 'Code abgelaufen oder schon benutzt. Am PC einen neuen QR-Code erzeugen.' } };
      if (locked(`pair:${ip}`)) return { code: 429, obj: { error: 'Zu viele Fehlversuche. Bitte 5 Minuten warten.' } };
      const msg = unseal(body, p.key);
      if (!msg || !freshNonce(body.n, msg.t)) return { code: 400, obj: { error: 'Ungültige Anfrage.' } };
      const c = cfg();
      if (!samePassword(msg.password, c.salt, c.hash)) {
        fail(`pair:${ip}`);
        log({ action: 'Falsches Passwort bei Kopplung', device: String(msg.name || '').slice(0, 40), ip });
        return { code: 200, obj: seal({ error: 'Falsches Passwort.' }, p.key) };
      }
      p.used = true; // Einmal-Code ist ab jetzt verbraucht – egal wie es ausgeht
      const name = String(msg.name || 'Gerät').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40) || 'Gerät';
      const ok = await askHost({ kind: 'pair', device: name, ip });
      if (!ok) {
        log({ action: 'Kopplung abgelehnt', device: name, ip });
        return { code: 200, obj: seal({ error: 'Am PC abgelehnt.' }, p.key) };
      }
      if (loadDevices().length >= MAX_DEVICES) {
        pairings.delete(String(body.p));
        return { code: 200, obj: seal({ error: `Höchstens ${MAX_DEVICES} Geräte. Entferne am PC erst ein altes Gerät.` }, p.key) };
      }
      const dev = { id: rid(12), name, key: b64(nacl.randomBytes(32)), pairedAt: now(), lastSeen: now(), ip };
      saveDevices([...loadDevices(), dev]);
      log({ action: 'Gerät gekoppelt', device: name, ip });
      pairings.delete(String(body.p));
      return { code: 200, obj: seal({ deviceId: dev.id, deviceKey: dev.key, name }, p.key) };
    }

    // Alle weiteren Anfragen: Gerät + Geräteschlüssel + (außer login) gültige Sitzung
    if (pathname === '/api') {
      const devices = loadDevices();
      const dev = devices.find((d) => d.id === body.d);
      if (!dev) return { code: 403, obj: { error: 'Gerät unbekannt oder entfernt.', unpaired: true } };
      const key = unb64(dev.key);
      const msg = unseal(body, key);
      if (!msg || !freshNonce(body.n, msg.t)) return { code: 400, obj: { error: 'Ungültige Anfrage.' } };
      const reply = (obj) => ({ code: 200, obj: seal(obj, key) });
      dev.lastSeen = now();
      dev.ip = ip;
      saveDevices(devices);
      if (msg.op === 'login') {
        if (locked(`dev:${dev.id}`)) return reply({ error: 'Zu viele Fehlversuche. Bitte 5 Minuten warten.' });
        if (!samePassword(msg.args?.password, cfg().salt, cfg().hash)) {
          fail(`dev:${dev.id}`);
          log({ action: 'Falsches Passwort', device: dev.name, ip });
          return reply({ error: 'Falsches Passwort.' });
        }
        const token = rid(24);
        sessions.set(token, { deviceId: dev.id, expires: now() + SESSION_TTL_MS });
        log({ action: 'Angemeldet', device: dev.name, ip });
        return reply({ session: token, expires: now() + SESSION_TTL_MS, bot: service.getStatus?.()?.bot?.displayName || 'Bot' });
      }
      const s = sessions.get(msg.session);
      if (!s || s.deviceId !== dev.id || s.expires < now()) return reply({ error: 'Bitte neu anmelden.', relogin: true });
      try {
        return reply({ data: await handleOp(dev, ip, msg) });
      } catch (err) {
        return reply({ error: String(err?.message || 'Fehler').slice(0, 200) });
      }
    }
    return { code: 404, obj: {} };
  }

  // ---- Relay (unterwegs, #104/#105) ----
  // Der PC verbindet sich AUSGEHEND zum selbst gehosteten Relay und wartet dort in einem festen, zufälligen Raum auf
  // gekoppelte Geräte. Kein offener Port. Fällt die Verbindung weg (Relay-Neustart, Raum nach 30 Min. abgelaufen,
  // Internet weg), verbindet sich der PC von selbst neu (2 s … 60 s).
  let relayWs = null;
  let relayTimer = null;
  let relayUp = false;
  let relayTries = 0;
  // #138: Ist der Relay dauerhaft kaputt, NICHT jede Minute dieselbe Warnung ins Protokoll schreiben:
  // erster Fehler sofort, danach höchstens alle 30 Min. eine Sammelzeile; „wieder verbunden“ wird gemeldet.
  let relayError = null; // { text, since, count, loggedAt }
  const LOG_REPEAT_MS = 30 * 60 * 1000;
  function relayFailed(err) {
    const { explain } = require('./relay-test');
    const text = explain(err);
    const t = now();
    if (!relayError || relayError.text !== text) {
      relayError = { text, since: t, count: 1, loggedAt: t };
      logger?.warn?.('remote', `relay: ${text} (${String(err?.message || err).slice(0, 120)})`);
      return;
    }
    relayError.count += 1;
    if (t - relayError.loggedAt >= LOG_REPEAT_MS) {
      relayError.loggedAt = t;
      logger?.warn?.('remote', `relay: weiterhin nicht erreichbar (${relayError.count} Versuche seit ${new Date(relayError.since).toLocaleTimeString('de-DE')}) – ${text}`);
    }
  }
  const loadWs = () => {
    if (WebSocketImpl) return WebSocketImpl;
    try {
      return require('ws');
    } catch {
      return null;
    }
  };
  function relayRoom() {
    let r = cfg().relayRoom;
    if (typeof r !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(r)) {
      r = rid(18); // 24 Zeichen base64url ≈ 144 Bit Zufall
      saveCfg({ relayRoom: r });
    }
    return r;
  }
  function relayStatus() {
    const r = getRelay();
    return { configured: Boolean(r?.wss), connected: relayUp, base: r?.httpBase || null, error: relayUp ? null : relayError?.text || null };
  }
  function stopRelay() {
    clearTimeout(relayTimer);
    relayTimer = null;
    const w = relayWs;
    relayWs = null;
    relayUp = false;
    if (w) {
      try {
        w.close();
      } catch {
        /* egal */
      }
    }
  }
  function scheduleRelay() {
    clearTimeout(relayTimer);
    relayTimer = null;
    if (!cfg().enabled || !getRelay()?.wss) return;
    // 2 s … 60 s; nach vielen Fehlschlägen (Server dauerhaft kaputt) nur noch alle 10 Minuten
    const delay = relayTries >= 12 ? 10 * 60000 : Math.min(60000, 2000 * 2 ** Math.min(relayTries, 5));
    relayTries += 1;
    relayTimer = setTimeoutImpl(() => {
      relayTimer = null;
      startRelay();
    }, delay);
    relayTimer?.unref?.();
  }
  function startRelay() {
    const relay = getRelay();
    const WS = loadWs();
    if (!cfg().enabled || !relay?.wss || !WS) return;
    stopRelay();
    let ws;
    try {
      ws = new WS(relay.wss);
    } catch (err) {
      relayFailed(err);
      scheduleRelay();
      return;
    }
    relayWs = ws;
    const room = relayRoom();
    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ room, role: 'host' }));
      } catch {
        /* egal */
      }
    });
    ws.on('message', async (raw) => {
      let m = null;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (m.relay) {
        if (m.relay === 'joined') {
          if (relayError) logger?.info?.('remote', 'relay: wieder verbunden ✓');
          relayError = null;
          relayUp = true;
          relayTries = 0;
        }
        return;
      }
      if (typeof m.id !== 'string' || m.id.length > 40 || typeof m.path !== 'string') return;
      let out;
      if (limited('relay')) out = { code: 429, obj: { error: 'Zu viele Anfragen.' } };
      else {
        try {
          out = await rpc(m.path, m.body, 'relay');
        } catch {
          out = { code: 500, obj: { error: 'Fehler.' } };
        }
      }
      try {
        ws.send(JSON.stringify({ id: m.id, reply: out.obj }));
      } catch {
        /* Verbindung inzwischen weg */
      }
    });
    ws.on('close', () => {
      if (relayWs !== ws) return; // absichtlich beendet
      relayWs = null;
      relayUp = false;
      scheduleRelay();
    });
    ws.on('error', (err) => relayFailed(err));
  }
  /** Relay-Adresse geändert / neuer Raum → Verbindung neu aufbauen. */
  function refreshRelay() {
    relayTries = 0;
    stopRelay();
    startRelay();
    return status();
  }

  function start() {
    if (!relayWs && !relayTimer) startRelay(); // unterwegs über den Relay (falls eingetragen)
    if (server?.listening) return Promise.resolve(status());
    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        onRequest(req, res).catch(() => {
          try {
            res.writeHead(500).end();
          } catch {
            /* schon gesendet */
          }
        });
      });
      server.on('error', (err) => {
        logger?.error?.('remote', `listen failed: ${err.message}`);
        server = null;
        reject(Object.assign(new Error(`Fernzugang konnte nicht starten (${err.code || err.message}).`), { code: 'VALIDATION', hint: 'Anderer Port belegt? PKMessenger neu starten.' }));
      });
      server.listen(cfg().port, bindHost, () => resolve(status()));
    });
  }
  function stop() {
    return new Promise((resolve) => {
      stopRelay();
      sessions.clear();
      pairings.clear();
      for (const id of [...pending.keys()]) decide({ id, allow: false });
      if (!server) return resolve(status());
      const s = server;
      server = null;
      s.close(() => resolve(status()));
      s.closeAllConnections?.();
    });
  }

  return { status, setPassword, setEnabled, setOptions, createPairing, cancelPairing, removeDevice, decide, start, stop, refreshRelay, _test: { seal, unseal, sessions, pairings, rpc } };
}

module.exports = { createRemote, seal, unseal, isPrivateIp, PAIR_TTL_MS, DEFAULT_PORT };
