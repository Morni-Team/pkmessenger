'use strict';

// Direktverbindung am PC (vibeworks #219): WebRTC gibt es nur in Chromium, nicht in Node. Deshalb läuft die PC-Seite in einem
// VERSTECKTEN, abgeschotteten Fenster (Sandbox, eigene Sitzung im Speicher, keine Node-APIs, strenge CSP).
// Das Fenster darf nur eines: Helfer-Anfragen (/pair, /view, /act) an den Hilfe-Manager weiterreichen.
// Alles andere (Kopplung mit Code, Bestätigung am PC, Schwärzen, Prüfung jeder Aktion) bleibt unverändert in help.js.

const ALLOWED_PATHS = new Set(['/pair', '/view', '/act']);
const MAX_BODY = 32 * 1024;

/** Anfrage aus dem P2P-Fenster prüfen (IPC-Validierung). */
function checkRequest(p) {
  if (!p || typeof p !== 'object' || !ALLOWED_PATHS.has(p.path)) return null;
  const body = p.body && typeof p.body === 'object' && !Array.isArray(p.body) ? p.body : null;
  if (!body) return null;
  try {
    if (JSON.stringify(body).length > MAX_BODY) return null;
  } catch {
    return null;
  }
  return { path: p.path, body };
}

const STATES = new Set(['suche', 'angeboten', 'verbunden', 'getrennt', 'new', 'connecting', 'connected', 'disconnected', 'failed', 'closed', 'bereit']);

/**
 * @param {object} o
 * @param {Function} o.BrowserWindow
 * @param {object} o.ipcMain
 * @param {string} o.htmlPath   build/p2p-host/index.html
 * @param {string} o.preloadPath
 */
function createP2PBridge({ BrowserWindow, ipcMain, htmlPath, preloadPath, logger = null }) {
  let win = null;
  let onRequest = null;
  let state = null;
  let onStateCb = () => {};

  const fromWin = (event) => Boolean(win && !win.isDestroyed() && event.sender === win.webContents);

  ipcMain.handle('pk:p2p-request', async (event, p) => {
    if (!fromWin(event) || !onRequest) return { error: 'Nicht erlaubt.' };
    const req = checkRequest(p);
    if (!req) return { error: 'Ungültig.' };
    return onRequest(req.path, req.body);
  });
  ipcMain.on('pk:p2p-state', (event, s) => {
    if (!fromWin(event) || !STATES.has(s)) return;
    state = s;
    onStateCb(s);
  });

  function start(key, handler, onState = () => {}) {
    stop();
    onRequest = handler;
    onStateCb = onState;
    state = 'suche';
    win = new BrowserWindow({
      show: false,
      width: 200,
      height: 200,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: 'p2p', // eigene Sitzung nur im Speicher – keine Cookies/Daten der App
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    wc.on('render-process-gone', (_e, d) => logger?.warn?.('p2p', `gone: ${d?.reason}`));
    const keyB64 = Buffer.from(key).toString('base64');
    wc.once('did-finish-load', () => {
      if (win && !win.isDestroyed()) wc.send('pk:p2p-start', { key: keyB64 });
    });
    win.loadFile(htmlPath).catch((err) => logger?.warn?.('p2p', `load: ${err.message}`));
  }

  function stop() {
    onRequest = null;
    state = null;
    const w = win;
    win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  return { start, stop, state: () => state };
}

module.exports = { createP2PBridge, checkRequest };
