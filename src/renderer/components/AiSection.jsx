import { useCallback, useEffect, useState } from 'react';
import { api, onEvent } from '../api';
import Fold from './Fold';
import { fuzzyFilter } from '../../shared/fuzzy';
import { describeSchedule, DAY_NAMES } from '../../shared/schedule';
import { formatListTime } from '../../shared/format';

// KI-Agenten (Beta): beliebiger Anbieter, zeitgesteuerte Aufträge, Ergebnis postet der Bot.
const PRESETS = [
  { id: 'openai', label: 'OpenAI (ChatGPT)', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
  { id: 'anthropic', label: 'Anthropic (Claude)', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  { id: 'openrouter', label: 'OpenRouter (viele Modelle)', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { id: 'gemini', label: 'Google Gemini', provider: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '' },
  { id: 'groq', label: 'Groq', provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: '' },
  { id: 'mistral', label: 'Mistral', provider: 'openai', baseUrl: 'https://api.mistral.ai/v1', model: '' },
  { id: 'ollama', label: 'Ollama (lokal, ohne Schlüssel)', provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: '' },
  { id: 'lmstudio', label: 'LM Studio (lokal, ohne Schlüssel)', provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: '' },
  { id: 'llamacpp', label: 'llama.cpp-Server (lokal, ohne Schlüssel)', provider: 'openai', baseUrl: 'http://localhost:8080/v1', model: '' },
];
const presetOf = (cfg) => PRESETS.find((p) => p.provider === cfg.provider && p.baseUrl === cfg.baseUrl)?.id || 'custom';

const INTERVALS = [15, 30, 60, 120, 240, 720, 1440];
const intervalLabel = (m) => describeSchedule({ kind: 'interval', minutes: m });
const WEEK = [1, 2, 3, 4, 5, 6, 0];

const JOB_DEFAULTS = { maxLength: 1800, language: 'auto', persona: '', contextSize: 0, postAs: 'message', notify: true, web: false };
// Nur die Felder, die der Validator kennt (keine lastRun/nextRun usw. zurückschicken)
const jobPayload = (j) => ({
  ...(j.id ? { id: j.id } : {}),
  name: j.name,
  channelId: j.channelId,
  channelName: j.channelName,
  prompt: j.prompt,
  schedule: j.schedule,
  context: j.contextSize > 0,
  enabled: j.enabled,
  maxLength: j.maxLength,
  language: j.language,
  persona: j.persona,
  contextSize: j.contextSize,
  postAs: j.postAs,
  notify: j.notify,
  web: j.web,
});

/** Ziele nach Server gruppieren: [{ id, name, items }] – Privatchats zuletzt. */
function groupByServer(targets) {
  const map = new Map();
  for (const t of targets) {
    const id = t.guildId || '@dm';
    if (!map.has(id)) map.set(id, { id, name: t.guildName || 'Server', items: [] });
    map.get(id).items.push(t);
  }
  return [...map.values()].sort((a, b) => (a.id === '@dm') - (b.id === '@dm') || a.name.localeCompare(b.name));
}

// Erst Server wählen, dann Kanal (übersichtlich bei vielen Servern)
function ServerChannelPicker({ targets, value, onChange }) {
  const groups = groupByServer(targets);
  const current = targets.find((t) => t.id === value);
  const [serverId, setServerId] = useState(current?.guildId || groups[0]?.id || '');
  const group = groups.find((g) => g.id === serverId) || groups[0];
  return (
    <div className="settings__row ai-target">
      <select
        aria-label="Server"
        value={group?.id || ''}
        onChange={(e) => {
          setServerId(e.target.value);
          const first = groups.find((g) => g.id === e.target.value)?.items[0];
          if (first) onChange(first.id);
        }}
      >
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.id === '@dm' ? '💬' : '🖥'} {g.name}
          </option>
        ))}
      </select>
      <select id="ai-job-target" aria-label="Kanal" value={value} onChange={(e) => onChange(e.target.value)}>
        {(group?.items || []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.dm ? `💬 ${t.name}` : `#${t.name}`}
          </option>
        ))}
      </select>
    </div>
  );
}

function JobForm({ targets, initial, onSave, onCancel, toast }) {
  const [job, setJob] = useState({
    ...JOB_DEFAULTS,
    ...(initial || { name: '', channelId: targets[0]?.id || '', prompt: '', schedule: { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }, enabled: true }),
  });
  const [preview, setPreview] = useState(null); // { text, durationMs, model } | 'busy'
  const runPreview = async () => {
    setPreview('busy');
    try {
      setPreview(await api.aiPreviewJob(jobPayload({ ...job, channelName: targets.find((t) => t.id === job.channelId)?.label || '' })));
    } catch (e) {
      setPreview(null);
      toast?.({ kind: 'error', title: e.message, text: e.hint });
    }
  };
  const set = (patch) => setJob((j) => ({ ...j, ...patch }));
  const setSchedule = (patch) => setJob((j) => ({ ...j, schedule: { ...j.schedule, ...patch } }));
  const daily = job.schedule.kind === 'daily';
  const ok = job.name.trim() && job.prompt.trim().length >= 3 && job.channelId && (!daily || job.schedule.days.length > 0);

  return (
    <div className="ai-job-form">
      <label className="settings__label" htmlFor="ai-job-name">
        Name
      </label>
      <div className="settings__row">
        <input id="ai-job-name" value={job.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="z. B. Morgengruß" />
      </div>
      <label className="settings__label" htmlFor="ai-job-prompt">
        Auftrag an die KI <span className="muted small">{job.prompt.length}/2000</span>
      </label>
      <textarea
        id="ai-job-prompt"
        className="profile__desc"
        rows={3}
        maxLength={2000}
        value={job.prompt}
        onChange={(e) => set({ prompt: e.target.value })}
        placeholder="z. B. Schreib einen kurzen, lustigen Guten-Morgen-Gruß für den Server mit einem Tipp des Tages."
      />
      <label className="settings__label" htmlFor="ai-job-target">
        Wohin posten?
      </label>
      <ServerChannelPicker targets={targets} value={job.channelId} onChange={(channelId) => set({ channelId })} />
      <label className="settings__label">Wann?</label>
      <div className="settings__row">
        <select value={daily ? 'daily' : 'interval'} onChange={(e) => setSchedule(e.target.value === 'daily' ? { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5], minutes: undefined } : { kind: 'interval', minutes: 60, time: undefined, days: undefined })}>
          <option value="daily">Zu einer Uhrzeit</option>
          <option value="interval">Regelmäßig alle …</option>
        </select>
        {daily ? (
          <input type="time" value={job.schedule.time} onChange={(e) => setSchedule({ time: e.target.value })} aria-label="Uhrzeit" className="ai-time" />
        ) : (
          <select value={job.schedule.minutes} onChange={(e) => setSchedule({ minutes: Number(e.target.value) })} aria-label="Abstand">
            {INTERVALS.map((m) => (
              <option key={m} value={m}>
                {intervalLabel(m)}
              </option>
            ))}
          </select>
        )}
      </div>
      {daily && (
        <div className="ai-days" role="group" aria-label="Wochentage">
          {WEEK.map((d) => (
            <button
              key={d}
              className={job.schedule.days.includes(d) ? 'is-on' : ''}
              aria-pressed={job.schedule.days.includes(d)}
              onClick={() => setSchedule({ days: job.schedule.days.includes(d) ? job.schedule.days.filter((x) => x !== d) : [...job.schedule.days, d] })}
            >
              {DAY_NAMES[d]}
            </button>
          ))}
        </div>
      )}
      <div className="ai-opts">
        <label>
          Länge
          <select value={job.maxLength} onChange={(e) => set({ maxLength: Number(e.target.value) })}>
            {[300, 800, 1500, 1800, 2000].map((n) => (
              <option key={n} value={n}>
                max. {n} Zeichen
              </option>
            ))}
          </select>
        </label>
        <label>
          Sprache
          <select value={job.language} onChange={(e) => set({ language: e.target.value })}>
            <option value="auto">Deutsch (außer der Auftrag sagt was anderes)</option>
            <option value="de">Deutsch</option>
            <option value="en">Englisch</option>
          </select>
        </label>
        <label>
          Kontext
          <select value={job.contextSize} onChange={(e) => set({ contextSize: Number(e.target.value) })}>
            <option value={0}>keiner</option>
            <option value={10}>letzte 10 Nachrichten</option>
            <option value={20}>letzte 20 Nachrichten</option>
            <option value={50}>letzte 50 Nachrichten</option>
          </select>
        </label>
        <label>
          Posten als
          <select value={job.postAs} onChange={(e) => set({ postAs: e.target.value })}>
            <option value="message">Nachricht</option>
            <option value="thread">neuer Thread</option>
          </select>
        </label>
      </div>
      {job.contextSize > 0 && <p className="muted small">⚠ Diese Nachrichten gehen an deinen KI-Anbieter. Für die KI sind sie nur Daten, keine Anweisungen.</p>}
      <label className="settings__label" htmlFor="ai-job-persona">
        Tonfall / Persona <span className="muted small">(optional)</span>
      </label>
      <div className="settings__row">
        <input id="ai-job-persona" value={job.persona} maxLength={300} onChange={(e) => set({ persona: e.target.value })} placeholder="z. B. locker, mit Emojis, wie ein Sportmoderator" />
      </div>
      <label className="composer__ping">
        <input type="checkbox" checked={job.notify} onChange={(e) => set({ notify: e.target.checked })} /> Hinweis in der App bei Erfolg oder Fehler
      </label>
      <WebToggle checked={job.web} onChange={(web) => set({ web })} />
      {preview && preview !== 'busy' && (
        <div className="ai-preview" role="status">
          <div className="muted small">
            👁 Vorschau – wird NICHT gepostet · {preview.model} · {(preview.durationMs / 1000).toFixed(1)} s
          </div>
          <div className="ai-preview__text">{preview.text}</div>
        </div>
      )}
      <div className="confirm__actions">
        <button className="btn btn--ghost" onClick={onCancel}>
          Abbrechen
        </button>
        <button className="btn" disabled={!ok || preview === 'busy'} onClick={runPreview} title="Die KI schreibt eine Probe – es wird nichts gepostet">
          {preview === 'busy' ? 'KI schreibt …' : '👁 Vorschau'}
        </button>
        <button className="btn btn--primary" disabled={!ok} onClick={() => onSave(jobPayload({ ...job, channelName: targets.find((t) => t.id === job.channelId)?.label || '' }))}>
          Auftrag speichern
        </button>
      </div>
    </div>
  );
}

// Werkzeug „Websuche“ (kostenlos, ohne Schlüssel)
function WebToggle({ checked, onChange }) {
  return (
    <>
      <label className="composer__ping">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> 🌐 Websuche erlauben (kostenlos, ohne Schlüssel)
      </label>
      {checked && <p className="muted small">Die KI darf bis zu 2× im Web suchen (DuckDuckGo, sonst Wikipedia). Dorthin geht nur der Suchbegriff. Jede Runde zählt zum KI-Verbrauch.</p>}
    </>
  );
}

// Personen aus der Mitgliederliste der Server suchen und hinzufügen
function PeoplePicker({ label, people, onChange, guilds }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState(null); // null = (noch) nicht gesucht
  const [open, setOpen] = useState(false); // Feld aktiv → Vorschläge zeigen, auch ohne Eingabe (Issue #1)
  useEffect(() => {
    if (!open || !guilds.length) {
      setItems(null);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const q = query.trim().slice(0, 32);
      // Alle Server auf einmal, unscharf (Groß/klein egal, Teile, Tippfehler) – Issue #1
      const res = await api.searchPeople({ query: q }).catch(() => []);
      const found = new Map();
      for (const u of res) if (!u.bot && !found.has(u.id)) found.set(u.id, { id: u.id, name: u.display, sub: u.sub });
      if (!cancelled) setItems([...found.values()].filter((u) => !people.some((p) => p.id === u.id)).slice(0, 8));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query, guilds, people]);
  return (
    <div className="ai-people">
      <span className="settings__label">{label}</span>
      <div className="ai-chips">
        {people.map((p) => (
          <span key={p.id} className="ai-chip">
            {p.name}
            <button aria-label={`${p.name} entfernen`} onClick={() => onChange(people.filter((x) => x.id !== p.id))}>
              ×
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)} // Klick auf einen Vorschlag noch zulassen
          placeholder="Name suchen …"
          aria-label={`${label}: Name suchen`}
        />
      </div>
      {open && items && items.length > 0 && (
        <div className="ai-suggest">
          {items.map((u) => (
            <button
              key={u.id}
              onMouseDown={(e) => e.preventDefault()} // Fokus behalten → Liste bleibt offen
              onClick={() => {
                onChange([...people, { id: u.id, name: u.name }]);
                setQuery('');
              }}
            >
              ＋ {u.name}
              {u.sub && u.sub !== u.name && <span className="muted small"> @{u.sub}</span>}
            </button>
          ))}
        </div>
      )}
      {open && items && items.length === 0 && (
        <p className="muted small">{query.trim() ? `Niemand mit „${query.trim()}“ gefunden. Tipp: Anfang des Namens tippen (z. B. „Mo“).` : 'Noch keine bekannten Personen – einfach einen Namen tippen.'}</p>
      )}
    </div>
  );
}

// Antwort-Agent: antwortet als Bot, wenn er in zugewiesenen Kanälen erwähnt (oder privat angeschrieben) wird
// KI-Modi (Wunsch MoinMornhart 08.10.2026): mehrere unabhängige Persönlichkeiten/Modelle; Admins wechseln im Chat
// mit „modus Name“. Hier nur anlegen/bearbeiten – welcher gerade wo aktiv ist, steht darunter.
function ModesEditor({ r, set, guilds }) {
  const modes = r.modes || [];
  const update = (id, patch) => set({ modes: modes.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  const add = () => set({ modes: [...modes, { id: crypto.randomUUID(), name: `Modus ${modes.length + 1}`, instructions: '', model: '' }] });
  const remove = (id) => {
    const active = Object.fromEntries(Object.entries(r.activeModes || {}).filter(([, v]) => v !== id));
    set({ modes: modes.filter((x) => x.id !== id), activeModes: active });
  };
  const guildName = (gid) => guilds.find((g) => g.id === gid)?.name || 'Privatchat';
  const activeList = Object.entries(r.activeModes || {}).map(([scope, id]) => [scope, modes.find((x) => x.id === id)]).filter(([, x]) => x);
  return (
    <Fold id="ai-modes" className="ai-modes ai-subfold" title="🎭 Modi" badge={modes.length || null} hint="Mehrere Persönlichkeiten für den Bot – Admins wechseln im Chat mit „modus Name“">
      <div data-setting="ai-modes">
      <p className="muted small">
        Mehrere unabhängige Persönlichkeiten für den Bot, jede mit eigenen Anweisungen und auf Wunsch eigenem Modell. Eine Admin schreibt im Chat <b>„modus Name“</b> – der Bot wechselt sofort. „modus“ allein zeigt die Liste, „modus standard“ schaltet zurück.
      </p>
      {modes.map((x) => (
        <Fold key={x.id} id={`ai-mode-${x.id}`} className="ai-mode" title={`🎭 ${x.name || 'Ohne Namen'}`} badge={x.model || null}>
          <div className="settings__row">
            <input aria-label="Name des Modus" value={x.name} maxLength={32} onChange={(e) => update(x.id, { name: e.target.value })} placeholder="Name, z. B. Rainer" />
            <input aria-label="Eigenes Modell (optional)" value={x.model} maxLength={100} onChange={(e) => update(x.id, { model: e.target.value })} placeholder="Modell (leer = wie oben)" />
            <button className="btn btn--ghost btn--small" onClick={() => remove(x.id)} aria-label={`Modus ${x.name} löschen`}>
              🗑
            </button>
          </div>
          <TokenHint text={x.instructions} />
          <textarea className="profile__desc" rows={3} maxLength={8000} value={x.instructions} onChange={(e) => update(x.id, { instructions: e.target.value })} placeholder="So ist der Bot in diesem Modus …" />
        </Fold>
      ))}
      {modes.length < 20 && (
        <button className="btn btn--ghost btn--small" onClick={add}>
          ＋ Modus hinzufügen
        </button>
      )}
      {modes.length > 0 && (
        <>
          <PeoplePicker label="Außer Server-Admins dürfen auch diese Personen den Modus wechseln" people={r.modeUsers || []} onChange={(modeUsers) => set({ modeUsers })} guilds={guilds} />
          <p className="muted small">🔒 Wechseln dürfen nur Server-Admins (Recht „Server verwalten“) und die Personen oben – im Privatchat nur die Personen oben. Andere bekommen eine kurze Absage.</p>
          {activeList.length > 0 && (
            <p className="small">
              Gerade aktiv: {activeList.map(([scope, x]) => `${guildName(scope)} → „${x.name}“`).join(' · ')}{' '}
              <button className="link-btn" onClick={() => set({ activeModes: {} })}>
                alle auf Standard
              </button>
            </p>
          )}
        </>
      )}
      </div>
    </Fold>
  );
}

// #131: Werkzeuge der KI übersichtlich – was sie darf, wo man es einschaltet, und was sie zuletzt getan hat
function ToolsInfo({ cfg }) {
  const r = cfg.responder;
  const jobsWithWeb = cfg.jobs.filter((j) => j.web).length;
  return (
    <div className="ai-tools">
      <ul className="small ai-tools__list">
        <li>
          🌐 <b>Websuche</b> – Antworten: <b>{r.web ? 'an' : 'aus'}</b> · Aufträge mit Websuche: <b>{jobsWithWeb}</b>
          <span className="muted"> (einschalten unter „Auf Erwähnungen antworten“ bzw. im Auftrag)</span>
        </li>
        <li>
          🧠 <b>Erinnern</b> („Leon hat mal gesagt …“): <b>{r.memory ? 'an' : 'aus'}</b>
          <span className="muted"> – nur Gespräche vom selben Server, nie aus Privatchats</span>
        </li>
      </ul>
      <p className="muted small">Modelle, die Werkzeuge können, rufen sie selbst auf. Bei anderen nutzt die App einen einfachen Ersatz (nur Websuche).</p>
      {cfg.searches?.length > 0 && (
        <p className="small">
          Letzte Websuche: „{cfg.searches[0].query}“ · {cfg.searches[0].source} · {cfg.searches[0].count} Treffer
        </p>
      )}
      {cfg.toolLog?.length > 0 ? (
        <ul className="small ai-tools-log">
          {cfg.toolLog.slice(0, 15).map((t, i) => (
            <li key={`${t.at}-${i}`} className={t.ok ? '' : 'warn'}>
              {new Date(t.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} · {t.ok ? '✅' : '⚠️'} {t.tool}: {t.detail}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Noch keine Werkzeug-Aufrufe.</p>
      )}
    </div>
  );
}

// #131: KI darf (auf Wunsch von Admins) den Server mitverwalten – Gefahren-Schalter pro Server, ab Werk aus
function AdminGuilds({ r, set, guilds }) {
  const [ask, setAsk] = useState(null); // Server, der gerade bestätigt werden soll
  const list = r.adminGuilds || [];
  const toggle = (g, on) => (on ? setAsk(g) : set({ adminGuilds: list.filter((id) => id !== g.id) }));
  return (
    <Fold id="ai-admin" className="ai-subfold ai-danger" title="🛠 KI darf den Server mitverwalten" badge={list.length ? `${list.length} Server` : 'aus'} hint="Gefährlich: Die KI darf auf Bitte eines Admins Kanäle anlegen, Nachrichten löschen und Timeouts geben">
      <p className="muted small">
        Schreibt ein <b>Server-Admin</b> (oder eine Person, die Modi wechseln darf) den Bot an, kann die KI auf Bitte z. B. Kanäle anlegen/umbenennen, Nachrichten in den Kanal posten, löschen, anpinnen oder kurze Timeouts (max. 60 Min.) geben. Normale Mitglieder können das <b>nie</b> auslösen.
      </p>
      <p className="muted small">🔒 Nie: bannen, kicken, Kanäle löschen, Rollen/Rechte ändern. Höchstens 15 Aktionen pro Stunde und Server. Jede Aktion steht im Werkzeug-Protokoll. Funktioniert nur mit Modellen, die Werkzeuge können.</p>
      {guilds.map((g) => (
        <label key={g.id} className="composer__ping">
          <input type="checkbox" checked={list.includes(g.id)} onChange={(e) => toggle(g, e.target.checked)} /> 🖥 {g.name}
        </label>
      ))}
      {ask && (
        <div className="ai-danger__confirm" role="alertdialog" aria-label="Gefahr bestätigen">
          <p className="warn small">
            ⚠ <b>Gefahr:</b> Die KI kann auf „{ask.name}“ Fehler machen – z. B. die falsche Nachricht löschen oder die falsche Person stummschalten. Eine KI kann sich auch irren oder austricksen lassen. Nur einschalten, wenn du das Risiko verstehst.
          </p>
          <div className="settings__row">
            <button className="btn btn--ghost btn--small" onClick={() => setAsk(null)}>
              Abbrechen
            </button>
            <button
              className="btn btn--danger btn--small"
              onClick={() => {
                set({ adminGuilds: [...new Set([...list, ask.id])] });
                setAsk(null);
              }}
            >
              Ja, ich verstehe das Risiko
            </button>
          </div>
        </div>
      )}
    </Fold>
  );
}

function ResponderSection({ cfg, targets, guilds, toast }) {
  const [r, setR] = useState(cfg.responder);
  const [busy, setBusy] = useState(false);
  const groups = groupByServer(targets.filter((t) => !t.dm));
  const [serverId, setServerId] = useState(() => groups.find((g) => g.items.some((t) => cfg.responder.channelIds.includes(t.id)))?.id || groups[0]?.id || '');
  const group = groups.find((g) => g.id === serverId) || groups[0];
  const activeIn = (g) => g.items.filter((t) => r.channelIds.includes(t.id)).length;
  const setGroup = (g, on) => set({ channelIds: on ? [...new Set([...r.channelIds, ...g.items.map((t) => t.id)])] : r.channelIds.filter((id) => !g.items.some((t) => t.id === id)) });
  const dirty = JSON.stringify(r) !== JSON.stringify(cfg.responder);
  const set = (patch) => setR((x) => ({ ...x, ...patch }));
  const save = async () => {
    setBusy(true);
    try {
      await api.aiSetResponder(r);
      toast({ kind: 'info', title: 'Gespeichert ✓', text: r.enabled ? 'Der Bot antwortet jetzt, wenn er erwähnt wird.' : 'Automatische Antworten sind aus.', duration: 2500 });
    } catch (e) {
      toast({ kind: 'error', title: e.message, text: e.hint });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ai-responder">
      <label className="composer__ping">
        <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Bot antwortet mit KI, wenn ihn jemand erwähnt
      </label>
      {r.enabled && (
        <>
          <span className="settings__label">In diesen Kanälen</span>
          {groups.length === 0 && <span className="muted small">Kein Kanal, in den der Bot schreiben darf.</span>}
          {groups.length > 0 && (
            <div className="settings__row ai-target">
              <select aria-label="Server" value={group?.id} onChange={(e) => setServerId(e.target.value)}>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    🖥 {g.name} ({activeIn(g)}/{g.items.length} an)
                  </option>
                ))}
              </select>
              <button className="btn btn--small" onClick={() => setGroup(group, true)}>
                Alle an
              </button>
              <button className="btn btn--ghost btn--small" onClick={() => setGroup(group, false)}>
                Alle aus
              </button>
            </div>
          )}
          <div className="ai-channels">
            {(group?.items || []).map((c) => (
              <label key={c.id} className="ai-channel" title={c.label}>
                <input
                  type="checkbox"
                  checked={r.channelIds.includes(c.id)}
                  onChange={(e) => set({ channelIds: e.target.checked ? [...r.channelIds, c.id] : r.channelIds.filter((x) => x !== c.id) })}
                />{' '}
                #{c.name}
              </label>
            ))}
          </div>
          <label className="composer__ping">
            <input type="checkbox" checked={r.dms} onChange={(e) => set({ dms: e.target.checked })} /> Auch in Privatchats antworten (dort ohne Erwähnung)
          </label>
          <PeoplePicker label="Nur diesen Personen antworten (leer = allen)" people={r.allowUsers} onChange={(allowUsers) => set({ allowUsers })} guilds={guilds} />
          <PeoplePicker label="Diese Personen ausschließen" people={r.blockUsers} onChange={(blockUsers) => set({ blockUsers })} guilds={guilds} />
          <label className="settings__label" htmlFor="ai-instr">
            So soll der Bot sein <TokenHint text={r.instructions} />
          </label>
          <textarea
            id="ai-instr"
            className="profile__desc"
            rows={5}
            maxLength={8000}
            value={r.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            placeholder="z. B. Du bist Claw, locker und hilfsbereit. Du kennst die Server-Regeln: …"
          />
          <ModesEditor r={r} set={set} guilds={guilds} />
          <AdminGuilds r={r} set={set} guilds={guilds} />
          <label className="composer__ping">
            <input type="checkbox" checked={r.context} onChange={(e) => set({ context: e.target.checked })} /> Letzte 20 Nachrichten als Kontext mitschicken
          </label>
          {r.context && <p className="muted small">⚠ Diese Nachrichten gehen dann an deinen KI-Anbieter.</p>}
          <WebToggle checked={r.web} onChange={(web) => set({ web })} />
          <label className="composer__ping">
            <input type="checkbox" checked={r.quietWhenOpen !== false} onChange={(e) => set({ quietWhenOpen: e.target.checked })} /> Nicht antworten, wenn ich den Chat gerade selbst offen habe
          </label>
          <label className="composer__ping" data-setting="ai-memory">
            <input type="checkbox" checked={Boolean(r.memory)} onChange={(e) => set({ memory: e.target.checked })} /> 🧠 Gedächtnis pro Person (verschlüsselt auf diesem PC)
          </label>
          {r.memory && (
            <div className="settings__row ai-limits">
              <label>
                Größe pro Person
                <select value={r.memoryBudget || 3000} onChange={(e) => set({ memoryBudget: Number(e.target.value) })}>
                  <option value={1000}>klein (~1.000 Tokens)</option>
                  <option value={3000}>mittel (~3.000 Tokens)</option>
                  <option value={8000}>groß (~8.000 Tokens)</option>
                  <option value={16000}>sehr groß (~16.000 Tokens)</option>
                </select>
              </label>
            </div>
          )}
          {r.memory && (
            <label className="composer__ping">
              <input type="checkbox" checked={r.memoryAuto !== false} onChange={(e) => set({ memoryAuto: e.target.checked })} /> Automatisch zusammenfassen, wenn es voll wird
            </label>
          )}
          {r.memory && <p className="muted small">Der Bot merkt sich, was jede Person ihm geschrieben hat. Wird es zu viel, fasst die KI das Alte zu wichtigen Fakten zusammen und löscht den Rest. Das Gedächtnis geht nur an deinen KI-Anbieter und liegt verschlüsselt auf diesem PC. Auf einem Server kann der Bot nachschlagen, was andere dort zu ihm gesagt haben („Leon hat mal gesagt …“) – aber nur Gespräche von diesem Server, nie aus Privatchats.</p>}
          <p className="muted small">💡 Als Erwähnung zählt: @Bot, die Bot-Rolle oder eine Antwort auf eine Nachricht des Bots.</p>
          <label className="composer__ping">
            <input type="checkbox" checked={r.notify} onChange={(e) => set({ notify: e.target.checked })} /> Hinweis in der App, wenn der Bot geantwortet hat
          </label>
          <div className="settings__row ai-limits">
            <label>
              Antworten pro Stunde
              <select value={r.replyLimit ?? 30} onChange={(e) => set({ replyLimit: Number(e.target.value) })}>
                {[10, 30, 60, 120, 300].map((n) => (
                  <option key={n} value={n}>
                    höchstens {n}
                  </option>
                ))}
                <option value={0}>unbegrenzt</option>
              </select>
            </label>
          </div>
          <p className="muted small">🛑 Schutz: antwortet nie anderen Bots, höchstens alle 15 Sek. pro Kanal{(r.replyLimit ?? 30) > 0 ? ` und ${r.replyLimit ?? 30}× pro Stunde` : ''}, pingt niemanden.</p>
        </>
      )}
      {dirty && (
        <div className="settings__row">
          <button className="btn btn--primary btn--small" disabled={busy} onClick={save}>
            Speichern
          </button>
          <button className="btn btn--ghost btn--small" onClick={() => setR(cfg.responder)}>
            Verwerfen
          </button>
        </div>
      )}
      {cfg.skips?.length > 0 && (
        <div className="ai-recent">
          <span className="settings__label">Nicht geantwortet (warum?)</span>
          {cfg.skips.map((e, i) => (
            <div key={i} className="small muted">
              ⏭ {formatListTime(e.at, Date.now())} · {e.userName}
              {targets.find((t) => t.id === e.channelId) ? ` in ${targets.find((t) => t.id === e.channelId).label}` : ' (Privatchat)'}: {e.text}
            </div>
          ))}
        </div>
      )}
      {cfg.recent?.length > 0 && (
        <div className="ai-recent">
          <span className="settings__label">Letzte Antworten</span>
          {cfg.recent.map((e, i) => (
            <div key={i} className={`small ${e.ok ? '' : 'warn'}`}>
              {e.ok ? '✓' : '⚠'} {formatListTime(e.at, Date.now())} · {e.userName}: {e.answer}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Gedächtnis verwalten (Issue #1): alle Personen ansehen, Zusammenfassung bearbeiten, „Jetzt zusammenfassen“
// auslösen, Erfolg/Fehler sehen, einzeln oder alles vergessen. Inhalte werden erst beim Öffnen geladen.
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

function CompactState({ c }) {
  if (!c?.at) return <span className="muted"> · noch nie zusammengefasst</span>;
  if (c.ok) return <span className="ok"> · ✓ zusammengefasst {fmtTime(c.at)} ({c.before} → {c.after} Tokens)</span>;
  return <span className="warn" title={c.error || ''}> · ⚠ Zusammenfassen fehlgeschlagen {fmtTime(c.at)}: {c.error}</span>;
}

function MemoryList({ toast }) {
  const [list, setList] = useState(null);
  const [view, setView] = useState(null);
  const [edit, setEdit] = useState(null); // Text der Zusammenfassung beim Bearbeiten
  const [busyId, setBusyId] = useState('');
  const [q, setQ] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const load = () => api.aiMemoryList().then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
    return onEvent((type) => type === 'ai:changed' && load());
  }, []);
  const run = (p) => p.then(setList).catch((e) => toast({ kind: 'error', title: e.message }));
  const open = (userId) =>
    api.aiMemoryView({ userId }).then((v) => {
      setView(v);
      setEdit(null);
    });
  const compact = async (p) => {
    setBusyId(p.userId);
    try {
      const r = await api.aiMemoryCompact({ userId: p.userId });
      if (r?.ok) toast({ kind: 'info', title: `Gedächtnis von ${p.name} zusammengefasst ✓`, text: `Jetzt ~${r.tokens} Tokens.`, duration: 3000 });
      else toast({ kind: 'warn', title: 'Zusammenfassen hat nicht geklappt', text: r?.error || 'Unbekannter Fehler' });
      await load();
      if (view?.userId === p.userId) await open(p.userId);
    } catch (e) {
      toast({ kind: 'error', title: e.message, text: e.hint });
    } finally {
      setBusyId('');
    }
  };
  if (!list) return <p className="muted small">Lade …</p>;
  if (list.length === 0) return <p className="muted small">Noch niemand im Gedächtnis. Schalte unter „Auf Erwähnungen antworten“ das Gedächtnis ein. Dann merkt sich der Bot jede Person, die mit ihm schreibt.</p>;
  const shown = q.trim() ? fuzzyFilter(list, q, (p) => [p.name]) : list;
  const total = list.reduce((n, p) => n + p.tokens, 0);
  return (
    <div className="ai-memory" data-setting="ai-memory-list">
      <div className="ai-memory__head">
        <span>
          🧠 <b>{list.length}</b> {list.length === 1 ? 'Person' : 'Personen'} · ~{total.toLocaleString('de-DE')} Tokens
        </span>
        {list.length > 5 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Person suchen …" aria-label="Person im Gedächtnis suchen" />}
      </div>
      {shown.map((p) => (
        <div key={p.userId} className="ai-memory-row small">
          <span>
            <b>{p.name || 'Unbekannt'}</b> · {p.turns} Wortwechsel · ~{p.tokens} Tokens{p.hasSummary ? ' · 📝 Zusammenfassung' : ''}
            <CompactState c={p.lastCompact} />
          </span>
          <button className="btn btn--ghost btn--small" onClick={() => open(p.userId)}>
            Ansehen
          </button>
          <button className="btn btn--ghost btn--small" disabled={busyId === p.userId} onClick={() => compact(p)} title="Die KI fasst das Gedächtnis jetzt zusammen">
            {busyId === p.userId ? 'Fasse zusammen …' : '🗜 Jetzt zusammenfassen'}
          </button>
          <button className="btn btn--ghost btn--small" onClick={() => run(api.aiMemoryForget({ userId: p.userId }))}>
            Vergessen
          </button>
        </div>
      ))}
      <button className="btn btn--ghost btn--small" onClick={() => setConfirmAll(true)}>
        🗑 Alles vergessen
      </button>
      {confirmAll && (
        <div className="settings__row">
          <span className="warn small">Wirklich das ganze Gedächtnis löschen?</span>
          <button
            className="btn btn--danger btn--small"
            onClick={() => {
              setConfirmAll(false);
              run(api.aiMemoryForgetAll());
            }}
          >
            Ja, löschen
          </button>
          <button className="btn btn--ghost btn--small" onClick={() => setConfirmAll(false)}>
            Abbrechen
          </button>
        </div>
      )}
      {view && (
        <div className="ai-preview" role="region" aria-label={`Gedächtnis von ${view.name}`}>
          <div className="muted small">
            🧠 Gedächtnis von {view.name} · ~{view.tokens} Tokens ·{' '}
            <button className="linklike" onClick={() => setView(null)}>
              schließen
            </button>
          </div>
          <span className="settings__label">📝 Zusammenfassung</span>
          {edit === null ? (
            <>
              <div className="ai-preview__text">{view.summary || <span className="muted">(noch keine – entsteht automatisch oder mit „Jetzt zusammenfassen“)</span>}</div>
              <button className="btn btn--ghost btn--small" onClick={() => setEdit(view.summary || '')}>
                ✏️ Bearbeiten
              </button>
            </>
          ) : (
            <>
              <textarea className="profile__desc" rows={5} maxLength={4000} value={edit} onChange={(e) => setEdit(e.target.value)} aria-label="Zusammenfassung bearbeiten" />
              <div className="settings__row">
                <button
                  className="btn btn--primary btn--small"
                  onClick={() =>
                    api
                      .aiMemorySetSummary({ userId: view.userId, summary: edit })
                      .then((v) => {
                        setView(v);
                        setEdit(null);
                        load();
                      })
                      .catch((e) => toast({ kind: 'error', title: e.message }))
                  }
                >
                  Speichern
                </button>
                <button className="btn btn--ghost btn--small" onClick={() => setEdit(null)}>
                  Abbrechen
                </button>
              </div>
            </>
          )}
          <span className="settings__label">💬 Letzte Wortwechsel</span>
          {view.turns.map((t, i) => (
            <div key={i} className="small">
              <b>{t.role === 'user' ? view.name : '🤖 Bot'}:</b> {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Harte Limits (gelten für alle KI-Anfragen zusammen)
function LimitsRow({ cfg, onSave }) {
  const [l, setL] = useState(cfg.limits);
  const dirty = l.mode !== cfg.limits.mode || l.perHour !== cfg.limits.perHour || l.perDay !== cfg.limits.perDay;
  return (
    <div className="settings__row ai-limits">
      <label>
        Limits
        <select value={l.mode} onChange={(e) => setL({ ...l, mode: e.target.value })}>
          <option value="auto">Automatisch (nur bei Cloud-Anbietern)</option>
          <option value="an">Immer an</option>
          <option value="aus">Aus</option>
        </select>
      </label>
      <label>
        Max. pro Stunde
        <input type="number" min="1" max="500" value={l.perHour} onChange={(e) => setL({ ...l, perHour: Math.round(Number(e.target.value)) || 1 })} />
      </label>
      <label>
        Max. pro Tag
        <input type="number" min="1" max="5000" value={l.perDay} onChange={(e) => setL({ ...l, perDay: Math.round(Number(e.target.value)) || 1 })} />
      </label>
      {dirty && (
        <button className="btn btn--primary btn--small" onClick={() => onSave(l)}>
          Limits speichern
        </button>
      )}
    </div>
  );
}

// Anbieterprofile: Anbieter + Adresse + Modell merken (der Schlüssel bleibt im Tresor)
function ProfilesRow({ cfg, setDraft, wrap, setCfg }) {
  const [name, setName] = useState('');
  return (
    <div className="settings__row ai-profiles">
      {cfg.profiles.length > 0 && (
        <select
          aria-label="Gespeichertes Anbieterprofil"
          value=""
          onChange={(e) =>
            e.target.value &&
            wrap('profile', async () => {
              const c = await api.aiUseProfile({ id: e.target.value });
              setCfg(c);
              setDraft({ provider: c.provider, baseUrl: c.baseUrl, model: c.model });
            })()
          }
        >
          <option value="">Profil laden …</option>
          {cfg.profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} – {p.model}
            </option>
          ))}
        </select>
      )}
      <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Profilname, z. B. Ollama lokal" aria-label="Profilname" />
      <button className="btn btn--small" disabled={!name.trim()} onClick={wrap('profile', async () => (setCfg(await api.aiSaveProfile({ name })), setName('')))}>
        Aktuelle Einstellung als Profil speichern
      </button>
    </div>
  );
}

export default function AiSection({ toast, targets = [], guilds = [] }) {
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState(null); // Anbieter-Einstellungen in Bearbeitung
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | job
  const [error, setError] = useState('');
  const [modelList, setModelList] = useState([]); // automatisch erkannte Modelle
  const [localFound, setLocalFound] = useState(null); // gefundene lokale KI-Programme
  const [jobServer, setJobServer] = useState('alle'); // Filter der Auftragsliste

  const load = useCallback(
    () =>
      api
        .aiGet()
        .then((c) => {
          setCfg(c);
          setDraft((d) => d || { provider: c.provider, baseUrl: c.baseUrl, model: c.model });
        })
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    load();
    return onEvent((type) => type === 'ai:changed' && load());
  }, [load]);

  if (error) return <p className="muted small">KI-Agenten nicht verfügbar: {error}</p>;
  if (!cfg || !draft) return <p className="muted small">Lade …</p>;

  const wrap = (name, fn) => async () => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast({ kind: 'error', title: e.message, text: e.hint });
    } finally {
      setBusy('');
    }
  };

  const saveConfig = (enabled) => api.aiSetConfig({ enabled, ...draft }).then(setCfg);
  const toggleBeta = wrap('beta', () => saveConfig(!cfg.enabled));
  const dirty = draft.provider !== cfg.provider || draft.baseUrl !== cfg.baseUrl || draft.model !== cfg.model;
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const serverOfJob = (j) => targetById.get(j.channelId)?.guildId || '?';
  const jobServers = groupByServer(targets).filter((g) => cfg.jobs.some((j) => serverOfJob(j) === g.id));

  return (
    <Fold id="ai-all" className="ai-card ai-all" title="🤖 KI-Agenten" badge={cfg.enabled ? 'an' : 'aus'} hint="KI-Aufträge, Antworten auf Erwähnungen, Modi, Werkzeuge und Gedächtnis">
      <label className="composer__ping">
        <input type="checkbox" checked={cfg.enabled} disabled={busy === 'beta'} onChange={toggleBeta} /> 🧪 Beta freischalten: KI-Agenten
      </label>
      <p className="muted small">Eine KI erledigt Aufträge zu festen Zeiten (z. B. „jeden Morgen einen Gruß posten“). Gepostet wird als dein Bot. Läuft nur, solange PKMessenger offen ist.</p>
      {cfg.enabled && (
        <div className="ai-box">
          <div className="ai-status" role="status">
            <span>
              🧠 <b>KI an</b> · {cfg.model || 'kein Modell'} ({PRESETS.find((p) => p.baseUrl === cfg.baseUrl)?.label || cfg.baseUrl})
            </span>
            <span>
              🤖 Aufträge aktiv: {cfg.jobs.filter((j) => j.enabled).length}/{cfg.jobs.length} · 💬 Antworten auf Erwähnungen: {cfg.responder.enabled ? 'an' : 'aus'}
            </span>
            {cfg.limitsActive ? (
              <span className={cfg.usage.hour >= cfg.limits.perHour || cfg.usage.day >= cfg.limits.perDay ? 'warn' : ''}>
                📊 Verbrauch: {cfg.usage.hour}/{cfg.limits.perHour} pro Stunde · {cfg.usage.day}/{cfg.limits.perDay} pro Tag
              </span>
            ) : (
              <span>
                📊 Verbrauch: {cfg.usage.hour} pro Stunde · {cfg.usage.day} pro Tag · ohne Limit ({cfg.limits.mode === 'aus' ? 'ausgeschaltet' : 'lokales Modell, kostet nichts'})
              </span>
            )}
            {cfg.searches?.length > 0 && (
              <span>
                🌐 Letzte Websuche: „{cfg.searches[0].query}“ · {cfg.searches[0].source} · {cfg.searches[0].count} Treffer
              </span>
            )}
            {cfg.running.length > 0 && (
              <button className="btn btn--danger btn--small" onClick={wrap('abort', () => api.aiAbort())}>
                ⏹ Laufende KI-Anfragen stoppen
              </button>
            )}
          </div>
          <Fold id="ai-conn" title="🔌 Verbindung & Modell" hint="Anbieter, Adresse, Modell und API-Schlüssel">
          <ProfilesRow cfg={cfg} draft={draft} setDraft={setDraft} wrap={wrap} setCfg={setCfg} />
          <label className="settings__label" htmlFor="ai-preset">
            KI-Anbieter
          </label>
          <select
            id="ai-preset"
            value={presetOf(draft)}
            onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value);
              if (p) setDraft({ provider: p.provider, baseUrl: p.baseUrl, model: p.model || draft.model });
              else setDraft({ ...draft, baseUrl: '' });
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Eigene Adresse (OpenAI-kompatibel)</option>
          </select>
          <div className="settings__row">
            <button
              className="btn btn--small"
              disabled={busy === 'local'}
              title="Sucht Ollama, LM Studio, llama.cpp & Co. auf diesem PC"
              onClick={wrap('local', async () => setLocalFound(await api.aiFindLocal()))}
            >
              {busy === 'local' ? 'Suche …' : '🔎 Lokale KI auf diesem PC suchen'}
            </button>
          </div>
          {localFound && (
            <div className="ai-local" role="status">
              {localFound.length === 0 && <span className="muted small">Nichts gefunden. Läuft Ollama, LM Studio oder llama.cpp?</span>}
              {localFound.map((s) => (
                <button
                  key={s.id}
                  className="ai-local__item"
                  onClick={() => {
                    setDraft({ provider: 'openai', baseUrl: s.baseUrl, model: s.models[0] || '' });
                    setModelList(s.models);
                    setLocalFound(null);
                  }}
                >
                  ✅ <b>{s.label}</b> · {s.models.length} {s.models.length === 1 ? 'Modell' : 'Modelle'}
                  {s.models.length > 0 && <span className="muted small"> ({s.models.slice(0, 3).join(', ')}{s.models.length > 3 ? ' …' : ''})</span>}
                </button>
              ))}
            </div>
          )}
          {presetOf(draft) === 'custom' && (
            <div className="settings__row">
              <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, provider: 'openai', baseUrl: e.target.value })} placeholder="https://…/v1" aria-label="Adresse des Anbieters" />
            </div>
          )}
          <label className="settings__label" htmlFor="ai-model">
            Modell
          </label>
          <div className="settings__row">
            <input id="ai-model" list="ai-model-list" value={draft.model} maxLength={100} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="Name des Modells beim Anbieter" />
            <datalist id="ai-model-list">
              {modelList.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button
              className="btn btn--small"
              disabled={busy === 'models' || !draft.baseUrl}
              title="Fragt den Anbieter, welche Modelle es gibt"
              onClick={wrap('models', async () => {
                const list = await api.aiModels({ provider: draft.provider, baseUrl: draft.baseUrl });
                setModelList(list);
                if (list.length && !list.includes(draft.model)) setDraft({ ...draft, model: list[0] });
                toast({ kind: 'info', title: list.length ? `${list.length} Modelle gefunden ✓` : 'Keine Modelle gefunden', text: list.length ? 'Im Feld „Modell“ auswählen.' : 'Bei lokalen Programmen zuerst ein Modell laden.', duration: 2500 });
              })}
            >
              {busy === 'models' ? 'Lade …' : '🔍 Modelle laden'}
            </button>
            {dirty && (
              <button className="btn btn--primary btn--small" disabled={busy === 'cfg'} onClick={wrap('cfg', () => saveConfig(true))}>
                Übernehmen
              </button>
            )}
          </div>
          <label className="settings__label" htmlFor="ai-key">
            API-Schlüssel {cfg.hasKey ? <span className="ok small">🔐 gespeichert (verschlüsselt)</span> : <span className="muted small">(bei lokalen Modellen leer lassen)</span>}
          </label>
          <div className="settings__row">
            <input id="ai-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={cfg.hasKey ? 'Neuen Schlüssel eintragen …' : 'Schlüssel vom Anbieter einfügen'} />
            <button
              className="btn btn--small"
              disabled={!key || busy === 'key'}
              onClick={wrap('key', async () => {
                setCfg(await api.aiSetKey({ key }));
                setKey(''); // Schlüssel sofort aus der Oberfläche entfernen
              })}
            >
              Speichern
            </button>
            {cfg.hasKey && (
              <button className="btn btn--ghost btn--small" onClick={wrap('key', async () => setCfg(await api.aiClearKey()))}>
                Entfernen
              </button>
            )}
          </div>
          <div className="settings__row">
            <button
              className="btn btn--small"
              disabled={busy === 'test' || dirty}
              title={dirty ? 'Erst „Übernehmen“ klicken' : ''}
              onClick={wrap('test', async () => {
                const r = await api.aiTest();
                toast({ kind: 'info', title: 'KI antwortet ✓', text: r.reply });
              })}
            >
              {busy === 'test' ? 'Teste …' : '🔌 Verbindung testen'}
            </button>
            <label className="composer__ping" data-setting="ai-autoconnect">
              <input type="checkbox" checked={cfg.options.autoConnect} onChange={wrap('opt', async () => setCfg(await api.aiSetOptions({ autoConnect: !cfg.options.autoConnect })))} /> Beim Start automatisch verbinden
            </label>
          </div>
          {cfg.conn && (
            <p className={`small ${cfg.conn.ok ? 'ok' : 'warn'}`} role="status">
              {cfg.conn.ok ? `🟢 Verbunden mit ${cfg.conn.model || cfg.model}` : `🔴 Nicht verbunden: ${cfg.conn.message}`} · {formatListTime(cfg.conn.at, Date.now())}
              {!cfg.conn.ok && cfg.options.autoConnect ? ' · neuer Versuch in 5 Minuten' : ''}
            </p>
          )}
          <label className="composer__ping" data-setting="ai-thinking">
            <input type="checkbox" checked={cfg.options.thinking} onChange={wrap('opt', async () => setCfg(await api.aiSetOptions({ thinking: !cfg.options.thinking })))} /> 🧠 Denkendes Modell (Thinking)
          </label>
          <p className="muted small">Für Modelle, die erst „nachdenken“ (z. B. Qwen3, DeepSeek-R1, …-thinking). Sie bekommen mehr Zeit und Platz, ihre Gedanken landen nie im Chat.</p>
          <label className="composer__ping" data-setting="ai-vision">
            <input type="checkbox" checked={cfg.options.vision} onChange={wrap('opt', async () => setCfg(await api.aiSetOptions({ vision: !cfg.options.vision })))} /> 👁 Modell kann Bilder sehen
          </label>
          <p className="muted small">Dann bekommt die KI Bilder aus Nachrichten (nur von Discords Servern, max. 5 MB). Ohne den Schalter, und bei Ton oder Video, sagt sie locker, dass sie das nicht kann.</p>

          </Fold>
          <Fold id="ai-limits" title="📊 Verbrauch & Limits" hint="Wie viele KI-Anfragen pro Stunde/Tag erlaubt sind">
            <LimitsRow cfg={cfg} onSave={(l) => wrap('limits', async () => setCfg(await api.aiSetLimits(l)))()} />
          </Fold>
          <Fold id="ai-responder" title="💬 Auf Erwähnungen antworten" badge={cfg.responder.enabled ? 'an' : 'aus'} hint="Der Bot antwortet, wenn ihn jemand anpingt – mit Modi, Gedächtnis und Websuche">
            <ResponderSection key={JSON.stringify(cfg.responder)} cfg={cfg} targets={targets} guilds={guilds} toast={toast} />
          </Fold>
          <Fold id="ai-tools" title="🧰 Werkzeuge (Websuche & Erinnern)" badge={cfg.toolLog?.length || null} hint="Was die KI selbst nachschlagen darf und was sie zuletzt gemacht hat">
            <ToolsInfo cfg={cfg} />
          </Fold>
          <Fold id="ai-memory" title="🧠 Gedächtnis verwalten" hint="Was sich der Bot über jede Person gemerkt hat">
            <MemoryList toast={toast} />
          </Fold>
          <Fold id="ai-jobs" title="🤖 Aufträge" badge={cfg.jobs.length || null} hint="Zeitgesteuerte Aufgaben, z. B. jeden Morgen ein Gruß">

          {cfg.jobs.length === 0 && !editing && <p className="muted small">Noch keine Aufträge.</p>}
          {jobServers.length > 1 && (
            <div className="settings__row ai-target">
              <select aria-label="Aufträge nach Server filtern" value={jobServer} onChange={(e) => setJobServer(e.target.value)}>
                <option value="alle">Alle Server ({cfg.jobs.length})</option>
                {jobServers.map((g) => (
                  <option key={g.id} value={g.id}>
                    🖥 {g.name} ({cfg.jobs.filter((j) => serverOfJob(j) === g.id).length})
                  </option>
                ))}
              </select>
            </div>
          )}
          {cfg.jobs.filter((j) => jobServer === 'alle' || serverOfJob(j) === jobServer).map((j) =>
            editing?.id === j.id ? (
              <JobForm
                key={j.id}
                targets={targets}
                initial={j}
                toast={toast}
                onCancel={() => setEditing(null)}
                onSave={(job) =>
                  wrap('save', async () => {
                    await api.aiSaveJob({ ...job, id: j.id });
                    setEditing(null);
                  })()
                }
              />
            ) : (
              <div key={j.id} className={`ai-job ${j.enabled ? '' : 'is-off'}`}>
                <div className="ai-job__main">
                  <b>{j.name}</b>
                  <span className="muted small">
                    {describeSchedule(j.schedule)} → {j.channelName || 'Kanal'}
                    {j.postAs === 'thread' ? ' · als Thread' : ''}
                    {j.web ? ' · 🌐 Websuche' : ''}
                    {j.contextSize > 0 ? ` · Kontext ${j.contextSize}` : ''}
                  </span>
                  {j.enabled && j.nextRun && (
                    <span className="muted small">⏭ nächster Lauf: {new Date(j.nextRun).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  )}
                  {j.lastRun && (
                    <span className={`small ${j.lastRun.ok ? 'ok' : 'warn'}`}>
                      {j.lastRun.ok ? '✓' : '⚠'} {formatListTime(j.lastRun.at, Date.now())}
                      {j.lastRun.durationMs ? ` · ${(j.lastRun.durationMs / 1000).toFixed(1)} s` : ''}
                      {j.lastRun.model ? ` · ${j.lastRun.model}` : ''}: {j.lastRun.message}
                    </span>
                  )}
                </div>
                <div className="ai-job__actions">
                  <label className="ai-switch" title={j.enabled ? 'Aktiv' : 'Pausiert'}>
                    <input
                      type="checkbox"
                      checked={j.enabled}
                      onChange={wrap('save', () =>
                        api.aiSaveJob(jobPayload({ ...JOB_DEFAULTS, ...j, enabled: !j.enabled })),
                      )}
                    />
                    {j.enabled ? 'aktiv' : 'pausiert'}
                  </label>
                  <button
                    className="btn btn--small"
                    disabled={cfg.running.includes(j.id)}
                    onClick={wrap('run', async () => {
                      await api.aiRunJob({ id: j.id });
                      toast({ kind: 'info', title: 'Auftrag ausgeführt ✓', text: 'Die Nachricht wurde gepostet.' });
                    })}
                  >
                    {cfg.running.includes(j.id) ? 'Läuft …' : '▶ Jetzt'}
                  </button>
                  <button className="icon-btn" title="Bearbeiten" aria-label="Bearbeiten" onClick={() => setEditing(j)}>
                    ✏️
                  </button>
                  <button className="icon-btn" title="Löschen" aria-label="Löschen" onClick={wrap('del', () => api.aiDeleteJob({ id: j.id }))}>
                    🗑
                  </button>
                </div>
              </div>
            ),
          )}
          {editing === 'new' ? (
            targets.length ? (
              <JobForm
                targets={targets}
                toast={toast}
                onCancel={() => setEditing(null)}
                onSave={(job) =>
                  wrap('save', async () => {
                    await api.aiSaveJob(job);
                    setEditing(null);
                  })()
                }
              />
            ) : (
              <p className="muted small">Kein Kanal gefunden, in den der Bot schreiben darf.</p>
            )
          ) : (
            !editing && (
              <button className="btn btn--small" onClick={() => setEditing('new')}>
                ＋ Neuer Auftrag
              </button>
            )
          )}
          </Fold>
        </div>
      )}
    </Fold>
  );
}

// #112: Länge + geschätzte Tokens (≈ Zeichen/4). Ab ~1500 Tokens orange: jede Antwort kostet dann merklich mehr und
// kleine Modelle verlieren den Faden; ab ~4000 Tokens rot.
function TokenHint({ text }) {
  const n = (text || '').length;
  const tokens = Math.ceil(n / 4);
  const cls = tokens >= 4000 ? 'warn' : tokens >= 1500 ? 'token--mid' : 'muted';
  return (
    <span className={`small ${cls}`} title="Ungefähre Größe im Prompt. Je mehr Tokens, desto teurer und langsamer jede Antwort.">
      {n}/8000 Zeichen · ≈{tokens} Tokens{tokens >= 1500 ? ' – viel, jede Antwort wird teurer' : ''}
    </span>
  );
}
