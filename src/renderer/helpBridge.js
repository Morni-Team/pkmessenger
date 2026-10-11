// Fernhilfe (Issue #79), Renderer-Seite: meldet laufend, was auf dem Bildschirm zu sehen ist (geschwärzt wird erst
// in Main), und führt erlaubte Helfer-Aktionen aus. Im Chat-Bereich wird NICHTS gemeldet und NICHTS ausgeführt.
import { api } from './api';

let timer = null;
let unAction = null;
let lastCursor = null;

// #158: alle Positionen als ANTEIL der Fenstergröße (0…1) – dann passen sie beim Helfer auf das Bild, egal wie groß
const norm = (r) => ({ x: r.left / innerWidth, y: r.top / innerHeight, w: r.width / innerWidth, h: r.height / innerHeight });
const onMouse = (e) => {
  lastCursor = { x: e.clientX / innerWidth, y: e.clientY / innerHeight };
};
// Was im Bild für den Helfer IMMER geschwärzt wird (zusätzlich zu allem außerhalb des erlaubten Bereichs)
const PRIVATE = 'input[type=password], [data-private], .toast, .toasts, .ai-memory, .ai-preview, .ai-memory-row, .ctx-menu, .profile-card';

function currentScreen() {
  // #104: Die Einstellungen öffnen als Modal ÜBER dem Workspace (.layout bleibt dahinter). Darum zuerst auf die
  // Einstellungen/Einrichtung prüfen – sonst sähe der Helfer nie die Settings. Der Helfer bekommt dann NUR die
  // Felder des Einstellungs-Dialogs (collectFields grenzt auf .modal.settings ein); die Chats dahinter bleiben verborgen.
  if (document.querySelector('.modal.settings')) return 'settings';
  if (document.querySelector('.token-quick, .setup-head, .wizard')) return 'setup';
  if (document.querySelector('.layout')) return 'workspace';
  return 'other';
}

const visible = (el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};

// Sichtbare Bedienelemente der Einrichtung/Einstellungen mit stabiler ID versehen (für Klick/Tippen durch den Helfer)
function collectFields() {
  const scope = document.querySelector('.center-card, .modal.settings') || document.body;
  const els = [...scope.querySelectorAll('button, input, select, textarea, a.link-btn, summary')].filter(visible).slice(0, 100);
  return els.map((el, i) => {
    const id = `h${i}`;
    el.setAttribute('data-help-id', id);
    const label = (el.getAttribute('aria-label') || el.textContent || el.placeholder || el.value || '').trim().slice(0, 80);
    const secret = el.type === 'password';
    return { id, label, secret, rect: norm(el.getBoundingClientRect()) };
  });
}

// Erlaubter Bildbereich: in den Einstellungen nur das Einstellungs-Fenster, bei der Einrichtung das ganze Fenster
function allowedRect(screen) {
  if (screen === 'settings') {
    const m = document.querySelector('.modal.settings');
    return m ? norm(m.getBoundingClientRect()) : null;
  }
  if (screen === 'setup') return { x: 0, y: 0, w: 1, h: 1 };
  return null;
}

function buildView() {
  const screen = currentScreen();
  const inChat = screen === 'workspace';
  const masks = inChat ? [] : [...document.querySelectorAll(PRIVATE)].filter(visible).slice(0, 60).map((el) => norm(el.getBoundingClientRect()));
  return { screen, fields: inChat ? [] : collectFields(), cursor: lastCursor, allowed: inChat ? null : allowedRect(screen), masks };
}

function pushView() {
  try {
    api.helpView(buildView());
  } catch {
    /* Hilfe evtl. gerade aus */
  }
}

function applyAction(action) {
  // #160: „Einstellungen öffnen“ darf der Helfer auch aus dem Chat-Bereich heraus (öffnet nur das Einstellungs-Fenster)
  if (action.type === 'open-settings') {
    window.dispatchEvent(new CustomEvent('pk:open-settings', { detail: {} }));
    return;
  }
  if (currentScreen() === 'workspace') return; // im Chat sonst nie etwas ausführen
  // #160: Zeichnung des Helfers anzeigen (Linie aus Anteilen 0…1) bzw. löschen
  if (action.type === 'draw' || action.type === 'clear-draw') {
    window.dispatchEvent(new CustomEvent('help:draw', { detail: action }));
    return;
  }
  if (action.type === 'cursor') {
    window.dispatchEvent(new CustomEvent('help:cursor', { detail: action }));
    return;
  }
  const sel = `[data-help-id="${String(action.target || '').replace(/[^a-z0-9]/gi, '')}"]`;
  const el = document.querySelector(sel);
  if (!el) return;
  if (el.type === 'password') return; // Sicherheits-Felder bedient nur der Nutzer selbst
  if (action.type === 'click') el.click();
  else if (action.type === 'type' && 'value' in el && el.type !== 'password') {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, String(action.text || '').slice(0, 200));
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  } else if (action.type === 'scroll') {
    const box = document.querySelector('.settings__body, .center-screen') || document.scrollingElement;
    if (action.dir === 'top') box.scrollTo({ top: 0 });
    else if (action.dir === 'bottom') box.scrollTo({ top: box.scrollHeight });
    else box.scrollBy({ top: action.dir === 'up' ? -300 : 300 });
  }
}

export function startHelpBridge() {
  if (timer) return;
  window.addEventListener('mousemove', onMouse);
  unAction = api.onHelpAction(applyAction);
  timer = setInterval(pushView, 700);
  pushView();
}

export function stopHelpBridge() {
  clearInterval(timer);
  timer = null;
  window.removeEventListener('mousemove', onMouse);
  if (unAction) unAction();
  unAction = null;
}
