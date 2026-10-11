# PKMessenger-Relay

Verschlüsselnder WebSocket-Vermittler, damit **Fernzugang** und **Fernhilfe** von PKMessenger auch **außerhalb des WLANs** funktionieren – ohne dass der Nutzer-PC von außen erreichbar sein muss.

- Leitet **nur Ende-zu-Ende-verschlüsselte Pakete** weiter (tweetnacl in der App). Der Relay sieht nie Klartext, nie den Bot-Token, nie Nachrichten.
- **Speichert nichts.** Ein Raum verbindet genau zwei Geräte; er verschwindet, sobald beide weg sind oder nach 30 Minuten.
- Höchstens 2 Geräte pro Raum, Größen-/Rate-Limits, systemd-Hardening.

## Betrieb mit Docker (empfohlen, „integrierter Server")

Turnkey: Relay **plus automatisches HTTPS** (Caddy) in zwei Containern. Du brauchst nur Docker + eine Domain.

1. **DNS:** Einen A-/AAAA-Eintrag deiner Domain (z. B. `relay.deine-domain.de`) auf den Server zeigen lassen.
2. **Domain eintragen:**
   ```bash
   cd relay
   cp .env.example .env     # dann RELAY_DOMAIN=... in .env setzen
   ```
3. **Starten:**
   ```bash
   docker compose up -d
   ```
   Caddy holt das TLS-Zertifikat automatisch (Let's Encrypt). Nach außen sind nur 80/443 offen; der Relay läuft nur im internen Docker-Netz.
4. **In PKMessenger** → Einstellungen → Hilfe & Tour: `wss://relay.deine-domain.de/ws` eintragen.

Updaten: `cd relay && docker compose build --pull && docker compose up -d`. Logs: `docker compose logs -f relay`.

> Der Build-Kontext ist das Repo-Wurzelverzeichnis (die `docker-compose.yml` setzt das automatisch), weil der Relay die Helfer-Oberfläche aus `src/help-web` mit ausliefert.

### Server hat schon einen Caddy (z. B. NetBird) – #138

Läuft auf dem Server bereits ein Caddy (oder ein anderer Reverse-Proxy) auf 80/443, kann der Caddy aus der `docker-compose.yml` nicht starten. **Typisches Zeichen:** Die App meldet „Problem mit dem HTTPS-Zertifikat“, `curl https://relay.deine-domain.de` bricht mit *TLS alert internal error* ab – der vorhandene Caddy kennt die Relay-Domain nicht und hat kein Zertifikat dafür.

So geht's:

1. Nur den Relay-Container starten und ihn **lokal** auf Port 8787 freigeben:
   ```bash
   cd relay
   docker compose build
   docker run -d --name pk-relay --restart unless-stopped -p 127.0.0.1:8787:8787 -e HOST=0.0.0.0 -e PORT=8787 pkmessenger-relay
   ```
2. Im **vorhandenen** Caddyfile einen Block ergänzen und Caddy neu laden (`caddy reload` bzw. `docker exec <caddy> caddy reload --config /etc/caddy/Caddyfile`):
   ```caddy
   relay.deine-domain.de {
   	reverse_proxy 127.0.0.1:8787
   }
   ```
   Läuft der vorhandene Caddy selbst in Docker, statt `127.0.0.1` die Host-IP aus Sicht des Containers nehmen (z. B. `host.docker.internal:8787` mit `extra_hosts: ["host.docker.internal:host-gateway"]`) oder beide Container ins selbe Docker-Netz hängen und `reverse_proxy pk-relay:8787` schreiben.
3. Prüfen: `curl https://relay.deine-domain.de/health` → `{"ok":true,"service":"pkmessenger-relay",…}`. In der App: Einstellungen → Support → Erweitert → „Verbindung testen“.

## Betrieb auf dem Proxmox (ohne Docker)

Siehe **[docs/proxmox-quickstart.md](../docs/proxmox-quickstart.md)** – Einzeiler-Install, Reverse-Proxy (Caddy/Nginx) für TLS + Domain, `update`-Befehl.

## Lokal starten (zum Ausprobieren)

```bash
cd relay && npm install && npm start   # lauscht auf 127.0.0.1:8787, WebSocket unter /ws
```

Gesundheits-Check: `GET http://127.0.0.1:8787/health` → `{"ok":true,…}`.

## Protokoll (für die App)

1. WebSocket zu `wss://<domain>/ws` öffnen.
2. Erste Nachricht (JSON): `{"room":"<raum-id>","role":"host"|"guest"}`. Antwort `{"relay":"joined","peer":<bool>}`; kommt die Gegenseite später, folgt `{"relay":"peer","connected":true}`.
3. Danach jedes Paket (verschlüsselte Bytes) wird **unverändert** an die Gegenseite weitergereicht.

Die Raum-ID ist zufällig und steht im Einladungslink; der Krypto-Schlüssel steht getrennt im Link-Fragment (`#…`) und erreicht den Relay nie.
