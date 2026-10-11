import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { bus } from '../state';
import { createVoiceEngine, micErrorText } from './engine';

/** Zustand + Aktionen für Sprachkanäle (Beitreten, Mikro, Ton, Auflegen) und Teilnehmerlisten je Server. */
export function useVoice({ toast, guildIds }) {
  const [voice, setVoice] = useState({ state: 'idle' });
  const [members, setMembers] = useState({}); // guildId → { channelId → [Teilnehmer] }
  const [speaking, setSpeaking] = useState(() => new Set());
  const [micLevel, setMicLevel] = useState(0);
  const engineRef = useRef(null);
  const lastLevel = useRef(0);

  const engine = useCallback(() => {
    if (!engineRef.current)
      engineRef.current = createVoiceEngine({
        onLevel: (l) => {
          // Pegelanzeige drosseln: nur sichtbare Änderungen rendern
          if (Math.abs(l - lastLevel.current) > 0.05 || l === 0) {
            lastLevel.current = l;
            setMicLevel(l);
          }
        },
      });
    return engineRef.current;
  }, []);

  const loadMembers = useCallback(async (gid) => {
    try {
      const m = await api.listVoiceMembers({ guildId: gid });
      setMembers((all) => ({ ...all, [gid]: m }));
    } catch {
      /* Teilnehmerliste ist optional */
    }
  }, []);

  useEffect(() => {
    for (const gid of guildIds) loadMembers(gid);
  }, [guildIds, loadMembers]);

  useEffect(() => {
    api.voiceState().then(setVoice).catch(() => {});
    const timers = new Map();
    const off = bus.on((type, p) => {
      if (type === 'voice:state') {
        setVoice(p);
        if (p.state === 'idle' || p.state === 'error') {
          engineRef.current?.stopMic();
          engineRef.current?.setPlayback(false);
          setSpeaking(new Set());
          if (p.ended) toast({ kind: 'warn', title: p.ended });
        }
      } else if (type === 'voice:speaking') {
        setSpeaking((s) => {
          if (s.has(p.userId) === p.speaking) return s;
          const n = new Set(s);
          p.speaking ? n.add(p.userId) : n.delete(p.userId);
          return n;
        });
      } else if (type === 'voice:members' && p.guildId) {
        clearTimeout(timers.get(p.guildId));
        timers.set(p.guildId, setTimeout(() => loadMembers(p.guildId), 250));
      }
    });
    return () => {
      off();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [loadMembers, toast]);

  useEffect(() => () => engineRef.current?.destroy(), []);

  const join = useCallback(
    async (channel) => {
      try {
        engine().resume(); // AudioContext im Klick starten (Autoplay-Regeln)
        await api.voiceJoin({ guildId: channel.guildId, channelId: channel.id, listen: true });
        engine().setPlayback(true);
      } catch (e) {
        // #156: schnell einen anderen Kanal gewählt → der alte Beitritt wird absichtlich abgebrochen, kein Fehler
        if (e.code === 'VOICE_ABORTED') return;
        toast({ kind: 'error', title: e.message, text: e.hint });
      }
    },
    [engine, toast],
  );

  const leave = useCallback(async () => {
    engineRef.current?.stopMic();
    engineRef.current?.setPlayback(false);
    await api.voiceLeave().catch(() => {});
  }, []);

  const toggleMic = useCallback(async () => {
    if (voice.talking) {
      engine().stopMic();
      await api.voiceTalk({ on: false }).catch(() => {});
      return;
    }
    try {
      await api.voiceTalk({ on: true });
    } catch (e) {
      toast({ kind: 'error', title: e.message, text: e.hint });
      return;
    }
    try {
      await engine().startMic();
    } catch (err) {
      await api.voiceTalk({ on: false }).catch(() => {});
      const t = micErrorText(err);
      toast({ kind: 'error', title: t.message, text: `Was kann ich tun? ${t.hint}`, duration: 9000 });
    }
  }, [voice.talking, engine, toast]);

  const toggleListen = useCallback(async () => {
    const next = !voice.listening;
    try {
      await api.voiceListen({ on: next });
      engine().setPlayback(next);
    } catch (e) {
      toast({ kind: 'error', title: e.message, text: e.hint });
    }
  }, [voice.listening, engine, toast]);

  return { voice, members, speaking, micLevel, join, leave, toggleMic, toggleListen };
}
