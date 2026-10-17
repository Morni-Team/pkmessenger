import { useEffect, useState } from 'react';
import { api, onEvent } from '../api';

// Einstellungen → Sicherheit & Start → 📱 Fernzugang (WLAN) – Issue #46/#50
const fmt = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');

export default function RemoteSection({ toast }) {
  const [st, setSt] = useState(null);
  const [pw, setPw] = useState({ password: '', repeat: '', current: '' });
  const [pair, setPair] = useState(null); // { url, qr, expires }
  const [left, setLeft] = useState(0);
  const load = () =>
    api
      .remoteStatus()
      .then(setSt)
      .catch(() => setSt(null));
  useEffect(() => {
    load();
    return onEvent((t, p) => {
      if (t === 'remote:activity' && p?.action === 'Gerät gekoppelt') setPair(null); // Einmal-Code ist verbraucht
      if (t === 'remote:activity' || t === 'remote:pending') load();
    });
  }, []);
  useEffect(() => {
    if (!pair) return undefined;
    const iv = setInterval(() => {
      const s = Math.max(0, Math.round((pair.expires - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setPair(null);
    }, 500);
    return () => clearInterval(iv);
  }, [pair]);
  const run = async (fn, ok) => {
    try {
      const r = await fn();
      if (ok) toast({ kind: 'info', title: ok, duration: 2500 });
      return r;
    } catch (e) {
      toast({ kind: 'error', title: e.message, text: e.hint });
      return null;
    }
  };
  if (!st) return <p className="muted small">Lade …</p>;

  const savePw = async () => {
    if (pw.password !== pw.repeat) return toast({ kind: 'warn', title: 'Die Passwörter sind nicht gleich.' });
    const r = await run(() => api.remoteSetPassword({ password: pw.password, current: pw.current || undefined }), 'Fernzugangs-Passwort gespeichert 🔒');
    if (r) {
      setSt(r);
      setPw({ password: '', repeat: '', current: '' });
    }
    return undefined;
  };

  return (
    <div className="remote" data-setting="remote">
      <span className="settings__label">📱 Fernzugang (Handy, zweiter PC)</span>
      <p className="muted small">
        Andere Geräte können den Bot über den Browser bedienen – im <b>eigenen WLAN</b> direkt, <b>unterwegs</b> über deinen eigenen Relay (Adresse unter Hilfe &amp; Tour). Ihre Nachrichten gehen weiter als Bot raus. Verschlüsselt, nur mit Einmal-Code, Passwort und deiner Bestätigung. Ab Werk aus.
      </p>

      <div className="remote__pw">
        <span className="small">{st.hasPassword ? '🔒 Fernzugangs-Passwort ist gesetzt' : 'Zuerst ein eigenes Fernzugangs-Passwort festlegen (mind. 8 Zeichen):'}</span>
        {st.hasPassword && <input type="password" autoComplete="current-password" placeholder="Bisheriges Passwort (zum Ändern)" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} aria-label="Bisheriges Fernzugangs-Passwort" />}
        <input type="password" autoComplete="new-password" placeholder="Neues Fernzugangs-Passwort" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} aria-label="Neues Fernzugangs-Passwort" />
        <input type="password" autoComplete="new-password" placeholder="Wiederholen" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} aria-label="Fernzugangs-Passwort wiederholen" />
        <button className="btn btn--small" disabled={!pw.password} onClick={savePw}>
          {st.hasPassword ? 'Passwort ändern' : 'Passwort festlegen'}
        </button>
      </div>

      <label className="composer__ping">
        <input type="checkbox" checked={st.enabled} disabled={!st.hasPassword} onChange={(e) => run(async () => setSt(await api.remoteEnable({ on: e.target.checked })), e.target.checked ? 'Fernzugang an' : 'Fernzugang aus')} /> 📡 Fernzugang einschalten
      </label>
      {st.enabled && (
        <p className="small">
          {st.running ? '🟢 Läuft' : '🔴 Läuft nicht'} · {st.addresses.length ? `erreichbar im WLAN${st.host ? ` als „${st.host}“` : ''}` : 'kein WLAN gefunden'}
          <span className="muted"> · Beim ersten Mal fragt die Windows-Firewall nach: „Private Netzwerke“ erlauben, „Öffentliche“ NICHT.</span>
        </p>
      )}
      {st.enabled && (
        <p className="small" data-help-id="remote-relay">
          🌍 Unterwegs:{' '}
          {!st.relay?.configured ? (
            <span className="muted">aus – trag unter „Hilfe &amp; Tour“ deine Relay-Adresse ein (wss://…/ws), dann geht es auch außerhalb des WLANs.</span>
          ) : st.relay.connected ? (
            <span>🟢 über deinen Relay erreichbar</span>
          ) : (
            <span>🟡 verbinde mit dem Relay …</span>
          )}
        </p>
      )}
      {st.enabled && st.relay?.configured && (
        <div className="settings__row">
          <button
            className="btn btn--ghost btn--small"
            title="Alle bisherigen Unterwegs-Links werden ungültig – gekoppelte Geräte müssen dann neu gekoppelt werden"
            onClick={() => run(async () => setSt(await api.remoteOptions({ newRoom: true })), 'Neuer Relay-Raum – alte Unterwegs-Links gelten nicht mehr')}
          >
            🔄 Neuen Relay-Raum erzeugen
          </button>
        </div>
      )}
      <label className="composer__ping">
        <input type="checkbox" checked={st.requireApproval} onChange={(e) => run(async () => setSt(await api.remoteOptions({ requireApproval: e.target.checked })))} /> ✋ Jede Nachricht von anderen Geräten erst hier bestätigen
      </label>

      {st.enabled && (st.running || st.relay?.configured) && (
        <div className="settings__row">
          <button
            className="btn btn--primary btn--small"
            onClick={() =>
              run(async () => {
                const p = await api.remotePair();
                setPair(p);
              })
            }
          >
            ➕ Gerät hinzufügen (QR-Code)
          </button>
        </div>
      )}
      {pair && (
        <div className="remote__pair">
          <img src={pair.qr} alt="QR-Code zum Koppeln" width="220" height="220" data-private />
          <div>
            <p className="small">
              Mit dem Handy scannen{pair.relayUrl ? ' – geht überall (über deinen Relay)' : ' (gleiches WLAN)'}. Gültig noch <b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</b> Minuten, nur <b>einmal</b> benutzbar.
            </p>
            <div className="settings__row">
              <button className="btn btn--ghost btn--small" onClick={() => api.copyText({ text: pair.relayUrl || pair.url }).then(() => toast({ kind: 'info', title: 'Link kopiert', duration: 1500 }))}>
                📋 Link kopieren
              </button>
              <button
                className="btn btn--ghost btn--small"
                onClick={() => {
                  api.remoteCancelPair({ pairId: pair.pairId }).catch(() => {});
                  setPair(null);
                }}
              >
                Widerrufen
              </button>
            </div>
            <p className="muted small">🔒 Der Link enthält keine IP-Adresse – {pair.relayUrl ? 'nur deinen Relay' : `nur den Namen deines PCs („${pair.host || 'im WLAN'}“)`} und einen geheimen Schlüssel. Nicht weitergeben. Koppeln geht nur mit Fernzugangs-Passwort und deiner Bestätigung hier.</p>
          </div>
        </div>
      )}

      <span className="settings__label">Gekoppelte Geräte ({st.devices.length})</span>
      {st.devices.length === 0 && <p className="muted small">Noch keine.</p>}
      {st.devices.map((d) => (
        <div key={d.id} className="ai-memory-row small">
          <span>
            📱 <b>{d.name}</b> · gekoppelt {fmt(d.pairedAt)} · zuletzt {fmt(d.lastSeen)}
          </span>
          <button className="btn btn--danger btn--small" onClick={() => run(async () => setSt(await api.remoteRemoveDevice({ id: d.id })), `${d.name} entfernt`)}>
            Entfernen
          </button>
        </div>
      ))}

      {st.activity.length > 0 && (
        <>
          <span className="settings__label">Aktivität</span>
          <div className="remote__log">
            {st.activity.map((a, i) => (
              <div key={i} className={`small ${/Falsch|abgelehnt/.test(a.action) ? 'warn' : ''}`}>
                {fmt(a.at)} · {a.device || 'PC'}: {a.action}
                {a.detail ? ` – „${a.detail}“` : ''}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Bestätigung am PC: Kopplung oder Nachricht eines anderen Geräts (läuft im Workspace). */
export function RemoteApprovals() {
  const [list, setList] = useState([]);
  useEffect(
    () =>
      onEvent((t, p) => {
        if (t !== 'remote:pending' || !p?.id) return;
        setList((l) => (p.done ? l.filter((x) => x.id !== p.id) : [...l.filter((x) => x.id !== p.id), p]));
      }),
    [],
  );
  if (!list.length) return null;
  const p = list[0];
  const decide = (allow) => {
    api.remoteDecide({ id: p.id, allow }).catch(() => {});
    setList((l) => l.filter((x) => x.id !== p.id));
  };
  return (
    <div className="modal-backdrop oops-backdrop">
      <div className="modal confirm" role="alertdialog" aria-label="Fernzugang bestätigen">
        <h3>{p.kind === 'pair' ? '📱 Neues Gerät will sich verbinden' : '📱 Nachricht von einem anderen Gerät'}</h3>
        <p>
          <b>{p.device}</b> (aus deinem WLAN) {p.kind === 'pair' ? 'möchte deinen Bot über den Fernzugang bedienen.' : 'möchte als Bot senden:'}
        </p>
        {p.preview && <div className="link-warn__url">{p.preview}</div>}
        <p className="muted small">{new Date().toLocaleTimeString('de-DE')} · Kennst du das Gerät nicht? Dann ablehnen.</p>
        <div className="confirm__actions">
          <button className="btn btn--ghost" onClick={() => decide(false)}>
            Ablehnen
          </button>
          <button className="btn btn--primary" onClick={() => decide(true)}>
            Zulassen
          </button>
        </div>
      </div>
    </div>
  );
}
