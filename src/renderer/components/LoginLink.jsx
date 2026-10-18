import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { api } from '../api';
import { pc } from '../platform';

// Anmelden per Link/QR-Code (JoniMoni #77): Ein angemeldetes Gerät zeigt einen verschlüsselten Anmelde-Link (als QR)
// und einen 8-stelligen Code. Das neue Gerät braucht beides – der Code steht nur auf diesem Bildschirm.

/** Fenster „Anderes Gerät anmelden“ (Einstellungen → Bot-Token). */
export function ShareLoginDialog({ onClose, toast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const make = () => {
    setData(null);
    api
      .tokenShare()
      .then(setData)
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    make();
    const onKey = (e) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const qr = useMemo(() => {
    if (!data?.link) return null;
    const q = qrcode(0, 'M');
    q.addData(data.link);
    q.make();
    return q.createDataURL(4, 2);
  }, [data?.link]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal invite" role="dialog" aria-label="Anderes Gerät anmelden" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <h3>📱 Anderes Gerät anmelden</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>
        <p>Melde PKMessenger auf dem Handy oder einem anderen PC mit demselben Bot an – ohne den Token abzutippen.</p>
        {error && <p className="warn">{error}</p>}
        {data && (
          // #170: QR-Code + Code zusammen = Bot-Token → für einen Fernhelfer immer geschwärzt
          <div className="invite__box" data-private>
            {qr && <img className="invite__qr" src={qr} alt="QR-Code zum Anmelden" />}
            <div className="invite__actions">
              <span className="muted small">Code (nur hier sichtbar):</span>
              <b className="login-code">{data.code}</b>
              <button className="btn btn--ghost" onClick={() => api.copyText({ text: data.link }).then(() => toast?.({ kind: 'info', title: 'Anmelde-Link kopiert', duration: 2000 }))}>
                🔗 Link kopieren (für einen PC)
              </button>
              <button className="btn btn--ghost btn--small" onClick={make}>
                ↻ Neuen Code erzeugen
              </button>
            </div>
          </div>
        )}
        <ol className="invite__steps">
          <li>
            <b>Handy:</b> QR-Code mit der Kamera scannen → PKMessenger öffnet sich → Code eingeben.
          </li>
          <li>
            <b>Anderer PC:</b> Link kopieren, dort ins Feld „Bot-Token eingeben“ einfügen → Code eingeben.
          </li>
        </ol>
        <p className="muted small">🔒 Der Token steckt nur verschlüsselt im Link. Ohne den Code ist er nutzlos – schick Link und Code deshalb nie zusammen an jemanden. Jedes Öffnen dieses Fensters erzeugt einen neuen Code.</p>
      </div>
    </div>
  );
}

/** Eingabe auf dem neuen Gerät: Link wurde eingefügt (oder kam per Kamera) → Code abfragen und anmelden. */
export function LoginLinkForm({ link, onCancel, onDone }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.tokenImport({ link, code });
      if (res?.state !== 'ready') setErr({ message: res?.error?.message || 'Verbindung fehlgeschlagen.', hint: res?.error?.hint || '' });
      else onDone?.();
    } catch (e) {
      setErr({ message: e.message, hint: e.hint });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-link">
      <p>
        ✅ <b>Anmelde-Link erkannt.</b> Gib jetzt den Code ein, der am anderen Gerät steht ({pc('Einstellungen → Bot-Token → „Anderes Gerät anmelden“', 'am PC unter Einstellungen → Bot-Token')}).
      </p>
      <div className="token-quick__row">
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && !busy && submit()} placeholder="z. B. ABCD-2345" maxLength={9} aria-label="Code vom anderen Gerät" autoFocus autoComplete="off" spellCheck={false} />
        <button className="btn btn--primary" disabled={code.replace(/[^A-Za-z0-9]/g, '').length !== 8 || busy} onClick={submit}>
          {busy ? 'Melde an …' : 'Anmelden'}
        </button>
      </div>
      {err && (
        <p className="warn small">
          {err.message} {err.hint}
        </p>
      )}
      <button className="link-btn" onClick={onCancel}>
        Doch lieber den Token eingeben
      </button>
    </div>
  );
}
