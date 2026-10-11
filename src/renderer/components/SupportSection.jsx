// Support (Issue #120, vibeworks #219): „Mir soll jemand helfen" so einfach wie möglich.
//  - Oben: kurz erklärt, EIN Knopf „▶ Hilfe starten" → Link + Einmal-Code werden erzeugt und als fertige Nachricht kopiert.
//    Standard: über den Server des Morni-Teams – der Nutzer muss nichts installieren. Ist er nicht erreichbar, gibt es
//    ein Popup mit Grund und der Link fällt automatisch auf „nur im selben WLAN" zurück.
//  - „⚙️ Erweitert" (eingeklappt): Standard-Server / eigener Server / aus, Verbindung testen, kurze Anleitung.
//  - „📱 Fernzugang fürs Handy" (eingeklappt).
// Sicherheit wie bei der Fernhilfe: der Helfer sieht nur Einrichtung/Einstellungen, nie Chats; jede Kopplung wird am PC
// bestätigt; Beenden jederzeit (auch Strg+Umschalt+X). Über den Server laufen nur Ende-zu-Ende-verschlüsselte Pakete.
import { useEffect, useState } from 'react';
import { api } from '../api';
import RemoteSection from './RemoteSection.jsx';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (u) => String(u || '').replace(/^\w+:\/\//, '').replace(/\/.*$/, '');

function TestResult({ test }) {
  if (!test || test.running) return null;
  return (
    <ul className="support__test" aria-label="Ergebnis des Verbindungstests">
      {test.steps.map((s) => (
        // #151: Der Ersatz-Server ist optional – ein Fehler dort ist kein Grund zur Sorge (gelb statt rot)
        <li key={s.name} className={s.ok ? 'ok' : s.optional ? 'muted' : 'warn'}>
          {s.ok ? '✅' : s.optional ? '➖' : '❌'} <b>{s.name}:</b> {s.detail}
        </li>
      ))}
      {test.ok && <li className="ok">🎉 Alles bereit – Hilfelinks gehen jetzt überall ({test.ms} ms).</li>}
      {test.ok && test.direct && !test.serverOk && <li className="muted small">Der Ersatz-Server wird nur gebraucht, wenn weder direkt noch über die Vermittler eine Verbindung klappt – und für den Fernzugang fürs Handy.</li>}
    </ul>
  );
}

/** Welcher Server vermittelt Hilfe/Fernzugang von außerhalb? (Standard / eigener / aus) */
export function HelpRelayField({ onChange }) {
  const [setting, setSetting] = useState(null); // { mode, own, standard }
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState(null);
  const [test, setTest] = useState(null);
  useEffect(() => {
    api
      .helpStatus()
      .then((s) => {
        setSetting(s?.relaySetting || { mode: 'standard', own: '' });
        setUrl(s?.relaySetting?.own || '');
      })
      .catch(() => setSetting({ mode: 'standard', own: '' }));
  }, []);
  const apply = async (patch, okText) => {
    try {
      const s = await api.helpSetRelay(patch);
      setSetting(s?.relaySetting || setting);
      setTest(null);
      setMsg(okText ? { ok: true, text: okText } : null);
      onChange?.(s?.relaySetting);
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };
  const runTest = async (target) => {
    setTest({ running: true });
    try {
      setTest(await api.helpTestRelay({ url: target || '' }));
    } catch (e) {
      setTest({ ok: false, steps: [{ name: 'Test', ok: false, detail: e.message }] });
    }
  };
  if (!setting) return <p className="muted small">Lade …</p>;
  const mode = setting.mode;
  return (
    <div className="settings__field" data-setting="help-relay">
      <span className="settings__label">🌍 Server für Hilfe von außerhalb</span>
      <label className="composer__ping">
        <input type="radio" name="relay-mode" checked={mode === 'standard'} onChange={() => apply({ mode: 'standard' }, 'Standard-Server aktiv.')} /> Standard-Server des Morni-Teams <span className="muted small">(empfohlen – nichts installieren)</span>
      </label>
      <label className="composer__ping">
        <input type="radio" name="relay-mode" checked={mode === 'own'} onChange={() => apply({ mode: 'own' })} /> Eigener Server
      </label>
      <label className="composer__ping">
        <input type="radio" name="relay-mode" checked={mode === 'off'} onChange={() => apply({ mode: 'off' }, 'Aus – Hilfe geht nur im selben WLAN.')} /> Aus <span className="muted small">(nur im selben WLAN)</span>
      </label>

      {mode === 'standard' && (
        <div className="settings__row">
          <span className="small">🌍 {hostOf(setting.standard)}</span>
          <button className="btn btn--ghost btn--small" onClick={() => runTest(setting.standard)} disabled={test?.running}>
            {test?.running ? 'Teste …' : '🔌 Verbindung testen'}
          </button>
        </div>
      )}
      {mode === 'own' && (
        <>
          <div className="settings__row">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://relay.deine-domain.de/ws" aria-label="Relay-Adresse" spellCheck={false} />
            <button className="btn btn--small" onClick={() => apply({ url: url.trim(), mode: 'own' }, 'Gespeichert. Tipp: einmal „Verbindung testen".')} disabled={!url.trim()}>
              Speichern
            </button>
            <button className="btn btn--ghost btn--small" onClick={() => runTest(url.trim())} disabled={!url.trim() || test?.running}>
              {test?.running ? 'Teste …' : '🔌 Verbindung testen'}
            </button>
          </div>
          <p className="small">{setting.own ? `🟢 Eingetragen: ${hostOf(setting.own)}` : '⚪ Noch keine Adresse gespeichert – bis dahin nur im selben WLAN.'}</p>
          <details className="support__guide">
            <summary>📖 Kurze Anleitung: eigenen Server in 3 Schritten</summary>
            <ol className="small">
              <li>
                Server mit Docker + eigener Domain (z. B. <code>relay.deine-domain.de</code>), DNS-Eintrag zeigt auf den Server, Ports 80/443 offen.
              </li>
              <li>
                Im Projektordner <code>relay/</code>: <code>cp .env.example .env</code> (Domain eintragen), dann <code>docker compose up -d</code>. Das HTTPS-Zertifikat kommt automatisch.
              </li>
              <li>
                Hier <code>wss://relay.deine-domain.de/ws</code> eintragen → Speichern → Verbindung testen.
              </li>
            </ol>
          </details>
        </>
      )}
      {msg && <p className={`small ${msg.ok ? 'ok' : 'warn'}`}>{msg.text}</p>}
      <TestResult test={test} />
      <p className="muted small">Der Server leitet nur Ende-zu-Ende-verschlüsselte Pakete weiter, speichert nichts und sieht nie deinen Token oder deine Chats.</p>
    </div>
  );
}

/** Hilfe mit einem Klick starten – Link + Code werden erzeugt und kopiert. */
function HelpLinkCard({ toast }) {
  const [info, setInfo] = useState(null); // { code, link, overRelay, expires }
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0);
  const [status, setStatus] = useState(null);
  const message = (link, code) => `Hi! Du kannst mir bei PKMessenger helfen: Öffne ${link} und gib den Code ${code} ein. Ich bestätige dich dann am PC.`;

  useEffect(() => {
    api
      .helpStatus()
      .then(setStatus)
      .catch(() => setStatus({}));
  }, []);
  useEffect(() => {
    if (!info?.expires) return undefined;
    const tick = () => setLeft(Math.max(0, Math.round((info.expires - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [info]);

  const copy = (text, title) =>
    api
      .copyText({ text })
      .then(() => toast?.({ kind: 'info', title, duration: 2500 }))
      .catch(() => {});

  const start = async () => {
    setBusy(true);
    try {
      const r = await api.helpRequest();
      let link = r?.url || null;
      let overRelay = false;
      // #143: Direktverbindung (Link auf GitHub Pages) geht ohne eigenen Server – sofort nutzen
      const direct = typeof r?.relayUrl === 'string' && r.relayUrl.includes('#p=1');
      if (direct) {
        link = r.relayUrl;
        overRelay = true;
      } else if (r?.relayUrl) {
        // Wirklich mit dem Server verbunden? (sonst wäre der Link tot) – bis zu 6 s warten
        let s = null;
        for (let i = 0; i < 12; i++) {
          s = await api.helpStatus().catch(() => null);
          if (s?.relayConnected || s?.relayError) break;
          await sleep(500);
        }
        if (s?.relayConnected) {
          link = r.relayUrl;
          overRelay = true;
        } else {
          toast?.({
            kind: 'warn',
            title: 'Server für Hilfe von außerhalb gerade nicht erreichbar',
            text: `${s?.relayError || 'Keine Antwort'}. Der Link geht jetzt nur im selben WLAN. Unter „Erweitert" kannst du den Server testen.`,
            duration: 9000,
          });
        }
      }
      if (!link) {
        toast?.({ kind: 'error', title: 'Kein Hilfelink möglich', text: 'Weder ein Server für außerhalb noch ein WLAN-Name ist verfügbar. Unter „Erweitert" einen Server wählen und testen.' });
        await api.helpStop({ reason: 'kein-link' }).catch(() => {});
        return;
      }
      setInfo({ code: r.code, link, overRelay, expires: r.expires });
      await copy(message(link, r.code), 'Kopiert – schick die Nachricht einfach deinem Helfer');
    } catch (e) {
      toast?.({ kind: 'error', title: e.message, text: e.hint });
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    await api.helpStop({ reason: 'knopf' }).catch(() => {});
    setInfo(null);
  };

  const where = !status ? '' : status.relayMode ? `🌍 Der Link geht überall – direkt von Gerät zu Gerät, ohne Server dazwischen (Rückfall: ${status.relayMode === 'own' ? 'dein Server' : 'Server des Morni-Teams'}).` : '🏠 Der Link geht nur im selben WLAN (Hilfe von außerhalb ist aus).';
  return (
    <div className="settings__field support__link" data-setting="help-link">
      <span className="settings__label">🙋 Jemand soll mir helfen</span>
      <p className="small">
        Ein Freund oder Support-Admin kann dir beim Einrichten über die Schulter schauen und Knöpfe drücken – <b>deine Chats sieht er nie</b>. Du bestätigst ihn am PC und kannst jederzeit beenden.
      </p>
      {!info ? (
        <>
          <div className="settings__row">
            <button className="btn btn--primary support__start" onClick={start} disabled={busy}>
              {busy ? 'Starte …' : '▶ Hilfe starten'}
            </button>
            <button className="btn btn--ghost btn--small" onClick={() => window.dispatchEvent(new CustomEvent('pk:help-open'))}>
              Mit QR-Code …
            </button>
          </div>
          <p className="muted small">{where}</p>
        </>
      ) : (
        <>
          <p className="small">
            ✅ Läuft! Nachricht ist kopiert – schick sie deinem Helfer. Code <b className="login-code">{info.code}</b> · gültig noch{' '}
            <b>
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </b>{' '}
            · {info.overRelay ? '🌍 geht überall' : '🏠 nur im selben WLAN'}
          </p>
          <div className="settings__row">
            <button className="btn btn--small" onClick={() => copy(message(info.link, info.code), 'Nachricht kopiert')}>
              📋 Nochmal kopieren
            </button>
            <button className="btn btn--ghost btn--small" onClick={() => copy(info.link, 'Link kopiert')}>
              Nur Link
            </button>
            <button className="btn btn--danger btn--small" onClick={stop}>
              ■ Hilfe beenden
            </button>
          </div>
          <HelpLiveLog />
        </>
      )}
    </div>
  );
}

// #152: Was passiert gerade? Protokoll der Fernhilfe live (Vermittler, Helfer gefunden, direkt verbunden …) – zum Kopieren
function HelpLiveLog() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .helpStatus()
        .then((s) => alive && setItems(Array.isArray(s?.activity) ? s.activity.slice(0, 8) : []))
        .catch(() => {});
    load();
    const t = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!items.length) return null;
  const time = (at) => new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const text = items.map((e) => `${time(e.at)}  ${e.action}`).join('\n');
  return (
    <details className="support__log" open>
      <summary className="muted small">📋 Was passiert gerade?</summary>
      <pre className="muted small">{text}</pre>
      <button className="btn btn--ghost btn--small" onClick={() => api.copyText({ text: `PKMessenger Fernhilfe-Protokoll (PC)\n${text}` }).catch(() => {})}>
        Protokoll kopieren
      </button>
    </details>
  );
}

export default function SupportSection({ toast }) {
  return (
    <>
      <HelpLinkCard toast={toast} />
      <details className="support__more" data-setting="support-advanced">
        <summary>⚙️ Erweitert: Server für Hilfe von außerhalb</summary>
        <HelpRelayField />
      </details>
      <details className="support__more" data-setting="support-remote">
        <summary>📱 Fernzugang fürs Handy</summary>
        <RemoteSection toast={toast} />
      </details>
    </>
  );
}
