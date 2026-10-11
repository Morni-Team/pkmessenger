import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { bus } from '../state';
import { startHelpBridge, stopHelpBridge } from '../helpBridge';

// Fernhilfe (Issue #79): Der Nutzer fordert Hilfe an. Ein Helfer sieht nur die Einrichtung (Chats verborgen),
// kann optional mithelfen, und der Nutzer kann jederzeit beenden (Knopf oder Strg+Umschalt+X).
// #156: früher Strg+C – dann beendete schon das Kopieren von Link/Code die Hilfe, bevor der Helfer da war.

/** Fenster „Hilfe anfordern“ (öffnet sich über Event pk:help-open oder Prop open). */
export function HelpDialog({ onClose, toast }) {
  const [info, setInfo] = useState(null); // { code, qr, url }
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    api.helpStatus().then(setStatus).catch(() => {});
    const off = bus.on((type, p) => type === 'help:status' && setStatus(p));
    const onKey = (e) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const request = async () => {
    setBusy(true);
    try {
      setInfo(await api.helpRequest());
    } catch (e) {
      toast?.({ kind: 'error', title: e.message, text: e.hint });
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    await api.helpStop({ reason: 'knopf' }).catch(() => {});
    setInfo(null);
    onClose();
  };

  const connected = status?.connected;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal invite" role="dialog" aria-label="Hilfe anfordern" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <h3>🙋 Hilfe bei der Einrichtung anfordern</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <p>Jemand, dem du vertraust, kann dir im selben WLAN beim Einrichten helfen. <b>Deine Chats und Nachrichten bleiben dabei verborgen.</b> Beenden kannst du jederzeit – auch mit <b>Strg+Umschalt+X</b>.</p>
        {!info ? (
          <p>
            <button className="btn btn--primary" disabled={busy} onClick={request}>
              {busy ? 'Starte …' : 'Hilfe anfordern'}
            </button>
          </p>
        ) : (
          <>
            <div className="invite__box">
              {info.qr && <img className="invite__qr" src={info.qr} alt="QR-Code für den Helfer" />}
              <div className="invite__actions">
                <span className="muted small">Code für den Helfer (nur hier sichtbar):</span>
                <b className="login-code">{info.code}</b>
                {info.relayUrl || info.url ? (
                  <>
                    <span className="muted small">{info.relayUrl ? '🌍 Link (funktioniert überall):' : '🏠 Link (nur im selben WLAN):'}</span>
                    <button className="btn btn--ghost btn--small" onClick={() => api.copyText({ text: info.relayUrl || info.url }).then(() => toast?.({ kind: 'info', title: 'Link kopiert', text: 'An den Helfer schicken.', duration: 2500 }))}>
                      🔗 Link kopieren
                    </button>
                  </>
                ) : null}
                {!info.relayUrl && (
                  <span className="muted small">
                    Für Hilfe von außerhalb: Relay-Adresse unter Einstellungen → Hilfe &amp; Tour eintragen.
                  </span>
                )}
                {connected ? <span className="ok">✅ Helfer verbunden</span> : <span className="muted small">Warte auf den Helfer …</span>}
                <label className="composer__ping">
                  <input type="checkbox" defaultChecked={status?.controlAllowed !== false} onChange={(e) => api.helpControl({ on: e.target.checked }).catch(() => {})} /> Helfer darf mithelfen (sonst nur zusehen)
                </label>
                <button className="btn btn--danger btn--small" onClick={stop}>
                  ⏹ Hilfe beenden
                </button>
              </div>
            </div>
            <ol className="invite__steps">
              <li>Der Helfer scannt den QR-Code (gleiches WLAN) oder öffnet den Link.</li>
              <li>Er gibt den <b>Code</b> ein, du bestätigst hier am PC.</li>
              <li>Fertig. Er sieht nur die Einrichtung, nie deine Chats.</li>
            </ol>
          </>
        )}
      </div>
    </div>
  );
}

/** Läuft immer im Hintergrund: Bestätigung, Bridge start/stop, Not-Aus Strg+Umschalt+X, kleine Leiste wenn aktiv. */
export function HelpController({ toast }) {
  const [pending, setPending] = useState(null);
  const [active, setActive] = useState(false);
  const [cursor, setCursor] = useState(null);

  useEffect(() => {
    const off = bus.on((type, p) => {
      if (type === 'help:pending') setPending(p.done ? null : p);
      if (type === 'help:status') {
        const running = Boolean(p?.running);
        setActive(running);
        if (running) startHelpBridge();
        else stopHelpBridge();
        if (!running) setCursor(null);
      }
    });
    const onCursor = (e) => setCursor({ x: e.detail.x, y: e.detail.y });
    window.addEventListener('help:cursor', onCursor);
    api.helpStatus().then((s) => s?.running && (setActive(true), startHelpBridge())).catch(() => {});
    const onKey = (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key || '').toLowerCase() === 'x' && active) api.helpStop({ reason: 'tastatur' }).catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.toggle('help-active', active);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('help:cursor', onCursor);
      document.body.classList.remove('help-active');
      stopHelpBridge();
    };
  }, [active]);

  return (
    <>
      {pending && (
        <div className="modal-backdrop">
          <div className="modal confirm" role="dialog" aria-label="Helfer zulassen">
            <h3>🙋 Darf dieser Helfer verbinden?</h3>
            <p>
              <b>{pending.helper || 'Jemand'}</b> möchte dir bei der Einrichtung helfen. Er sieht nur die Einrichtung, <b>nie deine Chats</b>.
            </p>
            <div className="confirm__actions">
              <button className="btn btn--ghost" onClick={() => api.helpDecide({ id: pending.id, allow: false }).catch(() => {})}>
                Ablehnen
              </button>
              <button className="btn btn--primary" onClick={() => api.helpDecide({ id: pending.id, allow: true }).catch(() => {})}>
                Zulassen
              </button>
            </div>
          </div>
        </div>
      )}
      {active && (
        <div className="help-bar" role="status">
          🙋 Fernhilfe aktiv – Chats verborgen
          <button className="btn btn--small" onClick={() => api.helpStop({ reason: 'knopf' }).catch(() => {})}>
            Beenden (Strg+Umschalt+X)
          </button>
        </div>
      )}
      {active && <HelpDrawings />}
      {active && <HelpChat />}
      {active && cursor && (
        <div
          style={{
            position: 'fixed',
            // #158: Anteil der Fenstergröße (0…1) → passt unabhängig von Bildschirmgröße und Zoom des Helfers
            left: `${cursor.x * 100}%`,
            top: `${cursor.y * 100}%`,
            zIndex: 9999,
            pointerEvents: 'none',
            fontSize: '24px',
            textShadow: '0 2px 4px rgba(0,0,0,0.5)',
            transform: 'translate(-50%, -50%)'
          }}
        >
          👆
        </div>
      )}
    </>
  );
}

// #160: Zeichnungen des Helfers über der App (Linien aus Anteilen 0…1). Verschwinden nach 15 s oder „Löschen“.
function HelpDrawings() {
  const [lines, setLines] = useState([]);
  useEffect(() => {
    const on = (e) => {
      const a = e.detail || {};
      if (a.type === 'clear-draw') return setLines([]);
      const id = `${Date.now()}-${Math.random()}`;
      setLines((l) => [...l.slice(-20), { id, points: a.points }]);
      setTimeout(() => setLines((l) => l.filter((x) => x.id !== id)), 15000);
    };
    window.addEventListener('help:draw', on);
    return () => window.removeEventListener('help:draw', on);
  }, []);
  if (!lines.length) return null;
  return (
    <svg className="help-draw" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
      {lines.map((l) => (
        <polyline key={l.id} points={l.points.map((p) => `${p[0] * 1000},${p[1] * 1000}`).join(' ')} />
      ))}
    </svg>
  );
}

// #160: Schwebender Chat zwischen Nutzer und Helfer (nur Text, nur während der Fernhilfe, nichts wird gespeichert)
function HelpChat() {
  const [log, setLog] = useState([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [text, setText] = useState('');
  const endRef = useRef(null);
  useEffect(() => {
    api
      .helpStatus()
      .then((s) => setLog(Array.isArray(s?.chat) ? s.chat : []))
      .catch(() => {});
    const off = bus.on((type, p) => {
      if (type !== 'help:chat') return;
      setLog((l) => [...l, p].slice(-50));
      if (p.from === 'helfer') {
        setOpen((o) => {
          if (!o) setUnread((n) => n + 1);
          return o;
        });
      }
    });
    return () => {
      off();
    };
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [log, open]);
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await api.helpChat({ text: t }).catch(() => {});
  };
  if (!open)
    return (
      <button className="help-chat__bubble" onClick={() => (setOpen(true), setUnread(0))} aria-label="Chat mit dem Helfer öffnen">
        💬{unread > 0 && <span className="help-chat__badge">{unread}</span>}
      </button>
    );
  return (
    <div className="help-chat" role="dialog" aria-label="Chat mit dem Helfer">
      <div className="help-chat__head">
        💬 Chat mit dem Helfer
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Chat einklappen">
          ▾
        </button>
      </div>
      <div className="help-chat__log">
        {log.length === 0 && <p className="muted small">Noch keine Nachrichten. Schreib deinem Helfer, wobei du Hilfe brauchst.</p>}
        {log.map((m, i) => (
          <p key={`${m.at}-${i}`} className={`help-chat__msg help-chat__msg--${m.from === 'helfer' ? 'in' : 'out'}`}>
            {m.text}
          </p>
        ))}
        <div ref={endRef} />
      </div>
      <div className="help-chat__row">
        <input value={text} maxLength={300} placeholder="Nachricht an den Helfer …" aria-label="Nachricht an den Helfer" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button className="btn btn--primary btn--small" onClick={send}>
          Senden
        </button>
      </div>
    </div>
  );
}
