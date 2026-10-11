'use strict';

// Nur Entwicklung: `--screenshots=<ordner>` nimmt automatisch echte Bilder der laufenden App auf.
const fs = require('node:fs');
const path = require('node:path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(win, dir, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
  console.log(`[screenshots] ${name}.png gespeichert`);
}

const js = (win, code) => win.webContents.executeJavaScript(code, true);

// Tippt Text in ein React-kontrolliertes Textfeld (setzt Wert + feuert input-Event).
const typeInto = (selector, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  el.focus(); setter.call(el, ${JSON.stringify(text)});
  el.setSelectionRange(${text.length}, ${text.length});
  el.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

const key = (k, opts = {}) => `window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key: k, bubbles: true, ...opts })}))`;

async function runScreenshots(win, dir, { demo, stats, simulate, captureHelp = null }) {
  fs.mkdirSync(dir, { recursive: true });
  await wait(3500);
  if (!demo) {
    await shoot(win, dir, '01-setup');
    return;
  }
  // #160: Datenschutz beim ersten Start – einmal zeigen, Knopf erst nach dem Lesen aktiv, dann zustimmen
  await js(win, `localStorage.removeItem('pk.privacy.v1')`);
  win.webContents.reload();
  await wait(3000);
  const consent = await js(win, `JSON.stringify({ sichtbar: Boolean(document.querySelector('.privacy')), knopfAnfangs: document.querySelector('.privacy .btn--primary')?.disabled })`);
  await shoot(win, dir, '00-datenschutz');
  await js(win, `(() => { const b = document.querySelector('.privacy__text'); if (b) { b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); } })()`);
  await wait(300);
  const afterScroll = await js(win, `document.querySelector('.privacy .btn--primary')?.disabled`);
  await js(win, `document.querySelector('.privacy .btn--primary')?.click()`);
  await wait(1500);
  console.log(`[datenschutz] ${consent} · nach dem Lesen gesperrt: ${afterScroll} · danach sichtbar: ${await js(win, `Boolean(document.querySelector('.privacy'))`)}`);
  // Gleicher Ausgangszustand wie beim ersten Start (Aussehen, Sortierung): Auswahl früherer Läufe verwerfen
  const hadPrefs = await js(win, `(() => { const had = localStorage.getItem('pk.prefs.v1') !== null; localStorage.removeItem('pk.prefs.v1'); return had; })()`);
  if (hadPrefs) {
    win.webContents.reload();
    await wait(3500);
  }
  // Die App merkt sich den letzten Chat – für reproduzierbare Bilder immer bei #allgemein starten.
  await js(win, `[...document.querySelectorAll('.chatrow')].find(b=>b.textContent.includes('allgemein'))?.click()`);
  await wait(1200);
  await shoot(win, dir, '02-chat');
  // Bug aus Issue #1: Nachricht bearbeiten → abbrechen → Nachricht darf NICHT verschwinden (× und Esc)
  const editCheck = async (how) => {
    const info = await js(win, `(() => { const m=[...document.querySelectorAll('.msg--out')].filter(x=>x.querySelector('.msg-actions button[aria-label="Bearbeiten"]') && !x.querySelector('.poll')).at(-1); if(!m) return null; const id=m.dataset.mid; m.classList.add('show-actions'); m.querySelector('.msg-actions button[aria-label="Bearbeiten"]').click(); m.classList.remove('show-actions'); return { id, text: m.querySelector('.bubble')?.innerText.slice(0,40) }; })()`);
    if (!info) return 'keine eigene Nachricht';
    await wait(300);
    if (how === 'x') await js(win, `document.querySelector('.composer__bar--edit .icon-btn')?.click()`);
    else if (how === 'speichern') await js(win, `(() => { const el=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, el.value + ' (bearbeitet)'); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
    else await js(win, `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await wait(500);
    return js(win, `JSON.stringify({ wie: '${how}', sichtbar: Boolean(document.querySelector('[data-mid="${info.id}"] .bubble')), text: document.querySelector('[data-mid="${info.id}"] .bubble')?.innerText.slice(0,30) || null, feld: document.querySelector('.composer textarea')?.value.slice(0,20) })`);
  };
  // Entwurf im Feld darf beim Bearbeiten + Abbrechen nicht verloren gehen
  await js(win, `(() => { const el=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Mein Entwurf'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait(200);
  console.log(`[edit] ${await editCheck('x')} | ${await editCheck('esc')} | ${await editCheck('speichern')}`);
  // Text markieren → Formatierungs-Leiste (Issue #1)
  await js(win, `(() => { const el=document.querySelector('.composer textarea'); el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Das ist wichtig heute'); el.dispatchEvent(new Event('input',{bubbles:true})); const s=el.value.indexOf('wichtig'); el.setSelectionRange(s, s+7); el.dispatchEvent(new Event('select',{bubbles:true})); })()`);
  await wait(300);
  await shoot(win, dir, '33-formatieren');
  const bar = await js(win, `document.querySelectorAll('.format-bar button').length`);
  await js(win, `document.querySelector('.format-bar__btn--bold')?.click()`);
  await wait(200);
  const afterBold = await js(win, `document.querySelector('.composer textarea').value`);
  await js(win, `(() => { const el=document.querySelector('.composer textarea'); const s=el.value.indexOf('heute'); el.setSelectionRange(s, s+5); el.dispatchEvent(new KeyboardEvent('keydown',{key:'i',ctrlKey:true,bubbles:true})); })()`);
  await wait(200);
  const afterItalic = await js(win, `document.querySelector('.composer textarea').value`);
  console.log(`[format] Knöpfe: ${bar} · nach F: ${JSON.stringify(afterBold)} · nach Strg+I: ${JSON.stringify(afterItalic)}`);
  await js(win, `(() => { const el=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); el.blur(); })()`);
  // Rechtsklick-Menü + Person verwalten (Issue #1)
  await js(win, `[...document.querySelectorAll('.msg--in')].filter(x=>x.querySelector('.bubble__author')?.textContent.includes('Anna')).at(-1)?.scrollIntoView({block:'center'})`);
  await wait(400);
  const clickT = (sel, text) => js(win, `[...document.querySelectorAll('${sel}')].find(b=>b.textContent.includes('${text}'))?.click()`);
  await js(win, `(() => { const m=[...document.querySelectorAll('.msg--in')].filter(x=>x.querySelector('.bubble__author')?.textContent.includes('Anna')).at(-1); const r=m.querySelector('.bubble').getBoundingClientRect(); m.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+40,clientY:r.top+20})); })()`);
  await wait(300);
  await shoot(win, dir, '36-rechtsklick');
  const menu = await js(win, `JSON.stringify([...document.querySelectorAll('.ctx-menu__item')].map(b=>b.textContent.trim()))`);
  await clickT('.ctx-menu__item', 'verwalten');
  await wait(600);
  const roleBefore = await js(win, `[...document.querySelectorAll('.moderation__role')].find(l=>l.textContent.includes('Moderatoren'))?.querySelector('input')?.checked`);
  await js(win, `[...document.querySelectorAll('.moderation__role')].find(l=>l.textContent.includes('Moderatoren'))?.querySelector('input')?.click()`);
  await wait(500);
  await clickT('.moderation .btn', 'Timeout setzen');
  await wait(500);
  await clickT('.moderation .btn', 'Kicken');
  await wait(300);
  await shoot(win, dir, '37-person-verwalten');
  const mod = await js(win, `JSON.stringify({ rolle: [...document.querySelectorAll('.moderation__role')].find(l=>l.textContent.includes('Moderatoren'))?.querySelector('input')?.checked, timeout: Boolean(document.querySelector('.moderation__who .warn')), kickRueckfrage: Boolean(document.querySelector('.moderation__confirm')), bannenGesperrt: [...document.querySelectorAll('.moderation .btn')].find(b=>b.textContent.includes('Bannen'))?.disabled })`);
  console.log(`[moderation] Menü: ${menu} · Rolle vorher: ${roleBefore} · danach: ${mod}`);
  await clickT('.moderation__confirm .btn', 'Abbrechen');
  await js(win, `document.querySelector('.moderation .icon-btn')?.click()`);
  await wait(300);
  // Rechtsklick auf einen Chat (Issue #1): Hintergrund nur für diesen Chat, Kanal umbenennen
  const rowCtx = (name) => js(win, `(() => { const r=[...document.querySelectorAll('.chatlist__items .chatrow')].find(b=>b.querySelector('.chatrow__name')?.textContent===${JSON.stringify(name)}); const b=r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left+60,clientY:b.top+20})); })()`);
  await rowCtx('allgemein');
  await wait(300);
  const chatMenu = await js(win, `JSON.stringify([...document.querySelectorAll('.ctx-menu__item')].map(b=>b.textContent.trim()))`);
  await js(win, `[...document.querySelectorAll('.ctx-menu__item')].find(b=>b.textContent.includes('Hintergrund'))?.click()`);
  await wait(300);
  await js(win, `[...document.querySelectorAll('.wallpaper-tile')].find(b=>b.textContent.includes('Aurora'))?.click()`);
  await wait(200);
  await shoot(win, dir, '40-hintergrund-waehlen');
  await js(win, `[...document.querySelectorAll('.wallpaper-dialog .btn')].find(b=>b.textContent.includes('Übernehmen'))?.click()`);
  await wait(400);
  await shoot(win, dir, '41-hintergrund-aurora');
  const wall = await js(win, `document.querySelector('main.chat')?.dataset.wall`);
  // #131: eigenes Bild hochladen (echtes, hier erzeugtes PNG über das Datei-Feld) → als Hintergrund übernehmen
  await rowCtx('allgemein');
  await wait(300);
  await js(win, `[...document.querySelectorAll('.ctx-menu__item')].find(b=>b.textContent.includes('Hintergrund'))?.click()`);
  await wait(300);
  await js(win, `(async () => { const c=document.createElement('canvas'); c.width=1200; c.height=800; const g=c.getContext('2d'); const gr=g.createLinearGradient(0,0,1200,800); gr.addColorStop(0,'#f472b6'); gr.addColorStop(0.5,'#a78bfa'); gr.addColorStop(1,'#38bdf8'); g.fillStyle=gr; g.fillRect(0,0,1200,800); g.fillStyle='rgba(255,255,255,.35)'; for(let i=0;i<40;i++){g.beginPath(); g.arc((i*137)%1200,(i*271)%800,10+(i%7)*6,0,7); g.fill();} const blob=await new Promise(r=>c.toBlob(r,'image/png')); const dt=new DataTransfer(); dt.items.add(new File([blob],'urlaub.png',{type:'image/png'})); const inp=document.querySelector('.wallpaper-dialog input[type=file]'); inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await wait(1500);
  await shoot(win, dir, '41b-hintergrund-eigenes-bild');
  await js(win, `[...document.querySelectorAll('.wallpaper-dialog .btn')].find(b=>b.textContent.includes('Übernehmen'))?.click()`);
  await wait(500);
  await shoot(win, dir, '41c-chat-mit-eigenem-bild');
  const ownWall = await js(win, `JSON.stringify({ wall: document.querySelector('main.chat')?.dataset.wall, bild: /url\\("data:image\\/webp/.test(document.querySelector('main.chat')?.style.getPropertyValue('--wall-img') || '') })`);
  console.log(`[hintergrund-eigen] ${ownWall}`);
  // wieder löschen → zurück auf Aurora (für die weiteren Bilder)
  await rowCtx('allgemein');
  await wait(300);
  await js(win, `[...document.querySelectorAll('.ctx-menu__item')].find(b=>b.textContent.includes('Hintergrund'))?.click()`);
  await wait(300);
  await js(win, `document.querySelector('.wallpaper-tile__del')?.click()`);
  await wait(300);
  await js(win, `[...document.querySelectorAll('.wallpaper-tile')].find(b=>b.textContent.includes('Aurora'))?.click()`);
  await js(win, `[...document.querySelectorAll('.wallpaper-dialog .btn')].find(b=>b.textContent.includes('Übernehmen'))?.click()`);
  await wait(300);
  await rowCtx('projekt-a');
  await wait(300);
  const manageMenu = await js(win, `[...document.querySelectorAll('.ctx-menu__item')].map(b=>b.textContent.trim()).filter(t=>/Umbenennen|verschieben/.test(t)).length`);
  await js(win, `[...document.querySelectorAll('.ctx-menu__item')].find(b=>b.textContent.includes('Umbenennen'))?.click()`);
  await wait(300);
  await js(win, `(() => { const el=document.querySelector('#name-dialog-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'projekt-alpha'); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  await wait(1200);
  const renamed = await js(win, `[...document.querySelectorAll('.chatlist__items .chatrow__name')].some(e=>e.textContent==='projekt-alpha')`);
  console.log(`[chat-rechtsklick] Menü: ${chatMenu} · Hintergrund: ${wall} · Verwalten-Einträge bei #projekt-a: ${manageMenu} · umbenannt: ${renamed}`);
  await js(win, `[...document.querySelectorAll('.chatrow')].find(b=>b.textContent.includes('allgemein'))?.click()`);
  await wait(400);
  // Medien + Link-Warnung (Issue #1): GIF erst nach Rückfrage, Links mit Warnung, „Hier aktivieren“ springt in die Einstellungen
  {
    const openChat = (name) => js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].find(b=>b.querySelector('.chatrow__name')?.textContent===${JSON.stringify(name)})?.click()`);
    await openChat('ankuendigungen');
    await wait(800);
    const gate = await js(win, `document.querySelector('.media-off')?.textContent.trim().slice(0,60) || null`);
    await shoot(win, dir, '45-medien-gesperrt');
    await js(win, `[...document.querySelectorAll('.media-off .btn')].find(b=>b.textContent.includes('Anzeigen'))?.click()`);
    await wait(300);
    await shoot(win, dir, '46-medien-rueckfrage');
    await js(win, `[...document.querySelectorAll('.modal .btn')].find(b=>b.textContent.includes('Nur dieses'))?.click()`);
    await wait(500);
    const video = await js(win, `JSON.stringify({ video: Boolean(document.querySelector('video.embed__image')), src: document.querySelector('video.embed__image')?.getAttribute('src')?.slice(0,45) || null })`);
    await js(win, `[...document.querySelectorAll('.bubble a')].find(l=>l.textContent.includes('beispiel-shop'))?.click()`);
    await wait(300);
    await shoot(win, dir, '47-link-warnung');
    const warn = await js(win, `document.querySelector('.link-warn')?.textContent.replace(/\\s+/g,' ').slice(0,90) || null`);
    await js(win, `[...document.querySelectorAll('.link-warn .btn')].find(b=>b.textContent.includes('Abbrechen'))?.click()`);
    await wait(200);
    // Medien „nie“ → Hinweis „Hier aktivieren“ → Einstellungen öffnen sich an der richtigen Stelle
    await js(win, `(() => { const p=JSON.parse(localStorage.getItem('pk.prefs.v1')||'{}'); p.media='nie'; localStorage.setItem('pk.prefs.v1', JSON.stringify(p)); })()`);
    await openChat('allgemein');
    await wait(300);
    await js(win, `window.dispatchEvent(new CustomEvent('pk:open-settings', { detail: { focus: 'media' } }))`);
    await wait(200);
    await js(win, `(() => { const el=document.querySelector('#set-media'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'nie'); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
    await wait(300);
    await openChat('ankuendigungen');
    await wait(600);
    const off = await js(win, `document.querySelector('.media-off__note')?.textContent.trim() || null`);
    await js(win, `[...document.querySelectorAll('.media-off__note .linklike')][0]?.click()`);
    await wait(900);
    await shoot(win, dir, '48-hier-aktivieren');
    const focused = await js(win, `Boolean(document.querySelector('.settings [data-setting="media"].is-focus'))`);
    await js(win, `(() => { const el=document.querySelector('#set-media'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,'fragen'); el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
    await wait(300);
    console.log(`[medien] gesperrt: ${gate} · nach „Nur dieses“: ${video} · Link-Warnung: ${warn} · aus: ${off} · Einstellung angesprungen: ${focused}`);
    // Schnellbefehle (Issue #29): „/ping“ → Rückfrage statt still senden; „/mü“ + Enter → Münze sofort
    await openChat('allgemein');
    await wait(500);
    await js(win, typeInto('.composer textarea', '/ping'));
    await wait(200);
    await js(win, `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await wait(300);
    await shoot(win, dir, '49-unbekannter-befehl');
    const unknown = await js(win, `document.querySelector('.modal h3')?.textContent || null`);
    await js(win, `[...document.querySelectorAll('.modal .btn')].find(b=>b.textContent.includes('Abbrechen'))?.click()`);
    await wait(200);
    const sentBefore = await js(win, `document.querySelectorAll('.msg--out').length`);
    await js(win, typeInto('.composer textarea', '/mü'));
    await wait(300);
    await js(win, `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await wait(900);
    const coin = await js(win, `JSON.stringify({ neu: document.querySelectorAll('.msg--out').length - ${sentBefore}, text: [...document.querySelectorAll('.msg--out')].at(-1)?.textContent.slice(0,30) || null, feld: document.querySelector('.composer textarea')?.value })`);
    console.log(`[befehle] /ping: ${unknown} · /mü + Enter: ${coin}`);
  }
  // Profile + unscharfe Suche + @ im Privatchat (Issue #1)
  {
    const openChat = (name) => js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].find(b=>b.querySelector('.chatrow__name')?.textContent===${JSON.stringify(name)})?.click()`);
    await openChat('allgemein');
    await wait(500);
    await js(win, `[...document.querySelectorAll('.bubble__author-btn')].find(b=>b.textContent.includes('Anna'))?.click()`);
    await wait(700);
    await shoot(win, dir, '50-profil');
    const profile = await js(win, `JSON.stringify({ name: document.querySelector('.profile-card__name')?.textContent.trim() || null, knoepfe: [...document.querySelectorAll('.profile-card__actions .btn')].map(b=>b.textContent.trim()) })`);
    await js(win, `[...document.querySelectorAll('.profile-card__actions .btn')].find(b=>b.textContent.includes('Erwähnen'))?.click()`);
    await wait(300);
    const field = await js(win, `document.querySelector('.composer textarea')?.value || null`);
    await js(win, typeInto('.composer textarea', ''));
    console.log(`[profil] ${profile} · nach „Erwähnen“ im Feld: ${field}`);
    // Schnellsuche mit Tippfehler: „allgmein“ findet #allgemein
    await js(win, key('k', { ctrlKey: true }));
    await wait(300);
    await js(win, `(() => { const el=document.querySelector('.quick__input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'allgmein'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(300);
    const quick = await js(win, `[...document.querySelectorAll('.quick__item, .quick li, .quick button')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,3).join(' | ') || null`);
    await js(win, `document.querySelector('.quick__input')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await wait(200);
    // Privatchat: @ schlägt Personen von allen Servern vor
    await js(win, `document.querySelector('.rail__dm')?.click()`);
    await wait(700);
    await js(win, `document.querySelector('.chatlist__items .chatrow')?.click()`);
    await wait(700);
    await js(win, typeInto('.composer textarea', '@bnd'));
    await wait(700);
    await shoot(win, dir, '51-at-im-privatchat');
    const dmAt = await js(win, `[...document.querySelectorAll('.suggest__item, .suggest li, .suggest button')].map(b=>b.textContent.trim()).slice(0,4).join(' | ') || null`);
    await js(win, typeInto('.composer textarea', ''));
    console.log(`[suche] Strg+K „allgmein“: ${quick} · Privatchat „@bnd“: ${dmAt}`);
    await js(win, `document.querySelector('.rail__item:not(.rail__dm):not(.rail__add)')?.click()`);
    await wait(500);
    await openChat('allgemein');
    await wait(400);
  }
  // Tour (Issue #1): Spotlight, Mitmachen (Chat anklicken, „/“ tippen), Fortschritt gespeichert
  {
    const card = () => js(win, `document.querySelector('.tour__card h3')?.textContent || null`);
    const next = () => js(win, `[...document.querySelectorAll('.tour__card .btn')].find(b=>b.classList.contains('btn--primary'))?.click()`);
    await js(win, `window.dispatchEvent(new CustomEvent('pk:start-tour'))`);
    await wait(500);
    const t1 = await card();
    await next();
    await wait(400);
    await shoot(win, dir, '55-tour-server');
    await next();
    await wait(400);
    const t3 = await card();
    await shoot(win, dir, '56-tour-chats');
    // Mitmachen: Chat anklicken → Tour geht von selbst weiter
    await js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].find(b=>b.textContent.includes('allgemein'))?.click()`);
    await wait(1400);
    const t4 = await card(); // „Rechtsklick auf einen Chat“ (Mitmachen)
    // Echter Rechtsklick → Menü geht auf und muss im Licht liegen (Issue #35)
    await js(win, `(() => { const r=document.querySelector('.chatlist__items .chatrow'); const b=r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:b.left+80,clientY:b.top+30})); })()`);
    await wait(1300);
    const t4b = await card();
    await shoot(win, dir, '56b-tour-rechtsklick-menue');
    const menuLit = await js(win, `(() => { const m=document.querySelector('.ctx-menu')?.getBoundingClientRect(); const r=document.querySelector('.tour__ring')?.getBoundingClientRect(); return Boolean(m && r && m.left>=r.left-1 && m.right<=r.right+1 && m.top>=r.top-1 && m.bottom<=r.bottom+1); })()`);
    console.log(`[tour-menue] nach Rechtsklick: ${t4b} · Menü im Licht: ${menuLit}`);
    await next(); // „Das kurze Menü“ → „Oben in der Liste“
    await wait(300);
    await next(); // → „Schreiben“
    await wait(400);
    await js(win, typeInto('.composer textarea', '/'));
    await wait(300);
    await shoot(win, dir, '57-tour-mitmachen');
    await wait(1100);
    const t5 = await card(); // „Die Knöpfe unten“
    await js(win, typeInto('.composer textarea', ''));
    await wait(300);
    await shoot(win, dir, '57b-tour-knoepfe-unten');
    await js(win, typeInto('.composer textarea', ''));
    await js(win, `[...document.querySelectorAll('.tour__card .btn')].find(b=>b.textContent.includes('überspringen'))?.click()`);
    await wait(300);
    const saved = await js(win, `localStorage.getItem('pk.tour.v1')`);
    console.log(`[tour] ${t1} → ${t3} → nach Klick: ${t4} → nach „/“: ${t5} · gespeichert: ${saved?.slice(0,40)} · Overlay weg: ${await js(win, `!document.querySelector('.tour')`)}`);
    // Einstellungen: Navigation + Suche
    await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
    await wait(500);
    await shoot(win, dir, '58-einstellungen-neu');
    await js(win, `(() => { const el=document.querySelector('.settings__search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'passwrt'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(300);
    const found = await js(win, `[...document.querySelectorAll('.settings__navitem')].map(b=>b.textContent.trim()).join(', ')`);
    await shoot(win, dir, '59-einstellungen-suche');
    await js(win, `(() => { const el=document.querySelector('.settings__search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(200);
    const hints = await js(win, `[...document.querySelectorAll('button[aria-label]')].filter(b=>!b.title).length`);
    await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
    await wait(300);
    console.log(`[einstellungen] Suche „passwrt“: ${found} · Knöpfe ohne Hinweis: ${hints}`);
  }
  // Tippanzeige (Issue #1): mehrere tippen in #allgemein, während ein anderer Chat offen ist
  {
    await js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].find(b=>b.textContent.includes('ankuendigungen'))?.click()`);
    await wait(500);
    simulate?.typingAll?.();
    await wait(500);
    const row = await js(win, `[...document.querySelectorAll('.chatrow__preview.is-typing')].map(e=>e.textContent.trim()).join(' | ') || null`);
    await shoot(win, dir, '68-tippen-in-der-liste');
    console.log(`[tippen] Chatliste: ${row}`);
  }
  // #38: IP-Grabber erkannt → gesperrt + Warnung; „für mich ausblenden“
  {
    await js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].find(b=>b.querySelector('.chatrow__name')?.textContent==='ankuendigungen')?.click()`);
    await wait(700);
    await js(win, `document.querySelector('.link-alarm')?.scrollIntoView({block:'center'})`);
    await wait(300);
    await shoot(win, dir, '63-ip-grabber-erkannt');
    const alarm = await js(win, `JSON.stringify({ alarm: document.querySelector('.link-alarm b')?.textContent || null, gesperrt: document.querySelector('.link-danger')?.textContent || null, klickbar: [...document.querySelectorAll('.bubble a')].some(a=>a.href.includes('grabify')) })`);
    await js(win, `[...document.querySelectorAll('.link-alarm .btn')].find(b=>b.textContent.includes('ausblenden'))?.click()`);
    await wait(300);
    const hidden = await js(win, `document.querySelector('.msg-hidden')?.textContent.trim().slice(0,60) || null`);
    await js(win, `[...document.querySelectorAll('.msg-hidden .linklike')][0]?.click()`);
    await wait(200);
    console.log(`[link-schutz] ${alarm} · ausgeblendet: ${hidden}`);
  }
  // #35: fremder Spoiler → Rückfrage; Vorschau verdeckt; Einstellungen „nur dieser Bereich“; @Name getippt → Erwähnung
  {
    const openChat = (name) => js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].find(b=>b.querySelector('.chatrow__name')?.textContent===${JSON.stringify(name)})?.click()`);
    await openChat('ankuendigungen');
    await wait(700);
    const preview = await js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].map(r=>r.textContent).find(t=>t.includes('Film')) || null`);
    await js(win, `document.querySelector('.spoiler:not(.is-open)')?.click()`);
    await wait(300);
    await shoot(win, dir, '61-spoiler-rueckfrage');
    const ask = await js(win, `document.querySelector('.spoiler-ask h3')?.textContent || null`);
    await js(win, `[...document.querySelectorAll('.spoiler-ask .btn')].find(b=>b.textContent.includes('Aufdecken'))?.click()`);
    await wait(200);
    const opened = await js(win, `Boolean(document.querySelector('.spoiler.is-open'))`);
    console.log(`[spoiler] Vorschau: ${preview?.slice(0,60)} · Rückfrage: ${ask} · aufgedeckt: ${opened}`);
    await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
    await wait(500);
    await js(win, `document.querySelector('.settings__nav [data-nav="datenschutz"]')?.click()`);
    await wait(300);
    await shoot(win, dir, '62-einstellungen-nur-bereich');
    const only = await js(win, `[...document.querySelectorAll('.settings__body section')].map(s=>s.dataset.section).join(',')`);
    await js(win, `document.querySelector('.settings__nav [data-nav="alle"]')?.click()`);
    await wait(200);
    const all = await js(win, `document.querySelectorAll('.settings__body section').length`);
    await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
    await wait(300);
    await openChat('allgemein');
    await wait(500);
    await js(win, typeInto('.composer textarea', '@ann'));
    await wait(700);
    await js(win, typeInto('.composer textarea', '@ann' + 'a '));
    await wait(300);
    const typed = await js(win, `document.querySelector('.composer textarea')?.value`);
    await js(win, typeInto('.composer textarea', ''));
    console.log(`[einstellungen-filter] nur: ${only} · alle: ${all} · @anna getippt → „${typed}“`);
    // Hilfe & Tour: Einrichtungs-Check + „Ups …“-Fehlerbericht (Issue #1)
    await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
    await wait(500);
    await js(win, `document.querySelector('.settings__nav [data-nav="hilfe"]')?.click()`);
    await wait(800);
    await shoot(win, dir, '66-einrichtungs-check');
    const check = await js(win, `[...document.querySelectorAll('.setup-check__item')].map(i=>i.textContent.trim().slice(0,40)).join(' | ')`);
    await js(win, `[...document.querySelectorAll('.settings .btn')].find(b=>b.textContent.includes('Fehlerbericht erstellen'))?.click()`);
    await wait(700);
    await js(win, `[...document.querySelectorAll('.oops .btn')].find(b=>b.textContent.includes('Kopieren'))?.click()`);
    await wait(300);
    await shoot(win, dir, '65-ups-fehlerbericht');
    const oops = await js(win, `JSON.stringify({ titel: document.querySelector('.oops h3')?.textContent || null, bericht: document.querySelector('.oops__report')?.value.split(String.fromCharCode(10))[0] || null, githubAktiv: ![...document.querySelectorAll('.oops .btn')].find(b=>b.textContent.includes('GitHub'))?.disabled })`);
    await js(win, `[...document.querySelectorAll('.oops .btn')].find(b=>b.textContent.includes('Schließen'))?.click()`);
    await js(win, `document.querySelector('.settings__nav [data-nav="alle"]')?.click()`);
    await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
    await wait(300);
    console.log(`[hilfe] Check: ${check} · Ups: ${oops}`);
    // Fernzugang im WLAN (#46/#50): Passwort, einschalten, QR, „Handy“ koppelt sich, Bestätigung am PC, Nachricht senden
    {
      const nacl = require('tweetnacl');
      const seal = (obj, key) => {
        const n = nacl.randomBytes(24);
        return { n: Buffer.from(n).toString('base64'), c: Buffer.from(nacl.secretbox(Buffer.from(JSON.stringify(obj)), n, key)).toString('base64') };
      };
      const unseal = (m, key) => {
        const p = m?.n ? nacl.secretbox.open(new Uint8Array(Buffer.from(m.c, 'base64')), new Uint8Array(Buffer.from(m.n, 'base64')), key) : null;
        return p ? JSON.parse(Buffer.from(p).toString()) : m;
      };
      const post = async (u, body) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      const setIn = (sel, v) => js(win, `(() => { const el=document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
      await wait(500);
      await js(win, `document.querySelector('.settings__nav [data-nav="support"]')?.click()`);
      await wait(400);
      await js(win, `(() => { const d = document.querySelector('[data-setting="support-remote"]'); if (d) d.open = true; })()`); // #120: eingeklappt
      await wait(200);
      await setIn('input[aria-label="Neues Fernzugangs-Passwort"]', 'demo-passwort-123');
      await setIn('input[aria-label="Fernzugangs-Passwort wiederholen"]', 'demo-passwort-123');
      await js(win, `[...document.querySelectorAll('.remote .btn')].find(b=>b.textContent.includes('Passwort festlegen'))?.click()`);
      await wait(600);
      await js(win, `[...document.querySelectorAll('.remote label.composer__ping')].find(l=>l.textContent.includes('einschalten'))?.querySelector('input')?.click()`);
      await wait(800);
      await js(win, `[...document.querySelectorAll('.remote .btn')].find(b=>b.textContent.includes('Gerät hinzufügen'))?.click()`);
      await wait(800);
      await js(win, `document.querySelector('.remote__pair')?.scrollIntoView({block:'center'})`);
      await wait(300);
      await shoot(win, dir, '73-fernzugang-qr');
      // Link wie ein Nutzer über „Link kopieren“ holen (er steht absichtlich nicht als Text in der App)
      await js(win, `[...document.querySelectorAll('.remote__pair .btn')].find(b=>b.textContent.includes('Link kopieren'))?.click()`);
      let url = '';
      for (let i = 0; i < 10 && !/^https?:/.test(url); i++) {
        await wait(200);
        url = String(await require('electron').clipboard.readText());
      }
      if (!/^https?:/.test(url)) {
        console.log(`[fernzugang] Zwischenablage: ${String(url).slice(0, 60)} · QR da: ${await js(win, `Boolean(document.querySelector('.remote__pair'))`)} · Knöpfe: ${await js(win, `[...document.querySelectorAll('.remote__pair .btn')].map(b=>b.textContent).join('|')`)}`);
        url = '';
      }
      const pageText = await js(win, `document.querySelector('.settings')?.textContent || ''`);
      let result = { url: Boolean(url) };
      result.ipSichtbar = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(pageText);
      result.linkHost = url ? new URL(url).hostname : null;
      if (url) {
        const h = new URLSearchParams(new URL(url).hash.slice(1));
        const key = new Uint8Array(Buffer.from(h.get('k'), 'base64url'));
        const base = url.split('#')[0];
        // Web-Oberfläche erreichbar?
        result.web = (await fetch(base)).status;
        const pairing = post(`${base}api/pair`, { p: h.get('p'), ...seal({ password: 'demo-passwort-123', name: 'Annas Handy', t: Date.now() }, key) });
        await wait(900);
        await shoot(win, dir, '74-fernzugang-bestaetigen');
        result.frage = await js(win, `document.querySelector('[aria-label="Fernzugang bestätigen"] h3')?.textContent || null`);
        await js(win, `[...document.querySelectorAll('[aria-label="Fernzugang bestätigen"] .btn')].find(b=>b.textContent.includes('Zulassen'))?.click()`);
        const dev = unseal(await pairing, key);
        result.gekoppelt = Boolean(dev.deviceId);
        if (dev.deviceId) {
          const dk = new Uint8Array(Buffer.from(dev.deviceKey, 'base64'));
          const call = async (op, args, session) => unseal(await post(`${base}api`, { d: dev.deviceId, ...seal({ op, args, session, t: Date.now() }, dk) }), dk);
          const login = await call('login', { password: 'demo-passwort-123' });
          const guilds = await call('guilds', null, login.session);
          const groups = await call('channels', { guildId: guilds.data[0].id }, login.session);
          const ch = groups.data.flatMap((g) => g.channels).find((c) => c.name === 'allgemein');
          const sent = await call('send', { channelId: ch.id, content: 'Hallo vom Handy 📱' }, login.session);
          result.gesendet = sent.data?.content || sent.error;
          await wait(800);
          await shoot(win, dir, '75-fernzugang-aktivitaet');
          result.protokoll = await js(win, `[...document.querySelectorAll('.remote__log div')].slice(0,3).map(d=>d.textContent.replace(/^[^·]+· /,'')).join(' | ')`);
        }
      }
      // Handy-Oberfläche im echten Browserfenster (Handygröße) – lädt sie fehlerfrei?
      try {
        const { BrowserWindow } = require('electron');
        const phone = new BrowserWindow({ width: 400, height: 760, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        const errs = [];
        phone.webContents.on('console-message', (e) => e.level === 'error' && errs.push(e.message));
        await phone.loadURL(url);
        await wait(800);
        const img = await phone.webContents.capturePage();
        require('fs').writeFileSync(require('path').join(dir, '76-fernzugang-handy.png'), img.toPNG());
        result.handySeite = await phone.webContents.executeJavaScript(`document.querySelector('#pair:not(.hidden) h2, #nodevice:not(.hidden) h2')?.textContent || null`);
        result.handyFehler = errs.length;
        phone.destroy();
      } catch (e) {
        result.handyFehler = String(e.message);
      }
      console.log(`[fernzugang] ${JSON.stringify(result)}`);
      await js(win, `[...document.querySelectorAll('.remote label.composer__ping')].find(l=>l.textContent.includes('einschalten'))?.querySelector('input')?.click()`);
      await wait(400);
      await js(win, `document.querySelector('.settings__nav [data-nav="alle"]')?.click()`);
      await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
      await wait(300);
    }
    // „Das ist neu“ nach einem Update (#44)
    await js(win, `window.dispatchEvent(new CustomEvent('pk:whats-new', { detail: { since: '0.0.1' } }))`);
    await wait(1200);
    await shoot(win, dir, '72-das-ist-neu');
    console.log(`[das-ist-neu] ${await js(win, `JSON.stringify({ titel: document.querySelector('.whats-new h3')?.textContent || null, versionen: document.querySelectorAll('.whats-new__list > div').length, punkte: document.querySelectorAll('.whats-new__list li').length })`)}`);
    await js(win, `[...document.querySelectorAll('.whats-new .btn')].find(b=>b.textContent.includes('weiter'))?.click()`);
    await wait(300);
    // Einrichtungs-Assistent (#38)
    await js(win, `window.dispatchEvent(new CustomEvent('pk:setup-wizard'))`);
    await wait(1500);
    await shoot(win, dir, '71-einrichtungs-assistent');
    console.log(`[assistent] ${await js(win, `JSON.stringify({ schritte: document.querySelectorAll('.wizard__step').length, erledigt: document.querySelectorAll('.wizard__step.is-done').length, jetzt: document.querySelector('.wizard__now')?.closest('.wizard__step')?.querySelector('.wizard__head span:nth-child(2)')?.textContent || null })`)}`);
    await js(win, `document.querySelector('.wizard-modal .icon-btn')?.click()`);
    await wait(300);
    // Online-Status (Issue #1): im Demo ist „Presence Intent“ aus → verständliche Ablehnung statt Verbindungsabbruch
    await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
    await wait(500);
    await js(win, `document.querySelector('.settings__nav [data-nav="datenschutz"]')?.click()`);
    await wait(300);
    await js(win, `document.querySelector('[data-setting="presence"] input')?.click()`);
    await wait(800);
    await js(win, `document.querySelector('[data-setting="presence"]')?.scrollIntoView({block:'center'})`);
    await wait(200);
    await shoot(win, dir, '67-online-status-pruefung');
    await js(win, `document.querySelector('[data-setting="blocklist"]')?.scrollIntoView({block:'center'})`);
    await wait(300);
    await shoot(win, dir, '69-sperrlisten');
    console.log(`[sperrlisten] ${await js(win, `document.querySelector('[data-setting="blocklist"] p')?.textContent || null`)}`);
    const pres = await js(win, `JSON.stringify({ an: document.querySelector('[data-setting="presence"] input')?.checked, hinweis: document.querySelector('[data-setting="presence"] .warn')?.textContent.slice(0,70) || null, verbunden: document.querySelector('.me__status, .chatlist__me')?.textContent.includes('Verbunden') ?? null })`);
    await js(win, `document.querySelector('.settings__nav [data-nav="alle"]')?.click()`);
    await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
    await wait(300);
    console.log(`[online-status] ${pres}`);
  }
  // Smileys (Issue #1: „mehr Smileys“): 😀 im Eingabefeld, suchen, einfügen; ➕ bei Reaktionen
  await js(win, `document.querySelector('.tool-btn[aria-label="Smileys"]')?.click()`);
  await wait(300);
  const tabs = await js(win, `document.querySelectorAll('.emoji-panel__tabs button').length`);
  await js(win, `(() => { const el=document.querySelector('.emoji-panel__search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'herz'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait(200);
  await shoot(win, dir, '39-smileys');
  const emojiHits = await js(win, `document.querySelectorAll('.emoji-panel__item').length`);
  await js(win, `document.querySelector('.emoji-panel__item')?.click()`);
  await wait(200);
  const inserted = await js(win, `document.querySelector('.composer textarea').value`);
  await js(win, `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));`);
  await js(win, `(() => { const el=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  console.log(`[smileys] Kategorien: ${tabs} · Treffer „herz“: ${emojiHits} · eingefügt: ${JSON.stringify(inserted)}`);
  // Schnellbefehle (Issue #1: „es funktionieren keine Befehle“)
  const typeCmd = (t) => js(win, `(() => { const el=document.querySelector('.composer textarea'); el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(t)}); el.setSelectionRange(${t.length},${t.length}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const enter = () => js(win, `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await wait(400); // verzögertes Schließen vom vorigen Schritt abwarten
  await typeCmd('/');
  await wait(300);
  await shoot(win, dir, '34-befehle');
  const list = await js(win, `JSON.stringify({ titel: document.querySelector('.suggest__title')?.textContent, anzahl: document.querySelectorAll('.suggest__item').length })`);
  await js(win, `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await typeCmd('/shrug na gut');
  await enter();
  await wait(700);
  await typeCmd('/spoiler Das Ende');
  await enter();
  await wait(700);
  await typeCmd('/zitat Gute Idee!');
  await enter();
  await wait(900);
  const shown = await js(win, `JSON.stringify({ shrug: [...document.querySelectorAll('.msg--out .msg__content')].some(e=>e.innerText.includes('na gut ¯\\\\_(ツ)_/¯')), spoiler: Boolean(document.querySelector('.msg--out .spoiler')), zitat: Boolean(document.querySelector('.msg--out .mdquote')) })`);
  console.log(`[befehle] Liste: ${list} · angezeigt: ${shown}`);
  const sys = await js(win, `JSON.stringify([...document.querySelectorAll('.sysmsg')].map(e=>e.textContent.slice(0,60)))`);
  console.log(`[system] Systemnachrichten: ${sys}`);
  await js(win, `document.querySelector('.sysmsg')?.scrollIntoView({block:'center'})`);
  await wait(400);
  await shoot(win, dir, '02b-systemnachricht');
  const sysStyle = await js(win, `(() => { const e=document.querySelector('.msg--system'); return e ? getComputedStyle(e).justifyContent : null; })()`);
  console.log(`[system] Ausrichtung: ${sysStyle}`);
  await js(win, `document.querySelector('.msglist .msg:last-child')?.scrollIntoView()`);
  await js(win, typeInto('.composer textarea', 'Hey @an'));
  await wait(900);
  await shoot(win, dir, '03-mention-autocomplete');
  await js(win, typeInto('.composer textarea', ''));
  await js(win, key('k', { ctrlKey: true }));
  await wait(500);
  await shoot(win, dir, '04-schnellsuche');
  await js(win, key('Escape'));
  await js(win, `document.querySelector('.quick__input')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await wait(300);
  await js(win, typeInto('.composer textarea', '@everyone Server-Wartung um 22 Uhr!'));
  await js(win, `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await wait(500);
  await shoot(win, dir, '05-everyone-bestaetigung');
  await js(win, `[...document.querySelectorAll('.confirm .btn')].find(b=>b.textContent.includes('Abbrechen'))?.click()`);
  await js(win, typeInto('.composer textarea', ''));
  await js(win, key('f', { ctrlKey: true }));
  await wait(300);
  await js(win, `(() => { const el = document.querySelector('.search-panel input'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(el,'repo'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait(400);
  await shoot(win, dir, '06-suche');
  await js(win, `document.querySelector('.search-panel .icon-btn')?.click()`);
  // Kanal mit 260+ Nachrichten → virtualisierte Liste
  await js(win, `[...document.querySelectorAll('.chatrow')].find(b=>b.textContent.includes('projekt-a'))?.click()`);
  await wait(1500);
  await shoot(win, dir, '07-virtualisiert');
  await js(win, `[...document.querySelectorAll('.chatrow')].find(b=>b.textContent.includes('nur-lesen'))?.click()`);
  await wait(1000);
  await shoot(win, dir, '08-nur-lesen');
  await js(win, `[...document.querySelectorAll('.chatrow')].find(b=>b.textContent.includes('allgemein'))?.click()`);
  await wait(800);
  await js(win, typeInto('.composer textarea', 'Hallo aus PKMessenger 👋'));
  await js(win, `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await wait(800);
  await shoot(win, dir, '09-gesendet');

  // ---- Sprachkanal (F17) inkl. End-to-End-Tontest mit SIMULIERTEM Mikrofon ----
  await js(win, `[...document.querySelectorAll('.chatrow')].find(b=>b.textContent.includes('Lounge'))?.click()`);
  await wait(800);
  await shoot(win, dir, '10-sprachkanal');
  await js(win, `document.querySelector('.call-btn--join')?.click()`);
  await wait(1500);
  await js(win, `[...document.querySelectorAll('.call-btn')].find(b=>b.textContent.includes('Mikro'))?.click()`);
  await wait(3000);
  await shoot(win, dir, '11-im-anruf');
  const r = await js(win, 'JSON.stringify(window.__pkVoiceStats || {})');
  console.log(`[voice-e2e] Renderer: ${r} | Main: ${JSON.stringify(stats || {})}`);
  // Issue #1: Teilnehmer nur für mich stumm (gegen Doppelt-Hören) → seine Pakete werden übersprungen
  const ctrls = await js(win, `document.querySelectorAll('.tile__ctrl').length`);
  await js(win, `[...document.querySelectorAll('.tile')].find(t=>t.textContent.includes('Anna'))?.querySelector('.tile__mute')?.click()`);
  const skipBefore = await js(win, '(window.__pkVoiceStats||{}).skippedMuted||0');
  await wait(1500);
  const skipAfter = await js(win, '(window.__pkVoiceStats||{}).skippedMuted||0');
  await shoot(win, dir, '11b-teilnehmer-stumm');
  console.log(`[voice-fx] Regler: ${ctrls} · Anna stumm → übersprungene Pakete: +${skipAfter - skipBefore} · Gate-Stille: ${await js(win, '(window.__pkVoiceStats||{}).gated||0')}`);
  await js(win, `[...document.querySelectorAll('.tile')].find(t=>t.textContent.includes('Anna'))?.querySelector('.tile__mute')?.click()`);
  await js(win, `document.querySelector('.call-btn--hangup')?.click()`);
  await wait(500);
  const after = await js(win, `document.querySelector('.callbar') ? 'Anrufleiste noch da' : 'aufgelegt'`);
  console.log(`[voice-e2e] Nach Auflegen: ${after}`);

  // ---- Issue #1: Aktualisieren, gesperrte Kanäle, Einstellungen ----
  await js(win, `[...document.querySelectorAll('.chatrow')].find(b=>b.textContent.includes('allgemein'))?.click()`);
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Aktualisieren"]')?.click()`);
  await wait(1200);
  const toastText = await js(win, `[...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' | ')`);
  console.log(`[issue1] Nach Aktualisieren: ${toastText || '(kein Hinweis)'}`);
  await js(win, `document.querySelector('.access-hint')?.click()`);
  await wait(500);
  await shoot(win, dir, '12-kanalzugriff');
  await js(win, `[...document.querySelectorAll('.access .btn')].find(b=>b.textContent.includes('Schließen'))?.click()`);
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(700);
  await shoot(win, dir, '13-einstellungen');
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);

  // ---- Server beitreten (Vorschau; "In Discord beitreten" wird im Test NICHT geklickt) ----
  await js(win, `document.querySelector('.rail__add[aria-label="Server beitreten"]')?.click()`);
  await wait(400);
  await js(win, `(() => { const el = document.querySelector('#invite-input'); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; s.call(el,'https://discord.gg/moinclub'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await js(win, `[...document.querySelectorAll('.join .btn')].find(b=>b.textContent.includes('Vorschau'))?.click()`);
  await wait(800);
  await shoot(win, dir, '14-server-beitreten');
  const card = await js(win, `document.querySelector('.join__card')?.textContent || '(keine Vorschau)'`);
  console.log(`[join] Vorschau: ${card}`);
  await js(win, `document.querySelector('.join .icon-btn')?.click()`);
  await wait(300);

  // ---- F7–F15 ----
  await js(win, `[...document.querySelectorAll('.chatrow')].find(b=>b.textContent.includes('allgemein'))?.click()`);
  await wait(1200);
  // Aktionsleiste sichtbar machen (simuliert Hover) und auf "Antworten" klicken
  await js(win, `(() => { const msgs=[...document.querySelectorAll('.msg--in')]; const m=msgs[msgs.length-1]; m?.classList.add('show-actions'); m?.querySelector('.msg-actions button[aria-label="Antworten"]')?.click(); })()`);
  await wait(400);
  await js(win, `(() => { const el=document.querySelector('.composer textarea'); const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(el,'Stimmt 😄'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait(300);
  await shoot(win, dir, '15-antworten-reaktionen');
  const shift = await js(win, 'JSON.stringify({ html: document.documentElement.scrollTop, body: document.body.scrollTop, root: document.getElementById("root").scrollTop })');
  console.log(`[layout] Seite verschoben? ${shift}`);
  const sizes = await js(win, 'JSON.stringify({ fenster: innerHeight, body: document.body.scrollHeight, layout: document.querySelector(".layout")?.offsetHeight, chat: document.querySelector(".chat")?.offsetHeight, liste: document.querySelector(".chatlist")?.offsetHeight, rail: document.querySelector(".rail")?.offsetHeight })');
  console.log(`[layout] Höhen: ${sizes}`);
  const f7 = await js(win, `JSON.stringify({ antwortLeiste: !!document.querySelector('.composer__bar'), reaktionen: document.querySelectorAll('.reaction').length, embeds: document.querySelectorAll('.embed').length, antwortZitate: document.querySelectorAll('.reply-quote').length, threadChips: document.querySelectorAll('.thread-chip').length, pins: [...document.querySelectorAll('.bubble__meta')].filter(x=>x.textContent.includes('📌')).length })`);
  console.log(`[f7-f15] Ansicht: ${f7}`);
  await js(win, "document.querySelectorAll('.show-actions').forEach((m) => m.classList.remove('show-actions'))");
  // Senden der Antwort → Gegenprobe: Antwort-Zitat + Absenden
  await js(win, `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await wait(700);
  // Reaktion umschalten (👍 ist vom Bot gesetzt → entfernen)
  await js(win, `[...document.querySelectorAll('.reaction.is-me')][0]?.click()`);
  await wait(600);
  const afterActions = await js(win, `JSON.stringify({ gesendeteAntwort: [...document.querySelectorAll('.msg--out')].some(m=>m.textContent.includes('Stimmt') && m.querySelector('.reply-quote')), eigeneReaktionen: document.querySelectorAll('.reaction.is-me').length })`);
  console.log(`[f7-f15] Nach Aktionen: ${afterActions}`);
  // Threads-Seitenleiste
  await js(win, `document.querySelector('.chat__tools button[aria-label="Threads"]')?.click()`);
  await wait(700);
  await shoot(win, dir, '16-threads');
  // Thread öffnen
  await js(win, `document.querySelector('.thread-hit')?.click()`);
  await wait(900);
  const th = await js(win, `document.querySelector('.chat__head h1')?.textContent || ''`);
  console.log(`[f7-f15] Thread geöffnet: ${th}`);
  await js(win, `document.querySelector('.chat__head button[aria-label="Zurück"]')?.click()`);
  await wait(600);
  // Embed-Baukasten
  await js(win, `document.querySelector('.tool-btn[aria-label="Embed erstellen"]')?.click()`);
  await wait(300);
  await js(win, `(() => { const set=(sel,v,proto)=>{const el=document.querySelector(sel); Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));}; set('#emb-title','Treffen heute',HTMLInputElement); set('#emb-desc','Um **19 Uhr** in der Lounge – bringt Ideen mit!',HTMLTextAreaElement); })()`);
  await wait(300);
  await shoot(win, dir, '17-embed-baukasten');
  await js(win, `[...document.querySelectorAll('.embed-dialog .btn')].find(b=>b.textContent.includes('Abbrechen'))?.click()`);
  // Umfrage: Karte prüfen, Dialog zeigen
  const pollInfo = await js(win, `JSON.stringify({ karten: document.querySelectorAll('.poll').length, antworten: document.querySelectorAll('.poll__a').length, gewinner: document.querySelector('.poll__a.is-win') ? 1 : 0 })`);
  console.log(`[poll] Anzeige: ${pollInfo}`);
  await js(win, `document.querySelector('.tool-btn[aria-label="Umfrage erstellen"]')?.click()`);
  await wait(300);
  await js(win, `(() => { const set=(el,v)=>{ Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); }; set(document.querySelector('#poll-q'),'Wohin geht der nächste Ausflug?'); const a=document.querySelectorAll('.poll-dialog input[aria-label^="Antwort"]'); set(a[0],'Berge'); set(a[1],'See'); })()`);
  await wait(300);
  await shoot(win, dir, '19-umfrage');
  await js(win, `[...document.querySelectorAll('.poll-dialog .btn')].find(b=>b.textContent.includes('hinzufügen'))?.click()`);
  await wait(200);
  await js(win, `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await wait(800);
  const pollSent = await js(win, `[...document.querySelectorAll('.msg--out .poll__q')].some(q=>q.textContent.includes('Ausflug'))`);
  console.log(`[poll] Gesendete Umfrage sichtbar: ${pollSent}`);
  // Serversuche
  await js(win, `document.querySelector('.chat__tools button[aria-label="Suchen"]')?.click()`);
  await wait(300);
  await js(win, `[...document.querySelectorAll('.search-panel__tabs button')].find(b=>b.textContent.includes('Ganzer Server'))?.click()`);
  await wait(200);
  await js(win, `(() => { const el=document.querySelector('.search-panel__head input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'projekt'); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  await wait(800);
  await shoot(win, dir, '18-serversuche');
  const hits = await js(win, `document.querySelectorAll('.search-hit').length`);
  console.log(`[f7-f15] Serversuche-Treffer angezeigt: ${hits}`);
  await js(win, `document.querySelector('.search-panel .icon-btn')?.click()`);
  // Bot-Profil in den Einstellungen: Beschreibung ändern, speichern, Ergebnis prüfen
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(800);
  await js(win, `(() => { const el=document.querySelector('#profile-desc'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Ich helfe beim Organisieren von Treffen 🎉'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait(200);
  await shoot(win, dir, '20-bot-profil');
  await js(win, `[...document.querySelectorAll('.settings .btn')].find(b=>b.textContent.includes('Profil speichern'))?.click()`);
  await wait(600);
  const prof = await js(win, `JSON.stringify({ felder: document.querySelectorAll('#profile-name,#profile-desc,#profile-nick').length, toast: [...document.querySelectorAll('.toast')].map(t=>t.textContent).join(' | ').slice(0,80), gespeichertAktiv: !document.querySelector('.settings .btn--primary')?.disabled })`);
  console.log(`[profil] ${prof}`);
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
  await wait(300);
  // Aktionsleiste darf den Namen über der Nachricht nicht verdecken (Issue #1, Screenshot JoniMoni)
  const overlap = await js(win, `(() => { const m=[...document.querySelectorAll('.msg--in')].find(x=>x.querySelector('.bubble__author')); if(!m) return 'keine Nachricht'; m.classList.add('show-actions'); const a=m.querySelector('.msg-actions').getBoundingClientRect(), n=m.querySelector('.bubble__author').getBoundingClientRect(); const hit = a.left < n.right && a.right > n.left && a.top < n.bottom && a.bottom > n.top; m.classList.remove('show-actions'); return hit ? 'VERDECKT' : 'frei'; })()`);
  console.log(`[ui] Name neben Aktionsleiste: ${overlap}`);
  // Chatliste nach Kategorien, eine Kategorie einklappen
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Sortierung wechseln"]')?.click()`);
  await wait(300);
  const cats = await js(win, `document.querySelectorAll('.chatlist__category').length`);
  const rowsBefore = await js(win, `document.querySelectorAll('.chatlist__items .chatrow').length`);
  await js(win, `[...document.querySelectorAll('.chatlist__category')].find(b=>b.textContent.includes('Projekte'))?.click()`);
  await wait(300);
  const rowsAfter = await js(win, `document.querySelectorAll('.chatlist__items .chatrow').length`);
  await shoot(win, dir, '21-kategorien');
  console.log(`[ui] Kategorien: ${cats}, Zeilen vorher ${rowsBefore}, eingeklappt ${rowsAfter}`);
  await js(win, `[...document.querySelectorAll('.chatlist__category')].find(b=>b.textContent.includes('Projekte'))?.click()`);
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Sortierung wechseln"]')?.click()`);
  // Privatnachrichten: Bereich öffnen, Chat mit Chiara, antworten, neuen Privatchat mit Anna starten
  await js(win, `document.querySelector('.rail__dm')?.click()`);
  await wait(600);
  const dmRows = await js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].map(r=>r.querySelector('.chatrow__name')?.textContent).join(',')`);
  await js(win, `document.querySelector('.chatlist__items .chatrow')?.click()`);
  await wait(700);
  await js(win, `(() => { const el=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Erinnerung steht ✅'); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
  await wait(800);
  await shoot(win, dir, '22-privatchat');
  const dmInfo = await js(win, `JSON.stringify({ blasen: document.querySelectorAll('.msg').length, gesendet: [...document.querySelectorAll('.msg--out')].some(m=>m.textContent.includes('Erinnerung steht')), kopf: document.querySelector('.chat__head')?.textContent.slice(0,80) })`);
  console.log(`[dm] Liste: ${dmRows} · Chat: ${dmInfo}`);
  await js(win, `document.querySelector('.newdm-btn')?.click()`);
  await wait(300);
  await js(win, `(() => { const el=document.querySelector('#newdm-query'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'An'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait(600);
  await shoot(win, dir, '23-neuer-privatchat');
  await js(win, `document.querySelector('.newdm__item')?.click()`);
  await wait(800);
  const dmRows2 = await js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].map(r=>r.querySelector('.chatrow__name')?.textContent).join(',')`);
  console.log(`[dm] Nach "Neuer Privatchat": ${dmRows2} · offen: ${await js(win, `document.querySelector('.chat__head')?.textContent.slice(0,40)`)}`);
  // Neue Gruppe: privaten Kanal für Anna anlegen (Issue #1 „Gruppe erstellen“)
  {
    const setInput = (sel, v) => js(win, `(() => { const el=document.querySelector('${sel}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'${v}'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await js(win, `document.querySelector('.rail__item:not(.rail__dm):not(.rail__add)')?.click()`);
    await wait(500);
    await js(win, `document.querySelector('.newgroup-btn')?.click()`);
    await wait(300);
    await setInput('#newgroup-name', 'Team Planung');
    await js(win, `document.querySelector('.newgroup__private input')?.click()`);
    await wait(200);
    await setInput('.newgroup__people input', 'An');
    await wait(600);
    await js(win, `document.querySelector('.newgroup .newdm__item')?.click()`);
    await wait(200);
    await shoot(win, dir, '77-neue-gruppe');
    await js(win, `document.querySelector('.newgroup button[type="submit"]')?.click()`);
    await wait(1200);
    const grp = await js(win, `JSON.stringify({ dialogZu: !document.querySelector('.newgroup'), offen: document.querySelector('.chat__head')?.textContent.slice(0,40), inListe: [...document.querySelectorAll('.chatrow__name')].some(n=>n.textContent.includes('team-planung')) })`);
    console.log(`[gruppe] ${grp}`);
    await shoot(win, dir, '78-gruppe-erstellt');
  }
  // JoniMoni #61/#62/#56: Schnellfenster Benachrichtigungen, Abschnitte einklappen, Einstellungs-Markierung, @ im Privatchat
  {
    await js(win, `[...document.querySelectorAll('.chatrow')].find(r=>r.textContent.includes('allgemein'))?.click()`);
    await wait(600);
    await js(win, `document.querySelector('[data-notify-toggle]')?.click()`);
    await wait(400);
    await shoot(win, dir, '79-benachrichtigungen');
    await js(win, `[...document.querySelectorAll('.notify-pop__mode')].find(b=>b.textContent.includes('Stumm'))?.click()`);
    await wait(300);
    const notify = await js(win, `JSON.stringify({ fenster: Boolean(document.querySelector('.notify-pop')), stummInListe: [...document.querySelectorAll('.chatrow')].some(r=>r.textContent.includes('allgemein') && r.textContent.includes('🔕')), knopf: document.querySelector('[data-notify-toggle]')?.textContent.trim() })`);
    await js(win, `document.querySelector('.notify-pop .link-btn')?.click()`); // Zurücksetzen
    await js(win, `document.querySelector('[data-notify-toggle]')?.click()`);
    await wait(200);
    await js(win, `[...document.querySelectorAll('.chatlist__section-btn')].find(b=>b.textContent.includes('Sprachkanäle'))?.click()`);
    await wait(300);
    const zu = await js(win, `JSON.stringify({ eingeklappt: document.querySelector('.chatlist__section-btn')?.getAttribute('aria-expanded') === 'false', sprachZeilen: [...document.querySelectorAll('.chatrow')].filter(r=>r.textContent.includes('Sprache')).length })`);
    await shoot(win, dir, '80-abschnitt-eingeklappt');
    await js(win, `[...document.querySelectorAll('.chatlist__section-btn')].find(b=>b.textContent.includes('Sprachkanäle'))?.click()`);
    await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
    await wait(500);
    await js(win, `document.querySelector('.settings__body')?.scrollTo({ top: 1400 }); document.querySelector('.settings__body')?.dispatchEvent(new Event('scroll'))`);
    await wait(300);
    const nav = await js(win, `JSON.stringify({ voll: document.querySelectorAll('.settings__navitem.is-on').length, strich: document.querySelectorAll('.settings__navitem.is-here').length })`);
    await shoot(win, dir, '81-einstellungen-markierung');
    await js(win, `document.querySelector('.settings .icon-btn[aria-label="Schließen"]')?.click()`);
    await wait(300);
    await js(win, `document.querySelector('.rail__dm')?.click()`);
    await wait(700);
    await js(win, `[...document.querySelectorAll('.chatrow')].find(r=>r.textContent.includes('Anna'))?.click()`);
    await wait(700);
    await js(win, `(() => { const el=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'@'); el.selectionStart=el.selectionEnd=1; el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await wait(700);
    const dmAt = await js(win, `JSON.stringify([...document.querySelectorAll('.suggest .suggest__item, .suggest li, .suggest button')].map(x=>x.textContent.trim().slice(0,30)))`);
    await shoot(win, dir, '82-privatchat-erwaehnen');
    await js(win, `(() => { const el=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    // Bot einladen lassen, ohne eigenes Konto (Wunsch MoinMornhart 08.10.2026)
    await js(win, `document.querySelector('.rail [aria-label="Bot einladen"]')?.click()`);
    await wait(700);
    const inv = await js(win, `JSON.stringify({ fenster: Boolean(document.querySelector('.invite')), qr: Boolean(document.querySelector('.invite__qr')?.naturalWidth), knoepfe: [...document.querySelectorAll('.invite__actions .btn')].map(b=>b.textContent.trim().slice(0,22)) })`);
    await shoot(win, dir, '83-bot-einladen-lassen');
    await js(win, `[...document.querySelectorAll('.invite__actions .btn')][0]?.click()`);
    await wait(300);
    const kopiert = String(await require('electron').clipboard.readText());
    console.log(`[einladen] ${inv} · Nachricht: ${JSON.stringify(kopiert.slice(0, 60))} … enthält Link: ${/discord\.com\/oauth2\/authorize/.test(kopiert)}`);
    await js(win, `document.querySelector('.invite .icon-btn[aria-label="Schließen"]')?.click()`);
    await wait(200);
    // JoniMoni #73: Reaktions-Smileys an einer kurzen Nachricht links dürfen nicht aus dem Chat ragen
    await js(win, `document.querySelector('.rail__item:not(.rail__dm):not(.rail__add)')?.click()`);
    await wait(500);
    await js(win, `[...document.querySelectorAll('.chatrow')].find(r=>r.textContent.includes('allgemein'))?.click()`);
    await wait(700);
    // echte Mausbewegung über die letzte fremde Nachricht (die Aktionsleiste erscheint nur beim Darüberfahren)
    const pos = JSON.parse(await js(win, `(() => { const b = [...document.querySelectorAll('.msg--in .bubble')].at(-1); b?.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }); })()`));
    await wait(200);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
    await wait(300);
    // „Reagieren“ → Schnellauswahl → ➕ „Mehr Smileys“ = das große Fenster aus Jonis Bild
    await js(win, `[...document.querySelectorAll('.msg--in')].at(-1)?.querySelector('button[aria-label="Reagieren"]')?.click()`);
    await wait(250);
    await js(win, `[...document.querySelectorAll('.msg--in')].at(-1)?.querySelector('button[aria-label="Mehr Smileys"]')?.click()`);
    await wait(500);
    const emo = await js(win, `(() => { const p = document.querySelector('.emoji-panel--reactions'); const c = document.querySelector('.chat')?.getBoundingClientRect(); if (!p || !c) return 'kein Fenster'; const r = p.getBoundingClientRect(); return JSON.stringify({ links: Math.round(r.left - c.left), rechts: Math.round(c.right - r.right), unten: Math.round(innerHeight - r.bottom), ganzSichtbar: r.left >= c.left && r.right <= c.right && r.bottom <= innerHeight }); })()`);
    await shoot(win, dir, '85-reaktion-smileys');
    const dbg = await js(win, `JSON.stringify({ msgsIn: document.querySelectorAll('.msg--in').length, bubbles: document.querySelectorAll('.msg--in .bubble').length, knoepfe: document.querySelectorAll('.msg-actions button[aria-label="Reagieren"]').length, panels: document.querySelectorAll('.emoji-panel').length, chat: document.querySelector('.chat__head h1')?.textContent })`);
    console.log(`[issue73] Reaktions-Smileys: ${emo} · ${dbg} · pos ${JSON.stringify(pos)}`);
    await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(200);
    console.log(`[issue61] Schnellfenster: ${notify} · Abschnitt: ${zu} · Einstellungen: ${nav} · @ im Privatchat: ${dmAt}`);
    await js(win, `document.querySelector('.rail__item:not(.rail__dm):not(.rail__add)')?.click()`);
    await wait(500);
  }
  // KI-Agenten (Beta): einschalten, Anbieter + Modell + Schlüssel, Verbindung testen, Auftrag anlegen und sofort ausführen
  const SET = `const setVal=(el,v)=>{ const proto=el instanceof HTMLSelectElement?HTMLSelectElement:el instanceof HTMLTextAreaElement?HTMLTextAreaElement:HTMLInputElement; Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(el,v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true})); };`;
  const clickText = (sel, text) => js(win, `[...document.querySelectorAll('${sel}')].find(b=>b.textContent.includes('${text}'))?.click()`);
  await js(win, `document.querySelector('.rail__item:not(.rail__dm):not(.rail__add)')?.click()`);
  await wait(400);
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(600);
  await js(win, `[...document.querySelectorAll('.settings label.composer__ping')].find(l=>l.textContent.includes('Beta'))?.querySelector('input')?.click()`);
  await wait(500);
  await js(win, `document.querySelectorAll('.settings details[data-fold]').forEach((d) => (d.open = true))`); // #131: einklappbare Bereiche öffnen
  await wait(150);
  await js(win, `(() => { ${SET} setVal(document.querySelector('#ai-model'),'demo-modell'); })()`);
  await wait(200);
  await clickText('.ai-box .btn', 'Übernehmen');
  await wait(300);
  await js(win, `(() => { ${SET} setVal(document.querySelector('#ai-key'),'sk-demo-1234567890'); })()`);
  await wait(100);
  await clickText('.ai-box .btn', 'Speichern');
  await wait(300);
  await clickText('.ai-box .btn', 'Verbindung testen');
  await wait(500);
  const aiTest = await js(win, `[...document.querySelectorAll('.toast')].map(t=>t.textContent).find(t=>t.includes('KI antwortet'))||'(kein Test-Hinweis)'`);
  // Issue #12: Modelle automatisch laden + lokale KI (Ollama, LM Studio, llama.cpp) auf diesem PC finden
  await clickText('.ai-box .btn', 'Modelle laden');
  await wait(500);
  const modelOpts = await js(win, `[...document.querySelectorAll('#ai-model-list option')].map(o=>o.value).join(',')`);
  await clickText('.ai-box .btn', 'Lokale KI');
  await wait(800);
  await win.webContents.executeJavaScript(`document.querySelector('.ai-local')?.scrollIntoView({block:'center'})`);
  await wait(300);
  await shoot(win, dir, '42-ki-lokal-gefunden');
  const local = await js(win, `[...document.querySelectorAll('.ai-local__item')].map(b=>b.textContent.trim()).join(' | ')`);
  console.log(`[ki-modelle] geladen: ${modelOpts} · lokal gefunden: ${local}`);
  await clickText('.ai-box .btn', 'Neuer Auftrag');
  await wait(300);
  await js(win, `(() => { ${SET} setVal(document.querySelector('#ai-job-name'),'Morgengruß'); setVal(document.querySelector('#ai-job-prompt'),'Schreib einen kurzen, fröhlichen Guten-Morgen-Gruß mit dem Plan für heute.'); const t=document.querySelector('#ai-job-target'); const o=[...t.options].find(o=>o.textContent.includes('#allgemein')); if(o) setVal(t,o.value); })()`);
  await wait(300);
  // Issue #12: Vorschau vor dem Speichern – KI schreibt, aber NICHTS wird gepostet
  const sentBefore = await js(win, `document.querySelectorAll('.msg--out').length`);
  await clickText('.ai-job-form .btn', 'Vorschau');
  await wait(800);
  const prev = await js(win, `JSON.stringify({ vorschau: document.querySelector('.ai-preview__text')?.textContent.slice(0,50) || null, status: document.querySelector('.ai-status')?.textContent.replace(/\\s+/g,' ').slice(0,140) || null })`);
  const sentAfter = await js(win, `document.querySelectorAll('.msg--out').length`);
  console.log(`[ki-vorschau] ${prev} · gepostet: ${sentAfter - sentBefore}`);
  await win.webContents.executeJavaScript(`document.querySelector('.ai-preview')?.scrollIntoView({block:'center'})`);
  await wait(300);
  await shoot(win, dir, '24-ki-auftrag');
  // Websuche (Issue #12): einschalten → KI sucht erst, antwortet dann mit Quelle; danach wieder aus
  const webBox = `[...document.querySelectorAll('.ai-job-form label.composer__ping')].find(l=>l.textContent.includes('Websuche'))?.querySelector('input')`;
  await js(win, `${webBox}?.click()`);
  await wait(200);
  await clickText('.ai-job-form .btn', 'Vorschau');
  await wait(900);
  await win.webContents.executeJavaScript(`document.querySelector('.ai-preview')?.scrollIntoView({block:'center'})`);
  await wait(300);
  await shoot(win, dir, '43-ki-websuche');
  const web = await js(win, `JSON.stringify({ vorschau: document.querySelector('.ai-preview__text')?.textContent.slice(0,60) || null, suche: [...document.querySelectorAll('.ai-status span')].map(s=>s.textContent).find(t=>t.includes('Websuche')) || null })`);
  console.log(`[ki-websuche] ${web}`);
  await js(win, `${webBox}?.click()`);
  await wait(200);
  await clickText('.ai-job-form .btn', 'Auftrag speichern');
  await wait(500);
  await clickText('.ai-job .btn', 'Jetzt');
  await wait(1000);
  await win.webContents.executeJavaScript(`document.querySelector('.ai-box')?.scrollIntoView({block:'end'})`);
  await wait(300);
  await shoot(win, dir, '25-ki-agenten');
  const aiJob = await js(win, `JSON.stringify({ auftraege: document.querySelectorAll('.ai-job').length, status: document.querySelector('.ai-job .small.ok, .ai-job .small.warn')?.textContent.slice(0,90) || null, schluesselSichtbar: document.body.innerHTML.includes('sk-demo-1234567890') })`);
  console.log(`[ki] Test: ${aiTest.slice(0,60)} · Auftrag: ${aiJob}`);
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
  await wait(400);
  await js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].find(r=>r.textContent.includes('allgemein'))?.click()`);
  await wait(800);
  const posted = await js(win, `[...document.querySelectorAll('.msg--out')].some(m=>m.textContent.includes('Guten Morgen, Team'))`);
  console.log(`[ki] Nachricht im Kanal sichtbar: ${posted}`);
  // Antwort-Agent: für #allgemein einschalten, dann erwähnt Anna den Bot → KI antwortet als Reply
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(500);
  await js(win, `[...document.querySelectorAll('.ai-responder label.composer__ping')].find(l=>l.textContent.includes('erwähnt'))?.querySelector('input')?.click()`);
  await wait(300);
  await js(win, `[...document.querySelectorAll('.ai-channel')].find(l=>l.textContent.includes('#allgemein'))?.querySelector('input')?.click()`);
  await js(win, `(() => { const el=document.querySelector('#ai-instr'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Du bist PKBot, locker und hilfsbereit.'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait(200);
  await win.webContents.executeJavaScript(`document.querySelector('.ai-responder')?.scrollIntoView({block:'center'})`);
  await wait(300);
  await shoot(win, dir, '29-ki-antworten');
  // Personen ausschließen (Issue #1): Vorschläge schon beim Reinklicken und für Teile des Namens
  const blockInput = `document.querySelector('input[aria-label="Diese Personen ausschließen: Name suchen"]')`;
  await js(win, `${blockInput}?.focus()`);
  await wait(700);
  const onFocus = await js(win, `[...document.querySelectorAll('.ai-people')].at(-1)?.querySelectorAll('.ai-suggest button').length || 0`);
  await js(win, `(() => { ${SET} setVal(${blockInput}, 'n'); })()`);
  await wait(700);
  await js(win, `[...document.querySelectorAll('.ai-people')].at(-1)?.scrollIntoView({block:'center'})`);
  await wait(200);
  await shoot(win, dir, '44-personen-vorschlaege');
  const withN = await js(win, `[...[...document.querySelectorAll('.ai-people')].at(-1).querySelectorAll('.ai-suggest button')].map(b=>b.textContent.trim()).join(', ')`);
  console.log(`[personen] beim Reinklicken: ${onFocus} Vorschläge · mit „n“: ${withN}`);
  await js(win, `(() => { ${SET} setVal(${blockInput}, ''); ${blockInput}.blur(); })()`);
  await wait(300);
  // KI-Modi (Wunsch MoinMornhart 08.10.2026): Modus anlegen
  await clickText('.ai-modes .btn', 'Modus hinzufügen');
  await wait(200);
  await js(win, `(() => { ${SET} setVal(document.querySelector('.ai-mode input[aria-label="Name des Modus"]'), 'Rainer'); setVal(document.querySelector('.ai-mode textarea'), 'Kurz, trocken, mit Humor.'); })()`);
  await wait(200);
  await js(win, `document.querySelectorAll('.settings details[data-fold]').forEach((d) => (d.open = true))`); // #131: einklappbare Bereiche öffnen
  await wait(150);
  await js(win, `document.querySelector('.ai-modes')?.scrollIntoView({block:'center'})`);
  await wait(300);
  await shoot(win, dir, '84-ki-modi');
  // #131: Gefahren-Schalter „KI darf den Server mitverwalten“ – Bestätigung zeigen, dann abbrechen
  await js(win, `document.querySelector('[data-fold="ai-admin"]')?.setAttribute('open', '')`);
  await wait(200);
  await js(win, `document.querySelector('[data-fold="ai-admin"] input[type=checkbox]')?.click()`);
  await wait(300);
  await js(win, `document.querySelector('[data-fold="ai-admin"]')?.scrollIntoView({block:'center'})`);
  await wait(300);
  await shoot(win, dir, '84b-ki-server-verwaltung');
  console.log(`[ki-admin] Bestätigung sichtbar: ${await js(win, `Boolean(document.querySelector('.ai-danger__confirm'))`)}`);
  await clickText('.ai-danger__confirm .btn', 'Abbrechen');
  await wait(200);
  // #131: Bot-Module – Auto-Antwort anlegen, Zählen einschalten
  await js(win, `document.querySelectorAll('.settings details[data-fold]').forEach((d) => (d.open = true))`);
  await wait(300);
  await js(win, `document.querySelectorAll('.settings details[data-fold^="module"]').forEach((d) => (d.open = true))`);
  await wait(200);
  await js(win, `document.querySelector('[data-setting="module-counting"] input')?.click()`);
  await wait(300);
  if (!(await js(win, `document.querySelectorAll('.module-rule').length`))) await clickText('.module-card .btn', 'Auto-Antwort');
  await wait(200);
  await js(win, `(() => { ${SET} setVal(document.querySelector('.module-rule input[aria-label="Stichwort"]'), '!regeln'); setVal(document.querySelector('.module-rule textarea'), 'Seid nett zueinander 💛'); })()`);
  await wait(200);
  await clickText('.module-card .btn', 'Speichern');
  await wait(400);
  await js(win, `document.querySelector('[data-fold="modules"]')?.scrollIntoView({block:'start'})`);
  await wait(300);
  await shoot(win, dir, '87-bot-module');
  await js(win, `document.querySelector('[data-fold="module-protection"]')?.scrollIntoView({block:'start'})`);
  await wait(300);
  await shoot(win, dir, '87b-bot-module-schutz');
  const modState = await js(win, `JSON.stringify([...document.querySelectorAll('.module-card > summary')].map((s) => s.textContent.trim()))`);
  console.log(`[module] ${modState}`);
  console.log(`[ki-modi] ${await js(win, `JSON.stringify({ modi: document.querySelectorAll('.ai-mode').length, name: document.querySelector('.ai-mode input')?.value, wechsler: Boolean([...document.querySelectorAll('.ai-people')].find(p=>p.textContent.includes('Modus wechseln'))), limit: document.querySelector('.ai-responder .ai-limits select')?.value })`)}`);
  // Gedächtnis pro Person einschalten (Issue #1)
  await js(win, `document.querySelector('[data-setting="ai-memory"] input')?.click()`);
  await wait(200);
  await clickText('.ai-responder .btn', 'Speichern');
  await wait(400);
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
  await wait(400);
  // #allgemein ist offen und das Fenster aktiv → KI schweigt (Issue #1: „wenn ich im Chat bin, soll KI nichts machen“)
  simulate?.mention('Bist du da?');
  await wait(800);
  const quiet = await js(win, `[...document.querySelectorAll('.msg--out')].some(m=>m.textContent.includes('in der Lounge'))`);
  // Anderer Chat offen → KI antwortet; währenddessen „🤖 KI schreibt gerade an …“
  await js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].find(b=>b.textContent.includes('ankuendigungen'))?.click()`);
  await wait(16000); // Wartezeit pro Kanal (15 s) abwarten
  simulate?.mention('Wann ist das Treffen heute?');
  await wait(600);
  await shoot(win, dir, '60-ki-schreibt-gerade');
  const busyPill = await js(win, `document.querySelector('.ai-busy')?.textContent.trim() || null`);
  await wait(2200);
  await js(win, `[...document.querySelectorAll('.chatlist__items .chatrow')].find(b=>b.textContent.includes('allgemein'))?.click()`);
  await wait(900);
  console.log(`[ki-still] Chat offen → geantwortet: ${quiet} · Anzeige: ${busyPill}`);
  await shoot(win, dir, '30-ki-antwort-im-chat');
  const reply = await js(win, `JSON.stringify({ hinweis: [...document.querySelectorAll('.toast')].map(t=>t.textContent).find(t=>t.includes('geantwortet'))?.slice(0,60) || null, antwortAlsReply: [...document.querySelectorAll('.msg--out')].some(m=>m.querySelector('.reply-quote') && m.textContent.includes('19 Uhr** in der Lounge') || m.textContent.includes('in der Lounge 🎉')) })`);
  console.log(`[ki-antwort] ${reply}`);
  // Gedächtnis: Anna steht jetzt drin → ansehen
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(600);
  await js(win, `document.querySelector('.settings__nav [data-nav="beta"]')?.click()`);
  await wait(400);
  await js(win, `[...document.querySelectorAll('.ai-memory-row .btn')].find(b=>b.textContent.includes('Ansehen'))?.click()`);
  await wait(400);
  await js(win, `document.querySelector('[data-setting="ai-memory-list"]')?.scrollIntoView({block:'center'})`);
  await wait(300);
  await js(win, `[...document.querySelectorAll('.ai-memory-row .btn')].find(b=>b.textContent.includes('zusammenfassen'))?.click()`);
  await wait(1200);
  await js(win, `document.querySelector('[data-setting="ai-memory-list"]')?.scrollIntoView({block:'center'})`);
  await wait(300);
  await shoot(win, dir, '64-ki-gedaechtnis');
  console.log(`[ki-zusammenfassen] ${await js(win, `document.querySelector('.ai-memory-row')?.textContent.trim().slice(0,140) || null`)}`);
  await js(win, `document.querySelector('.settings__body')?.scrollTo({top:0})`);
  await wait(300);
  await shoot(win, dir, '70-beta-uebersicht');
  const mem = await js(win, `JSON.stringify({ personen: [...document.querySelectorAll('.ai-memory-row b')].map(b=>b.textContent), inhalt: document.querySelector('[data-setting="ai-memory-list"] .ai-preview')?.textContent.slice(0,90) || null })`);
  console.log(`[ki-gedaechtnis] ${mem}`);
  await js(win, `document.querySelector('.settings__nav [data-nav="alle"]')?.click()`);
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
  await wait(300);
  // Aussehen: Einstellungen zeigen, dann Designs „Hell“ und „Lila + Pink“ im Chat
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(600);
  await shoot(win, dir, '26-aussehen');
  const look = await js(win, `JSON.stringify({ designs: document.querySelectorAll('.look-theme').length, farben: document.querySelectorAll('.look-accent').length })`);
  // #131: Leistung – Sparmodus an/aus
  await js(win, `document.querySelector('.settings__nav [data-nav="leistung"]')?.click()`);
  await wait(300);
  await clickText('.settings .btn', 'Sparmodus');
  await wait(200);
  const perf = await js(win, `JSON.stringify({ wallAnim: document.documentElement.dataset.wallAnim, glass: document.documentElement.dataset.glass, motion: document.documentElement.dataset.motion })`);
  await shoot(win, dir, '26b-leistung');
  await clickText('.settings .btn', 'wieder an');
  await wait(200);
  console.log(`[leistung] Sparmodus: ${perf} · danach: ${await js(win, `document.documentElement.dataset.wallAnim + '/' + document.documentElement.dataset.glass`)}`);
  await js(win, `document.querySelector('.settings__nav [data-nav="aussehen"]')?.click()`);
  await wait(300);
  await clickText('.look-theme', 'Hell');
  await wait(200);
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
  await wait(500);
  await shoot(win, dir, '27-design-hell');
  const hell = await js(win, `JSON.stringify({ theme: document.documentElement.dataset.theme, hintergrund: getComputedStyle(document.body).backgroundColor })`);
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(400);
  await clickText('.look-theme', 'Lila');
  await js(win, `document.querySelector('.look-accent[aria-label="Farbe #f472b6"]')?.click()`);
  await clickText('.look-seg button', 'Kompakt');
  await wait(200);
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
  await wait(500);
  await shoot(win, dir, '28-design-lila');
  const lila = await js(win, `JSON.stringify({ theme: document.documentElement.dataset.theme, akzent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), dichte: document.documentElement.dataset.density })`);
  console.log(`[look] ${look} · Hell: ${hell} · Lila: ${lila}`);
  await js(win, `localStorage.removeItem('pk.prefs.v1')`);
  // Updates: Knopf „Jetzt nach Updates suchen“ muss eine Rückmeldung geben (Issue #1)
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(500);
  await clickText('.settings .btn', 'nach Updates suchen');
  await wait(300);
  // gerade beim Start geprüft → Rückfrage „Nochmal nachsehen?“ bestätigen
  await js(win, `[...document.querySelectorAll('.modal.confirm .btn')].find(b=>b.textContent.includes('nochmal'))?.click()`);
  await wait(100);
  const during =await js(win, `[...document.querySelectorAll('.settings .btn')].map(b=>b.textContent).find(t=>t.includes('Suche'))||null`);
  await wait(1800);
  await js(win, `[...document.querySelectorAll('.settings h4')].find(h=>h.textContent.includes('Updates'))?.scrollIntoView({block:'center'})`);
  await wait(300);
  await shoot(win, dir, '31-updates');
  const updAfter = await js(win, `JSON.stringify({ status: [...document.querySelectorAll('.settings p')].map(p=>p.textContent).find(t=>t.includes('PKMessenger v'))?.slice(0,90), hinweis: [...document.querySelectorAll('.toast')].map(t=>t.textContent).find(t=>t.includes('Update'))?.slice(0,70) || null })`);
  const upd = JSON.stringify({ waehrend: during, ...JSON.parse(updAfter) });
  console.log(`[update] ${upd}`);
  // Updates (Issue #1): nochmal drücken → Rückfrage; „Was ist neu?“ zeigt Releases; neu installieren
  {
    await clickText('.settings .btn', 'nach Updates suchen');
    await wait(300);
    const ask = await js(win, `document.querySelector('.modal.confirm h3')?.textContent || null`);
    await shoot(win, dir, '52-update-nochmal');
    await js(win, `[...document.querySelectorAll('.modal.confirm .btn')].find(b=>b.textContent.includes('nochmal'))?.click()`);
    await wait(1500);
    await clickText('.settings .btn', 'Was ist neu');
    await wait(900);
    await js(win, `document.querySelector('.update-changes')?.scrollIntoView({block:'center'})`);
    await wait(300);
    await shoot(win, dir, '53-was-ist-neu');
    const news = await js(win, `JSON.stringify({ releases: document.querySelectorAll('.update-changes__release').length, notizen: document.querySelectorAll('.update-changes__release[open] li').length, neuInstallieren: [...document.querySelectorAll('.update-changes .btn')].some(b=>b.textContent.includes('neu installieren')) })`);
    // Sicherheit: Hintergrund + Windows Hello
    await js(win, `[...document.querySelectorAll('.settings h4')].find(h=>h.textContent.includes('Sicherheit'))?.scrollIntoView({block:'start'})`);
    await wait(300);
    const sec = await js(win, `JSON.stringify({ hintergrund: Boolean(document.querySelector('[data-setting="background"]')) })`);
    await shoot(win, dir, '54-sicherheit-hintergrund');
    console.log(`[update-neu] Rückfrage: ${ask} · Was ist neu: ${news} · Sicherheit: ${sec}`);
  }
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
  // App-Sperre (Issue #1): Passwort festlegen → sperren → falsch → richtig → wieder entfernen
  const setInput = (sel, v) => js(win, `(() => { const el=document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const clickB = (sel, text) => js(win, `[...document.querySelectorAll(${JSON.stringify(sel)})].find(b=>b.textContent.includes(${JSON.stringify(text)}))?.click()`);
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(500);
  await clickB('.settings .btn', 'App-Passwort festlegen');
  await wait(200);
  await setInput('.lock-form input[aria-label="Neues Passwort"]', 'demo1234');
  await setInput('.lock-form input[aria-label="Neues Passwort wiederholen"]', 'demo1234');
  await clickB('.lock-form .btn', 'Speichern');
  await wait(500);
  // Windows Hello einschalten (Issue #29) → Sperrbildschirm zeigt den Hello-Knopf
  await js(win, `document.querySelector('[data-setting="hello"] input')?.click()`);
  await wait(400);
  await clickB('.settings .btn', 'Jetzt sperren');
  await wait(600);
  await shoot(win, dir, '38-gesperrt');
  console.log(`[hello] Knopf auf dem Sperrbildschirm: ${await js(win, `[...document.querySelectorAll('.lock-card .btn')].some(b=>b.textContent.includes('Windows Hello'))`)}`);
  const lockedUi = await js(win, `Boolean(document.querySelector('.lock-card')) && !document.querySelector('.chatlist')`);
  await setInput('.lock-card input', 'falsch');
  await js(win, `document.querySelector('.lock-card').requestSubmit()`);
  await wait(400);
  const wrongMsg = await js(win, `document.querySelector('.lock-card .warn')?.textContent || null`);
  await setInput('.lock-card input', 'demo1234');
  await js(win, `document.querySelector('.lock-card').requestSubmit()`);
  await wait(1500);
  const unlocked = await js(win, `Boolean(document.querySelector('.chatlist')) && !document.querySelector('.lock-card')`);
  console.log(`[sperre] gesperrt: ${lockedUi} · falsches Passwort: ${JSON.stringify(wrongMsg)} · entsperrt: ${unlocked}`);
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(500);
  await clickB('.settings .btn', 'Passwort entfernen');
  await wait(200);
  await setInput('.lock-form input[aria-label="Bisheriges Passwort"]', 'demo1234');
  await clickB('.lock-form .btn', 'Entfernen');
  await wait(400);
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
  await wait(300);
  // Nicht stören: Glocke → 🔕, Erwähnung darf keinen Ton auslösen
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Nicht stören"]')?.click()`);
  await wait(1700);
  const logBefore = await js(win, '(window.__pkSoundLog||[]).length');
  simulate?.mention('Bist du da?');
  await wait(800);
  const logAfter = await js(win, '(window.__pkSoundLog||[]).length');
  console.log(`[nicht-stoeren] Glocke: ${await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Nicht stören"]')?.textContent`)} · Töne bei Erwähnung: ${logAfter - logBefore}`);
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Nicht stören"]')?.click()`);
  await wait(300);
  // Audio-Test in den Einstellungen (simuliertes Mikrofon): Pegel muss sich bewegen
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(500);
  await clickText('.settings .btn', 'Mikrofon testen');
  await wait(1200);
  await js(win, `document.querySelector('.mic-test')?.scrollIntoView({block:'center'})`);
  await wait(200);
  await shoot(win, dir, '35-audio-test');
  // Über 2 s messen (das simulierte Mikro piept nur in Abständen)
  const micTest = await js(win, `new Promise((res) => { let max = 0, sendet = false, n = 0; const t = setInterval(() => { const v = parseFloat((document.querySelector('.mic-test .level i')?.style.transform || '').split('(')[1]) || 0; max = Math.max(max, v); sendet = sendet || (document.querySelector('.mic-test .small')?.textContent || '').includes('gesendet'); if (++n >= 20) { clearInterval(t); res(JSON.stringify({ maxPegel: max, sendetZwischendurch: sendet, hilfe: Boolean(document.querySelector('.voice-help')) })); } }, 100); })`);
  console.log(`[audio-test] ${micTest}`);
  await clickText('.settings .btn', 'Test beenden');
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
  await wait(300);
  // Töne (Issue #12): Testton in den Einstellungen, dann löst eine Erwähnung den Erwähnungston aus
  await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
  await wait(500);
  await js(win, `[...document.querySelectorAll('.settings h4')].find(h=>h.textContent.includes('Benachrichtigungen'))?.scrollIntoView({block:'start'})`);
  await js(win, `document.querySelector('.sound-event button[aria-label^="Testton: Jemand erwähnt"]')?.click()`);
  await wait(400);
  await shoot(win, dir, '32-toene');
  const overflow = await js(win, `(() => { const m=document.querySelector('.settings'); return m ? m.scrollWidth - m.clientWidth : -1; })()`);
  console.log(`[toene] Einstellungen waagerecht übergelaufen um ${overflow}px`);
  const test1 = await js(win, `JSON.stringify({ zeilen: document.querySelectorAll('.sound-event').length, log: (window.__pkSoundLog||[]).map(e=>e.event+':'+e.preset) })`);
  await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
  await wait(1700); // Drosselung abwarten
  simulate?.mention('Hörst du mich?');
  await wait(800);
  const test2 = await js(win, `JSON.stringify((window.__pkSoundLog||[]).slice(0,3).map(e=>e.event+':'+e.preset))`);
  console.log(`[toene] Einstellungen: ${test1} · nach Erwähnung: ${test2}`);
  // #120: Support-Bereich – Hilfelink mit einem Klick erzeugen + kopieren
  try {
    await js(win, `document.querySelector('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click()`);
    await wait(500);
    await js(win, `document.querySelector('.settings__nav [data-nav="support"]')?.click()`);
    await wait(400);
    await js(win, `[...document.querySelectorAll('.support__link .btn')].find((b) => b.textContent.includes('Hilfe starten'))?.click()`);
    await wait(900);
    const sup = await js(win, `JSON.stringify({ code: document.querySelector('.support__link .login-code')?.textContent?.length || 0, knoepfe: [...document.querySelectorAll('.support__link .btn')].map((b) => b.textContent.trim()) })`);
    await shoot(win, dir, '87-support-hilfelink');
    await js(win, `(() => { const d = document.querySelector('[data-setting="support-advanced"]'); if (d) { d.open = true; d.querySelector('details')?.setAttribute('open', ''); d.scrollIntoView({ block: 'start' }); } })()`);
    await wait(300);
    await shoot(win, dir, '88-support-erweitert');
    console.log(`[support] ${sup}`);
    // #158: genau das Bild, das der Helfer bekäme (geschwärzt) – zum Ansehen speichern
    if (captureHelp) {
      await js(win, `document.querySelector('.settings__nav [data-nav="aussehen"]')?.click()`);
      await wait(1200); // Bridge meldet die Sicht alle 700 ms
      const shot = await captureHelp();
      if (shot?.img) require('node:fs').writeFileSync(require('node:path').join(dir, '89-helfer-bild.jpg'), Buffer.from(shot.img.split(',')[1], 'base64'));
      console.log(`[helfer-bild] ${shot ? `${shot.w}x${shot.h}, ${Math.round(shot.img.length / 1024)} KB` : 'kein Bild'}`);
      // #160: so sieht der Nutzer eine Zeichnung des Helfers und den Hilfe-Chat
      await js(win, `window.dispatchEvent(new CustomEvent('help:draw', { detail: { type: 'draw', points: [[0.3, 0.35], [0.36, 0.42], [0.45, 0.44], [0.55, 0.4]] } }))`);
      await js(win, `document.querySelector('.help-chat__bubble')?.click()`);
      await wait(400);
      await shoot(win, dir, '89b-hilfe-zeichnung-chat');
      console.log(`[hilfe-160] ${await js(win, `JSON.stringify({ zeichnung: document.querySelectorAll('.help-draw polyline').length, chat: Boolean(document.querySelector('.help-chat')) })`)}`);
      await js(win, `document.querySelector('.settings__nav [data-nav="support"]')?.click()`);
      await wait(300);
    }
    await js(win, `[...document.querySelectorAll('.support__link .btn')].find((b) => b.textContent.includes('beenden'))?.click()`);
    await wait(300);
    await js(win, `document.querySelector('.settings .icon-btn')?.click()`);
    await wait(300);
  } catch (e) {
    console.log(`[support] Fehler: ${e.message}`);
  }
  // Fernhilfe (Issue #79): Hilfe anfordern → Code + QR. In try/catch, damit es den Lauf nie abbricht.
  try {
    await js(win, `document.querySelector('.rail__item:not(.rail__dm):not(.rail__add)')?.click()`);
    await wait(400);
    await js(win, `window.dispatchEvent(new CustomEvent('pk:help-open'))`);
    await wait(400);
    await js(win, `[...document.querySelectorAll('.modal .btn--primary')].find((b) => b.textContent.includes('Hilfe anfordern'))?.click()`);
    await wait(700);
    const helpInfo = await js(win, `JSON.stringify({ code: document.querySelector('.login-code')?.textContent?.length || 0, qr: Boolean(document.querySelector('.invite__qr')), zusehen: Boolean([...document.querySelectorAll('.composer__ping')].find((l) => l.textContent.includes('mithelfen'))) })`);
    await shoot(win, dir, '86-fernhilfe');
    console.log(`[fernhilfe] ${helpInfo}`);
    await js(win, `[...document.querySelectorAll('.modal .btn--danger')].find((b) => b.textContent.includes('beenden'))?.click()`);
    await js(win, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  } catch (e) {
    console.log(`[fernhilfe] Fehler: ${e.message}`);
  }
}

module.exports = { runScreenshots };
