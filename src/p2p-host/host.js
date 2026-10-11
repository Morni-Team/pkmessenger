'use strict';

// Verstecktes P2P-Fenster am PC (vibeworks #219): wartet auf den Helfer und reicht seine Anfragen an den Hilfe-Manager weiter.
const { createP2PHost } = require('../shared/p2p');

let host = null;
window.pkP2P.onStart(({ key }) => {
  if (host) host.close();
  const raw = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
  if (raw.length !== 32) return;
  host = createP2PHost({
    key: raw,
    onRequest: (path, body) => window.pkP2P.request(path, body),
    onState: (s) => window.pkP2P.state(s),
  });
  window.pkP2P.state('bereit');
});
