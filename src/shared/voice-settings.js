'use strict';

// Sprach-Einstellungen (Issue #1: „Rauschen entfernen“, „man hört sich doppelt“, „alles muten“).
// Reine Logik, getestet in tests/test-voice-settings.js. Audio selbst: src/renderer/voice/engine.js.

// RMS-Schwelle des Noise-Gates. #108: „stark“ lag bei 0.035 – zusammen mit der Rauschunterdrückung des Browsers
// (die den Pegel schon absenkt) blieb normale Sprache (RMS ~0.01–0.03) dauerhaft darunter → man hörte niemanden mehr.
const GATE_LEVELS = { aus: 0, normal: 0.006, stark: 0.012 };
const GATE_HOLD_MS = 450; // nach dem Sprechen offen lassen → keine abgeschnittenen Silben/Satzenden
// Geschlossenes Gate dämpft nur stark (~-22 dB) statt hart auf Stille – wird Sprache falsch eingestuft, ist sie
// trotzdem noch hörbar. Öffnen sofort, Schließen weich über ~80 ms (keine Klickgeräusche).
const GATE_FLOOR = 0.08;
const GATE_RELEASE_STEP = 0.25; // pro 20-ms-Block
const HIGHPASS_HZ = 80; // Trittschall/Brummen/Lüfter unterhalb der Stimme entfernen
const SNOWFLAKE = /^\d{17,20}$/;

const MIC_GAIN_MAX = 3; // #110: eigenes Mikrofon bis 300 % (andere Teilnehmer gehen bis 200 %)
// #177: KI-Rauschfilter (läuft komplett lokal im Audio-Thread, nichts geht ins Netz):
// rnnoise = sparsam und bewährt, gtcrn = neueres Modell (2024), filtert gründlicher, braucht etwas mehr Leistung
const AI_FILTERS = ['aus', 'rnnoise', 'gtcrn'];
const DEFAULT_VOICE_FX = Object.freeze({ echo: true, noise: true, agc: true, ai: 'rnnoise', gate: 'normal', micGain: 1, userMuted: {}, userVolume: {} });

function sanitizeVoiceFx(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ids = (o, ok) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k, v]) => SNOWFLAKE.test(k) && ok(v)));
  return {
    echo: typeof r.echo === 'boolean' ? r.echo : true,
    noise: typeof r.noise === 'boolean' ? r.noise : true,
    agc: typeof r.agc === 'boolean' ? r.agc : true,
    ai: AI_FILTERS.includes(r.ai) ? r.ai : 'rnnoise',
    gate: Object.hasOwn(GATE_LEVELS, r.gate) ? r.gate : 'normal',
    micGain: Number.isFinite(r.micGain) ? Math.min(MIC_GAIN_MAX, Math.max(0, r.micGain)) : 1,
    userMuted: ids(r.userMuted, (v) => v === true),
    userVolume: Object.fromEntries(Object.entries(ids(r.userVolume, (v) => Number.isFinite(v))).map(([k, v]) => [k, Math.min(2, Math.max(0, v))])),
  };
}

/** Lautstärke eines Teilnehmers für mich (0 = stumm). */
function userGain(fx, userId) {
  if (fx.userMuted[userId]) return 0;
  return fx.userVolume[userId] ?? 1;
}

/** Mikrofon-Optionen für getUserMedia. */
function micConstraints(fx, micId) {
  // voiceIsolation (W3C mediacapture-extensions, #108): trennt die Stimme vom Hintergrund, wo der Browser es kann –
  // sonst wird die Option einfach ignoriert. Hängt an „Rauschunterdrückung“.
  // #177: Ist der KI-Rauschfilter an, ersetzt er die Browser-Rauschunterdrückung – doppelt filtern klingt „unter Wasser“.
  const browserNs = fx.noise && (fx.ai || 'aus') === 'aus';
  return { echoCancellation: fx.echo, noiseSuppression: browserNs, autoGainControl: fx.agc, voiceIsolation: browserNs, channelCount: 1, ...(micId ? { deviceId: { ideal: micId } } : {}) };
}

/**
 * Noise-Gate: Soll dieser 20-ms-Block gesendet werden (sonst Stille)?
 * @returns {{ open: boolean, openUntil: number }}
 */
function gateStep(level, gate, now, openUntil) {
  const threshold = GATE_LEVELS[gate] ?? 0;
  if (threshold === 0) return { open: true, openUntil };
  if (level >= threshold) return { open: true, openUntil: now + GATE_HOLD_MS };
  return { open: now < openUntil, openUntil };
}

/** #110: eigene Mikrofon-Verstärkung auf einen Block anwenden (mit Begrenzung gegen Übersteuern). */
function applyMicGain(frame, gain) {
  if (!Number.isFinite(gain) || gain === 1) return frame;
  for (let i = 0; i < frame.length; i++) frame[i] = Math.max(-1, Math.min(1, frame[i] * gain));
  return frame;
}

/**
 * Verstärkung für den nächsten Block: offen → sofort 1, geschlossen → weich bis GATE_FLOOR absenken (nie 0).
 * @returns {number} Faktor 0..1
 */
function gateGain(prev, open) {
  if (open) return 1;
  return Math.max(GATE_FLOOR, (Number.isFinite(prev) ? prev : 1) - GATE_RELEASE_STEP);
}

module.exports = { GATE_LEVELS, GATE_HOLD_MS, GATE_FLOOR, HIGHPASS_HZ, MIC_GAIN_MAX, AI_FILTERS, DEFAULT_VOICE_FX, sanitizeVoiceFx, userGain, micConstraints, gateStep, gateGain, applyMicGain };
