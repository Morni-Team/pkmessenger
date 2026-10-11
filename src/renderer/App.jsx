import { useEffect, useRef, useState, useCallback } from 'react';
import PrivacyConsent, { privacyAccepted } from './components/PrivacyConsent.jsx';
import { api, onEvent } from './api';
import { bus } from './state';
import Workspace from './components/Workspace.jsx';
import SetupScreen from './components/SetupScreen.jsx';
import { ConnectingScreen, ErrorScreen } from './components/StatusScreens.jsx';
import Toasts from './components/Toasts.jsx';
import LockScreen from './components/LockScreen.jsx';
import OopsDialog, { reportError } from './components/OopsDialog.jsx';
import { HelpController, HelpDialog } from './components/HelpRequest.jsx';
import { Component } from 'react';

// Knöpfe mit Symbol statt Text: Beschriftung (aria-label) auch als Hinweis beim Drüberfahren zeigen
function useButtonHints() {
  useEffect(() => {
    const apply = (root) => {
      for (const b of root.querySelectorAll?.('button[aria-label]:not([title])') || []) b.title = b.getAttribute('aria-label');
    };
    apply(document);
    const obs = new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) apply(n.parentNode || n);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
}

// Unerwartete Fehler der Oberfläche → Protokoll + „Ups …“ (Issue #1)
function useErrorCatcher() {
  useEffect(() => {
    const onError = (e) => reportError(`window: ${e.filename?.split('/').pop() || ''}:${e.lineno || ''}`, e.error || e.message);
    const onRejection = (e) => reportError('promise', e.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
}

/** Stürzt ein Teil der Oberfläche ab, bleibt die App bedienbar und zeigt „Ups …“ statt eines weißen Fensters. */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error, info) {
    reportError(`react: ${(info?.componentStack || '').trim().split('\n')[0] || 'component'}`, error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="empty">
        <h2>😵 Ups, dieser Teil ist abgestürzt</h2>
        <button className="btn btn--primary" onClick={() => this.setState({ failed: false })}>
          Nochmal versuchen
        </button>
      </main>
    );
  }
}

function HelpHost({ toast }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener('pk:help-open', on);
    return () => window.removeEventListener('pk:help-open', on);
  }, []);
  return open ? <HelpDialog toast={toast} onClose={() => setOpen(false)} /> : null;
}

export default function App() {
  useButtonHints();
  useErrorCatcher();
  const [status, setStatus] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [appInfo, setAppInfo] = useState({ version: null, update: { state: 'idle' } });
  const everReady = useRef(false);
  const [locked, setLocked] = useState(null); // null = noch unbekannt
  const [privacyOk, setPrivacyOk] = useState(() => privacyAccepted()); // #160: Datenschutz beim ersten Start

  const toast = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((list) => [...list.slice(-3), { id, kind: 'info', ...t }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.duration || 5000);
  }, []);

  useEffect(() => {
    const off = onEvent((type, payload) => {
      if (type === 'status') setStatus(payload);
      else if (type === 'ratelimit') toast({ kind: 'warn', title: 'Discord bremst kurz (Rate-Limit)', text: `Automatischer neuer Versuch in ${Math.ceil((payload.retryAfterMs || 1000) / 1000)} s.` });
      else if (type === 'log') console.warn('[PKMessenger]', payload.message);
      else if (type === 'update') setAppInfo((i) => ({ ...i, update: payload }));
      else if (type === 'lock') setLocked(Boolean(payload?.locked));
      else bus.emit(type, payload);
    });
    api.getAppInfo().then(setAppInfo).catch(() => {});
    api
      .lockStatus()
      .then((s) => setLocked(Boolean(s?.locked)))
      .catch(() => setLocked(false));
    api.getStatus().then(setStatus).catch(() => setStatus({ state: 'error', error: { message: 'Interner Fehler beim Start.', hint: 'App neu starten.' } }));
    return off;
  }, [toast]);

  const reconnect = useCallback(() => api.connect().catch((e) => toast({ kind: 'error', title: e.message, text: e.hint })), [toast]);

  if (status?.state === 'ready') everReady.current = true;

  let screen;
  if (!privacyOk) screen = <PrivacyConsent onAccept={() => setPrivacyOk(true)} />;
  else if (locked) screen = <LockScreen onUnlocked={() => setLocked(false)} />;
  else if (locked === null) screen = <ConnectingScreen />;
  else if (!status || status.state === 'idle' || (status.state === 'connecting' && !everReady.current)) screen = <ConnectingScreen />;
  else if (status.state === 'setup') screen = <SetupScreen status={status} onReconnect={reconnect} />;
  else if (status.state === 'error' && !everReady.current) screen = <ErrorScreen status={status} onReconnect={reconnect} />;
  else if (status.state === 'disconnected' && !everReady.current) screen = <ErrorScreen status={status} onReconnect={reconnect} />;
  else screen = <Workspace status={status} toast={toast} onReconnect={reconnect} appInfo={appInfo} />;

  return (
    <>
      <ErrorBoundary>{screen}</ErrorBoundary>
      <OopsDialog />
      <HelpController toast={toast} />
      <HelpHost toast={toast} />
      {appInfo.update?.state === 'ready' && (
        <div className="update-banner" role="status">
          <span>
            <b>Update bereit</b>
            {appInfo.update.newVersion ? ` (${appInfo.update.newVersion})` : ''} – wird beim Neustart installiert.
          </span>
          <button className="btn btn--primary btn--small" onClick={() => api.installUpdate().catch(() => {})}>
            Jetzt neu starten
          </button>
        </div>
      )}
      <Toasts toasts={toasts} onClose={(id) => setToasts((l) => l.filter((t) => t.id !== id))} />
    </>
  );
}
