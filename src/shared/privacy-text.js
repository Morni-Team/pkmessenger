'use strict';

// Datenschutz-Hinweis (#160, Wunsch JONIMONI09): beim ersten Start durchlesen und akzeptieren, sonst startet die App nicht.
// Ändert sich der Text wesentlich, PRIVACY_VERSION erhöhen → alle müssen neu zustimmen.
const PRIVACY_VERSION = 1;

const PRIVACY_SECTIONS = [
  {
    title: '🤖 Worum es geht',
    text: 'PKMessenger ist ein Programm, mit dem du deinen eigenen Discord-Bot bedienst. Es läuft auf deinem PC. Es gibt kein Konto bei uns, keine Werbung und keine Telemetrie – wir sammeln keine Daten über dich.',
  },
  {
    title: '🔑 Dein Bot-Token',
    text: 'Der Token deines Bots wird verschlüsselt (Windows-Datenschutz) nur auf diesem PC gespeichert und nur an Discord geschickt, um dich anzumelden. Er landet nie in Protokollen, Fehlerberichten oder bei uns.',
  },
  {
    title: '💬 Nachrichten',
    text: 'Nachrichten, Server und Kanäle kommen direkt von Discord und gehen direkt zu Discord. Was dort gilt, steht in den Datenschutz-Regeln von Discord. Einstellungen wie Design, Töne oder Hintergründe bleiben nur auf diesem PC.',
  },
  {
    title: '🧠 KI (nur wenn du sie einschaltest)',
    text: 'Schaltest du unter Beta die KI ein, gehen die Nachrichten, die der Bot beantworten soll, an den KI-Anbieter, den DU auswählst (oder an ein KI-Programm auf deinem eigenen PC). Das Gedächtnis der KI wird verschlüsselt nur auf diesem PC gespeichert und lässt sich jederzeit löschen. Die Websuche fragt DuckDuckGo bzw. Wikipedia – ohne Konto.',
  },
  {
    title: '🙋 Fernhilfe (nur wenn du sie startest)',
    text: 'Startest du die Fernhilfe, kann ein Helfer nach deiner Bestätigung ein Bild der Einstellungen sehen. Chats, Nachrichten, Passwörter und Schlüssel werden vorher auf deinem PC geschwärzt. Die Verbindung ist Ende-zu-Ende verschlüsselt und läuft direkt oder über öffentliche Vermittler, die nur Datensalat sehen. Es wird nichts aufgenommen. Du kannst jederzeit beenden.',
  },
  {
    title: '🌐 Was ins Internet geht',
    text: 'Außer Discord: die Suche nach Updates bei GitHub, Sperrlisten für gefährliche Links (wenn eingeschaltet) und die Dienste oben, wenn du sie selbst nutzt. Fehlerberichte werden NIE automatisch verschickt – nur wenn du selbst auf „Auf GitHub melden“ klickst.',
  },
  {
    title: '🧹 Deine Kontrolle',
    text: 'Du kannst alles auf diesem PC löschen: Token entfernen, KI-Gedächtnis löschen, Protokolle aufräumen oder PKMessenger einfach deinstallieren. Bitte halte dich bei deinem Bot an die Regeln von Discord.',
  },
];

module.exports = { PRIVACY_VERSION, PRIVACY_SECTIONS };
