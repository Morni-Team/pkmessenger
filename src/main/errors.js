'use strict';

// Übersetzt technische Fehler in deutsche Meldungen mit "Was kann ich tun?"-Hinweis.
// Codes laut docs.discord.com/developers/topics/opcodes-and-status-codes.
const API_ERRORS = {
  10003: ['Kanal nicht gefunden.', 'Der Kanal wurde gelöscht. Lade die Kanalliste neu.'],
  10004: ['Server nicht gefunden.', 'Der Bot ist nicht mehr auf diesem Server. Lade ihn über den Einladungslink erneut ein.'],
  10008: ['Nachricht nicht gefunden.', 'Die Nachricht wurde inzwischen gelöscht.'],
  10006: ['Einladung ungültig oder abgelaufen.', 'Lass dir einen neuen Einladungslink vom Server geben.'],
  50001: ['Kein Zugriff auf diesen Kanal.', 'Gib der Bot-Rolle in den Kanaleinstellungen "Kanal ansehen" und "Nachrichtenverlauf lesen".'],
  50013: ['Dem Bot fehlt eine Berechtigung.', 'Prüfe in Discord unter Servereinstellungen → Rollen → Bot-Rolle die Rechte für diesen Kanal (z. B. "Nachrichten senden").'],
  50035: ['Discord hat die Anfrage abgelehnt (ungültige Daten).', 'Prüfe Länge und Inhalt der Nachricht.'],
  50007: ['Diese Person nimmt keine Privatnachrichten vom Bot an.', 'Sie muss einen Server mit dem Bot teilen und in ihren Discord-Einstellungen Direktnachrichten von Servermitgliedern erlauben.'],
  50006: ['Leere Nachricht.', 'Gib einen Text ein.'],
  40005: ['Datei ist zu groß.', 'Maximal 25 MiB pro Upload.'],
  20028: ['Zu viele Nachrichten in kurzer Zeit (Slowmode/Rate-Limit).', 'Warte kurz und versuche es erneut.'],
};

function describeError(err) {
  if (!err) return { code: 'UNKNOWN', message: 'Unbekannter Fehler.', hint: 'Versuche es erneut. Wenn es bleibt: Einstellungen → Hilfe & Tour → „Fehlerbericht erstellen“.' };
  if (err.code === 'VALIDATION') return { code: 'VALIDATION', message: err.message, hint: err.hint || 'Eingabe prüfen und erneut versuchen.' };
  // KI-Agenten (Beta): Meldungen sind bereits deutsch und enthalten nie den API-Schlüssel
  if (err.code === 'AI') return { code: 'AI', message: err.message, hint: err.hint || '' };
  // #156: absichtlich abgebrochen (schnell anderen Sprachkanal gewählt) – kein Fehler
  if (err.code === 'VOICE_ABORTED') return { code: 'VOICE_ABORTED', message: err.message, hint: '' };
  if (err.code === 'NOT_READY') return { code: 'NOT_READY', message: 'Nicht mit Discord verbunden.', hint: 'Warte auf "Verbunden ✓" oder klicke auf "Neu verbinden".' };
  if (err.code === 'NOT_FOUND') return { code: 'NOT_FOUND', message: err.message, hint: 'Der Bot sieht dieses Ziel nicht (fehlende Rechte oder gelöscht).' };
  if (err.code === 'MISSING_PERMISSION') return { code: 'MISSING_PERMISSION', message: err.message, hint: err.hint || 'Bot-Rolle in Discord anpassen.' };
  if (err.code === 'TokenInvalid' || err.status === 401 || err.code === 4004)
    return {
      code: 'TOKEN_INVALID',
      message: 'Discord hat den Bot-Token abgelehnt.',
      hint: 'Erzeuge im Developer Portal unter "Bot" mit "Reset Token" einen neuen Token und trage ihn in die .env-Datei ein.',
    };
  if (err.code === 'DisallowedIntents' || err.code === 4014)
    return {
      code: 'DISALLOWED_INTENTS',
      message: 'Das "Message Content Intent" ist für deinen Bot nicht aktiviert.',
      hint: 'Developer Portal → deine App → Bot → "Privileged Gateway Intents" → "Message Content Intent" einschalten → Speichern → hier "Neu verbinden".',
    };
  if (err.code === 'LOGIN_TIMEOUT')
    return { code: 'LOGIN_TIMEOUT', message: 'Discord antwortet nicht rechtzeitig.', hint: 'Prüfe deine Internetverbindung und klicke auf "Neu verbinden".' };
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(err.code || err.cause?.code))
    return { code: 'NETWORK', message: 'Keine Verbindung zu Discord.', hint: 'Prüfe deine Internetverbindung (WLAN/Kabel, VPN, Firewall).' };
  if (err.name === 'RateLimitError' || err.status === 429)
    return { code: 'RATE_LIMIT', message: 'Discord bremst gerade (Rate-Limit).', hint: 'Kurz warten – die App wiederholt automatisch.' };
  if (typeof err.code === 'number' && API_ERRORS[err.code]) {
    const [message, hint] = API_ERRORS[err.code];
    return { code: `API_${err.code}`, message, hint };
  }
  return {
    code: 'UNKNOWN',
    message: `Unerwarteter Fehler: ${String(err.message || err).slice(0, 200)}`,
    hint: 'Versuche es erneut. Wenn es bleibt: Einstellungen → Hilfe & Tour → „Fehlerbericht erstellen“.',
  };
}

function appError(code, message, hint) {
  const e = new Error(message);
  e.code = code;
  if (hint) e.hint = hint;
  return e;
}

module.exports = { describeError, appError };
