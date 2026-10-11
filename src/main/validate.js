'use strict';

const { isLocalAddress } = require('../shared/ai-limits');

const { isSnowflake } = require('../shared/snowflake');
const { parseInviteCode } = require('../shared/invites');
const { isValidSchedule } = require('../shared/schedule');
const { MESSAGE_CONTENT_MAX, MESSAGES_PER_FETCH_MAX, ALLOWED_MENTIONS_IDS_MAX, UPLOAD_MAX_BYTES, EMBEDS_PER_MESSAGE_MAX, EMBED_TOTAL_CHARS_MAX, FILES_PER_MESSAGE_MAX } = require('../shared/limits');

// Jeder IPC-Payload aus dem Renderer wird hier geprüft, bevor er discord.js erreicht.
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION';
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

function obj(payload) {
  if (!isPlainObject(payload)) throw new ValidationError('Ungültige Anfrage (kein Objekt).');
  return payload;
}

function snowflake(value, field) {
  if (!isSnowflake(value)) throw new ValidationError(`Ungültige ID im Feld "${field}".`);
  return value;
}

function optionalSnowflake(value, field) {
  return value === undefined || value === null ? undefined : snowflake(value, field);
}

function idList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ALLOWED_MENTIONS_IDS_MAX) throw new ValidationError(`Ungültige Liste "${field}".`);
  return [...new Set(value.map((v) => snowflake(v, field)))];
}

function mentionsOf(mentions) {
  const m = mentions === undefined ? {} : obj(mentions);
  if (m.everyone !== undefined && typeof m.everyone !== 'boolean') throw new ValidationError('Ungültiges Feld "everyone".');
  return { users: idList(m.users, 'users'), roles: idList(m.roles, 'roles'), everyone: m.everyone === true };
}

// Emoji: Unicode-Emoji (kurz, keine Steuerzeichen) oder eigenes Server-Emoji "name:id"
function isEmojiKey(e) {
  if (typeof e !== 'string' || e.length === 0 || e.length > 64) return false;
  if (/^[A-Za-z0-9_~-]{2,32}:\d{17,20}$/.test(e)) return true;
  return e.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]/u.test(e) && !/[\s<>:@#`]/.test(e);
}

// F10: Dateien – max. 10 Stück, zusammen max. 25 MiB (Discord-Limit pro Anfrage), sichere Dateinamen
function fileList(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > FILES_PER_MESSAGE_MAX) throw new ValidationError(`Höchstens ${FILES_PER_MESSAGE_MAX} Dateien pro Nachricht.`);
  let total = 0;
  const out = files.map((f) => {
    const { name, data } = obj(f);
    if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new ValidationError('Leere oder ungültige Datei.');
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) throw new ValidationError('Ungültiger Dateiname.');
    total += data.byteLength;
    const safe = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_');
    return { name: safe, data };
  });
  if (total > UPLOAD_MAX_BYTES) throw new ValidationError('Dateien sind zusammen größer als 25 MiB (Discord-Limit).');
  return out;
}

// F11: Embed-Baukasten – Discord-Limits (Titel 256, Beschreibung 4096, max. 10 Embeds, zusammen 6000 Zeichen)
function embedList(embeds) {
  if (embeds === undefined) return [];
  if (!Array.isArray(embeds) || embeds.length > EMBEDS_PER_MESSAGE_MAX) throw new ValidationError(`Höchstens ${EMBEDS_PER_MESSAGE_MAX} Embeds pro Nachricht.`);
  let chars = 0;
  const url = (v, field) => {
    if (v === undefined || v === '') return undefined;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
      return u.toString();
    } catch {
      throw new ValidationError(`Ungültiger Link im Feld "${field}".`);
    }
  };
  const out = embeds.map((e) => {
    const { title, description, color, footer, image } = obj(e);
    const str = (v, max, field) => {
      if (v === undefined || v === '') return undefined;
      if (typeof v !== 'string' || v.length > max) throw new ValidationError(`Embed-Feld "${field}" ist zu lang (max. ${max}).`);
      chars += v.length;
      return v;
    };
    const res = {
      title: str(title, 256, 'Titel'),
      description: str(description, 4096, 'Beschreibung'),
      footer: str(footer, 2048, 'Fußzeile'),
      url: url(e.url, 'Link'),
      image: url(image, 'Bild'),
      color: color === undefined || color === '' ? undefined : /^#[0-9a-fA-F]{6}$/.test(color) ? color : (() => { throw new ValidationError('Farbe muss wie #2dd4bf aussehen.'); })(),
    };
    if (!res.title && !res.description && !res.image) throw new ValidationError('Ein Embed braucht mindestens Titel, Beschreibung oder Bild.');
    return res;
  });
  if (chars > EMBED_TOTAL_CHARS_MAX) throw new ValidationError('Embeds haben zusammen mehr als 6000 Zeichen (Discord-Limit).');
  return out;
}

// Umfragen – Discord-Limits: Frage 300, 1–10 Antworten à 55 Zeichen, Laufzeit 1 Std. bis 32 Tage (768 Std.)
function pollOf(poll) {
  if (poll === undefined || poll === null) return null;
  const { question, answers, durationHours, allowMultiselect } = obj(poll);
  if (typeof question !== 'string' || question.trim().length === 0 || question.length > 300) throw new ValidationError('Die Frage muss 1–300 Zeichen haben.');
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 10) throw new ValidationError('Eine Umfrage braucht 1–10 Antworten.');
  const clean = answers.map((a) => (typeof a === 'string' ? a.trim() : ''));
  if (clean.some((a) => a.length === 0 || a.length > 55)) throw new ValidationError('Jede Antwort muss 1–55 Zeichen haben.');
  if (new Set(clean.map((a) => a.toLowerCase())).size !== clean.length) throw new ValidationError('Antworten dürfen nicht doppelt vorkommen.');
  if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 768) throw new ValidationError('Laufzeit muss zwischen 1 Stunde und 32 Tagen liegen.');
  if (allowMultiselect !== undefined && typeof allowMultiselect !== 'boolean') throw new ValidationError('Ungültiges Feld "allowMultiselect".');
  return { question: question.trim(), answers: clean, durationHours, allowMultiselect: allowMultiselect === true };
}

// Bot-Profil: Bild per Magic-Bytes prüfen (nicht dem Dateinamen trauen) und als Data-URI an Discord geben
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
function imageMime(d) {
  if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return 'image/png';
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'image/jpeg';
  if (d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x38) return 'image/gif';
  if (d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 && d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50) return 'image/webp';
  return null;
}

function avatarOf(avatar) {
  if (avatar === undefined) return undefined;
  if (avatar === null) return null; // zurück zum Standardbild
  if (!(avatar instanceof Uint8Array) || avatar.byteLength < 12) throw new ValidationError('Ungültiges Bild.');
  if (avatar.byteLength > AVATAR_MAX_BYTES) throw new ValidationError('Das Bild ist größer als 8 MiB.');
  const mime = imageMime(avatar);
  if (!mime) throw new ValidationError('Nur PNG, JPG, GIF oder WebP sind als Profilbild erlaubt.');
  return `data:${mime};base64,${Buffer.from(avatar.buffer, avatar.byteOffset, avatar.byteLength).toString('base64')}`;
}

// Discord-Regeln für Benutzernamen (Doku "Usernames and Nicknames")
function usernameOf(name) {
  if (name === undefined) return undefined;
  if (typeof name !== 'string') throw new ValidationError('Ungültiger Name.');
  const n = name.trim();
  if (n.length < 2 || n.length > 32) throw new ValidationError('Der Name muss 2–32 Zeichen haben.');
  if (/[@#:]|```/.test(n) || /discord/i.test(n) || /^(everyone|here)$/i.test(n)) throw new ValidationError('Der Name darf nicht @, #, :, ``` oder „discord“ enthalten.');
  return n;
}

// KI-Agenten (Beta): Anbieter-Adresse nur https – Ausnahme: lokale Modelle (Ollama, LM Studio) auf diesem PC
function aiBaseUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new ValidationError('Ungültige Adresse des KI-Anbieters.');
  }
  // http nur für diesen PC oder das eigene Heimnetz (z. B. LM Studio auf http://192.168.x.x:1234, Issue #1)
  const local = u.protocol === 'http:' && isLocalAddress(u.toString());
  if (u.protocol !== 'https:' && !local) throw new ValidationError('Die Adresse muss mit https:// beginnen (im eigenen Netz auch http://, z. B. http://localhost oder http://192.168.…).');
  if (u.username || u.password || u.search || u.hash) throw new ValidationError('Die Adresse darf keine Zugangsdaten oder Parameter enthalten.');
  return u.toString().replace(/\/+$/, '');
}

// Eigener Benachrichtigungston: nur WAV (RIFF/WAVE per Magic-Bytes), max. 2 MiB
const SOUND_MAX_BYTES = 2 * 1024 * 1024;

// Begründung fürs Audit-Log (Discord: max. 512 Zeichen; „PKMessenger: “ kommt davor)
function modReason(reason) {
  if (reason === undefined || reason === null || reason === '') return '';
  if (typeof reason !== 'string' || reason.length > 400) throw new ValidationError('Die Begründung darf höchstens 400 Zeichen haben.');
  return reason.trim();
}

const validators = {
  soundFile(p) {
    const { data } = obj(p);
    if (!(data instanceof Uint8Array) || data.byteLength < 44) throw new ValidationError('Ungültige Audiodatei.');
    if (data.byteLength > SOUND_MAX_BYTES) throw new ValidationError('Die Audiodatei ist größer als 2 MiB.');
    const ascii = (a, b) => String.fromCharCode(...data.subarray(a, b));
    if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WAVE') throw new ValidationError('Nur WAV-Dateien (.wav) sind erlaubt.');
    return data;
  },
  aiConfig(p) {
    const { enabled, provider, baseUrl, model } = obj(p);
    if (typeof enabled !== 'boolean') throw new ValidationError('Ungültiges Feld "enabled".');
    if (provider !== 'openai' && provider !== 'anthropic') throw new ValidationError('Unbekannter KI-Anbieter-Typ.');
    if (typeof model !== 'string' || model.length > 100 || /[\s<>"'`]/.test(model.trim())) throw new ValidationError('Ungültiger Modellname.');
    return { enabled, provider, baseUrl: aiBaseUrl(baseUrl), model: model.trim() };
  },
  aiKey(p) {
    const { key } = obj(p);
    if (typeof key !== 'string' || key.trim().length < 8 || key.length > 400 || /\s/.test(key.trim())) throw new ValidationError('Das sieht nicht wie ein API-Schlüssel aus.');
    return key.trim();
  },
  aiJob(p) {
    const { id, name, channelId, channelName, prompt, schedule, context, enabled, maxLength, language, persona, contextSize, postAs, notify, web } = obj(p);
    if (id !== undefined && !(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))) throw new ValidationError('Ungültige Auftrags-ID.');
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 60) throw new ValidationError('Der Name muss 1–60 Zeichen haben.');
    if (typeof prompt !== 'string' || prompt.trim().length < 3 || prompt.length > 2000) throw new ValidationError('Der Auftrag muss 3–2000 Zeichen haben.');
    if (channelName !== undefined && (typeof channelName !== 'string' || channelName.length > 100)) throw new ValidationError('Ungültiger Kanalname.');
    if (typeof context !== 'boolean' || typeof enabled !== 'boolean') throw new ValidationError('Ungültige Schalter.');
    const s = obj(schedule);
    const clean = s.kind === 'interval' ? { kind: 'interval', minutes: s.minutes } : { kind: 'daily', time: s.time, days: Array.isArray(s.days) ? [...s.days] : s.days };
    if (!isValidSchedule(clean)) throw new ValidationError('Ungültiger Zeitplan (mind. alle 15 Minuten, Uhrzeit HH:MM, mind. ein Wochentag).');
    // Neu (Issue #12): Länge, Sprache, Persona, Kontextumfang, Thread oder Nachricht, Hinweis
    const len = maxLength === undefined ? 1800 : maxLength;
    if (!Number.isInteger(len) || len < 100 || len > 2000) throw new ValidationError('Die Antwortlänge muss 100–2000 Zeichen sein.');
    const lang = language === undefined ? 'auto' : language;
    if (!['auto', 'de', 'en'].includes(lang)) throw new ValidationError('Unbekannte Sprache.');
    if (persona !== undefined && (typeof persona !== 'string' || persona.length > 300)) throw new ValidationError('Der Tonfall darf höchstens 300 Zeichen haben.');
    const ctx = contextSize === undefined ? (context ? 20 : 0) : contextSize;
    if (![0, 10, 20, 50].includes(ctx)) throw new ValidationError('Ungültiger Kontextumfang.');
    const mode = postAs === undefined ? 'message' : postAs;
    if (!['message', 'thread'].includes(mode)) throw new ValidationError('Ungültige Art (Nachricht oder Thread).');
    if (notify !== undefined && typeof notify !== 'boolean') throw new ValidationError('Ungültiges Feld "notify".');
    if (web !== undefined && typeof web !== 'boolean') throw new ValidationError('Ungültiges Feld "web".');
    return {
      ...(id ? { id } : {}),
      name: name.trim(),
      channelId: snowflake(channelId, 'channelId'),
      channelName: channelName?.trim() || '',
      prompt: prompt.trim(),
      schedule: clean,
      context: ctx > 0,
      contextSize: ctx,
      enabled,
      maxLength: len,
      language: lang,
      persona: (persona || '').trim(),
      postAs: mode,
      notify: notify !== false,
      web: web === true,
    };
  },
  aiOptions(p) {
    const { thinking, autoConnect, vision } = obj(p);
    const out = {};
    if (vision !== undefined) {
      if (typeof vision !== 'boolean') throw new ValidationError('Ungültiger Schalter.');
      out.vision = vision;
    }
    if (thinking !== undefined) {
      if (typeof thinking !== 'boolean') throw new ValidationError('Ungültiger Schalter.');
      out.thinking = thinking;
    }
    if (autoConnect !== undefined) {
      if (typeof autoConnect !== 'boolean') throw new ValidationError('Ungültiger Schalter.');
      out.autoConnect = autoConnect;
    }
    return out;
  },
  activeChat(p) {
    const { channelId, focused } = obj(p);
    if (typeof focused !== 'boolean') throw new ValidationError('Ungültiger Schalter.');
    return { channelId: channelId ? snowflake(channelId, 'channelId') : null, focused };
  },
  aiModels(p) {
    const { provider, baseUrl } = obj(p);
    if (provider !== 'openai' && provider !== 'anthropic') throw new ValidationError('Unbekannter KI-Anbieter-Typ.');
    return { provider, baseUrl: aiBaseUrl(baseUrl) };
  },
  aiResponder(p) {
    const { enabled, channelIds, dms, allowUsers, blockUsers, instructions, context, notify, web = false, quietWhenOpen = true, memory = false, memoryBudget = 3000, memoryAuto = true, modes = [], activeModes = {}, modeUsers = [], replyLimit = 30, adminGuilds = [] } = obj(p);
    if (typeof web !== 'boolean' || typeof quietWhenOpen !== 'boolean' || typeof memory !== 'boolean' || typeof memoryAuto !== 'boolean') throw new ValidationError('Ungültiger Schalter.');
    if (![1000, 3000, 8000, 16000].includes(memoryBudget)) throw new ValidationError('Ungültige Gedächtnisgröße.');
    for (const [k, v] of Object.entries({ enabled, dms, context, notify })) if (typeof v !== 'boolean') throw new ValidationError(`Ungültiges Feld "${k}".`);
    if (!Array.isArray(channelIds) || channelIds.length > 500) throw new ValidationError('Ungültige Kanalliste.');
    const people = (list, field) => {
      if (!Array.isArray(list) || list.length > 100) throw new ValidationError(`Ungültige Liste "${field}".`);
      const seen = new Set();
      return list
        .map((u) => {
          const { id, name } = obj(u);
          if (typeof name !== 'string' || name.length > 100) throw new ValidationError('Ungültiger Name in der Personenliste.');
          return { id: snowflake(id, field), name: name.trim() || 'Unbekannt' };
        })
        .filter((u) => !seen.has(u.id) && seen.add(u.id));
    };
    if (typeof instructions !== 'string' || instructions.length > 8000) throw new ValidationError('Die Anweisungen dürfen höchstens 8000 Zeichen haben.');
    // KI-Modi: Name (für „modus Name“ im Chat), eigene Anweisungen, optional eigenes Modell
    if (!Array.isArray(modes) || modes.length > 20) throw new ValidationError('Höchstens 20 Modi.');
    const names = new Set();
    const cleanModes = modes.map((x) => {
      const { id, name, instructions: ins = '', model = '' } = obj(x);
      if (typeof id !== 'string' || !/^[a-z0-9-]{4,40}$/i.test(id)) throw new ValidationError('Ungültige Modus-ID.');
      if (typeof name !== 'string' || !/^[\p{L}\p{N} _-]{1,32}$/u.test(name.trim())) throw new ValidationError('Modus-Name: 1–32 Buchstaben, Zahlen, Leerzeichen, - oder _.');
      const key = name.trim().toLowerCase();
      if (names.has(key) || ['standard', 'normal', 'aus', 'default', 'reset'].includes(key)) throw new ValidationError(`Den Modus-Namen „${name.trim()}“ gibt es schon oder er ist reserviert.`);
      names.add(key);
      if (typeof ins !== 'string' || ins.length > 8000) throw new ValidationError('Modus-Anweisungen: höchstens 8000 Zeichen.');
      if (typeof model !== 'string' || model.length > 100 || /[\s<>]/.test(model.trim())) throw new ValidationError('Ungültiger Modellname.');
      return { id, name: name.trim(), instructions: ins.trim(), model: model.trim() };
    });
    if (!activeModes || typeof activeModes !== 'object' || Array.isArray(activeModes)) throw new ValidationError('Ungültige aktive Modi.');
    const ids = new Set(cleanModes.map((x) => x.id));
    const cleanActive = Object.fromEntries(Object.entries(activeModes).filter(([k, v]) => isSnowflake(k) && ids.has(v)).slice(0, 500));
    if (!Number.isInteger(replyLimit) || replyLimit < 0 || replyLimit > 500) throw new ValidationError('Antworten pro Stunde: 0 (unbegrenzt) bis 500.');
    // #131: Server, auf denen die KI (auf Wunsch von Admins) mitverwalten darf – Gefahren-Schalter, ab Werk leer
    if (!Array.isArray(adminGuilds) || adminGuilds.length > 50) throw new ValidationError('Ungültige Server-Liste.');
    return {
      enabled,
      channelIds: [...new Set(channelIds.map((c) => snowflake(c, 'channelIds')))],
      dms,
      allowUsers: people(allowUsers, 'allowUsers'),
      blockUsers: people(blockUsers, 'blockUsers'),
      instructions: instructions.trim(),
      context,
      notify,
      web,
      quietWhenOpen,
      memory,
      memoryBudget,
      memoryAuto,
      modes: cleanModes,
      activeModes: cleanActive,
      modeUsers: people(modeUsers, 'modeUsers'),
      replyLimit,
      adminGuilds: [...new Set(adminGuilds.map((g) => snowflake(g, 'adminGuilds')))],
    };
  },
  aiLimits(p) {
    const { mode = 'auto', perHour, perDay } = obj(p);
    if (!['auto', 'an', 'aus'].includes(mode)) throw new ValidationError('Unbekannter Limit-Modus.');
    if (!Number.isInteger(perHour) || perHour < 1 || perHour > 500) throw new ValidationError('Stundenlimit: 1–500 Anfragen.');
    if (!Number.isInteger(perDay) || perDay < 1 || perDay > 5000) throw new ValidationError('Tageslimit: 1–5000 Anfragen.');
    if (perDay < perHour) throw new ValidationError('Das Tageslimit darf nicht kleiner als das Stundenlimit sein.');
    return { mode, perHour, perDay };
  },
  aiProfileName(p) {
    const { name } = obj(p);
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 40) throw new ValidationError('Der Profilname muss 1–40 Zeichen haben.');
    return { name: name.trim() };
  },
  aiJobRef(p) {
    const { id } = obj(p);
    if (!(typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))) throw new ValidationError('Ungültige Auftrags-ID.');
    return { id };
  },
  lockPassword(p) {
    const { password } = obj(p);
    if (typeof password !== 'string' || password.length > 200) throw new ValidationError('Ungültiges Passwort.');
    return { password };
  },
  lockSet(p) {
    const { password, current, idleMinutes } = obj(p);
    if (typeof password !== 'string' || password.length > 200) throw new ValidationError('Ungültiges Passwort.');
    if (current !== undefined && (typeof current !== 'string' || current.length > 200)) throw new ValidationError('Ungültiges Passwort.');
    if (idleMinutes !== undefined && !Number.isInteger(idleMinutes)) throw new ValidationError('Ungültige Zeit.');
    return { password, current, idleMinutes: idleMinutes ?? 0 };
  },
  lockIdle(p) {
    const { idleMinutes } = obj(p);
    if (!Number.isInteger(idleMinutes)) throw new ValidationError('Ungültige Zeit.');
    return { idleMinutes };
  },
  channelRename(p) {
    const { channelId, name } = obj(p);
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 100) throw new ValidationError('Der Kanalname muss 1–100 Zeichen haben.');
    return { channelId: snowflake(channelId, 'channelId'), name: name.trim() };
  },
  channelCreate(p) {
    const { guildId, name, kind, parentId, isPrivate, memberIds } = obj(p);
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 100) throw new ValidationError('Der Name muss 1–100 Zeichen haben.');
    if (kind !== 'text' && kind !== 'voice') throw new ValidationError('Ungültige Art.');
    if (memberIds !== undefined && (!Array.isArray(memberIds) || memberIds.length > 25)) throw new ValidationError('Höchstens 25 Personen.');
    const ids = [...new Set((memberIds || []).map((id) => snowflake(id, 'memberIds')))];
    return {
      guildId: snowflake(guildId, 'guildId'),
      name: name.trim(),
      kind,
      parentId: parentId == null || parentId === '' ? null : snowflake(parentId, 'parentId'),
      isPrivate: isPrivate === true,
      memberIds: isPrivate === true ? ids : [],
    };
  },
  channelMove(p) {
    const { channelId, direction } = obj(p);
    if (direction !== 'up' && direction !== 'down') throw new ValidationError('Ungültige Richtung.');
    return { channelId: snowflake(channelId, 'channelId'), direction };
  },
  memberRef(p) {
    const { guildId, userId } = obj(p);
    return { guildId: snowflake(guildId, 'guildId'), userId: snowflake(userId, 'userId') };
  },
  memberRole(p) {
    const { guildId, userId, roleId, add, reason } = obj(p);
    if (typeof add !== 'boolean') throw new ValidationError('Ungültiges Feld "add".');
    return { guildId: snowflake(guildId, 'guildId'), userId: snowflake(userId, 'userId'), roleId: snowflake(roleId, 'roleId'), add, reason: modReason(reason) };
  },
  memberTimeout(p) {
    const { guildId, userId, minutes, reason } = obj(p);
    // 0 = Timeout aufheben; Discord erlaubt höchstens 28 Tage
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 40320) throw new ValidationError('Timeout: 0 Minuten bis 28 Tage.');
    return { guildId: snowflake(guildId, 'guildId'), userId: snowflake(userId, 'userId'), minutes, reason: modReason(reason) };
  },
  memberKick(p) {
    const { guildId, userId, reason } = obj(p);
    return { guildId: snowflake(guildId, 'guildId'), userId: snowflake(userId, 'userId'), reason: modReason(reason) };
  },
  memberBan(p) {
    const { guildId, userId, reason, deleteMessageSeconds } = obj(p);
    const del = deleteMessageSeconds === undefined ? 0 : deleteMessageSeconds;
    if (!Number.isInteger(del) || del < 0 || del > 604800) throw new ValidationError('Nachrichten löschen: 0 bis 7 Tage.');
    return { guildId: snowflake(guildId, 'guildId'), userId: snowflake(userId, 'userId'), reason: modReason(reason), deleteMessageSeconds: del };
  },
  copyText(p) {
    const { text } = obj(p);
    // #129: Fehlerberichte können länger als 4000 Zeichen sein (GitHub erlaubt ~65 000)
    if (typeof text !== 'string' || text.length > 20000) throw new ValidationError('Ungültiger Text.');
    return text;
  },
  userRef(p) {
    const { userId } = obj(p);
    return { userId: snowflake(userId, 'userId') };
  },
  profileRef(p) {
    if (p === undefined || p === null) return {};
    const { guildId } = obj(p);
    return { guildId: optionalSnowflake(guildId, 'guildId') };
  },
  profileUpdate(p) {
    const { username, avatar, description, guildId, nick } = obj(p);
    if (description !== undefined && (typeof description !== 'string' || description.length > 400)) throw new ValidationError('Die Beschreibung darf höchstens 400 Zeichen haben.');
    if (nick !== undefined && (typeof nick !== 'string' || nick.trim().length > 32)) throw new ValidationError('Der Spitzname darf höchstens 32 Zeichen haben.');
    if (nick !== undefined && guildId == null) throw new ValidationError('Für den Spitznamen fehlt der Server.');
    const out = {
      username: usernameOf(username),
      avatar: avatarOf(avatar),
      description: description === undefined ? undefined : description.trim(),
      guildId: optionalSnowflake(guildId, 'guildId'),
      nick: nick === undefined ? undefined : nick.trim(),
    };
    if (out.username === undefined && out.avatar === undefined && out.description === undefined && out.nick === undefined) throw new ValidationError('Nichts zu ändern.');
    return out;
  },
  guildRef(p) {
    const { guildId } = obj(p);
    return { guildId: snowflake(guildId, 'guildId') };
  },
  channelRef(p) {
    const { channelId } = obj(p);
    return { channelId: snowflake(channelId, 'channelId') };
  },
  getMessages(p) {
    const { channelId, before, limit } = obj(p);
    const lim = limit === undefined ? 50 : limit;
    if (!Number.isInteger(lim) || lim < 1 || lim > MESSAGES_PER_FETCH_MAX) throw new ValidationError('limit muss zwischen 1 und 100 liegen.');
    return { channelId: snowflake(channelId, 'channelId'), before: optionalSnowflake(before, 'before'), limit: lim };
  },
  sendMessage(p) {
    const { channelId, content, mentions, nonce, replyTo, pingReply, files, embeds, poll } = obj(p);
    if (typeof content !== 'string') throw new ValidationError('Nachricht fehlt.');
    if (content.length > MESSAGE_CONTENT_MAX) throw new ValidationError(`Nachricht ist länger als ${MESSAGE_CONTENT_MAX} Zeichen.`);
    if (nonce !== undefined && !(typeof nonce === 'string' && /^[A-Za-z0-9]{1,25}$/.test(nonce))) throw new ValidationError('Ungültige Nonce.');
    if (pingReply !== undefined && typeof pingReply !== 'boolean') throw new ValidationError('Ungültiges Feld "pingReply".');
    const cleanFiles = fileList(files);
    const cleanEmbeds = embedList(embeds);
    const cleanPoll = pollOf(poll);
    if (content.trim().length === 0 && cleanFiles.length === 0 && cleanEmbeds.length === 0 && !cleanPoll) throw new ValidationError('Leere Nachrichten können nicht gesendet werden.');
    return {
      channelId: snowflake(channelId, 'channelId'),
      content,
      nonce,
      mentions: mentionsOf(mentions),
      replyTo: optionalSnowflake(replyTo, 'replyTo') ?? null,
      pingReply: pingReply === true,
      files: cleanFiles,
      embeds: cleanEmbeds,
      poll: cleanPoll,
    };
  },
  editMessage(p) {
    const { channelId, messageId, content, mentions } = obj(p);
    if (typeof content !== 'string' || content.trim().length === 0) throw new ValidationError('Leerer Text kann nicht gespeichert werden.');
    if (content.length > MESSAGE_CONTENT_MAX) throw new ValidationError(`Nachricht ist länger als ${MESSAGE_CONTENT_MAX} Zeichen.`);
    return { channelId: snowflake(channelId, 'channelId'), messageId: snowflake(messageId, 'messageId'), content, mentions: mentionsOf(mentions) };
  },
  messageRef(p) {
    const { channelId, messageId } = obj(p);
    return { channelId: snowflake(channelId, 'channelId'), messageId: snowflake(messageId, 'messageId') };
  },
  react(p) {
    const { channelId, messageId, emoji, add } = obj(p);
    if (typeof add !== 'boolean') throw new ValidationError('Ungültiges Feld "add".');
    if (!isEmojiKey(emoji)) throw new ValidationError('Ungültiges Emoji.');
    return { channelId: snowflake(channelId, 'channelId'), messageId: snowflake(messageId, 'messageId'), emoji, add };
  },
  pin(p) {
    const { channelId, messageId, pin } = obj(p);
    if (typeof pin !== 'boolean') throw new ValidationError('Ungültiges Feld "pin".');
    return { channelId: snowflake(channelId, 'channelId'), messageId: snowflake(messageId, 'messageId'), pin };
  },
  threadCreate(p) {
    const { channelId, name, messageId, content } = obj(p);
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 100) throw new ValidationError('Thread-Name muss 1–100 Zeichen haben.');
    if (content !== undefined && (typeof content !== 'string' || content.length > MESSAGE_CONTENT_MAX)) throw new ValidationError('Ungültige erste Nachricht.');
    return { channelId: snowflake(channelId, 'channelId'), name: name.trim(), messageId: optionalSnowflake(messageId, 'messageId'), content: content?.trim() || undefined };
  },
  threadRef(p) {
    const { threadId } = obj(p);
    return { threadId: snowflake(threadId, 'threadId') };
  },
  search(p) {
    const { guildId, content, channelId, authorId, pinned, offset } = obj(p);
    if (content !== undefined && (typeof content !== 'string' || content.length > 1024)) throw new ValidationError('Suchtext darf höchstens 1024 Zeichen haben.');
    if (pinned !== undefined && typeof pinned !== 'boolean') throw new ValidationError('Ungültiges Feld "pinned".');
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0 || offset > 9975)) throw new ValidationError('Ungültiger Offset.');
    const c = typeof content === 'string' ? content.trim() : '';
    if (!c && channelId == null && authorId == null && pinned === undefined) throw new ValidationError('Bitte einen Suchbegriff eingeben.');
    return { guildId: snowflake(guildId, 'guildId'), content: c || undefined, channelId: optionalSnowflake(channelId, 'channelId'), authorId: optionalSnowflake(authorId, 'authorId'), pinned, offset: offset ?? 0 };
  },
  searchMentionables(p) {
    const { guildId, query } = obj(p);
    if (typeof query !== 'string' || query.length > 32) throw new ValidationError('Ungültige Suchanfrage.');
    return { guildId: snowflake(guildId, 'guildId'), query };
  },
  lockHello(p) {
    const { on } = obj(p);
    if (typeof on !== 'boolean') throw new ValidationError('Ungültiger Schalter.');
    return { on };
  },
  backgroundSet(p) {
    const { on } = obj(p);
    if (typeof on !== 'boolean') throw new ValidationError('Ungültiger Schalter.');
    return { on };
  },
  searchPeople(p) {
    const { query, guildId } = obj(p);
    if (typeof query !== 'string' || query.length > 32) throw new ValidationError('Ungültige Suchanfrage.');
    return { query: query.trim(), ...(guildId == null ? {} : { guildId: snowflake(guildId, 'guildId') }) };
  },
  userProfile(p) {
    const { userId, guildId } = obj(p);
    return { userId: snowflake(userId, 'userId'), guildId: guildId ? snowflake(guildId, 'guildId') : null };
  },
  readMarker(p) {
    const { channelId, messageId } = obj(p);
    return { channelId: snowflake(channelId, 'channelId'), messageId: snowflake(messageId, 'messageId') };
  },
  lastLocation(p) {
    const { guildId, channelId } = obj(p);
    return { guildId: optionalSnowflake(guildId, 'guildId') ?? null, channelId: optionalSnowflake(channelId, 'channelId') ?? null };
  },
  inviteInput(p) {
    const { invite } = obj(p);
    const code = parseInviteCode(invite);
    if (!code) throw new ValidationError('Das ist kein gültiger Discord-Einladungslink (z. B. discord.gg/abc123).');
    return { code };
  },
  // #156: Wodurch wurde die Fernhilfe beendet? (nur fürs Protokoll)
  // #160: Nachricht des Nutzers im Hilfe-Chat
  helpChat(p) {
    const { text } = obj(p);
    if (typeof text !== 'string' || !text.trim() || text.length > 300) throw new ValidationError('Nachricht: 1 bis 300 Zeichen.');
    return { text: text.trim() };
  },
  helpStop(p) {
    if (p === undefined || p === null) return { reason: 'unbekannt' };
    const { reason = 'unbekannt' } = obj(p);
    if (!['knopf', 'tastatur', 'kein-link', 'unbekannt'].includes(reason)) throw new ValidationError('Ungültiger Grund.');
    return { reason };
  },
  helpRelay(p) {
    const { url, mode } = obj(p);
    if (mode !== undefined && !['standard', 'own', 'off'].includes(mode)) throw new ValidationError('Unbekannte Relay-Einstellung.');
    if (url === undefined && mode !== undefined) return { mode };
    if (url === '' || url == null) return { url: '', ...(mode ? { mode } : {}) };
    if (typeof url !== 'string' || url.length > 300 || !/^wss:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(url)) throw new ValidationError('Bitte eine Adresse wie wss://relay.deine-domain.de/ws eintragen.');
    return { url: url.trim(), ...(mode ? { mode } : {}) };
  },
  tokenImport(p) {
    const { link, code } = obj(p);
    if (typeof link !== 'string' || link.length > 2000 || !link.trim().startsWith('pkmessenger://login')) throw new ValidationError('Das ist kein gültiger Anmelde-Link.');
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{4}[- ]?[A-Za-z0-9]{4}$/.test(code.trim())) throw new ValidationError('Der Code hat 8 Zeichen (z. B. ABCD-2345).');
    return { link: link.trim(), code: code.trim() };
  },
  tokenInput(p) {
    const { token } = obj(p);
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw new ValidationError('Das sieht nicht wie ein Bot-Token aus.');
    return token;
  },
  optionalGuildRef(p) {
    if (p === undefined || p === null) return {};
    const { guildId } = obj(p);
    return guildId === undefined || guildId === null ? {} : { guildId: snowflake(guildId, 'guildId') };
  },
  voiceJoin(p) {
    const { guildId, channelId, listen } = obj(p);
    if (listen !== undefined && typeof listen !== 'boolean') throw new ValidationError('Ungültiges Feld "listen".');
    return { guildId: snowflake(guildId, 'guildId'), channelId: snowflake(channelId, 'channelId'), listen: listen !== false };
  },
  flag(p) {
    const { on } = obj(p);
    if (typeof on !== 'boolean') throw new ValidationError('Ungültiges Feld "on".');
    return on;
  },
  memorySummary(p) {
    const { userId, summary } = obj(p);
    if (typeof summary !== 'string' || summary.length > 4000) throw new ValidationError('Die Zusammenfassung darf höchstens 4000 Zeichen haben.');
    return { userId: snowflake(userId, 'userId'), summary };
  },
  remotePassword(p) {
    const { password, current } = obj(p);
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new ValidationError('Das Fernzugangs-Passwort braucht 8–200 Zeichen.');
    if (current !== undefined && (typeof current !== 'string' || current.length > 200)) throw new ValidationError('Ungültiges bisheriges Passwort.');
    return { password, current };
  },
  remoteOptions(p) {
    const { requireApproval, newRoom } = obj(p);
    if (requireApproval !== undefined && typeof requireApproval !== 'boolean') throw new ValidationError('Ungültiger Schalter.');
    if (newRoom !== undefined && newRoom !== true) throw new ValidationError('Ungültiger Schalter.');
    if (requireApproval === undefined && !newRoom) throw new ValidationError('Ungültiger Schalter.');
    return { ...(requireApproval !== undefined ? { requireApproval } : {}), ...(newRoom ? { newRoom: true } : {}) };
  },
  remoteDecide(p) {
    const { id, allow } = obj(p);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(id) || typeof allow !== 'boolean') throw new ValidationError('Ungültige Entscheidung.');
    return { id, allow };
  },
  remoteId(p) {
    const { id, pairId } = obj(p);
    const v = id ?? pairId;
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{4,40}$/.test(v)) throw new ValidationError('Ungültige ID.');
    return { id: v, pairId: v };
  },
  logError(p) {
    const { where, message } = obj(p);
    return { where: typeof where === 'string' ? where.slice(0, 200) : 'renderer', message: typeof message === 'string' ? message.slice(0, 2000) : 'unknown' };
  },
  externalUrl(p) {
    const { url } = obj(p);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ValidationError('Ungültiger Link.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ValidationError('Nur http(s)-Links sind erlaubt.');
    return { url: parsed.toString() };
  },
};

module.exports = { validators, ValidationError, isPlainObject };
