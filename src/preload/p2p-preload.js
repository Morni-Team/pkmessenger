'use strict';

// Preload des versteckten P2P-Fensters (vibeworks #219): nur Start-Signal empfangen, Anfragen weiterreichen, Zustand melden.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pkP2P', {
  onStart: (cb) => ipcRenderer.on('pk:p2p-start', (_e, cfg) => cb({ key: String(cfg?.key || '') })),
  request: (path, body) => ipcRenderer.invoke('pk:p2p-request', { path: String(path), body }),
  state: (s) => ipcRenderer.send('pk:p2p-state', String(s)),
});
