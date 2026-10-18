import { useEffect, useRef, useState } from 'react';
import { prefs } from '../prefs';
import { micConstraints, gateStep, gateGain, HIGHPASS_HZ, MIC_GAIN_MAX } from '../../shared/voice-settings';
import { rms } from '../../shared/audio-frames';
import { createDenoiser } from '../voice/denoise';

// Sprachkanal-Audio (Issue #1): Filter, Audio-Test, Hilfe bei Problemen
export default function VoiceFxSection() {
  const [p, setP] = useState(prefs.get());
  useEffect(() => prefs.subscribe(setP), []);
  const fx = p.voiceFx;
  const set = (patch) => prefs.set({ voiceFx: { ...fx, ...patch } });

  // Mikrofon-Test: Pegel anzeigen, optional sich selbst hören (mit den gewählten Filtern + Noise-Gate)
  const [test, setTest] = useState(null); // { level, open }
  const [loop, setLoop] = useState(false);
  const run = useRef(null);
  const stopTest = () => {
    const r = run.current;
    run.current = null;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    r.stream.getTracks().forEach((t) => t.stop());
    r.ctx.close().catch(() => {});
    setTest(null);
  };
  useEffect(() => stopTest, []);

  const startTest = async () => {
    stopTest();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(fx, p.micDeviceId), video: false });
      const ctx = new AudioContext({ sampleRate: 48000 }); // wie im Anruf (KI-Filter brauchen 48 kHz)
      if (typeof ctx.setSinkId === 'function') ctx.setSinkId(p.outputDeviceId || '').catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const gate = ctx.createGain();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.25; // leicht verzögert, damit man sich nicht „im Kopf“ hört
      // #108: wie im Anruf – Hochpass gegen Brummen, dann Gate
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = HIGHPASS_HZ;
      src.connect(hp);
      // #177: KI-Rauschfilter wie im Anruf – der Test soll genau so klingen, wie die anderen dich hören
      let out = hp;
      try {
        const dn = await createDenoiser(ctx, fx.ai);
        if (dn) out = hp.connect(dn);
      } catch {
        /* ohne KI-Filter weiter */
      }
      out.connect(analyser);
      out.connect(gate).connect(delay);
      const buf = new Float32Array(analyser.fftSize);
      const r = { stream, ctx, delay, raf: 0, openUntil: 0, gain: 1 };
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        const mg = prefs.get().voiceFx.micGain ?? 1;
        const level = rms(buf) * mg; // #110: Test zeigt den Pegel inkl. eigener Verstärkung
        const g = gateStep(level, prefs.get().voiceFx.gate, performance.now(), r.openUntil);
        r.openUntil = g.openUntil;
        r.gain = gateGain(r.gain, g.open);
        gate.gain.value = r.gain * mg; // weich absenken statt harter Stille (wie im Anruf) + eigener Pegel
        setTest({ level: Math.min(1, level * 4), open: g.open });
        r.raf = requestAnimationFrame(tick);
      };
      run.current = r;
      tick();
    } catch (e) {
      setTest({ error: e?.name === 'NotAllowedError' ? 'Kein Zugriff aufs Mikrofon (Windows-Datenschutz-Einstellungen prüfen).' : 'Mikrofon konnte nicht gestartet werden.' });
    }
  };

  useEffect(() => {
    const r = run.current;
    if (!r) return;
    try {
      if (loop) r.delay.connect(r.ctx.destination);
      else r.delay.disconnect();
    } catch {
      /* noch nicht verbunden */
    }
  }, [loop, test === null]);

  const speakerTest = () => {
    const ctx = new AudioContext();
    if (typeof ctx.setSinkId === 'function') ctx.setSinkId(p.outputDeviceId || '').catch(() => {});
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 660;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25 * Math.max(0.05, p.volume), ctx.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.85);
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  };

  return (
    <>
      <span className="settings__label">Filter fürs Mikrofon</span>
      <label className="composer__ping">
        <input type="checkbox" checked={fx.noise} onChange={(e) => set({ noise: e.target.checked })} /> Rauschunterdrückung
      </label>
      <label className="composer__ping">
        <input type="checkbox" checked={fx.echo} onChange={(e) => set({ echo: e.target.checked })} /> Echo-Unterdrückung (wichtig ohne Headset)
      </label>
      <label className="composer__ping">
        <input type="checkbox" checked={fx.agc} onChange={(e) => set({ agc: e.target.checked })} /> Automatische Lautstärke
      </label>
      <label className="settings__label" htmlFor="ai-select">
        KI-Rauschfilter
      </label>
      <select id="ai-select" value={fx.ai || 'aus'} onChange={(e) => set({ ai: e.target.value })}>
        <option value="rnnoise">RNNoise – filtert Rauschen, Lüfter, Tippen (sparsam)</option>
        <option value="gtcrn">GTCRN – beste Qualität (braucht etwas mehr Rechenleistung)</option>
        <option value="aus">Aus – nur der Filter von Windows/Chrome</option>
      </select>
      <p className="muted small">Läuft komplett auf deinem PC, nichts wird hochgeladen. Ist er an, ersetzt er die einfache Rauschunterdrückung oben.</p>
      <label className="settings__label" htmlFor="gate-select">
        Geräuschsperre (Noise-Gate)
      </label>
      <select id="gate-select" value={fx.gate} onChange={(e) => set({ gate: e.target.value })}>
        <option value="aus">Aus</option>
        <option value="normal">Normal – leises Rauschen wird nicht gesendet</option>
        <option value="stark">Stark – nur deutliche Sprache wird gesendet</option>
      </select>

      <label className="settings__label" htmlFor="mic-gain">
        Mein Mikrofon-Pegel: {Math.round((fx.micGain ?? 1) * 100)} %
      </label>
      <div className="settings__row">
        <input
          id="mic-gain"
          type="range"
          min="0"
          max={MIC_GAIN_MAX}
          step="0.1"
          value={fx.micGain ?? 1}
          aria-label="Mein Mikrofon lauter oder leiser"
          onChange={(e) => set({ micGain: Number(e.target.value) })}
        />
        <button className="btn btn--ghost btn--small" onClick={() => set({ micGain: 1 })} disabled={(fx.micGain ?? 1) === 1}>
          Zurück auf 100 %
        </button>
      </div>
      <p className="muted small">So laut hören dich die anderen. Zu leise? Höher stellen und im Audio-Test prüfen. Bei „Automatische Lautstärke“ gleicht der Browser zusätzlich aus.</p>

      <span className="settings__label">Audio-Test</span>
      <div className="settings__row">
        {test && !test.error ? (
          <button className="btn btn--small" onClick={stopTest}>
            ⏹ Test beenden
          </button>
        ) : (
          <button className="btn btn--small" onClick={startTest}>
            🎙 Mikrofon testen
          </button>
        )}
        <button className="btn btn--small" onClick={speakerTest}>
          🔊 Lautsprecher testen
        </button>
        {test && !test.error && (
          <label className="composer__ping">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Mich selbst hören
          </label>
        )}
      </div>
      {test && !test.error && (
        <div className="mic-test" role="status" aria-label="Mikrofon-Pegel">
          <span className="level level--wide" aria-hidden="true">
            <i style={{ transform: `scaleX(${Math.max(0.02, test.level)})` }} />
          </span>
          <span className={`small ${test.open ? 'ok' : 'muted'}`}>{test.open ? '● wird gesendet' : '○ Geräuschsperre: Stille'}</span>
        </div>
      )}
      {test?.error && <p className="warn small">{test.error}</p>}

      <details className="voice-help">
        <summary>❓ Hilfe bei Ton-Problemen</summary>
        <ul className="small">
          <li>
            <b>Du hörst dich doppelt?</b> Dann bist du wahrscheinlich zusätzlich mit deinem Discord-Account im selben Sprachkanal. Im Anruf bei deinem Namen auf „🔈 hören“ klicken → „🔇 für mich stumm“.
          </li>
          <li>
            <b>Rauschen oder Brummen?</b> KI-Rauschfilter auf „RNNoise“ oder „GTCRN“ stellen; Geräuschsperre zuerst auf „Normal“. Nur bei lauter Umgebung „Stark“ – und im Mikro-Test prüfen, dass deine Stimme als „● wird gesendet“ erscheint.
          </li>
          <li>
            <b>Andere hören ein Echo?</b> Echo-Unterdrückung einschalten oder ein Headset benutzen.
          </li>
          <li>
            <b>Niemanden hören?</b> Im Anruf „Ton an“ prüfen, Lautsprecher oben richtig wählen, „🔊 Lautsprecher testen“.
          </li>
          <li>
            <b>Mikro geht nicht?</b> Windows → Datenschutz &amp; Sicherheit → Mikrofon → „Desktop-Apps den Zugriff erlauben“.
          </li>
        </ul>
      </details>
    </>
  );
}
