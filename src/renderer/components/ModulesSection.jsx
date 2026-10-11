import { useEffect, useState } from 'react';
import { api } from '../api';
import Fold from './Fold';

// Bot-Module (Beta, #131 – Vorbild Moin_Julia): kleine Zusatzfunktionen pro Server, einzeln an/aus und einstellbar.
export default function ModulesSection({ guilds = [], targets = [], toast }) {
  const [guildId, setGuildId] = useState(guilds[0]?.id || '');
  const [mods, setMods] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!guildId && guilds[0]) setGuildId(guilds[0].id);
  }, [guilds, guildId]);
  useEffect(() => {
    if (!guildId) return;
    setMods(null);
    api
      .modulesList({ guildId })
      .then(setMods)
      .catch((e) => setError(e.message));
  }, [guildId]);

  const save = async (m, patch) => {
    setError('');
    try {
      setMods(await api.modulesSet({ guildId, moduleId: m.id, enabled: patch.enabled ?? m.enabled, config: patch.config ?? m.config }));
      return true;
    } catch (e) {
      setError(e.message);
      toast?.({ kind: 'warn', title: 'Nicht gespeichert', text: e.message });
      return false;
    }
  };
  const reset = async (m) => setMods(await api.modulesReset({ guildId, moduleId: m.id }).catch(() => mods));
  const channels = targets.filter((t) => !t.dm && t.guildId === guildId);
  const active = mods?.filter((m) => m.enabled).length || 0;

  return (
    <Fold id="modules" className="ai-card ai-all" title="🧩 Bot-Module" badge={mods ? `${active} an` : null} hint="Zusatzfunktionen für deinen Bot – pro Server einzeln an/aus">
      <p className="muted small">
        Zusatzfunktionen für deinen Bot – <b>ganz ohne KI</b>, pro Server einzeln an- und ausschaltbar. Sie laufen, solange PKMessenger offen ist. Der Bot pingt dabei nie jemanden.</p>
      {guilds.length === 0 ? (
        <p className="muted small">Der Bot ist auf keinem Server.</p>
      ) : (
        <div className="settings__row ai-target">
          <select aria-label="Server für Module" value={guildId} onChange={(e) => setGuildId(e.target.value)}>
            {guilds.map((g) => (
              <option key={g.id} value={g.id}>
                🖥 {g.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {error && (
        <p className="warn small" role="alert">
          {error}
        </p>
      )}
      {mods?.map((m) => (
        <Fold key={m.id} id={`module-${m.id}`} className="ai-mode module-card" title={`${m.icon} ${m.title}`} badge={m.enabled ? 'an' : 'aus'} hint={m.desc}>
          <p className="muted small">{m.desc}</p>
          <label className="composer__ping" data-setting={`module-${m.id}`}>
            <input type="checkbox" checked={m.enabled} onChange={(e) => save(m, { enabled: e.target.checked })} /> Auf diesem Server einschalten
          </label>
          {m.id === 'autoreply' && <AutoReplyEditor m={m} onSave={(config) => save(m, { config })} />}
          {m.id === 'counting' && (
            <>
              <div className="settings__row ai-target">
                <select aria-label="Zähl-Kanal" value={m.config.channelId} onChange={(e) => save(m, { config: { channelId: e.target.value } })}>
                  <option value="">– Kanal wählen –</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      #{c.name}
                    </option>
                  ))}
                </select>
              </div>
              <p className="small">
                Stand: <b>{m.info.current}</b> · Rekord: <b>{m.info.best}</b>{' '}
                <button className="link-btn" onClick={() => reset(m)}>
                  zurücksetzen
                </button>
              </p>
            </>
          )}
          {m.id === 'levels' && (
            <>
              <label className="composer__ping">
                <input type="checkbox" checked={m.config.announce} onChange={(e) => save(m, { config: { announce: e.target.checked } })} /> Neues Level im Chat ankündigen
              </label>
              <p className="small">
                {m.info.people} Personen mit Punkten ·{' '}
                <button className="link-btn" onClick={() => reset(m)}>
                  alle Punkte löschen
                </button>
              </p>
            </>
          )}
          {m.id === 'suggestions' && (
            <>
              <ChannelSelect label="Vorschlags-Kanal" value={m.config.channelId} channels={channels} onChange={(channelId) => save(m, { config: { ...m.config, channelId } })} />
              <Check label="Zu jedem Vorschlag einen Thread zum Diskutieren öffnen" checked={m.config.thread} onChange={(thread) => save(m, { config: { ...m.config, thread } })} />
            </>
          )}
          {m.id === 'protection' && (
            <>
              <Check label="🔗 Einladungen zu anderen Discord-Servern löschen" checked={m.config.invites} onChange={(invites) => save(m, { config: { ...m.config, invites } })} />
              <Check label="🔁 Spam löschen (gleiche Nachricht 4× oder 8 Nachrichten in 10 Sekunden)" checked={m.config.spam} onChange={(spam) => save(m, { config: { ...m.config, spam } })} />
              <div className="settings__row ai-target">
                <label className="small" htmlFor={`mass-${guildId}`}>📣 Massen-Pings ab</label>
                <select id={`mass-${guildId}`} value={m.config.massMentions} onChange={(e) => save(m, { config: { ...m.config, massMentions: Number(e.target.value) } })}>
                  {[0, 3, 5, 8, 10, 20].map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? 'aus' : `${n} Erwähnungen`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings__row ai-target">
                <label className="small" htmlFor={`to-${guildId}`}>⏳ Zusätzlich Timeout</label>
                <select id={`to-${guildId}`} value={m.config.timeoutMinutes} onChange={(e) => save(m, { config: { ...m.config, timeoutMinutes: Number(e.target.value) } })}>
                  {[0, 1, 5, 10, 60].map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? 'nein, nur löschen' : `${n} Minute${n === 1 ? '' : 'n'}`}
                    </option>
                  ))}
                </select>
              </div>
              <p className="muted small">Server-Admins sind immer ausgenommen. Der Bot braucht dafür die Rechte „Nachrichten verwalten“ (und für Timeouts „Mitglieder im Timeout“).</p>
            </>
          )}
          {m.id === 'starboard' && (
            <>
              <ChannelSelect label="Bestenkanal" value={m.config.channelId} channels={channels} onChange={(channelId) => save(m, { config: { ...m.config, channelId } })} />
              <div className="settings__row ai-target">
                <label className="small" htmlFor={`stars-${guildId}`}>⭐ Ab wie vielen Sternen</label>
                <select id={`stars-${guildId}`} value={m.config.threshold} onChange={(e) => save(m, { config: { ...m.config, threshold: Number(e.target.value) } })}>
                  {[1, 2, 3, 5, 7, 10, 15].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <p className="small">{m.info.posted || 0} Nachrichten im Bestenkanal</p>
            </>
          )}
          {m.id === 'logging' && (
            <>
              <ChannelSelect label="Protokoll-Kanal" value={m.config.channelId} channels={channels} onChange={(channelId) => save(m, { config: { ...m.config, channelId } })} />
              <Check label="🗑 Gelöschte Nachrichten" checked={m.config.deletes} onChange={(deletes) => save(m, { config: { ...m.config, deletes } })} />
              <Check label="✏️ Bearbeitete Nachrichten (vorher / nachher)" checked={m.config.edits} onChange={(edits) => save(m, { config: { ...m.config, edits } })} />
              <p className="muted small">⚠ Wähle einen Kanal, den nur dein Team sehen kann. Der Bot kennt nur Nachrichten, die seit dem Start von PKMessenger geschrieben wurden – nichts wird dauerhaft gespeichert.</p>
            </>
          )}
        </Fold>
      ))}
    </Fold>
  );
}

function AutoReplyEditor({ m, onSave }) {
  const [rules, setRules] = useState(m.config.rules);
  const dirty = JSON.stringify(rules) !== JSON.stringify(m.config.rules);
  const update = (i, patch) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="module-rules">
      {rules.map((r, i) => (
        <div key={i} className="module-rule">
          <div className="settings__row">
            <input aria-label="Stichwort" value={r.trigger} maxLength={100} placeholder="Stichwort, z. B. !regeln" onChange={(e) => update(i, { trigger: e.target.value })} />
            <select aria-label="Wann antworten" value={r.match} onChange={(e) => update(i, { match: e.target.value })}>
              <option value="genau">genau dieses Wort</option>
              <option value="enthaelt">wenn es vorkommt</option>
            </select>
            <button className="btn btn--ghost btn--small" aria-label="Auto-Antwort löschen" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
              🗑
            </button>
          </div>
          <textarea className="profile__desc" rows={2} maxLength={2000} value={r.reply} placeholder="Antwort des Bots" onChange={(e) => update(i, { reply: e.target.value })} />
        </div>
      ))}
      <div className="settings__row">
        {rules.length < 50 && (
          <button className="btn btn--ghost btn--small" onClick={() => setRules([...rules, { trigger: '', reply: '', match: 'genau' }])}>
            ＋ Auto-Antwort
          </button>
        )}
        {dirty && (
          // ganz leere Zeilen fallen beim Speichern einfach weg
          <button className="btn btn--primary btn--small" onClick={async () => { const clean = rules.filter((r) => r.trigger.trim() || r.reply.trim()); if (await onSave({ rules: clean })) setRules(clean); }}>
            Speichern
          </button>
        )}
      </div>
    </div>
  );
}

function ChannelSelect({ label, value, channels, onChange }) {
  return (
    <div className="settings__row ai-target">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">– {label} wählen –</option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            #{c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function Check({ label, checked, onChange }) {
  return (
    <label className="composer__ping">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}
