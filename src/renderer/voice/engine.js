// Sprach-Engine im Renderer:
//  Mikrofon → AudioWorklet → 20-ms-Frames → WebCodecs-Opus-Encoder → Pakete an den Main-Prozess (Bot spricht)
//  Opus-Pakete der anderen → WebCodecs-Opus-Decoder je Sprecher → Lautsprecher (mit kleinem Jitter-Puffer)
// Es wird nichts gespeichert oder aufgezeichnet.
import { voicePacket, onVoiceAudio } from '../api';
import { prefs } from '../prefs';
import { SAMPLE_RATE, FRAME_SAMPLES, CHANNELS, createFrameAssembler, rms, nextPlayTime } from '../../shared/audio-frames';
import { micConstraints, gateStep, gateGain, userGain, applyMicGain, HIGHPASS_HZ } from '../../shared/voice-settings';
import { createDenoiser } from './denoise';

const OPUS_CONFIG = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate: 64000, opus: { frameDuration: 20000 } };

export function micErrorText(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return { message: 'Kein Zugriff aufs Mikrofon.', hint: 'Windows-Einstellungen → Datenschutz & Sicherheit → Mikrofon → „Desktop-Apps den Zugriff erlauben“ einschalten.' };
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { message: 'Kein Mikrofon gefunden.', hint: 'Mikrofon/Headset anschließen und erneut versuchen.' };
  if (name === 'NotReadableError') return { message: 'Das Mikrofon wird gerade von einem anderen Programm benutzt.', hint: 'Andere Programme (z. B. Teams, Zoom) schließen und erneut versuchen.' };
  return { message: 'Mikrofon konnte nicht gestartet werden.', hint: String(err?.message || err || '') };
}

// Zähler für Diagnose/automatische Tests (nur Zahlen, keine Audiodaten).
const stats = (window.__pkVoiceStats = { encoded: 0, decoded: 0, played: 0, gated: 0, skippedMuted: 0, denoise: 'aus' });

export function createVoiceEngine({ onLevel = () => {} } = {}) {
  let ctx = null;
  let master = null;
  let mic = null; // { stream, source, node, encoder, assembler }
  let playback = false;
  const decoders = new Map(); // userId → { decoder, until, ts }
  let offAudio = null;

  function applyOutput(p) {
    if (!ctx) return;
    if (master) master.gain.value = p.volume;
    // Lautstärke je Teilnehmer (0 = für mich stumm)
    for (const [userId, d] of decoders) if (d.gain) d.gain.gain.value = userGain(p.voiceFx, userId);
    // Lautsprecher-Auswahl (Chromium: AudioContext.setSinkId); '' = Windows-Standard
    if (typeof ctx.setSinkId === 'function') ctx.setSinkId(p.outputDeviceId || '').catch(() => {});
  }

  function ensureContext() {
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
      master = ctx.createGain();
      master.connect(ctx.destination);
      applyOutput(prefs.get());
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  const micKey = (p) => JSON.stringify([p.micDeviceId, p.voiceFx.echo, p.voiceFx.noise, p.voiceFx.agc, p.voiceFx.ai]);
  let lastMic = micKey(prefs.get());
  const offPrefs = prefs.subscribe((p) => {
    applyOutput(p);
    // Anderes Mikrofon oder Echo/Rauschen/Automatik geändert, während das Mikro an ist → nahtlos neu starten
    if (micKey(p) !== lastMic) {
      lastMic = micKey(p);
      if (mic) {
        stopMic();
        startMic().catch(() => {});
      }
    }
  });

  // ---------- Sprechen ----------
  async function startMic() {
    if (mic) return;
    const c = ensureContext();
    const p = prefs.get();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(p.voiceFx, p.micDeviceId), video: false });
    try {
      await c.audioWorklet.addModule('voice-worklet.js');
    } catch {
      /* bereits geladen */
    }
    const source = c.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(c, 'pk-capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    const assembler = createFrameAssembler();
    let ts = 0;
    let levelTick = 0;
    let gateOpenUntil = 0; // Noise-Gate (Issue #1: „Rauschen entfernen“)
    let gateLevel = 1; // #108: weiches Absenken statt harter Stille
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        stats.encoded++;
        voicePacket(bytes);
      },
      error: (e) => console.warn('[Sprache] Encoder-Fehler', e),
    });
    encoder.configure(OPUS_CONFIG);
    node.port.onmessage = (ev) => {
      const block = ev.data;
      if (++levelTick % 8 === 0) onLevel(Math.min(1, rms(block) * 4));
      for (const frame of assembler.push(block)) {
        if (encoder.state !== 'configured') return;
        const fxNow = prefs.get().voiceFx;
        applyMicGain(frame, fxNow.micGain); // #110: eigenes Mikrofon lauter/leiser
        const g = gateStep(rms(frame), fxNow.gate, performance.now(), gateOpenUntil);
        gateOpenUntil = g.openUntil;
        const target = gateGain(gateLevel, g.open);
        if (target < 1 || gateLevel < 1) {
          // linear vom alten zum neuen Faktor über den Block → keine Klicks
          const n = frame.length;
          for (let i = 0; i < n; i++) frame[i] *= gateLevel + ((target - gateLevel) * i) / n;
        }
        gateLevel = target;
        if (!g.open) stats.gated++;
        const data = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: FRAME_SAMPLES, numberOfChannels: CHANNELS, timestamp: ts, data: frame });
        ts += 20000;
        encoder.encode(data);
        data.close();
      }
    };
    // #108: Hochpass gegen Brummen/Trittschall/Lüfter unterhalb der Stimme
    const highpass = c.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = HIGHPASS_HZ;
    source.connect(highpass);
    // #177: KI-Rauschfilter zwischen Hochpass und Aufnahme. Klappt er nicht (Laden/Rechnen), geht es ohne weiter –
    // lieber ungefiltert als stumm.
    let denoise = null;
    try {
      denoise = await createDenoiser(c, p.voiceFx.ai);
    } catch (e) {
      console.warn('[Sprache] KI-Rauschfilter nicht verfügbar – weiter ohne', e);
    }
    if (denoise) {
      highpass.connect(denoise);
      denoise.connect(node);
      denoise.onprocessorerror = () => {
        console.warn('[Sprache] KI-Rauschfilter ausgefallen – weiter ohne');
        stats.denoise = 'fehler';
        try {
          highpass.disconnect();
          denoise.disconnect();
        } catch {
          /* egal */
        }
        highpass.connect(node);
      };
      stats.denoise = p.voiceFx.ai;
    } else {
      highpass.connect(node);
      stats.denoise = 'aus';
    }
    mic = { stream, source, highpass, denoise, node, encoder, assembler };
  }

  function stopMic() {
    if (!mic) return;
    const m = mic;
    mic = null;
    m.node.port.onmessage = null;
    try {
      m.source.disconnect();
      m.highpass?.disconnect();
      m.denoise?.disconnect();
      m.denoise?.destroy?.(); // WASM-Speicher im Audio-Thread freigeben
      m.node.disconnect();
    } catch {
      /* egal */
    }
    for (const t of m.stream.getTracks()) t.stop(); // Mikrofon wirklich freigeben (Windows-Mikro-Symbol erlischt)
    if (m.encoder.state !== 'closed') m.encoder.close();
    onLevel(0);
  }

  // ---------- Zuhören ----------
  function decoderFor(userId) {
    let d = decoders.get(userId);
    if (d && d.decoder.state !== 'closed') return d;
    d = { until: 0, ts: 0, decoder: null, gain: null };
    if (ctx) {
      // Eigener Regler je Teilnehmer (für mich stumm / leiser / lauter)
      d.gain = ctx.createGain();
      d.gain.gain.value = userGain(prefs.get().voiceFx, userId);
      d.gain.connect(master);
    }
    d.decoder = new AudioDecoder({
      output: (audio) => {
        try {
          stats.decoded++;
          if (!playback || !ctx) return;
          const frames = audio.numberOfFrames;
          const chans = Math.min(audio.numberOfChannels, 2);
          const buffer = ctx.createBuffer(2, frames, audio.sampleRate);
          for (let ch = 0; ch < 2; ch++) {
            const tmp = new Float32Array(frames);
            audio.copyTo(tmp, { planeIndex: Math.min(ch, chans - 1), format: 'f32-planar' });
            buffer.copyToChannel(tmp, ch);
          }
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(d.gain || master);
          const at = nextPlayTime(ctx.currentTime, d.until);
          src.start(at);
          stats.played++;
          d.until = at + buffer.duration;
        } finally {
          audio.close();
        }
      },
      error: () => decoders.delete(userId), // kaputtes Paket → Decoder neu anlegen
    });
    d.decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS });
    decoders.set(userId, d);
    return d;
  }

  function setPlayback(on) {
    playback = on;
    if (on) {
      ensureContext();
      if (!offAudio)
        offAudio = onVoiceAudio((userId, data) => {
          if (!playback) return;
          if (prefs.get().voiceFx.userMuted[userId]) {
            stats.skippedMuted++; // für mich stumm → gar nicht erst dekodieren (spart Rechenleistung)
            return;
          }
          const d = decoderFor(userId);
          try {
            d.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: (d.ts += 20000), data }));
          } catch {
            decoders.delete(userId);
          }
        });
    } else {
      offAudio?.();
      offAudio = null;
      for (const d of decoders.values()) {
        if (d.decoder.state !== 'closed') d.decoder.close();
        d.gain?.disconnect();
      }
      decoders.clear();
    }
  }

  function setVolume(v) {
    if (master) master.gain.value = Math.max(0, Math.min(2, v));
  }

  function destroy() {
    offPrefs();
    stopMic();
    setPlayback(false);
    if (ctx) ctx.close();
    ctx = null;
    master = null;
  }

  return { startMic, stopMic, setPlayback, setVolume, destroy, isMicOn: () => Boolean(mic), resume: ensureContext };
}
