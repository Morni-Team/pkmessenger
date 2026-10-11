'use strict';
// Helfer-Oberfläche (Issue #79). Zwei Wege:
//  - Relay (außerhalb des WLANs): Link enthält #r=<raum>&c=<schlüssel>; verbindet per WebSocket zum Relay.
//  - LAN (gleiches WLAN): Link enthält #c=<schlüssel>; spricht per fetch mit dem PC direkt.
// Verschlüsselt mit nacl (Schlüssel aus dem Link-Fragment). Zeigt nur die geschwärzte Sicht. Nur textContent.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  var frag = new URLSearchParams(location.hash.slice(1));
  var room = frag.get('r');
  var relayMode = Boolean(room);
  // vibeworks #219: p=1 → erst DIREKT verbinden (WebRTC, Vermittlung über öffentliche Nostr-Relays); h = Relay-Server als Rückfall
  var p2pMode = frag.get('p') === '1' && typeof window.PKP2P === 'object';
  var relayHost = /^[a-z0-9.-]+(:\d+)?$/i.test(frag.get('h') || '') ? frag.get('h') : null;
  var direct = null; // offene Direktverbindung
  var key = null;
  try {
    var rawKey = atob((frag.get('c') || '').replace(/-/g, '+').replace(/_/g, '/'));
    key = Uint8Array.from(rawKey, function (c) { return c.charCodeAt(0); });
  } catch (e) { key = null; }

  function b64(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function unb64(s) { var b = atob(s); return Uint8Array.from(b, function (c) { return c.charCodeAt(0); }); }
  function seal(obj) {
    var n = nacl.randomBytes(nacl.secretbox.nonceLength);
    return { n: b64(n), c: b64(nacl.secretbox(enc.encode(JSON.stringify(obj)), n, key)) };
  }
  function unseal(msg) {
    if (!msg || !msg.c) return msg;
    var p = nacl.secretbox.open(unb64(msg.c), unb64(msg.n), key);
    return p ? JSON.parse(dec.decode(p)) : null;
  }

  // Transport: send(path, body) → Promise<antwort>
  var ws = null;
  var pending = {};
  var nextId = 1;
  function connectRelay() {
    return new Promise(function (resolve, reject) {
      var url = relayHost ? 'wss://' + relayHost + '/ws' : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
      ws = new WebSocket(url);
      ws.onopen = function () { ws.send(JSON.stringify({ room: room, role: 'guest' })); };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.relay) { if (m.relay === 'joined') resolve(); return; }
        if (m.id && pending[m.id]) { pending[m.id](m.reply); delete pending[m.id]; }
      };
      ws.onerror = function () { reject(new Error('Keine Verbindung zum Relay.')); };
      ws.onclose = function () { $('note').textContent = 'Verbindung getrennt.'; };
      setTimeout(function () { reject(new Error('Zeitüberschreitung.')); }, 8000);
    });
  }
  // Erst direkt (kein Server dazwischen), sonst Relay-Server, sonst Fehler mit verständlichem Hinweis
  function connectAny() {
    if (!p2pMode) return relayMode ? connectRelay() : Promise.resolve();
    msg.textContent = 'Suche den anderen PC …';
    return window.PKP2P.connect({ key: key, timeoutMs: 20000, onState: function (s) { if (s === 'verbinde') msg.textContent = 'Verbinde direkt …'; } })
      .then(function (c) {
        direct = c;
        c.onClose(function () { $('note').textContent = 'Verbindung getrennt.'; });
        $('via').textContent = '🔒 Direkt verbunden – ohne Server dazwischen.';
      })
      .catch(function () {
        if (!relayMode) throw new Error('Keine Verbindung möglich. Ist am anderen PC „Hilfe starten“ noch aktiv? Sonst: gleiches WLAN nutzen.');
        msg.textContent = 'Direkt klappt nicht – verbinde über den Server …';
        return connectRelay().then(function () { $('via').textContent = '🔒 Über den Server verbunden (Ende-zu-Ende verschlüsselt).'; });
      });
  }

  function send(path, body) {
    if (direct) return direct.send(path, body);
    if (relayMode) {
      return new Promise(function (resolve) {
        var id = String(nextId++);
        pending[id] = resolve;
        ws.send(JSON.stringify({ id: id, path: path, body: body }));
        setTimeout(function () { if (pending[id]) { pending[id](null); delete pending[id]; } }, 10000);
      });
    }
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  }

  function show(el, on) { el.classList.toggle('hidden', !on); }
  var msg = $('msg');

  $('go').onclick = function () {
    if (!key) { msg.textContent = 'Ungültiger Link. Bitte den Link neu öffnen.'; return; }
    var code = ($('code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) { msg.textContent = 'Der Code hat 6 Zeichen.'; return; }
    msg.textContent = 'Verbinde …';
    var ready = direct ? Promise.resolve() : connectAny();
    ready.then(function () {
      msg.textContent = 'Warte auf Bestätigung am anderen PC …';
      var sealed = seal({ name: $('name').value || 'Helfer', t: Date.now() });
      return send('/pair', { code: code, n: sealed.n, c: sealed.c });
    }).then(function (res) {
      var out = unseal(res);
      if (!out || out.error) { msg.textContent = (out && out.error) || (res && res.error) || 'Verbindung fehlgeschlagen.'; return; }
      show($('connect'), false);
      show($('live'), true);
      loop();
    }).catch(function (e) { msg.textContent = e.message || 'Verbindung fehlgeschlagen.'; });
  };

  function call(path, payload) {
    var body = seal(Object.assign({ t: Date.now() }, payload || {}));
    return send(path, body).then(function (r) { return unseal(r) || r; });
  }

  function renderFields(view) {
    var box = $('fields');
    box.textContent = '';
    (view.fields || []).forEach(function (f) {
      var b = document.createElement('button');
      b.className = 'field' + (f.secret ? ' secret' : '');
      b.textContent = f.label || '(ohne Beschriftung)';
      if (f.secret) { b.disabled = true; b.title = 'Sicherheits-Feld – bedient nur der Nutzer'; }
      else b.onclick = function () { call('/act', { action: { type: 'click', target: f.id } }); };
      box.appendChild(b);
    });
  }

  function loop() {
    call('/view', {}).then(function (out) {
      if (!out || out.error) { $('note').textContent = (out && out.error) || 'Getrennt.'; return; }
      var v = out.view || {};
      $('screen').textContent = 'Bildschirm: ' + (v.screen || '?');
      $('note').textContent = v.note || '';
      $('control').textContent = out.control ? 'Du kannst mithelfen (Knöpfe klicken).' : 'Nur Zusehen – der Nutzer hat das Mitsteuern aus.';
      if (v.hidden) $('fields').textContent = '';
      else renderFields(v);
      var cur = $('cursor');
      if (v.cursor) { show(cur, true); cur.style.left = (v.cursor.x - 8) + 'px'; cur.style.top = (v.cursor.y - 8) + 'px'; }
      else show(cur, false);
      setTimeout(loop, 900);
    }).catch(function () { $('note').textContent = 'Verbindung verloren.'; });
  }
})();
