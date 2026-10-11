'use strict';

// Fernhilfe (Issue #79): Ein Helfer schaut dem Nutzer bei der EINRICHTUNG über die Schulter und darf harmlose
// Schritte mitbedienen – Chats/Namen/Nachrichten bleiben verborgen, Token/Passwörter tippt nur der Nutzer selbst.
//
// Sicherheit (bewusst strenger als der Fernzugang):
// - AB WERK AUS und OHNE Dauer-Server: läuft NUR, solange der Nutzer „Hilfe anfordern“ aktiv hat. Danach sofort zu.
// - Nur EIN Helfer gleichzeitig. Kopplung mit Einmal-Code (10 Min) + Bestätigung am PC.
// - Nur private Netze (wie Fernzugang); Ende-zu-Ende verschlüsselt (tweetnacl secretbox), Nonce + Zeitstempel.
// - Der Helfer sieht einen GESCHWÄRZTEN Spiegel (help-redact.js): keine Chats, keine Namen, keine Geheimnisse.
// - Mitsteuern ist abschaltbar („nur Zusehen“), jede Helfer-Aktion wird gegen allowHelperAction geprüft.
// - Kein Bot-Token verlässt je das Gerät. Der Nutzer kann jederzeit beenden (Knopf oder Strg+C).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const nacl = require('tweetnacl');
const { isLocalAddress } = require('../shared/ai-limits');
const { redactView, allowHelperAction } = require('../shared/help-redact');

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;
// #152: Uhren von PC und Helfer-Gerät gehen oft ein paar Minuten auseinander. Wiederholungen verhindern die Nonces.
const CLOCK_SKEW_MS = 15 * 60 * 1000;
const APPROVAL_TIMEOUT_MS = 90 * 1000;
const RATE_PER_MIN = 240;
const MAX_BODY = 32 * 1024;
const DEFAULT_PORT = 47816; // ein anderer Port als der Fernzugang (47815)

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));
// URL-sicher (für den Schlüssel im Link-Fragment: kein +,/,= das URLSearchParams verfälscht). Die Helfer-Seite wandelt zurück.
const b64url = (u8) => Buffer.from(u8).toString('base64url');
const rid = (n = 16) => crypto.randomBytes(n).toString('base64url');
// Kurzer, gut ablesbarer Einmal-Code (ohne 0/O/1/I)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

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

const remoteIp = (req) => String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
const isPrivateIp = (ip) => ip === '::1' || isLocalAddress(`http://${ip.includes(':') ? `[${ip}]` : ip}/`);

/**
 * @param {object} o
 * @param {(t:string,p:any)=>void} o.emit
 * @param {() => object} o.getView   aktueller (ungeschwärzter) Oberflächen-Zustand, wird hier geschwärzt
 * @param {(action:object)=>void} o.applyAction  erlaubte Helfer-Aktion an die Oberfläche weitergeben
 * @param {() => string[]} o.lanAddresses
 * @param {string|null} o.hostName  mDNS-Name (kein IP im Link)
 */
function createHelp({ emit = () => {}, getView = () => ({}), applyAction = () => {}, now = () => Date.now(), lanAddresses = () => [], bindHost = '0.0.0.0', hostName = null, logger = null, port = DEFAULT_PORT, webDir = null, naclPath = null, getRelay = () => null, WebSocketImpl = null, p2p = null, p2pPage = null, captureScreen = null }) {
  let server = null;
  let pairing = null; // { code, key, expires } – ein offener Einmal-Code
  let session = null; // { key, expires, approved, control } – der eine verbundene Helfer
  let pendingApproval = null; // { resolve }
  const seenNonces = new Map();
  const rate = new Map();
  let controlAllowed = true; // „nur Zusehen“ schaltet das aus
  const activity = [];
  let lastShot = null; // #158: zuletzt aufgenommenes Bild (kurz zwischengespeichert)
  let chatLog = []; // #160: Hilfe-Chat zwischen Helfer und Nutzer (nur im Speicher, endet mit der Hilfe)
  function addChat(from, text) {
    const e = { from, text: String(text).trim().slice(0, 300), at: now() };
    chatLog.push(e);
    chatLog = chatLog.slice(-50);
    emit('help:chat', e);
    return e;
  }

  function log(action, extra = {}) {
    const e = { at: now(), action, ...extra };
    activity.unshift(e);
    activity.length = Math.min(activity.length, 100);
    emit('help:activity', e);
    logger?.info?.('help', action);
    return e;
  }

  function status() {
    return {
      running: Boolean(server?.listening),
      waitingForHelper: Boolean(pairing && !session),
      connected: Boolean(session?.approved),
      controlAllowed,
      host: hostName || null,
      addresses: lanAddresses(),
      port: server?.address()?.port || DEFAULT_PORT,
      relay: getRelay()?.httpBase || null,
      relayMode: getRelay()?.mode || null,
      relayConnected: relayUp,
      relayError,
      direct: p2pState,
      chat: chatLog.slice(-30),
      activity: activity.slice(0, 20),
    };
  }

  function emitStatus() {
    emit('help:status', status());
  }

  const cleanNonces = () => {
    for (const [k, exp] of seenNonces) if (exp < now()) seenNonces.delete(k);
  };
  function rateOk(ip) {
    const r = rate.get(ip) || { count: 0, win: now() };
    if (now() - r.win > 60000) {
      r.count = 0;
      r.win = now();
    }
    r.count += 1;
    rate.set(ip, r);
    return r.count <= RATE_PER_MIN;
  }

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  function askUser(info) {
    // „Darf dieser Helfer verbinden?“ am PC. Nur eine Anfrage gleichzeitig.
    if (pendingApproval) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = rid(8);
      pendingApproval = { id, resolve };
      emit('help:pending', { id, ...info });
      setTimeout(() => {
        if (pendingApproval?.id === id) {
          pendingApproval = null;
          emit('help:pending', { id, done: true });
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS).unref?.();
    });
  }
  function decide({ id, allow }) {
    if (!pendingApproval || pendingApproval.id !== id) return false;
    const { resolve } = pendingApproval;
    pendingApproval = null;
    emit('help:pending', { id, done: true });
    resolve(Boolean(allow));
    return true;
  }

  // verschlüsselte Anfrage prüfen (Nonce frisch, Zeitstempel aktuell)
  function openBody(body, key) {
    const data = unseal(body, key);
    if (!data || typeof data.t !== 'number' || Math.abs(now() - data.t) > CLOCK_SKEW_MS) return null;
    const nonce = body.n;
    cleanNonces();
    if (seenNonces.has(nonce)) return null;
    seenNonces.set(nonce, now() + 2 * CLOCK_SKEW_MS);
    return data;
  }

  const STATIC = { '/help/': ['index.html', 'text/html; charset=utf-8'], '/help/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/help/nacl.js': ['nacl.js', 'text/javascript; charset=utf-8'] };
  const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  // Gemeinsame Logik für LAN (HTTP) und Relay (WebSocket) → { code, obj } (code nur für HTTP relevant).
  async function rpc(path, body, { ip = 'relay' } = {}) {
    if (path === '/pair') {
      if (!pairing || pairing.expires < now()) return { code: 403, obj: { error: 'Code abgelaufen. Am PC „Hilfe anfordern“ neu starten.' } };
      if (String(body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') !== pairing.code) return { code: 403, obj: { error: 'Falscher Code.' } };
      if (session) return { code: 409, obj: { error: 'Es hilft bereits jemand.' } };
      const payload = unseal(body, pairing.key);
      const helperName = String(payload?.name || 'Helfer').slice(0, 40);
      const ok = await askUser({ helper: helperName, ip });
      if (!ok) return { code: 200, obj: seal({ error: 'Am PC abgelehnt oder keine Antwort.' }, pairing.key) };
      session = { key: pairing.key, expires: now() + SESSION_TTL_MS, approved: true, control: controlAllowed, name: helperName };
      pairing = null;
      log('Helfer verbunden', { helper: helperName });
      emitStatus();
      return { code: 200, obj: seal({ ok: true, ttl: SESSION_TTL_MS }, session.key) };
    }
    if (!session || session.expires < now()) return { code: 401, obj: { error: 'Nicht verbunden.' } };
    const data = openBody(body, session.key);
    if (!data) return { code: 400, obj: { error: 'Ungültige oder wiederholte Anfrage.' } };
    if (path === '/view') return { code: 200, obj: seal({ view: redactView(getView()), control: controlAllowed, screen: Boolean(captureScreen), chat: chatLog.slice(-30) }, session.key) };
    // #158: echtes Bild der App (geschwärzt in help-screen.js) – höchstens alle 700 ms neu aufnehmen
    if (path === '/screen') {
      if (!captureScreen) return { code: 200, obj: seal({ screen: null }, session.key) };
      // #161: schneller – höchstens alle 250 ms neu aufnehmen, und unverändertes Bild NICHT erneut schicken
      // (der Helfer nennt die Nummer seines Bildes; gleich → nur „same“ statt ~50 KB)
      if (!lastShot || now() - lastShot.at > 250) {
        let shot = null;
        try {
          shot = await captureScreen(getView());
        } catch (err) {
          logger?.warn?.('help', `Bild: ${err?.message || err}`);
        }
        const same = shot && lastShot?.shot && shot.img === lastShot.shot.img;
        lastShot = { at: now(), shot, id: same ? lastShot.id : (lastShot?.id || 0) + 1 };
      }
      if (lastShot.shot && data.have === lastShot.id) return { code: 200, obj: seal({ screen: { same: true, id: lastShot.id } }, session.key) };
      return { code: 200, obj: seal({ screen: lastShot.shot ? { ...lastShot.shot, id: lastShot.id } : null }, session.key) };
    }
    if (path === '/act') {
      const verdict = allowHelperAction(data.action, { view: getView(), enabled: true, controlAllowed });
      if (!verdict.ok) return { code: 200, obj: seal({ rejected: verdict.reason }, session.key) };
      // #160: Chat-Nachrichten landen im Hilfe-Chat, nicht als Aktion in der Oberfläche
      if (data.action.type === 'chat') addChat('helfer', data.action.text);
      // #161: die Maus des Helfers trägt seinen Namen (nur Anzeige beim Nutzer)
      else applyAction(data.action.type === 'cursor' ? { ...data.action, name: session.name } : data.action);
      if (data.action?.type !== 'cursor') log('Helfer-Aktion', { kind: data.action?.type }); // Mausbewegungen nicht protokollieren
      return { code: 200, obj: seal({ ok: true }, session.key) };
    }
    return { code: 404, obj: { error: 'Unbekannt.' } };
  }

  // Relay-Client (außerhalb des WLANs): verbindet sich AUSGEHEND zum Relay, empfängt Helfer-Pakete, antwortet.
  let relayWs = null;
  let relayUp = false;
  // #158: Zuletzt gesehener Zustand des Ersatz-Servers (über mehrere Hilfe-Sitzungen). Ist er bekannt kaputt, kommt
  // er gar nicht erst in den Link – die Helfer-Seite versucht ihn dann auch nicht (keine sinnlosen Fehlermeldungen).
  let relayLastOk = null;
  let relayError = null;
  function stopRelay() {
    const w = relayWs;
    relayWs = null;
    relayUp = false;
    if (w) try { w.close(); } catch { /* egal */ }
  }
  function startRelay(roomId) {
    const relay = getRelay();
    const WS = WebSocketImpl || (() => { try { return require('ws'); } catch { return null; } })();
    if (!relay?.wss || !WS) return;
    stopRelay();
    relayError = null;
    let ws;
    try {
      ws = new WS(relay.wss);
    } catch (err) {
      relayError = String(err?.message || err).slice(0, 200);
      relayLastOk = false;
      return;
    }
    relayWs = ws;
    ws.on('open', () => { try { ws.send(JSON.stringify({ room: roomId, role: 'host' })); } catch { /* egal */ } });
    ws.on('message', async (rawMsg) => {
      let m = null;
      try { m = JSON.parse(rawMsg.toString()); } catch { return; }
      if (m.relay) {
        if (m.relay === 'joined') {
          relayUp = true;
          relayLastOk = true;
        }
        if (m.relay === 'peer') { log(m.connected ? 'Helfer (über Relay) da' : 'Helfer (über Relay) weg'); emitStatus(); }
        return;
      }
      if (!m.path || typeof m.id !== 'string') return;
      const { obj } = await rpc(m.path, m.body, { ip: 'relay' });
      try { ws.send(JSON.stringify({ id: m.id, reply: obj })); } catch { /* egal */ }
    });
    ws.on('close', () => { if (relayWs === ws) { relayWs = null; relayUp = false; } });
    ws.on('error', (err) => {
      relayError = String(err?.message || err).slice(0, 200);
      relayLastOk = false;
      logger?.warn?.('help', `relay: ${relayError}`);
    });
  }

  // Direktverbindung (vibeworks #219, #143): WebRTC im versteckten P2P-Fenster, Vermittlung über öffentliche Nostr-Relays.
  // Gleiche rpc-Logik wie LAN/Relay (Einmal-Code, Bestätigung am PC, Schwärzen, Prüfung jeder Aktion).
  // Nur, wenn Hilfe von außen erlaubt ist (Relay-Modus nicht „nur WLAN“).
  let p2pState = null;
  function startP2P(key) {
    if (!p2p) return false;
    try {
      p2p.start(
        key,
        async (p, body) => (await rpc(p, body, { ip: 'direkt' })).obj,
        (st) => {
          // #148: Diagnose – Anzahl erreichbarer Vermittler nur protokollieren, kein eigener Zustand
          if (/^uhr:-?\d+$/.test(st)) {
            const min = Number(st.split(':')[1]);
            log(`Hinweis: Die Uhr des Helfer-Geräts weicht um ${Math.abs(min)} Min. von diesem PC ab – bei großen Abweichungen Uhrzeit automatisch stellen lassen`);
            return;
          }
          if (/^relays:\d+$/.test(st)) {
            const n = Number(st.split(':')[1]);
            if (n > 0) log(`Direktverbindung bereit – ${n} Vermittler erreichbar`);
            else {
              log('Direktverbindung: KEIN Vermittler erreichbar (Firewall, VPN oder Virenscanner blockiert?)');
              logger?.warn?.('help', 'p2p: keine Nostr-Vermittler erreichbar');
            }
            emitStatus();
            return;
          }
          const was = p2pState;
          p2pState = st;
          // #148: jeden Schritt der Direktverbindung protokollieren (Fehlersuche)
          const STEP_TEXT = {
            angeboten: 'Direktverbindung: Helfer gefunden, baue Verbindung auf …',
            connecting: 'Direktverbindung: verbinde …',
            connected: 'Direktverbindung: Netzweg gefunden',
            failed: 'Direktverbindung fehlgeschlagen (Netz/VPN blockiert) – Helfer kann über die Vermittler weitermachen',
            disconnected: 'Direktverbindung unterbrochen',
            getrennt: 'Direktverbindung getrennt',
            verbunden: 'Helfer direkt verbunden ✓',
            vermittler: 'Helfer über die Vermittler verbunden (keine Direktverbindung möglich)',
          };
          if (was !== st && STEP_TEXT[st]) {
            log(STEP_TEXT[st]);
            logger?.info?.('help', `p2p: ${st}`);
          }
          emitStatus();
        },
      );
      p2pState = 'suche';
      return true;
    } catch (err) {
      logger?.warn?.('help', `p2p: ${err?.message || err}`);
      return false;
    }
  }
  function stopP2P() {
    p2pState = null;
    try {
      p2p?.stop();
    } catch {
      /* egal */
    }
  }

  async function handle(req, res) {
    const ip = remoteIp(req);
    if (!isPrivateIp(ip)) return json(res, 403, { error: 'Nur im eigenen Netzwerk.' });
    if (req.method === 'GET') {
      const p = (req.url || '').split('?')[0].split('#')[0];
      const hit = STATIC[p] || (p === '/help' ? STATIC['/help/'] : null);
      if (!hit || !webDir) return json(res, 404, { error: 'Unbekannt.' });
      try {
        const body = fs.readFileSync(hit[0] ? path.join(webDir, hit[0]) : naclPath);
        res.writeHead(200, { 'content-type': hit[1], 'cache-control': 'no-store', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
        return res.end(body);
      } catch { return json(res, 500, { error: 'Fehler.' }); }
    }
    if (!rateOk(ip)) return json(res, 429, { error: 'Zu viele Anfragen.' });
    const url = (req.url || '').split('?')[0];
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return json(res, 413, { error: 'Zu groß.' });
    }
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { error: 'Ungültig.' });
    }

    const { code, obj } = await rpc(url, body, { ip });
    return json(res, code, obj);
  }

  /** „Hilfe anfordern“: Server starten (falls nötig), Einmal-Code erzeugen. */
  function request() {
    const key = nacl.randomBytes(nacl.secretbox.keyLength);
    const code = newCode();
    const roomId = rid(18).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    pairing = { code, key, expires: now() + CODE_TTL_MS };
    session = null;
    const relay = getRelay();
    if (relay?.wss) startRelay(roomId);
    const direct = relay && p2pPage ? startP2P(key) : false;
    const startServer = () =>
      new Promise((resolve) => {
        if (server?.listening) return resolve();
        server = http.createServer((req, res) => handle(req, res).catch(() => json(res, 500, { error: 'Fehler.' })));
        server.on('error', (err) => {
          logger?.error?.('help', `listen failed: ${err.message}`);
          resolve();
        });
        server.listen(port, bindHost, resolve);
      });
    return startServer().then(() => {
      const prt = server?.address()?.port || DEFAULT_PORT;
      const hash = `#c=${b64url(key)}`;
      // LAN: nur der PC-Name, kein IP im Link. Code wird separat angezeigt.
      const url = hostName ? `http://${hostName}:${prt}/help/${hash}` : null;
      // Außerhalb des WLANs: Link über den Relay – der Helfer öffnet ihn überall im Browser (kein QR-Scan nötig).
      // Mit Direktverbindung: Seite von GitHub Pages (kein eigener Server nötig), Relay nur als Rückfall (h=…).
      const relayHost = relay?.httpBase && relayLastOk !== false ? relay.httpBase.replace(/^https:\/\//, '') : '';
      if (direct && relay?.httpBase && relayLastOk === false) log('Ersatz-Server war zuletzt nicht erreichbar – Link nur mit Direktverbindung');
      const relayUrl = direct
        ? `${p2pPage}#p=1&c=${b64url(key)}${relayHost ? `&r=${roomId}&h=${relayHost}` : ''}`
        : relay?.httpBase
          ? `${relay.httpBase}/help/#r=${roomId}&c=${b64url(key)}`
          : null;
      log(direct ? 'Hilfe angefordert – Direktverbindung aktiv (ohne eigenen Server), Ersatz-Server als Rückfall' : relayUrl ? 'Hilfe angefordert – über den Server' : 'Hilfe angefordert – nur im selben WLAN');
      logger?.info?.('help', `Hilfe angefordert (${direct ? 'direkt' : relayUrl ? 'server' : 'wlan'}, App ${process.versions?.electron ? 'Electron' : 'Node'})`);
      emitStatus();
      return { code, url, relayUrl, port: prt, host: hostName, expires: pairing.expires, relay: Boolean(relayUrl) };
    });
  }

  /** #160: Nachricht des Nutzers an den Helfer (Hilfe-Chat). */
  function chat({ text }) {
    if (!session) return { ok: false, chat: chatLog.slice(-30) };
    addChat('nutzer', text);
    return { ok: true, chat: chatLog.slice(-30) };
  }

  /** Mitsteuern erlauben/sperren (nur Zusehen). */
  function setControl({ on }) {
    controlAllowed = Boolean(on);
    if (session) session.control = controlAllowed;
    emitStatus();
    return status();
  }

  /** Helfer trennen, aber Code offen lassen (falls jemand anderes helfen soll). */
  function disconnect() {
    session = null;
    log('Helfer getrennt');
    emitStatus();
    return status();
  }

  /** Alles beenden (Knopf oder Strg+C): Server zu, keine Verbindung mehr. */
  const STOP_TEXT = { knopf: 'Knopf „Hilfe beenden“', tastatur: 'Tastenkürzel Strg+Umschalt+X', 'kein-link': 'kein Link möglich', app: 'App wird beendet', unbekannt: '' };
  function stop({ reason = 'unbekannt' } = {}) {
    pairing = null;
    session = null;
    chatLog = [];
    stopRelay();
    stopP2P();
    if (pendingApproval) {
      pendingApproval.resolve(false);
      pendingApproval = null;
    }
    const s = server;
    server = null;
    if (s) s.close();
    log(STOP_TEXT[reason] ? `Fernhilfe beendet (${STOP_TEXT[reason]})` : 'Fernhilfe beendet');
    emitStatus();
    return status();
  }

  return { status, request, decide, setControl, disconnect, stop, chat, chatLog: () => chatLog.slice(-30), _test: { seal, unseal, handleAddress: () => server?.address() } };
}

module.exports = { createHelp, isPrivateIp, DEFAULT_PORT };
