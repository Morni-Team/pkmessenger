'use strict';

// Fernhilfe (Issue #79): Ein Helfer darf bei der EINRICHTUNG über die Schulter schauen – aber NIE die Chats sehen.
// Diese Datei ist das Herzstück der Sicherheitszusage und rein (ohne Netz/DOM), damit sie gut testbar ist:
//  1) redactView: macht aus dem Oberflächen-Zustand eine geschwärzte Fassung für den Helfer (keine Nachrichten,
//     keine Namen, keine Token/Passwörter).
//  2) allowHelperAction: entscheidet, ob eine vom Helfer geschickte Aktion erlaubt ist. Standard = verboten.
//     Erlaubt ist nur Harmloses rund um die Einrichtung; Sicherheits-Eingaben (Passwörter, Token) NIE.

// Textfelder, die der Helfer sehen/ausfüllen dürfte, sind genau diese (alles andere wird geschwärzt bzw. abgelehnt).
// Bewusst NICHT dabei: Bot-Token, App-Passwort, Fernzugangs-Passwort, KI-Schlüssel, Nachrichtentext.
const SECRET_FIELD = /token|passwor|passwort|secret|schlüssel|key|code|\.env/i;
const BLACK = '███████';

/** Nachrichten/Namen/Geheimnisse aus einem Wert entfernen. Tief, aber begrenzt (kein Endlos-Objekt). */
function scrub(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => scrub(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_FIELD.test(k)) out[k] = typeof v === 'string' && v ? BLACK : v;
    else if (/^(content|text|message|preview|answer|question|body|nachricht)$/i.test(k)) out[k] = typeof v === 'string' && v ? BLACK : v;
    else if (/^(name|displayName|username|author|nick|recipient|title|topic)$/i.test(k)) out[k] = typeof v === 'string' && v ? BLACK : scrub(v, depth + 1);
    else out[k] = scrub(v, depth + 1);
  }
  return out;
}

// #158: Rechteck als Anteil der Fenstergröße (0…1) – alles andere wird verworfen
const unit = (n) => Number.isFinite(n) && n >= -0.01 && n <= 1.01;
function rectOf(r) {
  if (!r || !unit(r.x) || !unit(r.y) || !unit(r.w) || !unit(r.h)) return null;
  const c = (n) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
  return { x: c(r.x), y: c(r.y), w: c(r.w), h: c(r.h) };
}

/**
 * Geschwärzter Zustand für den Helfer. `view` beschreibt, was die Oberfläche gerade zeigt.
 * Der Helfer sieht: welcher Bildschirm offen ist, den Einrichtungs-Status (ohne Geheimnisse) und die aktuelle Maus.
 * Er sieht NICHT: Serverliste mit Namen, Chatliste, Nachrichten.
 */
function redactView(view = {}) {
  const screen = String(view.screen || 'unknown');
  const inChat = screen === 'workspace' || screen === 'chat';
  return {
    screen,
    // Im Chat-Bereich wird ALLES geschwärzt – der Helfer sieht nur „Chats verborgen“.
    hidden: inChat,
    setup: view.setup ? scrub(view.setup) : null,
    settings: view.settings ? scrub(view.settings) : null,
    // Sichtbare Knöpfe/Labels: nur deren Beschriftung, Geheimnis-Felder als „verborgen“ markiert
    fields: Array.isArray(view.fields)
      ? view.fields.slice(0, 100).map((f) => ({ id: String(f.id || ''), label: SECRET_FIELD.test(`${f.id} ${f.label || ''}`) || f.secret ? '🔒 (verborgen)' : String(f.label || '').slice(0, 80), secret: Boolean(f.secret) || SECRET_FIELD.test(`${f.id} ${f.label || ''}`), rect: inChat ? null : rectOf(f.rect) }))
      : [],
    // #158: Mauszeiger als Anteil (0…1) – passt beim Helfer auf das Bild
    cursor: !inChat && view.cursor && unit(view.cursor.x) && unit(view.cursor.y) ? { x: Math.round(view.cursor.x * 1000) / 1000, y: Math.round(view.cursor.y * 1000) / 1000 } : null,
    // erlaubter Bildbereich + zu schwärzende Stellen (das Bild selbst wird in Main geschwärzt, hier nur die Daten)
    allowed: inChat ? null : rectOf(view.allowed),
    masks: inChat || !Array.isArray(view.masks) ? [] : view.masks.slice(0, 60).map(rectOf).filter(Boolean),
    note: inChat ? 'Chats und Nachrichten sind für den Helfer verborgen.' : null,
  };
}

// Was der Helfer auslösen darf. Jede Aktion nennt ein Ziel; nur diese IDs sind erlaubt.
const ALLOWED = {
  // auf einen sichtbaren Knopf/Bereich klicken – aber nie auf etwas Geheimes
  click: (a, view) => {
    const f = (view?.fields || []).find((x) => x.id === a.target);
    return Boolean(f) && !f.secret;
  },
  // in ein NICHT-geheimes Textfeld tippen (z. B. Servername, Modus-Name). Sicherheits-Felder tippt nur der Nutzer.
  type: (a, view) => {
    const f = (view?.fields || []).find((x) => x.id === a.target);
    return Boolean(f) && !f.secret && typeof a.text === 'string' && a.text.length <= 200 && !SECRET_FIELD.test(a.target);
  },
  // zu einem Einrichtungs-Schritt scrollen / Hinweis zeigen
  highlight: (a) => typeof a.target === 'string' && a.target.length <= 80,
  scroll: (a) => ['up', 'down', 'top', 'bottom'].includes(a.dir),
  cursor: (a) => unit(a.x) && unit(a.y), // #158: Anteil der Fenstergröße
  // #160: auf dem Bild zeichnen (Linie aus max. 200 Punkten, Anteile 0…1) bzw. Zeichnung löschen
  draw: (a) => Array.isArray(a.points) && a.points.length >= 2 && a.points.length <= 200 && a.points.every((p) => Array.isArray(p) && p.length === 2 && unit(p[0]) && unit(p[1])),
  'clear-draw': () => true,
  // #160: Einstellungen öffnen – harmlos, darf der Helfer auch aus dem Chat-Bereich heraus
  'open-settings': () => true,
  // #160: Nachricht im Hilfe-Chat (nur Text, wird beim Nutzer als Text angezeigt)
  chat: (a) => typeof a.text === 'string' && a.text.trim().length > 0 && a.text.length <= 300,
};

/**
 * Darf der Helfer diese Aktion ausführen? Verboten, wenn Hilfe aus ist, der Nutzer im Chat ist (dann nur zuschauen
 * gesperrt), die Aktion unbekannt ist oder ein Geheimnis beträfe.
 * @returns {{ok:true}|{ok:false,reason:string}}
 */
function allowHelperAction(action, { view = {}, enabled = true, controlAllowed = true } = {}) {
  if (!enabled) return { ok: false, reason: 'Fernhilfe ist aus.' };
  const a = action && typeof action === 'object' ? action : {};
  // Chatten ist kein Mitsteuern – geht auch bei „nur Zusehen“
  if (!controlAllowed && a.type !== 'chat') return { ok: false, reason: 'Der Nutzer hat das Mitsteuern verboten (nur Zusehen).' };
  // #160: Chat und „Einstellungen öffnen“ gehen immer – alles andere nicht im Chat-Bereich
  const anywhere = a.type === 'chat' || a.type === 'open-settings';
  if (!anywhere && redactView(view).hidden) return { ok: false, reason: 'Im Chat-Bereich kann der Helfer nichts tun.' };
  const check = ALLOWED[a.type];
  if (!check) return { ok: false, reason: 'Diese Aktion ist nicht erlaubt.' };
  if (SECRET_FIELD.test(String(a.target || ''))) return { ok: false, reason: 'Sicherheits-Felder bedient nur der Nutzer selbst.' };
  return check(a, view) ? { ok: true } : { ok: false, reason: 'Ziel nicht erlaubt oder nicht sichtbar.' };
}

module.exports = { redactView, allowHelperAction, scrub, SECRET_FIELD, BLACK };
