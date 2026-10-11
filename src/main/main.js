'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, session, Menu, autoUpdater, safeStorage, clipboard, powerMonitor, Tray, nativeImage } = require('electron');

// Squirrel-Installer (Windows): beim Installieren/Deinstallieren Verknüpfungen anlegen und sofort beenden.
if (handleSquirrelEvent()) return;

const discord = require('discord.js');
const { createDiscordService } = require('./discord');
const { createStore } = require('./store');
const { ensureEnvFile } = require('./env');
const { registerIpc } = require('./ipc');
const { createUpdater, parseRepo } = require('./updater');
const { createVoiceManager } = require('./voice');
const { createAiManager, createSecretFile } = require('./ai');
const { createBotModules } = require('./bot-modules');
const { createMemory } = require('./ai-memory');
const { createHello } = require('./hello');
const { createLogger, buildReport } = require('./logger');
const { createBlocklist } = require('./blocklist');
const { createRelayTester } = require('./relay-test');
const { createRemote } = require('./remote');
const { createHelp } = require('./help');
const { validators: remoteValidators } = require('./validate');
const os = require('node:os');
const qrcode = require('qrcode-generator');
const { createAppLock } = require('./app-lock');
const { createTokenStore } = require('./secrets');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const ROOT = path.join(__dirname, '..', '..');
const RENDERER_HTML = path.join(ROOT, 'build', 'renderer', 'index.html');
const RENDERER_URL_PREFIX = `${require('node:url').pathToFileURL(path.dirname(RENDERER_HTML)).toString()}/`;

// Entwickler-Schalter (in der installierten App wirkungslos):
//   --demo                 simulierte Daten ohne Discord-Verbindung (für Screenshots/UI-Tests)
//   --screenshots=<ordner> nimmt automatisch Bilder der laufenden App auf
const DEMO = !app.isPackaged && process.argv.includes('--demo');
const SHOTS_ARG = !app.isPackaged && process.argv.find((a) => a.startsWith('--screenshots='));
const demo = DEMO ? require('./demo').createDemo() : null;
// Automatischer Testlauf: simuliertes Mikrofon (Testton) statt des echten – dein Mikro wird dabei NICHT benutzt.
if (SHOTS_ARG) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

// Entwicklung: .env im Projektordner. Installierte App: .env im Benutzerordner (%APPDATA%\PKMessenger).
const ENV_PATH = demo ? demo.envPath : app.isPackaged ? path.join(app.getPath('userData'), '.env') : path.join(ROOT, '.env');

let mainWindow = null;

function broadcast(type, payload) {
  // Neuaufbau des Discord-Clients → verwaiste Sprachverbindung auflegen (Fehlersuche Issue #1)
  if (type === 'status') {
    try {
      voice.handleDiscordStatus(payload?.state);
    } catch {
      /* Sprach-Manager noch nicht initialisiert – dann gibt es auch keine Verbindung */
    }
  }
  if (type === 'log' && payload?.message) {
    try {
      logger[payload.level === 'error' ? 'error' : 'warn']('discord', payload.message);
    } catch {
      /* Logger noch nicht bereit */
    }
  }
  // KI-Antwort-Agent (Beta): neue Nachrichten prüfen (antwortet nur, wenn eingeschaltet und der Bot erwähnt wird)
  if (type === 'message:create') {
    try {
      ai.onMessage(payload).catch(() => {});
      botModules.onMessage(payload).catch(() => {}); // Bot-Module (Beta, #131)
    } catch {
      /* KI-Manager noch nicht initialisiert */
    }
  }
  // Bot-Module: Protokoll (bearbeitet/gelöscht) und Starboard (⭐-Reaktionen kommen als Update)
  if (type === 'message:update' || type === 'message:delete') {
    try {
      (type === 'message:update' ? botModules.onUpdate(payload) : botModules.onDelete(payload)).catch(() => {});
    } catch {
      /* noch nicht initialisiert */
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pk:event', { type, payload });
  }
}

// EINE Client-Instanz für alle Fenster.
// Token-Tresor: verschlüsselt (Windows DPAPI über safeStorage) in %APPDATA%\PKMessenger\token.enc; .env wird übernommen + gelöscht.
const tokenStore = demo ? null : createTokenStore({ safeStorage, filePath: path.join(app.getPath('userData'), 'token.enc'), envPath: ENV_PATH });
const service = createDiscordService({
  discord,
  envPath: ENV_PATH,
  emit: broadcast,
  ...(tokenStore ? { getToken: () => tokenStore.load() } : {}),
  // Bekannte Privatchats: nur Kanal- und Nutzer-ID, max. 100 (Discord liefert Bots keine DM-Liste)
  dmStore: {
    list: () => (Array.isArray(store.get().dmChannels) ? store.get().dmChannels : []),
    add: (entry) => store.set('dmChannels', [entry, ...(store.get().dmChannels || []).filter((e) => e.channelId !== entry.channelId)].slice(0, 100)),
  },
  // Online-Status (freiwillig, privilegiertes Intent): Schalter in settings.json
  presence: { get: () => store.get().presence === true, set: (on) => store.set('presence', Boolean(on)) },
  ...(demo ? { createClient: demo.createClient, statusExtra: { demo: true } } : {}),
});
const store = createStore(path.join(app.getPath('userData'), demo || SHOTS_ARG ? 'settings-dev-demo.json' : 'settings.json'));
// Screenshot-Lauf: jedes Mal mit gleichem Ausgangszustand starten (KI-Beta aus, keine gemerkten Privatchats)
if (SHOTS_ARG) {
  store.set('ai', null);
  store.set('dmChannels', []);
  store.set('screenProtection', false);
  store.set('appLock', null);
  store.set('remote', null); // Fernzugang (Issue #53): jeder Lauf beginnt aus und ohne Passwort
}
const voice = createVoiceManager({
  voiceLib: demo ? demo.voiceLib : require('@discordjs/voice'),
  getVoiceTarget: (t) => service.getVoiceTarget(t),
  emit: broadcast,
  // Empfangener Ton (Opus) live ans Fenster – wird nirgends gespeichert.
  sendAudio: (userId, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pk:voice-audio', { userId, data });
  },
});
const updater = createUpdater({
  // Demo: simulierter Updater, damit Anzeige und Rückmeldung testbar sind (echte App: Squirrel)
  autoUpdater: demo ? demo.autoUpdater : autoUpdater,
  isPackaged: demo ? true : app.isPackaged,
  version: app.getVersion(),
  repo: parseRepo(require('../../package.json').repository),
  emit: broadcast,
  // Installiert per PKMessenger-Setup.exe? Dann liegt Squirrels Update.exe eine Ebene über der App.
  squirrelInstalled: demo ? true : fs.existsSync(path.join(path.dirname(process.execPath), '..', 'Update.exe')),
  // Demo: GitHub-Abfrage simuliert (kein Netz) – „neueste Version“ = eigene Version
  ...(demo ? { fetchImpl: (url) => demo.githubFetch(url, app.getVersion()) } : {}),
});

// Eigener Benachrichtigungston: geprüfte WAV-Datei im App-Ordner (keine Geheimnisse, kein Netz)
const SOUND_PATH = path.join(app.getPath('userData'), 'custom-sound.wav');
const soundFile = {
  has: () => fs.existsSync(SOUND_PATH),
  get: () => (fs.existsSync(SOUND_PATH) ? new Uint8Array(fs.readFileSync(SOUND_PATH)) : null),
  set: (data) => fs.writeFileSync(SOUND_PATH, Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
  clear: () => fs.rmSync(SOUND_PATH, { force: true }),
};

// App-Sperre (Passwort-Hash in settings.json unter „appLock“)
const appLock = createAppLock({ store, emit: broadcast });

// Fehlerprotokoll (Issue #1): englisch, ohne Geheimnisse, nur lokal (Demo: nur im Speicher)
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const logger = createLogger({ dir: demo ? null : LOG_DIR });
process.on('uncaughtException', (e) => logger.error('main', `uncaughtException: ${e?.message}`, e?.stack?.split('\n').slice(1, 5).join(' ')));
process.on('unhandledRejection', (e) => logger.error('main', `unhandledRejection: ${e?.message || e}`, e?.stack?.split('\n').slice(1, 5).join(' ')));
const errorReport = ({ where, message }) =>
  buildReport({ version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron, error: message, where, lines: logger.tail(30) });
const openLogFolder = () => {
  if (demo) return false;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  shell.openPath(LOG_DIR);
  return true;
};

// Öffentliche Sperrlisten für den Link-Schutz: täglich von GitHub, lokal geprüft (Demo: kleine Liste, kein Netz)
const blocklist = createBlocklist({ dir: demo ? null : app.getPath('userData'), emit: broadcast, ...(demo ? { fetchImpl: demo.blocklistFetch } : {}) });

// Fernzugang im WLAN (Issue #46/#50, Eigentümer-Freigabe 07.10.2026): ab Werk aus, nur private Netze
const lanAddresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))
    .map((i) => i.address)
    .sort((a, b) => Number(!a.startsWith('192.168.')) - Number(!b.startsWith('192.168.'))); // echtes WLAN vor virtuellen Adaptern (WSL/Hyper-V)
// Selbst gehosteter Relay (Einstellungen → Hilfe & Tour): ein Relay für Fernzugang UND Fernhilfe (#104/#105)
// Standard: Morni-Team-Server (nichts installieren); eigener Server oder aus unter Support → Erweitert (vibeworks #219)
const { resolveRelay } = require('../shared/relay-config');
const relayConfig = () => resolveRelay(store.get(), { demo: Boolean(demo) });
const remoteRelayConfig = () => resolveRelay(store.get(), { demo: Boolean(demo), forRemote: true });
const remote = createRemote({
  getRelay: remoteRelayConfig,
  service,
  validators: remoteValidators,
  store,
  vault: demo ? (() => { let r = null; return { get: () => r, set: (v) => (r = v), clear: () => (r = null) }; })() : createSecretFile({ safeStorage, filePath: path.join(app.getPath('userData'), 'remote-devices.enc') }),
  emit: broadcast,
  logger,
  webDir: path.join(__dirname, '..', 'remote-web'),
  naclPath: require.resolve('tweetnacl/nacl-fast.min.js'),
  // Demo/Screenshot-Lauf: nur auf diesem PC lauschen (keine Firewall-Abfrage)
  lanAddresses: demo ? () => ['127.0.0.1'] : lanAddresses,
  bindHost: demo ? '127.0.0.1' : '0.0.0.0',
  // Gerätename statt IP im Link (mDNS „name.local“, nur wenn der Name dafür taugt)
  hostName: demo ? 'localhost' : /^[a-z0-9-]{1,63}$/i.test(os.hostname()) ? `${os.hostname().toLowerCase()}.local` : null,
});
/** Einmal-Code + QR-Code (als Bild) für die Oberfläche */
remote.createPairingWithQr = () => {
  const p = remote.createPairing();
  const qr = qrcode(0, 'M');
  qr.addData(p.relayUrl || p.url); // Unterwegs-Link geht überall, auch im WLAN
  qr.make();
  return { ...p, qr: qr.createDataURL(6, 2) };
};

// Fernhilfe (Issue #79): Helfer schaut bei der Einrichtung zu – Chats bleiben verborgen, läuft nur auf Anforderung.
let latestHelpView = { screen: 'setup' };
const help = createHelp({
  emit: broadcast,
  getView: () => latestHelpView,
  applyAction: (action) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('pk:help-action', action),
  logger,
  lanAddresses: demo ? () => ['127.0.0.1'] : lanAddresses,
  bindHost: demo ? '127.0.0.1' : '0.0.0.0',
  hostName: demo ? 'localhost' : /^[a-z0-9-]{1,63}$/i.test(os.hostname()) ? `${os.hostname().toLowerCase()}.local` : null,
  webDir: path.join(__dirname, '..', 'help-web'),
  naclPath: require.resolve('tweetnacl/nacl-fast.min.js'),
  // Relay-Adresse (für Fernhilfe außerhalb des WLANs): wss://<domain>/ws, selbst gehostet (relay/)
  getRelay: relayConfig,
});
/** „Hilfe anfordern“: Einmal-Code + QR-Code (als Bild) für die Oberfläche */
help.requestWithQr = async () => {
  const p = await help.request();
  const linkForQr = p.relayUrl || p.url;
  if (!linkForQr) return p;
  const qr = qrcode(0, 'M');
  qr.addData(linkForQr);
  qr.make();
  return { ...p, qr: qr.createDataURL(6, 2) };
};

// Windows Hello zum Entsperren (Issue #29) – Windows-eigene Prüfung, siehe hello.js
const hello = demo ? { availability: async () => 'Available', verify: async () => true } : createHello();

// Im Hintergrund weiterlaufen (Issue #29): Fenster schließen = verstecken, Bot bleibt online, Symbol im Infobereich
let tray = null;
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return undefined;
}
function updateTray() {
  const on = store.get().runInBackground === true;
  if (on && !tray) {
    tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 }));
    tray.setToolTip('PKMessenger – dein Bot läuft weiter');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'PKMessenger öffnen', click: showWindow }, { type: 'separator' }, { label: 'Beenden (Bot geht offline)', click: () => app.quit() }]));
    tray.on('click', showWindow);
  } else if (!on && tray) {
    tray.destroy();
    tray = null;
  }
}
const background = {
  get: () => ({ enabled: store.get().runInBackground === true }),
  set: (on) => {
    store.set('runInBackground', on);
    updateTray();
    return background.get();
  },
};

// Mit Windows starten: Squirrel-Apps über Update.exe starten (bleibt nach Updates gültig)
const SQUIRREL_UPDATE = path.join(path.dirname(process.execPath), '..', 'Update.exe');
const autostart = {
  get: () => {
    const available = app.isPackaged && fs.existsSync(SQUIRREL_UPDATE);
    return { available, enabled: available && app.getLoginItemSettings({ path: SQUIRREL_UPDATE, args: ['--processStart', `"${path.basename(process.execPath)}"`] }).openAtLogin };
  },
  set: (on) => {
    app.setLoginItemSettings({ openAtLogin: on, path: SQUIRREL_UPDATE, args: ['--processStart', `"${path.basename(process.execPath)}"`] });
    return autostart.get();
  },
};

// KI-Agenten (Beta): API-Schlüssel verschlüsselt in ai-key.enc; im Demo simulierter Anbieter
// Bot-Module (Beta, #131): Auto-Antworten, Zählen, Level – pro Server an/aus, ab Werk alles aus
const botModules = createBotModules({ store, service, logger });
const ai = createAiManager({
  store,
  service,
  emit: broadcast,
  secret: demo ? demo.aiSecret : createSecretFile({ safeStorage, filePath: path.join(app.getPath('userData'), 'ai-key.enc') }),
  // Gedächtnis pro Person: verschlüsselt in ai-memory.enc (Demo: nur im Speicher)
  memory: createMemory({ vault: demo ? demo.memoryVault : createSecretFile({ safeStorage, filePath: path.join(app.getPath('userData'), 'ai-memory.enc') }) }),
  ...(demo ? { fetchImpl: demo.aiFetch, searchImpl: demo.aiSearch } : {}),
});

function isTrustedSender(event) {
  const url = event.senderFrame?.url || '';
  return url.startsWith(RENDERER_URL_PREFIX);
}

async function openEnvFile() {
  ensureEnvFile(ENV_PATH);
  const err = await shell.openPath(ENV_PATH);
  if (err) {
    shell.showItemInFolder(ENV_PATH);
    return { opened: false, path: ENV_PATH };
  }
  return { opened: true, path: ENV_PATH };
}

async function openExternal(url) {
  await shell.openExternal(url);
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0f1117',
    title: 'PKMessenger',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      // Benachrichtigungstöne auch ohne vorherigen Klick (z. B. App minimiert gestartet)
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // Bildschirmschutz: Windows blendet das Fenster bei Screenshots/Aufnahmen anderer Programme schwarz aus
  if (store.get().screenProtection === true) mainWindow.setContentProtection(true);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Keine Navigation weg von der App; Links öffnen im Standardbrowser.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(RENDERER_URL_PREFIX)) e.preventDefault();
  });
  // Neue Fenster (Mittelklick, Umschalt+Klick) immer ablehnen und NICHT selbst öffnen: sonst würde der Link-Schutz
  // (Warnung bei gefährlichen Links) übersprungen. Links öffnen nur per Klick über den Renderer (nav.openExternal).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // DevTools nur in der Entwicklung (Strg+Umschalt+I).
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (!app.isPackaged && input.control && input.shift && input.key.toLowerCase() === 'i') mainWindow.webContents.toggleDevTools();
  });

  mainWindow.webContents.on('render-process-gone', (_e, d) => logger.error('renderer', `render-process-gone: ${d?.reason} (${d?.exitCode})`));
  mainWindow.loadFile(RENDERER_HTML, SHOTS_ARG ? { query: { shots: '1' } } : undefined);
  if (SHOTS_ARG) {
    // Testlauf: Fehler aus der Oberfläche im Terminal sichtbar machen
    mainWindow.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning') console.log(`[renderer:${e.level}] ${e.message}`);
    });
    const dir = path.resolve(SHOTS_ARG.split('=')[1]);
    mainWindow.webContents.once('did-finish-load', () => {
      require('./screenshots')
        .runScreenshots(mainWindow, dir, { demo: DEMO, stats: demo?.stats, simulate: demo?.simulate })
        .catch((e) => console.error('[screenshots] Fehler:', e))
        .finally(() => app.quit());
    });
  }
  // Hintergrundbetrieb: Schließen versteckt nur das Fenster (mit App-Passwort wird dabei gesperrt)
  mainWindow.on('close', (e) => {
    if (quitting || SHOTS_ARG || store.get().runInBackground !== true) return;
    e.preventDefault();
    mainWindow.hide();
    appLock.lock();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // Berechtigungen: NUR Mikrofon (Audio, keine Kamera), NUR für unser eigenes App-Fenster (Sprachkanäle).
  // Alles andere (Kamera, Benachrichtigungen, Standort, …) wird abgelehnt.
  const isOwnUrl = (url) => typeof url === 'string' && url.startsWith(RENDERER_URL_PREFIX);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => {
    const audioOnly = Array.isArray(details?.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio');
    cb(perm === 'media' && audioOnly && isOwnUrl(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin, details) => perm === 'media' && details?.mediaType !== 'video' && isOwnUrl(details?.requestingUrl || origin));
  const setScreenProtection = (on) => mainWindow?.setContentProtection(on);
  registerIpc(ipcMain, { service, store, openEnvFile, openExternal, updater, appVersion: app.getVersion(), voice, tokenStore, setScreenProtection, ai, soundFile, copyText: (t) => clipboard.writeText(t), appLock, autostart, hello, background, logger, errorReport, openLogFolder, blocklist, remote, help, relayTester: createRelayTester(), currentRelay: () => relayConfig()?.wss || '', botModules }, isTrustedSender);
  // Der Renderer meldet laufend seine (ungeschwärzte) Sicht; geschwärzt wird erst im Hilfe-Manager.
  ipcMain.on('pk:help-view', (event, view) => {
    if (isTrustedSender(event) && view && typeof view === 'object') latestHelpView = view;
  });
  // Automatische Sperre: PC eine Weile unbenutzt → App sperren
  setInterval(() => appLock.idleTick(powerMonitor.getSystemIdleTime()), 30000).unref?.();
  createWindow();
  updateTray();
  service.connect(); // async – blockiert das Fenster nicht
  updater.start();
  // Fernzugang: nur wenn der Besitzer ihn eingeschaltet hat
  if (store.get().remote?.enabled && !SHOTS_ARG) remote.start().catch(() => {});
  // Sperrlisten: kurz nach dem Start, dann alle 6 Stunden prüfen (geladen wird nur, wenn älter als 24 h)
  setTimeout(() => blocklist.update().catch(() => {}), 8000).unref?.();
  setInterval(() => blocklist.update().catch(() => {}), 6 * 60 * 60 * 1000).unref?.();
  ai.start();
});

app.on('window-all-closed', () => {
  if (store.get().runInBackground !== true || quitting) app.quit();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  try {
    botModules.flush(); // Zählerstand/Punkte sichern
    store.flush();
  } catch {
    /* ignorieren */
  }
  remote.stop().catch(() => {});
  try { help.stop(); } catch { /* egal */ }
  try {
    voice.leave(); // sauber auflegen
  } catch {
    /* ignorieren */
  }
  service.disconnect().finally(() => app.exit(0));
});

function handleSquirrelEvent() {
  if (process.platform !== 'win32') return false;
  const cmd = process.argv[1];
  if (!cmd || !cmd.startsWith('--squirrel-')) return false;
  const { spawn } = require('node:child_process');
  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  const exeName = path.basename(process.execPath);
  const run = (args) => spawn(updateExe, args, { detached: true }).on('close', () => app.quit());
  switch (cmd) {
    case '--squirrel-install':
    case '--squirrel-updated':
      run(['--createShortcut', exeName]);
      return true;
    case '--squirrel-uninstall':
      run(['--removeShortcut', exeName]);
      return true;
    case '--squirrel-obsolete':
      app.quit();
      return true;
    default:
      return false;
  }
}
