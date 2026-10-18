// #177: KI-Rauschfilter fürs Mikrofon (Wunsch JONIMONI09: „hört sich schrecklich an, Rauschen, Headset“).
// Läuft komplett lokal als AudioWorklet (WebAssembly) – kein Netz, keine Aufnahme. Bibliothek:
// @sapphi-red/web-noise-suppressor (MIT). Die WASM-Dateien stecken im Bundle (CSP: connect-src 'none' → kein fetch),
// die Worklet-Skripte kopiert build-renderer.js als eigene Dateien daneben (CSP: script-src 'self').
import { RnnoiseWorkletNode, GtcrnWorkletNode } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm';
import gtcrnWasm from '@sapphi-red/web-noise-suppressor/gtcrn.wasm';

const MODELS = {
  rnnoise: { worklet: 'rnnoise-worklet.js', wasm: rnnoiseWasm, Node: RnnoiseWorkletNode },
  gtcrn: { worklet: 'gtcrn-worklet.js', wasm: gtcrnWasm, Node: GtcrnWorkletNode },
};
const loaded = new WeakMap(); // AudioContext → geladene Worklets

/**
 * Filter-Knoten für den gewählten Modus anlegen (beide Modelle erwarten 48 kHz – so läuft unser AudioContext).
 * @returns {Promise<AudioWorkletNode|null>} null bei „aus“ oder unbekanntem Modus
 */
export async function createDenoiser(ctx, mode) {
  const m = MODELS[mode];
  if (!m || !m.Node) return null;
  let done = loaded.get(ctx);
  if (!done) loaded.set(ctx, (done = new Set()));
  if (!done.has(mode)) {
    await ctx.audioWorklet.addModule(m.worklet);
    done.add(mode);
  }
  // eigene Kopie: der Worklet-Thread bekommt sein eigenes ArrayBuffer (wird beim Übergeben kopiert)
  return new m.Node(ctx, { maxChannels: 1, wasmBinary: m.wasm.slice().buffer });
}
