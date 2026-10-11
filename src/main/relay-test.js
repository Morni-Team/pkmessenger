'use strict';

// Relay-Verbindung testen (Issue #120): „Verbindung testen" unter Einstellungen → Support → Erweitert.
// Prüft in zwei Schritten, ob ein selbst gehosteter PKMessenger-Relay wirklich funktioniert:
//   1) https://<domain>/health antwortet mit { service: 'pkmessenger-relay' }  (DNS, TLS-Zertifikat, Reverse-Proxy)
//   2) WebSocket wss://<domain>/ws: einem zufälligen Test-Raum beitreten → { relay: 'joined' }  (WebSocket-Weiterleitung)
// Es werden keine Schlüssel, Tokens oder Inhalte übertragen – nur ein zufälliger Test-Raum, der sofort wieder verlassen wird.

const crypto = require('node:crypto');

const TIMEOUT_MS = 8000;

/** Technische Fehler → verständliche deutsche Hinweise. */
function explain(err) {
  const code = String(err?.cause?.code || err?.code || '');
  const msg = String(err?.message || err || '');
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'Domain nicht gefunden – stimmt die Adresse? Zeigt der DNS-Eintrag auf deinen Server?';
  if (/ECONNREFUSED/.test(code)) return 'Server lehnt die Verbindung ab – läuft der Reverse-Proxy (Caddy/Nginx) auf Port 443?';
  if (/ETIMEDOUT|ECONNRESET|UND_ERR_CONNECT_TIMEOUT/.test(code) || /timeout|aborted/i.test(msg)) return 'Keine Antwort (Zeitüberschreitung) – Firewall, Port-Weiterleitung 443 oder Server aus?';
  if (/CERT|SSL|TLS|ERR_TLS/i.test(code + msg)) return 'Problem mit dem HTTPS-Zertifikat – hat Caddy/Let\'s Encrypt schon ein Zertifikat für die Domain? (DNS muss vorher stimmen.)';
  return msg.slice(0, 200) || 'Unbekannter Fehler.';
}

function createRelayTester({ fetchImpl = (...a) => fetch(...a), WebSocketImpl = null, now = () => Date.now() } = {}) {
  const loadWs = () => {
    if (WebSocketImpl) return WebSocketImpl;
    try {
      return require('ws');
    } catch {
      return null;
    }
  };

  /** @returns {Promise<{ ok: boolean, steps: {name:string, ok:boolean, detail:string}[], ms: number }>} */
  async function test(wss) {
    const started = now();
    const steps = [];
    const done = () => ({ ok: steps.every((s) => s.ok), steps, ms: now() - started });
    if (typeof wss !== 'string' || !/^wss:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(wss)) {
      steps.push({ name: 'Adresse', ok: false, detail: 'Bitte eine Adresse wie wss://relay.deine-domain.de/ws eintragen.' });
      return done();
    }
    const base = wss.replace(/^wss:/i, 'https:').replace(/\/ws\/?$/i, '').replace(/\/+$/, '');

    // 1) HTTPS-Gesundheitscheck
    try {
      const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { 'user-agent': 'PKMessenger-RelayTest' } });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) steps.push({ name: 'Server erreichbar', ok: false, detail: `Server antwortet mit HTTP ${res.status} – ist der Relay hinter dem Reverse-Proxy gestartet?` });
      else if (body?.service !== 'pkmessenger-relay') steps.push({ name: 'Server erreichbar', ok: false, detail: 'Der Server antwortet, ist aber kein PKMessenger-Relay (falsche Adresse oder Proxy zeigt woandershin).' });
      else steps.push({ name: 'Server erreichbar', ok: true, detail: 'HTTPS + Zertifikat in Ordnung, PKMessenger-Relay gefunden.' });
    } catch (err) {
      steps.push({ name: 'Server erreichbar', ok: false, detail: explain(err) });
      return done();
    }
    if (!steps[0].ok) return done();

    // 2) WebSocket: Test-Raum betreten und sofort wieder verlassen
    const WS = loadWs();
    if (!WS) {
      steps.push({ name: 'WebSocket', ok: false, detail: 'WebSocket-Modul fehlt in dieser App-Version.' });
      return done();
    }
    const result = await new Promise((resolve) => {
      let ws;
      let finished = false;
      const finish = (ok, detail) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          ws?.close();
        } catch {
          /* egal */
        }
        resolve({ ok, detail });
      };
      const timer = setTimeout(() => finish(false, 'Keine Antwort über WebSocket – leitet der Reverse-Proxy /ws als WebSocket weiter?'), TIMEOUT_MS);
      timer.unref?.();
      try {
        ws = new WS(wss);
      } catch (err) {
        finish(false, explain(err));
        return;
      }
      ws.on('open', () => {
        try {
          ws.send(JSON.stringify({ room: `test-${crypto.randomBytes(9).toString('base64url')}`, role: 'host' }));
        } catch (err) {
          finish(false, explain(err));
        }
      });
      ws.on('message', (raw) => {
        let m = null;
        try {
          m = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (m?.relay === 'joined') finish(true, 'WebSocket-Verbindung und Raum-Vermittlung funktionieren.');
      });
      ws.on('error', (err) => finish(false, explain(err)));
      ws.on('close', (code, reason) => finish(false, `Verbindung vom Server beendet (${code}${reason ? ` ${String(reason)}` : ''}).`));
    });
    steps.push({ name: 'WebSocket', ...result });
    return done();
  }

  /**
   * #151: Den KOSTENLOSEN Weg prüfen (Direktverbindung): Sind die öffentlichen Nostr-Vermittler erreichbar, ist die
   * Helfer-Seite auf GitHub Pages online? Dafür braucht es keinen eigenen Server.
   */
  async function testDirect({ relays, page }) {
    const started = now();
    const WS = loadWs();
    const reach = await Promise.all(
      relays.map(
        (url) =>
          new Promise((resolve) => {
            if (!WS) return resolve(false);
            let ws;
            const timer = setTimeout(() => done(false), TIMEOUT_MS);
            timer.unref?.();
            function done(ok) {
              clearTimeout(timer);
              try {
                ws?.close();
              } catch {
                /* egal */
              }
              resolve(ok);
            }
            try {
              ws = new WS(url);
            } catch {
              return done(false);
            }
            ws.on('open', () => done(true));
            ws.on('error', () => done(false));
          }),
      ),
    );
    const n = reach.filter(Boolean).length;
    const steps = [
      {
        name: 'Kostenlose Vermittler',
        ok: n > 0,
        detail: n ? `${n} von ${relays.length} erreichbar – darüber finden sich Helfer und PC.` : 'Keiner erreichbar – blockiert eine Firewall, ein VPN oder ein Virenscanner WebSockets?',
      },
    ];
    try {
      const res = await fetchImpl(page, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'PKMessenger-RelayTest' } });
      steps.push({ name: 'Helfer-Seite', ok: res.ok, detail: res.ok ? 'Online (GitHub Pages).' : `Antwortet mit HTTP ${res.status}.` });
    } catch (err) {
      steps.push({ name: 'Helfer-Seite', ok: false, detail: explain(err) });
    }
    return { ok: steps.every((s) => s.ok), steps, ms: now() - started };
  }

  return { test, testDirect };
}

module.exports = { createRelayTester, explain };
