'use strict';

// Bildtest der Android-Oberfläche am PC (Issue #56): lädt mobile/www (Demo-Build mit simuliertem Discord) in einem
// Fenster in Handy-Größe, klickt sich durch und speichert Screenshots + prüft das Layout.
// Aufruf: node scripts/build-mobile.js --demo && npx electron scripts/mobile-shots.js <ordner>
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const OUT = path.resolve(process.argv.find((a) => a.startsWith('--out='))?.slice(6) || path.join(__dirname, '..', 'screenshots', 'android'));
const W = 412;
const H = 892;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    const message = e.message ?? e.params?.message ?? '';
    if (level === 'error' || level === 3) problems.push(`Konsole: ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => problems.push(`Absturz: ${d.reason}`));
  win.showInactive(); // sichtbar, sonst laufen CSS-Animationen nicht weiter (Bilder blieben leer)
  const page = path.join(__dirname, '..', 'mobile', 'www', 'index.html');
  await win.loadFile(page);
  // Tour beim ersten Start überspringen (eigener Bildtest weiter unten), dann frisch laden
  await win.webContents.executeJavaScript(`localStorage.clear(); localStorage.setItem('pk.tour.v1', JSON.stringify({ status: 'skipped' })); localStorage.setItem('pk.privacy.v1', JSON.stringify({ version: 99, at: 1 }))`);
  await win.loadFile(page);
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await wait(350);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
    // Layout: nichts darf seitlich überstehen
    const over = await js(`(() => { const w = innerWidth; const bad = [...document.querySelectorAll('body *')].filter((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.right > w + 1 && cs.position !== 'fixed' && !el.closest('[class*="scroll"], .msgs, .chatlist__items, .settings__body'); }).slice(0, 3).map((el) => el.className || el.tagName); return { sw: document.documentElement.scrollWidth, w, bad }; })()`);
    if (over.sw > over.w + 1 || over.bad.length) problems.push(`${name}: seitlicher Überstand ${JSON.stringify(over)}`);
    console.log(`[android] ${name}.png`);
  };
  const click = (sel, text) => js(`(() => { const el = [...document.querySelectorAll('${sel}')].find((x) => !${JSON.stringify(text || '')} || x.textContent.includes(${JSON.stringify(text || '')})); el?.click(); return Boolean(el); })()`);

  await wait(2500);
  const state = await js(`({ rows: document.querySelectorAll('.chatrow').length, platform: document.documentElement.dataset.platform, status: document.querySelector('.bot-footer, .botfooter')?.textContent?.slice(0, 40) || '' })`);
  console.log(`[android] Start: ${JSON.stringify(state)}`);
  await shot('01-chatliste');
  console.log(`[android] Chat öffnen: ${await click('.chatrow', 'allgemein')}`);
  await wait(800);
  await shot('02-chat');
  await wait(4500); // Anna tippt und schreibt (simuliert)
  await shot('03-live');
  await js(`(() => { const el = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Klar, kommt sofort 📋'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await wait(900);
  const sent = await js(`[...document.querySelectorAll('.msg--out')].some((m) => m.textContent.includes('kommt sofort'))`);
  console.log(`[android] Gesendet sichtbar: ${sent}`);
  if (!sent) problems.push('Gesendete Nachricht nicht sichtbar');
  await shot('04-gesendet');
  // Langer Druck (Android meldet ihn als contextmenu)
  await js(`(() => { const m = [...document.querySelectorAll('.msg')].at(-2); const r = m.getBoundingClientRect(); m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 10 })); })()`);
  await wait(300);
  const menu = await js(`Boolean(document.querySelector('.ctx-menu'))`);
  console.log(`[android] Menü nach langem Druck: ${menu}`);
  await shot('05-menue');
  await js(`window.dispatchEvent(new CustomEvent('pk:back', { detail: { exit: () => { window.__exited = true; } } }))`); // schließt das Menü
  await wait(200);
  await js(`window.dispatchEvent(new CustomEvent('pk:back', { detail: { exit: () => { window.__exited = true; } } }))`); // zurück zur Liste
  await wait(400);
  const backToList = await js(`document.querySelector('.layout')?.className`);
  console.log(`[android] Nach Zurück: ${backToList}`);
  if (!/layout--list/.test(backToList)) problems.push('Zurück-Taste führt nicht zur Chatliste');
  await shot('06-zurueck-liste');
  console.log(`[android] Privatchats: ${await click('.rail__dm')}`);
  await wait(1200);
  await shot('07-privatchats');
  await click('.chatlist__head .icon-btn[aria-label="Einstellungen"]');
  await wait(800);
  const sections = await js(`[...document.querySelectorAll('.settings section[data-section]')].map((s) => s.dataset.section).join(',')`);
  console.log(`[android] Einstellungsbereiche: ${sections}`);
  if (/sicherheit|audio|beta/.test(sections)) problems.push('PC-Bereiche in den Einstellungen sichtbar');
  await shot('08-einstellungen');
  console.log(problems.length ? `[android] PROBLEME:\n - ${problems.join('\n - ')}` : '[android] Keine Probleme gefunden ✓');
  app.exit(problems.length ? 1 : 0);
});
