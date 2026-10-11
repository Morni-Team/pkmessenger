'use strict';

// Bot-Module (Beta, Wunsch JONIMONI09 in #131 – Vorbild: Modul-System von Moin_Julia): kleine Zusatzfunktionen,
// pro Server einzeln an/aus und einstellbar. Laufen nur, solange PKMessenger offen ist. Ab Werk ist alles AUS.
// Sicherheit: Der Bot pingt in Modul-Antworten nie jemanden (keine Massen-Pings), antwortet nie auf Bots,
// und hat ein eigenes Antwort-Limit pro Server, damit ein Modul den Kanal nicht zuspammen kann.

const NO_MENTIONS = Object.freeze({ users: [], roles: [], everyone: false });
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_REPLIES_PER_MIN = 20;
const XP_COOLDOWN_MS = 60 * 1000;
const XP_PER_MSG = 20;
const AUTOREPLY_COOLDOWN_MS = 10 * 1000;

const CATALOG = [
  {
    id: 'autoreply',
    icon: '💬',
    title: 'Auto-Antworten',
    desc: 'Der Bot antwortet auf Stichwörter mit festem Text – z. B. „!regeln“ → eure Server-Regeln.',
    defaults: { rules: [] },
  },
  {
    id: 'counting',
    icon: '🔢',
    title: 'Zählen',
    desc: 'Ein Kanal, in dem alle gemeinsam hochzählen. Niemand darf zweimal hintereinander. Falsche Zahl → von vorn.',
    defaults: { channelId: '' },
  },
  {
    id: 'levels',
    icon: '⭐',
    title: 'Level',
    desc: 'Punkte fürs Schreiben (höchstens 1× pro Minute). „!rang“ zeigt den eigenen Stand, „!top“ die Bestenliste.',
    defaults: { announce: true },
  },
  // #136/#131: weitere Module nach Vorbild Moin_Julia (ohne KI, ohne privilegierte Discord-Freigaben)
  {
    id: 'suggestions',
    icon: '💡',
    title: 'Vorschläge',
    desc: 'In einem Vorschlags-Kanal bekommt jede Nachricht automatisch 👍 und 👎 – auf Wunsch mit eigenem Thread zum Diskutieren.',
    defaults: { channelId: '', thread: true },
  },
  {
    id: 'protection',
    icon: '🛡',
    title: 'Schutz',
    desc: 'Löscht Einladungen zu fremden Servern, Massen-Pings und Spam. Admins sind ausgenommen. Auf Wunsch kurzer Timeout.',
    defaults: { invites: true, massMentions: 5, spam: true, timeoutMinutes: 0, ignoreChannelIds: [] },
  },
  {
    id: 'starboard',
    icon: '🌟',
    title: 'Starboard',
    desc: 'Bekommt eine Nachricht genug ⭐-Reaktionen, landet sie im Bestenkanal.',
    defaults: { channelId: '', threshold: 3 },
  },
  {
    id: 'logging',
    icon: '📝',
    title: 'Protokoll',
    desc: 'Schreibt gelöschte und bearbeitete Nachrichten in einen Protokoll-Kanal (nur für dein Team sichtbar machen!).',
    defaults: { channelId: '', deletes: true, edits: true },
  },
];
const IDS = new Set(CATALOG.map((m) => m.id));

const { ValidationError } = require('./validate');
const fail = (msg) => {
  throw new ValidationError(msg);
};

/** Einstellungen eines Moduls prüfen (IPC-Validierung). */
function checkConfig(moduleId, raw) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (moduleId === 'autoreply') {
    const rules = Array.isArray(c.rules) ? c.rules : [];
    if (rules.length > 50) fail('Höchstens 50 Auto-Antworten.');
    return {
      rules: rules.map((r) => {
        const trigger = typeof r?.trigger === 'string' ? r.trigger.trim() : '';
        const reply = typeof r?.reply === 'string' ? r.reply.trim() : '';
        if (!trigger || trigger.length > 100) fail('Stichwort: 1 bis 100 Zeichen.');
        if (!reply || reply.length > 2000) fail('Antwort: 1 bis 2000 Zeichen.');
        return { trigger, reply, match: r?.match === 'enthaelt' ? 'enthaelt' : 'genau' };
      }),
    };
  }
  if (moduleId === 'counting') {
    const channelId = typeof c.channelId === 'string' ? c.channelId : '';
    if (channelId && !SNOWFLAKE.test(channelId)) fail('Ungültiger Kanal.');
    return { channelId };
  }
  if (moduleId === 'levels') return { announce: c.announce !== false };
  const channel = (v) => {
    const id = typeof v === 'string' ? v : '';
    if (id && !SNOWFLAKE.test(id)) fail('Ungültiger Kanal.');
    return id;
  };
  if (moduleId === 'suggestions') return { channelId: channel(c.channelId), thread: c.thread !== false };
  if (moduleId === 'protection') {
    const mass = c.massMentions === undefined ? 5 : c.massMentions;
    if (!Number.isInteger(mass) || mass < 0 || mass > 50) fail('Massen-Pings: 0 (aus) bis 50.');
    const minutes = c.timeoutMinutes === undefined ? 0 : c.timeoutMinutes;
    if (![0, 1, 5, 10, 60].includes(minutes)) fail('Timeout: 0, 1, 5, 10 oder 60 Minuten.');
    const ignore = Array.isArray(c.ignoreChannelIds) ? c.ignoreChannelIds : [];
    if (ignore.length > 100) fail('Höchstens 100 Kanäle ausnehmen.');
    return { invites: c.invites !== false, massMentions: mass, spam: c.spam !== false, timeoutMinutes: minutes, ignoreChannelIds: [...new Set(ignore.map(channel).filter(Boolean))] };
  }
  if (moduleId === 'starboard') {
    const threshold = c.threshold === undefined ? 3 : c.threshold;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 50) fail('Sterne: 1 bis 50.');
    return { channelId: channel(c.channelId), threshold };
  }
  if (moduleId === 'logging') return { channelId: channel(c.channelId), deletes: c.deletes !== false, edits: c.edits !== false };
  return fail('Unbekanntes Modul.');
}

function checkSet(p) {
  const o = p && typeof p === 'object' ? p : fail('Ungültige Anfrage.');
  if (!SNOWFLAKE.test(String(o.guildId || ''))) fail('Ungültiger Server.');
  if (!IDS.has(o.moduleId)) fail('Unbekanntes Modul.');
  if (typeof o.enabled !== 'boolean') fail('Schalter muss an oder aus sein.');
  return { guildId: o.guildId, moduleId: o.moduleId, enabled: o.enabled, config: checkConfig(o.moduleId, o.config) };
}

/** Level aus Punkten: 100, 300, 600, 1000 … (immer etwas mehr pro Stufe) */
const levelOf = (xp) => Math.floor((Math.sqrt(1 + (8 * xp) / 100) - 1) / 2);

function createBotModules({ store, service, now = () => Date.now(), logger = null }) {
  const replies = new Map(); // guildId → [Zeitpunkte]
  const ruleCooldown = new Map(); // guild|channel|trigger → bis
  const xpCooldown = new Map(); // guild|user → bis
  let saveTimer = null;

  const allCfg = () => {
    const raw = store.get().botModules;
    return raw && typeof raw === 'object' ? raw : {};
  };
  // Laufende Daten (Zählerstand, Punkte) getrennt von den Einstellungen
  const data = (() => {
    const raw = store.get().botModuleData;
    return raw && typeof raw === 'object' ? raw : {};
  })();
  const saveData = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('botModuleData', data), 2000);
    saveTimer.unref?.();
  };
  const dataOf = (guildId, moduleId) => {
    data[guildId] ||= {};
    data[guildId][moduleId] ||= {};
    return data[guildId][moduleId];
  };

  const stateOf = (guildId, moduleId) => {
    const s = allCfg()[guildId]?.[moduleId];
    const def = CATALOG.find((m) => m.id === moduleId);
    let config = def.defaults;
    try {
      config = s?.config ? checkConfig(moduleId, s.config) : def.defaults;
    } catch {
      config = def.defaults;
    }
    return { enabled: s?.enabled === true, config };
  };

  function list({ guildId }) {
    if (!SNOWFLAKE.test(String(guildId || ''))) fail('Ungültiger Server.');
    return CATALOG.map((m) => {
      const st = stateOf(guildId, m.id);
      const d = data[guildId]?.[m.id] || {};
      const info = m.id === 'counting' ? { current: d.current || 0, best: d.best || 0 } : m.id === 'levels' ? { people: Object.keys(d.xp || {}).length } : m.id === 'starboard' ? { posted: Object.keys(d.posted || {}).length } : {};
      return { id: m.id, icon: m.icon, title: m.title, desc: m.desc, ...st, info };
    });
  }

  function set(p) {
    const { guildId, moduleId, enabled, config } = checkSet(p);
    const all = { ...allCfg() };
    all[guildId] = { ...(all[guildId] || {}), [moduleId]: { enabled, config } };
    store.set('botModules', all);
    return list({ guildId });
  }

  /** Daten eines Moduls zurücksetzen (Zählerstand, Punkte). */
  function reset({ guildId, moduleId }) {
    if (!SNOWFLAKE.test(String(guildId || '')) || !IDS.has(moduleId)) fail('Ungültige Anfrage.');
    if (data[guildId]) delete data[guildId][moduleId];
    saveData();
    return list({ guildId });
  }

  // Eigenes Limit pro Server: nie mehr als MAX_REPLIES_PER_MIN Modul-Antworten pro Minute
  function mayReply(guildId) {
    const t = now();
    const list = (replies.get(guildId) || []).filter((x) => t - x < 60000);
    if (list.length >= MAX_REPLIES_PER_MIN) {
      replies.set(guildId, list);
      return false;
    }
    list.push(t);
    replies.set(guildId, list);
    return true;
  }
  async function say(m, content) {
    if (!mayReply(m.guildId)) return false;
    await service.sendMessage({ channelId: m.channelId, content: String(content).slice(0, 2000), mentions: NO_MENTIONS, replyTo: m.id, pingReply: false, files: [], embeds: [], poll: null });
    return true;
  }
  const react = (m, emoji) => Promise.resolve(service.react?.({ channelId: m.channelId, messageId: m.id, emoji, add: true })).catch(() => {});
  const nameOf = (m) => String(m.author?.name || 'Jemand').replace(/[@`*_~|<>]/g, '').slice(0, 40);

  async function autoreply(m, cfg) {
    const text = String(m.content || '').trim().toLowerCase();
    const rule = cfg.rules.find((r) => (r.match === 'genau' ? text === r.trigger.toLowerCase() : text.includes(r.trigger.toLowerCase())));
    if (!rule) return;
    const key = `${m.guildId}|${m.channelId}|${rule.trigger}`;
    if ((ruleCooldown.get(key) || 0) > now()) return;
    ruleCooldown.set(key, now() + AUTOREPLY_COOLDOWN_MS);
    await say(m, rule.reply);
  }

  async function counting(m, cfg) {
    if (!cfg.channelId || m.channelId !== cfg.channelId) return;
    const t = String(m.content || '').trim();
    if (!/^\d{1,9}$/.test(t)) return; // Reden zwischendurch ist erlaubt
    const d = dataOf(m.guildId, 'counting');
    const n = Number(t);
    const current = d.current || 0;
    if (n === current + 1 && d.lastUserId !== m.author.id) {
      d.current = n;
      d.lastUserId = m.author.id;
      d.best = Math.max(d.best || 0, n);
      saveData();
      await react(m, '✅');
      return;
    }
    const why = d.lastUserId === m.author.id && n === current + 1 ? 'hat zweimal hintereinander gezählt' : `hat sich verzählt (richtig wäre ${current + 1})`;
    d.current = 0;
    d.lastUserId = null;
    saveData();
    await react(m, '❌');
    await say(m, `💥 ${nameOf(m)} ${why}. Wieder von vorn – die nächste Zahl ist **1**. (Rekord: ${d.best || 0})`);
  }

  async function levels(m, cfg) {
    const d = dataOf(m.guildId, 'levels');
    d.xp ||= {};
    const text = String(m.content || '').trim().toLowerCase();
    if (text === '!rang') {
      const xp = d.xp[m.author.id]?.xp || 0;
      const rank = Object.values(d.xp).filter((x) => x.xp > xp).length + 1;
      await say(m, `⭐ ${nameOf(m)}: Level **${levelOf(xp)}** · ${xp} Punkte · Platz ${rank}`);
      return;
    }
    if (text === '!top') {
      const top = Object.values(d.xp)
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 10)
        .map((x, i) => `${i + 1}. ${String(x.name || '?').replace(/[@`*_~|<>]/g, '')} – Level ${levelOf(x.xp)} (${x.xp})`);
      await say(m, top.length ? `🏆 **Bestenliste**\n${top.join('\n')}` : '🏆 Noch niemand hat Punkte.');
      return;
    }
    const key = `${m.guildId}|${m.author.id}`;
    if ((xpCooldown.get(key) || 0) > now()) return;
    xpCooldown.set(key, now() + XP_COOLDOWN_MS);
    const entry = d.xp[m.author.id] || { xp: 0, name: '' };
    const before = levelOf(entry.xp);
    entry.xp += XP_PER_MSG;
    entry.name = nameOf(m);
    d.xp[m.author.id] = entry;
    saveData();
    const after = levelOf(entry.xp);
    if (after > before && cfg.announce) await say(m, `🎉 ${nameOf(m)} ist jetzt **Level ${after}**!`);
  }

  async function suggestions(m, cfg) {
    if (!cfg.channelId || m.channelId !== cfg.channelId || !String(m.content || '').trim()) return;
    await react(m, '👍');
    await react(m, '👎');
    if (cfg.thread) {
      const name = `💡 ${String(m.content).replace(/\s+/g, ' ').slice(0, 80)}`;
      await Promise.resolve(service.createThread?.({ channelId: m.channelId, name, messageId: m.id })).catch(() => {});
    }
  }

  // Schutz: Admins (und der Bot selbst) sind immer ausgenommen. Aktionen: Nachricht löschen, kurz erklären, optional Timeout.
  const recentByUser = new Map(); // guild|user → [{ at, text }]
  const INVITE = /(discord\.gg|discord(app)?\.com\/invite)\/[a-z0-9-]+/i;
  async function protection(m, cfg) {
    if (cfg.ignoreChannelIds.includes(m.channelId)) return;
    const text = String(m.content || '');
    let reason = null;
    if (cfg.invites && INVITE.test(text)) reason = 'Einladungen zu anderen Servern sind hier nicht erlaubt';
    const pings = (m.mentions?.users?.length || 0) + (m.mentions?.roles?.length || 0) + (m.mentions?.everyone ? 10 : 0);
    if (!reason && cfg.massMentions > 0 && pings >= cfg.massMentions) reason = 'zu viele Erwähnungen auf einmal';
    if (!reason && cfg.spam) {
      const key = `${m.guildId}|${m.author.id}`;
      const t = now();
      const list = (recentByUser.get(key) || []).filter((x) => t - x.at < 10000);
      list.push({ at: t, text: text.trim().toLowerCase() });
      recentByUser.set(key, list);
      const same = list.filter((x) => x.text && x.text === list.at(-1).text).length;
      if (same >= 4 || list.length >= 8) reason = 'Spam (zu viele Nachrichten in kurzer Zeit)';
    }
    if (!reason) return;
    const admin = await Promise.resolve(service.isServerAdmin?.({ guildId: m.guildId, userId: m.author.id })).catch(() => false);
    if (admin) return;
    await Promise.resolve(service.deleteMessage?.({ channelId: m.channelId, messageId: m.id })).catch((err) => logger?.warn?.('module', `Schutz: löschen ging nicht – ${err?.message || err}`));
    cache.delete(m.id);
    if (cfg.timeoutMinutes > 0) {
      await Promise.resolve(service.timeoutMember?.({ guildId: m.guildId, userId: m.author.id, minutes: cfg.timeoutMinutes, reason: `Schutz-Modul: ${reason}` })).catch(() => {});
    }
    const key = `${m.guildId}|warn|${m.author.id}`;
    if ((ruleCooldown.get(key) || 0) > now()) return 'removed'; // pro Person höchstens eine Erklärung pro Minute
    ruleCooldown.set(key, now() + 60000);
    if (mayReply(m.guildId)) {
      await service.sendMessage({ channelId: m.channelId, content: `🛡 Nachricht von ${nameOf(m)} entfernt: ${reason}.${cfg.timeoutMinutes ? ` (${cfg.timeoutMinutes} Min. Timeout)` : ''}`, mentions: NO_MENTIONS, files: [], embeds: [], poll: null }).catch(() => {});
    }
    return 'removed';
  }

  const HANDLERS = { autoreply, counting, levels, suggestions, protection };

  // ---- Bearbeiten / Löschen / Reaktionen (Protokoll, Starboard) ----
  const cache = new Map(); // messageId → { guildId, channelId, author, content, at } – nur im Speicher, max. 3000
  const remember = (m) => {
    if (!m?.id || !m.guildId) return;
    cache.set(m.id, { guildId: m.guildId, channelId: m.channelId, author: nameOf(m), content: String(m.content || '').slice(0, 1500), attachments: (m.attachments || []).length });
    if (cache.size > 3000) cache.delete(cache.keys().next().value);
  };
  const enabled = (guildId, id) => allCfg()[guildId]?.[id]?.enabled === true;
  async function logTo(guildId, text) {
    const cfg = stateOf(guildId, 'logging').config;
    if (!cfg.channelId || !mayReply(guildId)) return;
    await service.sendMessage({ channelId: cfg.channelId, content: text.slice(0, 2000), mentions: NO_MENTIONS, files: [], embeds: [], poll: null }).catch(() => {});
  }
  const quote = (s) => (s ? s.split('\n').map((l) => `> ${l}`).join('\n') : '> *(kein Text)*');

  /** Nachricht bearbeitet (oder Reaktion geändert – Discord meldet beides als Update). */
  async function onUpdate(m) {
    if (!m?.guildId || !SNOWFLAKE.test(String(m.guildId))) return;
    try {
      const before = cache.get(m.id);
      if (enabled(m.guildId, 'logging') && before && !m.author?.bot && !m.isOwn && before.content !== String(m.content || '')) {
        const cfg = stateOf(m.guildId, 'logging').config;
        if (cfg.edits && m.channelId !== cfg.channelId) await logTo(m.guildId, `✏️ **${nameOf(m)}** hat in <#${m.channelId}> bearbeitet:\n**Vorher:**\n${quote(before.content)}\n**Nachher:**\n${quote(String(m.content || '').slice(0, 800))}`);
      }
      remember(m);
      if (enabled(m.guildId, 'starboard')) {
        const cfg = stateOf(m.guildId, 'starboard').config;
        const stars = (m.reactions || []).find((r) => r.key === '⭐')?.count || 0;
        const d = dataOf(m.guildId, 'starboard');
        d.posted ||= {};
        if (cfg.channelId && m.channelId !== cfg.channelId && stars >= cfg.threshold && !d.posted[m.id]) {
          d.posted[m.id] = now();
          const ids = Object.keys(d.posted);
          if (ids.length > 2000) delete d.posted[ids[0]];
          saveData();
          const img = (m.attachments || []).find((a) => /^image\//.test(a.contentType || ''))?.url;
          const link = `https://discord.com/channels/${m.guildId}/${m.channelId}/${m.id}`;
          if (mayReply(m.guildId)) await service.sendMessage({ channelId: cfg.channelId, content: `⭐ **${stars}** · <#${m.channelId}> · **${nameOf(m)}**\n${quote(String(m.content || '').slice(0, 1500))}${img ? `\n${img}` : ''}\n${link}`, mentions: NO_MENTIONS, files: [], embeds: [], poll: null }).catch(() => {});
        }
      }
    } catch (err) {
      logger?.warn?.('module', `update: ${err?.message || err}`);
    }
  }

  /** Nachricht gelöscht – Inhalt kennen wir nur, wenn sie seit dem App-Start im Speicher war. */
  async function onDelete({ id, channelId } = {}) {
    const before = cache.get(id);
    if (!before) return;
    cache.delete(id);
    if (!enabled(before.guildId, 'logging')) return;
    const cfg = stateOf(before.guildId, 'logging').config;
    if (!cfg.deletes || channelId === cfg.channelId) return;
    await logTo(before.guildId, `🗑 Nachricht von **${before.author}** in <#${before.channelId}> gelöscht:\n${quote(before.content)}${before.attachments ? `\n📎 ${before.attachments} Anhang/Anhänge` : ''}`);
  }

  /** Jede neue Nachricht (vom Hauptprozess durchgereicht). */
  async function onMessage(m) {
    if (!m?.guildId || !m.author?.id || m.author.bot || m.isOwn || m.system || !SNOWFLAKE.test(String(m.guildId))) return;
    const cfgs = allCfg()[m.guildId];
    if (!cfgs) return;
    // Protokoll: Inhalt nur merken, wenn das Modul an ist (sonst bleibt nichts im Speicher)
    if (cfgs.logging?.enabled === true) remember(m);
    // Schutz zuerst – wurde die Nachricht entfernt, reagieren die anderen Module nicht mehr darauf
    const order = ['protection', ...[...IDS].filter((x) => x !== 'protection')];
    for (const id of order) {
      if (cfgs[id]?.enabled !== true || !HANDLERS[id]) continue;
      try {
        if ((await HANDLERS[id](m, stateOf(m.guildId, id).config)) === 'removed') return;
      } catch (err) {
        logger?.warn?.('module', `${id}: ${err?.message || err}`);
      }
    }
  }

  function flush() {
    clearTimeout(saveTimer);
    store.set('botModuleData', data);
  }

  return { list, set, reset, onMessage, onUpdate, onDelete, flush, _data: () => data };
}

module.exports = { createBotModules, CATALOG, checkSet, levelOf };
