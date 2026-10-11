// NUR im Demo-Build für den Emulator-Test der CI (nie in der echten APK): klickt sich selbst durch die App und
// schreibt Ergebnisse ins Android-Protokoll (logcat, Markierung [pk-autoplay]). Die CI macht dazu Screenshots.
const log = (msg) => console.log(`[pk-autoplay] ${msg}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const results = {};

window.addEventListener('error', (e) => log(`FEHLER ${e.message}`));
window.addEventListener('unhandledrejection', (e) => log(`FEHLER ${e.reason?.message || e.reason}`));

(async () => {
  try {
    localStorage.setItem('pk.tour.v1', JSON.stringify({ status: 'skipped' }));
  } catch {
    /* egal */
  }
  // #160: Datenschutz beim ersten Start – wie ein Mensch bis unten lesen und zustimmen (testet die Abfrage gleich mit)
  for (let i = 0; i < 20 && !$('.privacy'); i++) await wait(250);
  if ($('.privacy')) {
    const box = $('.privacy__text');
    if (box) {
      box.scrollTop = box.scrollHeight;
      box.dispatchEvent(new Event('scroll'));
    }
    await wait(300);
    const btn = $('.privacy .btn--primary');
    results.datenschutz = btn && !btn.disabled ? 'ok' : 'Knopf gesperrt';
    btn?.click();
    log(`Datenschutz: ${results.datenschutz}`);
    await wait(800);
  }
  // Schritt 1 (CI-Bild 1): Chatliste – warten, bis verbunden und Chats da sind (Emulator ist unterschiedlich schnell)
  // Nur echte Zeilen zählen: beim Laden stehen kurz Platzhalter (.chatrow--skeleton) da (Lauf 37755403447)
  const realRows = () => document.querySelectorAll('.chatrow:not(.chatrow--skeleton)').length;
  for (let i = 0; i < 120 && realRows() === 0; i++) await wait(500);
  await wait(1500);
  results.chats = realRows();
  results.verbunden = /Verbunden/.test($('.chatlist')?.textContent || '');
  log(`schritt 1 liste chats=${results.chats} verbunden=${results.verbunden}`);
  [...document.querySelectorAll('.chatrow')].find((r) => r.textContent.includes('allgemein'))?.click();
  await wait(8000); // Schritt 2 (CI-Bild 2): Chat + Live-Nachricht
  const ta = $('.composer textarea');
  if (ta) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, 'Hallo vom Android-Emulator 🤖');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  await wait(2000);
  results.gesendet = [...document.querySelectorAll('.msg--out')].some((m) => m.textContent.includes('Android-Emulator'));
  log(`schritt 2 chat gesendet=${results.gesendet}`);
  await wait(6000); // Schritt 3 (CI-Bild 3): Menü per langem Druck
  const m = [...document.querySelectorAll('.msg')].at(-2);
  if (m) {
    const r = m.getBoundingClientRect();
    m.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 10 }));
  }
  await wait(1500);
  results.menue = Boolean($('.ctx-menu'));
  log(`schritt 3 menue=${results.menue}`);
  await wait(6000);
  window.dispatchEvent(new CustomEvent('pk:back', { detail: { exit: () => {} } }));
  await wait(300);
  window.dispatchEvent(new CustomEvent('pk:back', { detail: { exit: () => {} } }));
  await wait(1000);
  results.zurueck = /layout--list/.test($('.layout')?.className || '');
  $('.chatlist__head .icon-btn[aria-label="Einstellungen"]')?.click();
  await wait(2000); // Schritt 4 (CI-Bild 4): Einstellungen
  results.einstellungen = Boolean($('.settings'));
  results.ueberstand = document.documentElement.scrollWidth > innerWidth + 1;
  // Echter Netzweg (CapacitorHttp → CSP 'self'): die Update-Abfrage bei GitHub darf nicht scheitern
  const st = await window.api.getAppInfo();
  const u = st?.data?.update || {};
  // Eine Antwort von GitHub (auch „zu viele Abfragen“ von geteilten CI-Rechnern) beweist den Netzweg; blockiert wäre „Failed to fetch“
  results.update = u.state === 'error' && /GitHub antwortet/.test(u.error?.detail || '') ? 'antwort' : u.state || 'unbekannt';
  if (u.state === 'error') log(`update-fehler ${JSON.stringify(u.error)}`);
  log(`schritt 4 einstellungen=${results.einstellungen} zurueck=${results.zurueck} ueberstand=${results.ueberstand} update=${results.update}`);
  const ok = results.chats > 0 && results.verbunden && results.gesendet && results.menue && results.zurueck && results.einstellungen && !results.ueberstand;
  log(`ERGEBNIS ${ok ? 'OK' : 'FEHLER'} ${JSON.stringify(results)}`);
})();
