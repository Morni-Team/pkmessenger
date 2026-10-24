# Stand: PKMessenger (Übergabe 2026-10-24)

## Was es ist
Windows-Desktop-App (plus Android-APK), die einen Discord-Server wie einen schlanken Messenger zeigt: lesen, schreiben, erwähnen, suchen, Sprachkanäle – alles über einen **eigenen Bot** (nur Bot-Token nötig). Dazu Fernhilfe/Fernzugang über einen eigenen Relay-Server bzw. Direktverbindung, KI-Agenten (Beta).

## Aktueller Stand (Version 0.28.0, Releases v0.28.0 + android-v0.28.0 vom 2026-10-18)
- Messenger-Funktionen: Live-Chat, Verlauf, Erwähnungen, @everyone-Schutz, Antworten, Reaktionen, Bearbeiten/Löschen, Dateien, Embeds, Threads/Foren, Pins, Suche, Umfragen, Privatnachrichten, Bot-Profil, 5 Designs, App-Passwort, Auto-Update.
- Sprachkanäle (DAVE-verschlüsselt), seit 0.28.0 **KI-Rauschfilter** (RNNoise Standard / GTCRN / Aus), läuft lokal (#177).
- Fernhilfe: Direktverbindung (WebRTC + Nostr) mit Rückfall über Vermittler, Helfer-Seite auf GitHub Pages, geschwärztes Bild, Chat, Zeichnen, Rechte ankreuzen, Passwort/Windows Hello beim Zulassen, Protokoll, Bot-Token bleibt verborgen (#148–#170).
- KI-Agenten (OpenAI, Claude, Gemini, OpenRouter, Ollama …), KI-Gedächtnis, KI darf Server mitverwalten (Gefahren-Schalter je Server).
- Datenschutz-Zustimmung beim ersten Start; Android-Emulator-Test in CI.
- CI am 2026-10-24: Tests, Release-Build, Code Quality, Repo-Check grün.
- **Alle GitHub-Issues sind geschlossen** (Stand 24.10.).

## Zuletzt gemacht
- 2026-10-24: Cloud-Start-Hook (`.claude/hooks/skills-cloud.sh`).
- 2026-10-18: 0.28.0 KI-Rauschfilter (#177); Workflow `claude-review.yml` – KI-Review für PRs (nur lesen + kommentieren).
- 2026-10-17: Fernhilfe-Ausbau (#170), Bughunting „App öffnet nicht“ (#167), eigenes Android-Release, Abhängigkeiten (Electron 44.9.0, React 19.3.1) (#44), Jules nur eine Session pro Issue (#169).
- 2026-10-11/12: großer Fernhilfe-Block (P2P, Diagnose, Datenschutz-Lücke #164), Weekly Briefing von Jules (`docs/jules-briefing.md`).

## Offen / Nächste Schritte
- **Claude-Code-Sitzung „PKmessenger“ steht auf „Blockiert – hat eine Frage gestellt“**: Dort wartet eine Frage auf Philips Antwort. Inhalt aus dem Repo nicht erkennbar – in claude.ai/code nachsehen.
- #177 (geschlossen): Letzter Kommentar von JONIMONI09 (19.10.) „Was ist da los? also geht es?“ ist **unbeantwortet**. Thema: Plugin „caveman“ (Token sparen) wurde geprüft – Entscheidung liegt laut Kommentar bei Philip; ob installiert: **unklar**.
- Entscheidung Philip (18.10., laut #177): Plugins, Workflows und Sicherheitskram entscheidet **weiter Philip**; Joni darf vorschlagen, nicht bestimmen.
- Aus `docs/jules-briefing.md` (12.10., Vorschläge, teils evtl. erledigt): Text-Eingabe für Helfer in Fernhilfe (#170 inzwischen geschlossen), Opazitäts-Prüfung in `helpBridge.js` robuster machen, Last durch doppeltes `capturePage()` beobachten.
- Die automatische stündliche Issue-Bearbeitung (geplante Aufgabe) wurde am 19.10. **ausgeschaltet** (Guthaben sparen).
- `docs/archived_issues/` (30 Ordner `issue-<nr>-…`, z. B. #95 IP-Grabber-Gefahr, #97 CI startet nicht, #87 Android-Fehler, #12 Benachrichtigungstöne, #81 Umfragen) sind Zusammenfassungen von **PKMessenger-Issues**; laut GitHub alle seit 09.10. geschlossen.
- Bekannte Fehler: keine offenen dokumentiert.

## Wichtige Infos
- Technik: Electron 44 · discord.js 14 · @discordjs/voice (DAVE) · React 19 · react-window · esbuild · Electron Forge; Android über Capacitor (`mobile/`).
- Befehle: `npm install`, `npm run demo` (ohne Token), `npm start`, `npm test`, `npm run make`, `npm run publish` (braucht `GITHUB_TOKEN`), `npm run android:build`.
- Relay (`relay/`): WebSocket-Vermittler, Docker + Caddy (80/443 nach außen), intern Port 8787; Ziel-URL in der App `wss://<domain>/ws`. Speichert nichts.
- Workflows: tests, release, android-check, pages, jules, claude-review, vibeworks-check.
- Bot-Token liegt verschlüsselt nur auf dem PC; `.env` nie committen.
- Repo: `Morni-Team/pkmessenger` (öffentlich), Lizenz MIT. Lokal: `C:\Projekte\PKMessenger`.
- Beteiligte: JONIMONI09 (Joni) schreibt Issues; Jules (Google) arbeitet ebenfalls im Repo.

## Philips Vorgaben
- Update-Funktion: ja (Auto-Update, prüft beim Start und alle 6 Stunden).
- Repo öffentlich.
- Git-Texte: Commits enden mit `Co-Authored-By: Claude …`; Issue-Kommentare tragen bisher „🤖 Diese Nachricht wurde mit Claude (KI-Assistent) verfasst.“ Eine feste Regel dazu ist im Repo nicht dokumentiert.
- Plugins/Workflows/Sicherheit nur nach Philips Entscheidung.

Diese Datei wird beim Arbeiten aktuell gehalten: nach jedem größeren Schritt „Aktueller Stand“ und „Offen“ anpassen.
