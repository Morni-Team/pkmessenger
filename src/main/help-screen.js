'use strict';

// Fernhilfe – Bild für den Helfer (#158, Wunsch JONIMONI09: „man soll die App sehen können“).
// Der Helfer bekommt ein echtes Bild der App, aber NUR vom erlaubten Bereich (Einstellungs-Fenster bzw. Einrichtung).
// Alles außerhalb davon, Chats, Benachrichtigungen, KI-Gedächtnis, Passwort-/Geheimnis-Felder wird HIER im
// Hauptprozess schwarz übermalt – bevor das Bild den PC verlässt. Im Chat-Bereich gibt es gar kein Bild.
const { redactView } = require('../shared/help-redact');

const MAX_WIDTH = 1280;
const JPEG_QUALITY = 55;
const FILL = [17, 17, 23]; // fast schwarz (BGR)

/** Rechteck (Anteile 0…1) → Pixel, auf das Bild begrenzt. */
function toPixels(r, width, height) {
  const x0 = Math.max(0, Math.floor(r.x * width));
  const y0 = Math.max(0, Math.floor(r.y * height));
  const x1 = Math.min(width, Math.ceil((r.x + r.w) * width));
  const y1 = Math.min(height, Math.ceil((r.y + r.h) * height));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/** Alles AUSSERHALB des erlaubten Rechtecks als (höchstens 4) Rechtecke. */
function outside(a) {
  return [
    { x: 0, y: 0, w: 1, h: a.y }, // oben
    { x: 0, y: a.y + a.h, w: 1, h: 1 - (a.y + a.h) }, // unten
    { x: 0, y: a.y, w: a.x, h: a.h }, // links
    { x: a.x + a.w, y: a.y, w: 1 - (a.x + a.w), h: a.h }, // rechts
  ].filter((r) => r.w > 0 && r.h > 0);
}

/** Rechtecke in einem BGRA-Bitmap (Buffer) übermalen. Rein, ohne Electron – testbar. */
function maskBitmap(buf, width, height, rects) {
  for (const r of rects) {
    const p = toPixels(r, width, height);
    if (!p) continue;
    for (let y = p.y0; y < p.y1; y += 1) {
      let i = (y * width + p.x0) * 4;
      for (let x = p.x0; x < p.x1; x += 1, i += 4) {
        buf[i] = FILL[0];
        buf[i + 1] = FILL[1];
        buf[i + 2] = FILL[2];
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

/** Welche Stellen müssen schwarz? (erlaubter Bereich fehlt → alles) */
function rectsToHide(v) {
  if (!v.allowed) return [{ x: 0, y: 0, w: 1, h: 1 }];
  const secrets = (v.fields || []).filter((f) => f.secret && f.rect).map((f) => f.rect);
  return [...outside(v.allowed), ...(v.masks || []), ...secrets];
}

/**
 * Bild für den Helfer aufnehmen. capture() → Promise<nativeImage>; nativeImage = Electron-Modul (createFromBitmap).
 * @returns {Promise<{ img: string, w: number, h: number } | null>}
 */
const sameRect = (a, b) => Boolean(a && b) && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) < 0.003);

async function captureForHelper({ view, capture, nativeImage, freshView = null, maxWidth = MAX_WIDTH, quality = JPEG_QUALITY }) {
  // #164: Wenn möglich die AKTUELLE Ansicht direkt vor und nach der Aufnahme nehmen (nicht die bis zu 700 ms alte).
  // Passen vorher/nachher nicht zusammen (z. B. Einstellungen werden gerade geschlossen), wird das Bild verworfen.
  const before = freshView ? await freshView().catch(() => null) : view;
  if (freshView && !before) return null;
  let v = redactView(before);
  if (v.hidden || !v.allowed) return null; // Chat-Bereich oder unbekannt: kein Bild
  const img = await capture();
  if (freshView) {
    const after = redactView(await freshView().catch(() => null));
    if (after.hidden || after.screen !== v.screen || !sameRect(after.allowed, v.allowed)) return null;
    // geschwärzt wird beides: private Stellen von vorher UND nachher
    v = { ...v, masks: [...(v.masks || []), ...(after.masks || [])], fields: [...(v.fields || []), ...(after.fields || [])] };
  }
  if (!img || img.isEmpty?.()) return null;
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  if (!width || !height || bmp.length !== width * height * 4) return null; // unerwartetes Format → lieber kein Bild
  maskBitmap(bmp, width, height, rectsToHide(v));
  let out = nativeImage.createFromBitmap(bmp, { width, height });
  if (width > maxWidth) out = out.resize({ width: maxWidth, quality: 'good' });
  const jpeg = out.toJPEG(quality);
  const size = out.getSize();
  return { img: `data:image/jpeg;base64,${jpeg.toString('base64')}`, w: size.width, h: size.height };
}

module.exports = { captureForHelper, maskBitmap, rectsToHide, outside, toPixels, sameRect };
