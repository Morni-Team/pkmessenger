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
    diag('Suche den PC über die öffentlichen Vermittler …');
    var relays = null; // #148: Diagnose – erreichbare Vermittler
    return window.PKP2P.connect({
      key: key,
      timeoutMs: 20000,
      onState: function (s) {
        if (s !== 'suche') diag('Zustand: ' + s);
        if (s === 'verbinde') msg.textContent = 'PC gefunden – verbinde direkt …';
        if (s === 'vermittler') msg.textContent = 'Direkt geht nicht (VPN/Netz) – nutze die Vermittler …';
        if (/^relays:\d+$/.test(s)) {
          relays = Number(s.split(':')[1]);
          $('via').textContent = relays ? 'Vermittler erreichbar: ' + relays + ' – suche den PC …' : '⚠ Kein Vermittler erreichbar – blockiert ein VPN, eine Firewall oder ein Werbeblocker WebSockets?';
        }
      },
    })
      .then(function (c) {
        direct = c;
        diag(c.mode === 'vermittler' ? 'Verbunden über die Vermittler ✓' : 'Direkt verbunden ✓');
        c.onClose(function () { $('note').textContent = 'Verbindung getrennt.'; });
        // #148: kein Direktweg (VPN, strenges Netz) → über die Vermittler, etwas langsamer
        $('via').textContent = c.mode === 'vermittler' ? '🔒 Über öffentliche Vermittler verbunden (verschlüsselt, etwas langsamer).' : '🔒 Direkt verbunden – ohne Server dazwischen.';
      })
      .catch(function (e) {
        if (!relayMode) throw new Error((e && e.message) || 'Keine Verbindung möglich. Ist am anderen PC „Hilfe starten“ noch aktiv? Sonst: gleiches WLAN nutzen.');
        var why = (e && e.message) || 'Direktverbindung nicht möglich.';
        diag('Direkt/Vermittler gescheitert: ' + why + ' → versuche Ersatz-Server');
        msg.textContent = why + ' Versuche den Server …';
        return connectRelay()
          .then(function () { diag('Über den Ersatz-Server verbunden ✓'); $('via').textContent = '🔒 Über den Server verbunden (Ende-zu-Ende verschlüsselt).'; })
          .catch(function (e2) {
            diag('Ersatz-Server gescheitert: ' + ((e2 && e2.message) || '?'));
            // #148: beide Wege gescheitert → den eigentlichen Grund zeigen, nicht nur „Server nicht erreichbar“
            throw new Error(why + (relays === 0 ? ' (Kein Vermittler erreichbar – VPN/Firewall/Werbeblocker prüfen.)' : '') + ' Der Ersatz-Server ist auch nicht erreichbar.');
          });
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

  // #148: Verbindungs-Verlauf – jeder Schritt mit Uhrzeit, zum Kopieren für die Fehlersuche (keine Schlüssel, keine Codes)
  var diagLines = [];
  function diag(text) {
    var t = new Date();
    var hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2) + ':' + ('0' + t.getSeconds()).slice(-2);
    diagLines.push(hh + '  ' + text);
    var box = $('diaglog');
    if (box) box.textContent = diagLines.join('\n');
  }
  diag('Seite geladen · ' + (navigator.userAgent.match(/(Firefox|Edg|OPR|Chrome|Safari)\/[\d.]+/) || ['Browser ?'])[0] + ' · WebRTC: ' + (typeof RTCPeerConnection === 'function' ? 'ja' : 'NEIN (abgeschaltet?)') + ' · Modus: ' + (p2pMode ? 'direkt' : relayMode ? 'Server' : 'WLAN') + (relayHost ? ' · Ersatz-Server: ' + relayHost : ''));
  // #152: Plugins erkennen und verständlich sagen, was zu tun ist
  if (frag.get('p') === '1' && !p2pMode) {
    diag('⚠ Direktverbindung nicht geladen – ein Browser-Plugin (Werbe-/Tracking-Blocker) blockiert sie wahrscheinlich');
    msg.textContent = '⚠ Ein Browser-Plugin (z. B. Werbeblocker) blockiert die Verbindung. Bitte für diese Seite ausschalten und neu laden.';
  } else if (p2pMode && typeof RTCPeerConnection !== 'function') {
    diag('ℹ WebRTC ist in diesem Browser aus (Plugin oder Datenschutz-Einstellung) – es geht trotzdem über die Vermittler');
  }
  if ($('diagcopy')) $('diagcopy').onclick = function () {
    var text = 'PKMessenger Helfer-Verlauf\n' + diagLines.join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { $('diagcopy').textContent = 'Kopiert ✓'; });
  };

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
      if (!out || out.error) { msg.textContent = (out && out.error) || (res && res.error) || 'Verbindung fehlgeschlagen.'; diag('Kopplung: ' + msg.textContent); return; }
      diag('Kopplung bestätigt ✓');
      show($('connect'), false);
      show($('live'), true);
      loop();
    }).catch(function (e) { msg.textContent = e.message || 'Verbindung fehlgeschlagen.'; diag('Fehler: ' + msg.textContent); if ($('diag')) $('diag').open = true; });
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
      lastView = v;
      renderChat(out.chat);
      canControl = Boolean(out.control);
      // #158: echtes Bild der App holen (nicht über die Vermittler – zu groß dafür)
      var wantShot = out.screen && !v.hidden;
      var next = function () { setTimeout(loop, direct && direct.mode === 'vermittler' ? 2000 : 900); };
      if (!wantShot) {
        shotWanted = false;
        show($('shotwrap'), false);
        $('fieldlist').open = true;
        $('shothint').textContent = '';
        placeCursor(v);
        return next();
      }
      // #161: das Bild läuft in einer eigenen, schnelleren Schleife (nur Änderungen werden übertragen)
      shotWanted = true;
      if (!shotLoopRunning) shotLoop();
      placeCursor(v);
      next();
    }).catch(function () { $('note').textContent = 'Verbindung verloren.'; });
  }

  var shotWanted = false;
  var shotLoopRunning = false;
  var shotId = 0;
  function shotLoop() {
    if (!shotWanted) { shotLoopRunning = false; return; }
    var viaRelays = direct && direct.mode === 'vermittler'; // #44: kleines Bild über die Vermittler
    shotLoopRunning = true;
    call('/screen', { have: shotId, small: Boolean(viaRelays) }).then(function (r) {
      var shot = r && r.screen;
      if (shot && shot.same) {
        /* unverändert – nichts zu tun */
      } else if (shot && shot.img) {
        shotId = shot.id || 0;
        $('shot').src = shot.img;
        show($('shotwrap'), true);
        placeCursor(lastView);
        if (!$('shothint').textContent) $('shothint').textContent = canControl ? 'Klick ins Bild = Klick auf den Knopf an dieser Stelle. Mausrad = scrollen. Schwarze Flächen sind privat.' : 'Nur Zusehen. Schwarze Flächen sind privat.';
      } else {
        show($('shotwrap'), false);
        shotWanted = false;
      }
      setTimeout(shotLoop, viaRelays ? 1500 : 350);
    }, function () { setTimeout(shotLoop, 1500); });
  }

  // #158: Maus des Nutzers auf dem Bild anzeigen (Anteil 0…1 → Prozent – passt bei jeder Bildgröße)
  var lastView = null;
  var canControl = false;
  function placeCursor(v) {
    var c = $('shotcursor');
    if (v && v.cursor && !$('shotwrap').classList.contains('hidden')) {
      show(c, true);
      c.style.left = v.cursor.x * 100 + '%';
      c.style.top = v.cursor.y * 100 + '%';
    } else show(c, false);
  }
  // Klick ins Bild → kleinsten erlaubten Knopf an dieser Stelle finden (Geheimnis-Felder nie)
  function pointOf(e) {
    var img = $('shot');
    var b = img.getBoundingClientRect();
    return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
  }
  $('shot').addEventListener('click', function (e) {
    if (drawMode || !canControl || !lastView) return;
    var p = pointOf(e);
    var hit = (lastView.fields || [])
      .filter(function (f) { return f.rect && !f.secret && p.x >= f.rect.x && p.x <= f.rect.x + f.rect.w && p.y >= f.rect.y && p.y <= f.rect.y + f.rect.h; })
      .sort(function (a, b) { return a.rect.w * a.rect.h - b.rect.w * b.rect.h; })[0];
    if (!hit) { $('shothint').textContent = 'Dort ist kein Knopf, den du drücken darfst.'; return; }
    $('shothint').textContent = 'Klick auf: ' + (hit.label || '(Knopf)');
    call('/act', { action: { type: 'click', target: hit.id } });
  });
  // Eigene Maus dem Nutzer zeigen (höchstens 5× pro Sekunde)
  var lastMove = 0;
  $('shot').addEventListener('mousemove', function (e) {
    if (stroke) {
      var q = pointOf(e);
      var last = stroke[stroke.length - 1];
      if (!last || Math.abs(q.x - last[0]) + Math.abs(q.y - last[1]) > 0.004) stroke.push([clamp(q.x), clamp(q.y)]);
      drawLocal(stroke, true);
      return;
    }
    if (drawMode || !canControl || Date.now() - lastMove < 200) return;
    lastMove = Date.now();
    var p = pointOf(e);
    call('/act', { action: { type: 'cursor', x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) } });
  });

  // ---- #160: Werkzeuge: Einstellungen öffnen, Zeichnen, Chat ----
  function clamp(n) { return Math.min(1, Math.max(0, n)); }
  $('opensettings').onclick = function () {
    call('/act', { action: { type: 'open-settings' } }).then(function (r) { $('shothint').textContent = r && r.rejected ? r.rejected : '⚙️ Einstellungen werden beim Nutzer geöffnet …'; });
  };
  var drawMode = false;
  var stroke = null;
  $('drawmode').onclick = function () {
    drawMode = !drawMode;
    $('drawmode').classList.toggle('on', drawMode);
    $('shotwrap').classList.toggle('drawing', drawMode);
    $('shothint').textContent = drawMode ? '✏️ Zeichnen an: mit gedrückter Maus aufs Bild malen – der Nutzer sieht es in seiner App.' : '';
  };
  $('drawclear').onclick = function () {
    $('shotdraw').textContent = '';
    call('/act', { action: { type: 'clear-draw' } });
  };
  function drawLocal(points, live) {
    var svg = $('shotdraw');
    var line = live && svg.lastChild && svg.lastChild.getAttribute('data-live') ? svg.lastChild : document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    if (live) line.setAttribute('data-live', '1');
    line.setAttribute('points', points.map(function (p) { return p[0] * 1000 + ',' + p[1] * 1000; }).join(' '));
    if (!line.parentNode) svg.appendChild(line);
    return line;
  }
  $('shot').addEventListener('mousedown', function (e) {
    if (!drawMode || !canControl) return;
    e.preventDefault();
    var p = pointOf(e);
    stroke = [[clamp(p.x), clamp(p.y)]];
  });
  window.addEventListener('mouseup', function () {
    if (!stroke) return;
    var pts = stroke;
    stroke = null;
    var line = $('shotdraw').lastChild;
    if (line) line.removeAttribute('data-live');
    if (pts.length < 2) return;
    // höchstens 200 Punkte schicken (gleichmäßig ausdünnen)
    var step = Math.ceil(pts.length / 200);
    var send = pts.filter(function (_, i) { return i % step === 0; });
    if (send.length < 2) send = [pts[0], pts[pts.length - 1]];
    call('/act', { action: { type: 'draw', points: send } });
    setTimeout(function () { if (line && line.parentNode) line.parentNode.removeChild(line); }, 15000);
  });

  // Chat: Verlauf kommt mit jeder Ansicht; Senden über /act (type: chat)
  var chatCount = -1;
  function renderChat(list) {
    if (!Array.isArray(list)) return;
    show($('hchat'), true);
    if (list.length === chatCount) return;
    chatCount = list.length;
    var box = $('hchatlog');
    box.textContent = '';
    if (!list.length) {
      var hint = document.createElement('p');
      hint.className = 'in';
      hint.textContent = 'Hier könnt ihr euch schreiben. Der Nutzer sieht deine Nachrichten in seiner App.';
      box.appendChild(hint);
    }
    list.forEach(function (m) {
      var p = document.createElement('p');
      p.className = m.from === 'helfer' ? 'out' : 'in';
      p.textContent = String(m.text || '');
      box.appendChild(p);
    });
    box.scrollTop = box.scrollHeight;
  }
  function sendChat() {
    var t = ($('hchatin').value || '').trim();
    if (!t) return;
    $('hchatin').value = '';
    call('/act', { action: { type: 'chat', text: t.slice(0, 300) } });
  }
  $('hchatsend').onclick = sendChat;

  // #161: Mausrad über dem Bild = den Bereich unter der Maus beim Nutzer scrollen
  var lastWheel = 0;
  $('shot').addEventListener('wheel', function (e) {
    if (!canControl) return;
    e.preventDefault();
    if (Date.now() - lastWheel < 120) return;
    lastWheel = Date.now();
    var p = pointOf(e);
    call('/act', { action: { type: 'scroll', dir: e.deltaY < 0 ? 'up' : 'down', x: clamp(p.x), y: clamp(p.y) } });
  }, { passive: false });
  // #160: Vollbild für den Helfer
  $('fullscreen').onclick = function () {
    var w = $('shotwrap');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (w.requestFullscreen) w.requestFullscreen().catch(function () {});
  };
  $('shot').addEventListener('load', function () {
    var img = $('shot');
    if (img.naturalWidth && img.naturalHeight) $('shotwrap').style.setProperty('--ar', String(img.naturalWidth / img.naturalHeight));
  });
  $('hchatin').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });
})();
