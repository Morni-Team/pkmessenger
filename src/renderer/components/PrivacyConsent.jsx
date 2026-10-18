import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PRIVACY_SECTIONS, PRIVACY_VERSION } from '../../shared/privacy-text';

// Datenschutz beim ersten Start (#160): erst ganz durchlesen (bis unten scrollen), dann „Akzeptieren“.
// Ohne Zustimmung startet die App nicht. Gespeichert wird nur „Version X akzeptiert am …“ auf diesem Gerät.
const KEY = 'pk.privacy.v1';

export function privacyAccepted() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return Boolean(v && v.version >= PRIVACY_VERSION);
  } catch {
    return false;
  }
}

export default function PrivacyConsent({ onAccept }) {
  const [readToEnd, setReadToEnd] = useState(false);
  const [declined, setDeclined] = useState(false);
  const boxRef = useRef(null);
  const check = () => {
    const b = boxRef.current;
    if (b && b.scrollTop + b.clientHeight >= b.scrollHeight - 8) setReadToEnd(true);
  };
  // #167: Wird das Fenster größer (oder die Schrift kleiner), passt der Text plötzlich ganz hinein – dann gibt es nichts
  // mehr zu scrollen und „Akzeptieren“ blieb für immer gesperrt (App startete nicht). Darum auch bei Größenänderung prüfen.
  useEffect(() => {
    check();
    window.addEventListener('resize', check);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
    if (ro && boxRef.current) ro.observe(boxRef.current);
    return () => {
      window.removeEventListener('resize', check);
      ro?.disconnect();
    };
  }, []);
  const accept = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: PRIVACY_VERSION, at: Date.now() }));
    } catch {
      /* ohne Speicher: gilt bis zum Neustart */
    }
    onAccept();
  };
  const decline = () => {
    setDeclined(true);
    api.quitApp?.().catch(() => {});
  };
  if (declined)
    return (
      <div className="center-screen">
        <div className="center-card privacy">
          <h2>Schade 👋</h2>
          <p>Ohne Zustimmung kann PKMessenger nicht starten. Du kannst das Fenster jetzt schließen.</p>
          <button className="btn" onClick={() => setDeclined(false)}>
            Doch nochmal lesen
          </button>
        </div>
      </div>
    );
  return (
    <div className="center-screen">
      <div className="center-card privacy" role="dialog" aria-label="Datenschutz">
        <h2>📜 Datenschutz – bitte kurz lesen</h2>
        <div className="privacy__text" ref={boxRef} onScroll={check} tabIndex={0}>
          {PRIVACY_SECTIONS.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </section>
          ))}
          <p className="muted small">Stand: Version {PRIVACY_VERSION}. Ändert sich etwas Wichtiges, fragt PKMessenger dich erneut.</p>
        </div>
        {!readToEnd && <p className="muted small">⬇️ Bitte bis zum Ende lesen – dann kannst du zustimmen.</p>}
        <div className="confirm__actions">
          <button className="btn btn--ghost" onClick={decline}>
            Ablehnen
          </button>
          <button className="btn btn--primary" disabled={!readToEnd} onClick={accept} title={readToEnd ? '' : 'Erst bis zum Ende lesen'}>
            Gelesen & akzeptieren
          </button>
        </div>
      </div>
    </div>
  );
}
