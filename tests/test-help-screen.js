'use strict';

// #158: Der Helfer sieht ein echtes Bild der App – aber nur den erlaubten Bereich. Alles andere wird im Hauptprozess
// geschwärzt, bevor das Bild den PC verlässt. Im Chat-Bereich gibt es gar kein Bild.
const test = require('node:test');
const assert = require('node:assert/strict');
const { captureForHelper, maskBitmap, rectsToHide, outside } = require('../src/main/help-screen');
const { redactView, allowHelperAction } = require('../src/shared/help-redact');

// Mini-„nativeImage“: Bitmap im Speicher, damit wir prüfen können, welche Pixel geschwärzt wurden
function fakeImage(width, height, fill = 200) {
  const buf = Buffer.alloc(width * height * 4, fill);
  return { getSize: () => ({ width, height }), toBitmap: () => buf, isEmpty: () => false, buf };
}
const fakeNative = {
  createFromBitmap: (buf, size) => ({ buf, getSize: () => size, resize: function () { return this; }, toJPEG: () => Buffer.from('jpeg') }),
};
const px = (buf, w, x, y) => buf[(y * w + x) * 4];

test('Außerhalb des Einstellungs-Fensters, private Stellen und Geheimnis-Felder werden schwarz – der Rest bleibt', async () => {
  const img = fakeImage(100, 100);
  let captured = null;
  const view = {
    screen: 'settings',
    allowed: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 },
    masks: [{ x: 0.3, y: 0.3, w: 0.1, h: 0.1 }], // z. B. eine Benachrichtigung mit Nachrichtentext
    fields: [
      { id: 'h1', label: 'Weiter', rect: { x: 0.5, y: 0.5, w: 0.1, h: 0.05 } },
      { id: 'h2', label: 'App-Passwort', secret: true, rect: { x: 0.6, y: 0.7, w: 0.1, h: 0.05 } },
    ],
  };
  const out = await captureForHelper({ view, capture: async () => ((captured = img), img), nativeImage: fakeNative });
  assert.match(out.img, /^data:image\/jpeg;base64,/);
  const b = captured.buf;
  assert.notEqual(px(b, 100, 10, 10), 200); // außerhalb (Chats dahinter) → schwarz
  assert.notEqual(px(b, 100, 90, 50), 200);
  assert.notEqual(px(b, 100, 35, 35), 200); // private Stelle → schwarz
  assert.notEqual(px(b, 100, 65, 72), 200); // Passwort-Feld → schwarz
  assert.equal(px(b, 100, 55, 52), 200); // normaler Knopf → sichtbar
  assert.equal(px(b, 100, 50, 40), 200);
});

test('Chat-Bereich oder unbekannter Bereich: gar kein Bild', async () => {
  let called = false;
  const cap = async () => ((called = true), fakeImage(10, 10));
  assert.equal(await captureForHelper({ view: { screen: 'workspace', allowed: { x: 0, y: 0, w: 1, h: 1 } }, capture: cap, nativeImage: fakeNative }), null);
  assert.equal(await captureForHelper({ view: { screen: 'settings' }, capture: cap, nativeImage: fakeNative }), null); // ohne erlaubten Bereich
  assert.equal(called, false);
  // falsches Bitmap-Format → lieber kein Bild
  const odd = { getSize: () => ({ width: 10, height: 10 }), toBitmap: () => Buffer.alloc(7), isEmpty: () => false };
  assert.equal(await captureForHelper({ view: { screen: 'setup', allowed: { x: 0, y: 0, w: 1, h: 1 } }, capture: async () => odd, nativeImage: fakeNative }), null);
});

test('Rechtecke: außerhalb in 4 Teile, kaputte Werte fliegen raus, ohne erlaubten Bereich alles schwarz', () => {
  assert.equal(outside({ x: 0.2, y: 0.2, w: 0.6, h: 0.6 }).length, 4);
  assert.equal(outside({ x: 0, y: 0, w: 1, h: 1 }).length, 0);
  assert.deepEqual(rectsToHide({ allowed: null }), [{ x: 0, y: 0, w: 1, h: 1 }]);
  const v = redactView({ screen: 'settings', allowed: { x: 0, y: 0, w: 5, h: 1 }, masks: [{ x: 'a' }, { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }], cursor: { x: 0.5, y: 2 } });
  assert.equal(v.allowed, null); // w: 5 ist kein Anteil
  assert.equal(v.masks.length, 1);
  assert.equal(v.cursor, null);
  const buf = Buffer.alloc(4 * 4 * 4, 255);
  maskBitmap(buf, 4, 4, [{ x: 0, y: 0, w: 0.5, h: 0.5 }]);
  assert.equal(buf[0], 17);
  assert.equal(buf[(3 * 4 + 3) * 4], 255);
});

test('Maus: als Anteil 0…1 (passt bei jeder Größe); Helfer-Maus nur mit gültigen Werten', () => {
  const v = redactView({ screen: 'settings', cursor: { x: 0.25, y: 0.75 } });
  assert.deepEqual(v.cursor, { x: 0.25, y: 0.75 });
  assert.equal(redactView({ screen: 'workspace', cursor: { x: 0.25, y: 0.75 } }).cursor, null); // im Chat nie
  const view = { screen: 'settings', fields: [] };
  assert.equal(allowHelperAction({ type: 'cursor', x: 0.5, y: 0.5 }, { view }).ok, true);
  assert.equal(allowHelperAction({ type: 'cursor', x: 800, y: 600 }, { view }).ok, false);
});
