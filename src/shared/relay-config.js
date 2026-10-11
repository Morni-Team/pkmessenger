'use strict';

// Welcher Relay wird benutzt? (#120 / vibeworks #219)
//  - 'standard': eingebauter Standard-Server des Morni-Teams – der Nutzer muss nichts installieren.
//  - 'own':      eigener Server (Einstellungen → Support → Erweitert).
//  - 'off':      kein Relay → Hilfe/Fernzugang nur im selben WLAN.
// Fernhilfe startet nur auf Knopfdruck und nutzt den Standard sofort. Der Fernzugang (dauerhaft verbunden) nutzt einen
// Relay nur, wenn der Nutzer ihn BEWUSST gewählt hat – niemand landet ungefragt mit seinem Fernzugang auf einem Server.

const DEFAULT_RELAY = 'wss://relay.morncloud.de/ws';
// #143: Helfer-Seite für die Direktverbindung – kostenlos auf GitHub Pages, kein eigener Server nötig
const HELP_PAGE = 'https://morni-team.github.io/pkmessenger/help/';
const RELAY_MODES = ['standard', 'own', 'off'];
const WSS = /^wss:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i;

const httpBaseOf = (wss) => wss.replace(/^wss:/i, 'https:').replace(/\/ws\/?$/i, '').replace(/\/+$/, '');

/** Gespeicherte Wahl lesen (mit Rückwärts-Kompatibilität: alte Nutzer mit eingetragener Adresse → 'own'). */
function relaySetting(settings = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const own = typeof s.helpRelay === 'string' && WSS.test(s.helpRelay) ? s.helpRelay : '';
  const mode = RELAY_MODES.includes(s.relayMode) ? s.relayMode : own ? 'own' : 'standard';
  return { mode, own, chosen: RELAY_MODES.includes(s.relayMode) || Boolean(own), standard: DEFAULT_RELAY };
}

/** @returns {{ wss: string, httpBase: string, mode: string } | null} */
function resolveRelay(settings, { demo = false, forRemote = false } = {}) {
  const { mode, own, chosen } = relaySetting(settings);
  if (forRemote && !chosen) return null;
  const wss = mode === 'own' ? own : mode === 'standard' && !demo ? DEFAULT_RELAY : '';
  return wss ? { wss, httpBase: httpBaseOf(wss), mode } : null;
}

module.exports = { DEFAULT_RELAY, HELP_PAGE, RELAY_MODES, relaySetting, resolveRelay, httpBaseOf };
