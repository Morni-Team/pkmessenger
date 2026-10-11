'use strict';

// #131: Bot-Module (Vorbild Moin_Julia) – Auto-Antworten, Zählen, Level. Pro Server an/aus, ab Werk aus.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBotModules, levelOf } = require('../src/main/bot-modules');
const { buildHandlers } = require('../src/main/ipc');

const G = '100000000000000001';
const CH = '300000000000000001';
const COUNT = '300000000000000002';

function setup() {
  const data = {};
  const store = { get: () => ({ ...data }), set: (k, v) => (data[k] = v) };
  const sent = [];
  const reactions = [];
  const service = {
    sendMessage: async (p) => (sent.push(p), { id: 'x' }),
    react: async (p) => reactions.push(p.emoji),
  };
  let t = 1_000_000;
  const mods = createBotModules({ store, service, now: () => t });
  let n = 0;
  const msg = (content, over = {}) => ({ id: String(900000000000000000 + (n += 1)), guildId: G, channelId: CH, content, author: { id: '500000000000000001', name: 'Anna', bot: false }, isOwn: false, ...over });
  return { mods, sent, reactions, data, msg, tick: (ms) => (t += ms) };
}

test('Ab Werk ist jedes Modul aus – der Bot reagiert auf nichts', async () => {
  const { mods, sent, msg } = setup();
  assert.ok(mods.list({ guildId: G }).every((m) => m.enabled === false));
  await mods.onMessage(msg('!rang'));
  assert.equal(sent.length, 0);
});

test('Auto-Antworten: genau / enthält, ohne Pings, mit Abklingzeit', async () => {
  const { mods, sent, msg, tick } = setup();
  mods.set({ guildId: G, moduleId: 'autoreply', enabled: true, config: { rules: [{ trigger: '!regeln', reply: 'Seid nett @everyone', match: 'genau' }, { trigger: 'hilfe', reply: 'Schreib ins #support', match: 'enthaelt' }] } });
  await mods.onMessage(msg('!REGELN'));
  await mods.onMessage(msg('!regeln')); // Abklingzeit
  await mods.onMessage(msg('ich brauche Hilfe bitte'));
  await mods.onMessage(msg('!regeln bitte')); // „genau“ passt nicht
  assert.deepEqual(sent.map((s) => s.content), ['Seid nett @everyone', 'Schreib ins #support']);
  assert.deepEqual(sent[0].mentions, { users: [], roles: [], everyone: false });
  tick(11000);
  await mods.onMessage(msg('!regeln'));
  assert.equal(sent.length, 3);
  // nie auf Bots oder sich selbst
  await mods.onMessage(msg('!regeln', { author: { id: '2', name: 'Bot', bot: true } }));
  await mods.onMessage(msg('hilfe', { isOwn: true }));
  assert.equal(sent.length, 3);
});

test('Zählen: richtig → ✅, zweimal hintereinander oder falsch → ❌ und von vorn', async () => {
  const { mods, sent, reactions, msg } = setup();
  mods.set({ guildId: G, moduleId: 'counting', enabled: true, config: { channelId: COUNT } });
  const c = (content, user = '500000000000000001') => msg(content, { channelId: COUNT, author: { id: user, name: `U${user.slice(-1)}`, bot: false } });
  await mods.onMessage(c('1', '500000000000000001'));
  await mods.onMessage(c('2', '500000000000000002'));
  await mods.onMessage(c('wer ist dran?', '500000000000000003')); // Reden ist erlaubt
  await mods.onMessage(c('3', '500000000000000002')); // zweimal hintereinander
  assert.deepEqual(reactions, ['✅', '✅', '❌']);
  assert.match(sent[0].content, /zweimal hintereinander.*\*\*1\*\*.*Rekord: 2/);
  await mods.onMessage(c('5', '500000000000000001'));
  assert.match(sent[1].content, /verzählt \(richtig wäre 1\)/);
  assert.equal(mods.list({ guildId: G }).find((m) => m.id === 'counting').info.best, 2);
  // anderer Kanal zählt nicht
  await mods.onMessage(msg('1'));
  assert.equal(reactions.length, 4);
});

test('Level: Punkte höchstens 1× pro Minute, Level-Aufstieg, !rang und !top', async () => {
  const { mods, sent, msg, tick } = setup();
  mods.set({ guildId: G, moduleId: 'levels', enabled: true, config: { announce: true } });
  assert.equal(levelOf(0), 0);
  assert.equal(levelOf(100), 1);
  assert.equal(levelOf(300), 2);
  for (let i = 0; i < 5; i += 1) {
    await mods.onMessage(msg(`Nachricht ${i}`));
    await mods.onMessage(msg('Spam'));
    tick(61000);
  }
  assert.ok(sent.some((s) => /Anna ist jetzt \*\*Level 1\*\*/.test(s.content)));
  await mods.onMessage(msg('!rang'));
  assert.match(sent.at(-1).content, /Level \*\*1\*\* · 100 Punkte · Platz 1/);
  await mods.onMessage(msg('!top'));
  assert.match(sent.at(-1).content, /1\. Anna – Level 1 \(100\)/);
});

test('Eigenes Antwort-Limit pro Server (kein Zuspammen)', async () => {
  const { mods, sent, msg } = setup();
  mods.set({ guildId: G, moduleId: 'levels', enabled: true, config: { announce: false } });
  for (let i = 0; i < 40; i += 1) await mods.onMessage(msg('!top'));
  assert.equal(sent.length, 20);
});

test('IPC: Eingaben werden geprüft', async () => {
  const { mods } = setup();
  const h = buildHandlers({ botModules: mods, store: { get: () => ({}) } });
  assert.throws(() => h['pk:modules-set']({ guildId: 'x', moduleId: 'levels', enabled: true }), /Server/);
  assert.throws(() => h['pk:modules-set']({ guildId: G, moduleId: 'hack', enabled: true }), /Unbekanntes Modul/);
  assert.throws(() => h['pk:modules-set']({ guildId: G, moduleId: 'levels', enabled: 'ja' }), /Schalter/);
  assert.throws(() => h['pk:modules-set']({ guildId: G, moduleId: 'counting', enabled: true, config: { channelId: '../x' } }), /Kanal/);
  assert.throws(() => h['pk:modules-set']({ guildId: G, moduleId: 'autoreply', enabled: true, config: { rules: [{ trigger: '', reply: 'x' }] } }), /Stichwort/);
  assert.throws(() => h['pk:modules-set']({ guildId: G, moduleId: 'autoreply', enabled: true, config: { rules: Array.from({ length: 51 }, () => ({ trigger: 'a', reply: 'b' })) } }), /50/);
  assert.equal(h['pk:modules-list']({ guildId: G }).length, 7);
});

function setup2({ admin = false } = {}) {
  const data = {};
  const store = { get: () => ({ ...data }), set: (k, v) => (data[k] = v) };
  const calls = [];
  const service = {
    sendMessage: async (p) => (calls.push(['send', p.channelId, p.content, p.mentions]), { id: 'x' }),
    react: async (p) => calls.push(['react', p.emoji]),
    createThread: async (p) => calls.push(['thread', p.name]),
    deleteMessage: async (p) => calls.push(['delete', p.messageId]),
    timeoutMember: async (p) => calls.push(['timeout', p.userId, p.minutes]),
    isServerAdmin: async () => admin,
  };
  let t = 5_000_000;
  const mods = createBotModules({ store, service, now: () => t });
  let n = 0;
  const msg = (content, over = {}) => ({ id: String(910000000000000000 + (n += 1)), guildId: G, channelId: CH, content, author: { id: '500000000000000001', name: 'Anna', bot: false }, mentions: { users: [], roles: [], everyone: false }, attachments: [], reactions: [], isOwn: false, ...over });
  return { mods, calls, msg, tick: (ms) => (t += ms) };
}

test('Vorschläge: 👍/👎 und Thread nur im Vorschlags-Kanal', async () => {
  const { mods, calls, msg } = setup2();
  mods.set({ guildId: G, moduleId: 'suggestions', enabled: true, config: { channelId: COUNT, thread: true } });
  await mods.onMessage(msg('Mehr Emojis bitte', { channelId: COUNT }));
  await mods.onMessage(msg('anderer Kanal'));
  assert.deepEqual(calls.map((c) => c[0] + ':' + c[1]), ['react:👍', 'react:👎', 'thread:💡 Mehr Emojis bitte']);
});

test('Schutz: Einladung/Massen-Ping/Spam → löschen (+ Timeout); Admins ausgenommen; andere Module reagieren dann nicht', async () => {
  const s = setup2();
  s.mods.set({ guildId: G, moduleId: 'protection', enabled: true, config: { invites: true, massMentions: 3, spam: true, timeoutMinutes: 5, ignoreChannelIds: [] } });
  s.mods.set({ guildId: G, moduleId: 'autoreply', enabled: true, config: { rules: [{ trigger: 'discord', reply: 'Antwort', match: 'enthaelt' }] } });
  await s.mods.onMessage(s.msg('Komm auf discord.gg/abc123'));
  assert.deepEqual(s.calls.slice(0, 2).map((c) => c[0]), ['delete', 'timeout']);
  assert.match(s.calls[2][2], /Anna entfernt: Einladungen/);
  assert.deepEqual(s.calls[2][3], { users: [], roles: [], everyone: false });
  assert.ok(!s.calls.some((c) => c[2] === 'Antwort')); // Auto-Antwort lief nicht mehr
  await s.mods.onMessage(s.msg('hey', { mentions: { users: [{ id: '1' }, { id: '2' }, { id: '3' }], roles: [], everyone: false } }));
  assert.equal(s.calls.filter((c) => c[0] === 'delete').length, 2);
  for (let i = 0; i < 4; i += 1) await s.mods.onMessage(s.msg('KAUFT JETZT'));
  assert.equal(s.calls.filter((c) => c[0] === 'delete').length, 3);
  const a = setup2({ admin: true });
  a.mods.set({ guildId: G, moduleId: 'protection', enabled: true, config: {} });
  await a.mods.onMessage(a.msg('discord.gg/abc123'));
  assert.equal(a.calls.length, 0);
});

test('Starboard: ab Schwelle genau einmal in den Bestenkanal, mit Link', async () => {
  const { mods, calls, msg } = setup2();
  const BEST = '300000000000000009';
  mods.set({ guildId: G, moduleId: 'starboard', enabled: true, config: { channelId: BEST, threshold: 2 } });
  const m = msg('Bester Witz ever');
  await mods.onUpdate({ ...m, reactions: [{ key: '⭐', count: 1 }] });
  await mods.onUpdate({ ...m, reactions: [{ key: '⭐', count: 2 }] });
  await mods.onUpdate({ ...m, reactions: [{ key: '⭐', count: 3 }] });
  const sent = calls.filter((c) => c[0] === 'send');
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], BEST);
  assert.match(sent[0][2], /⭐ \*\*2\*\*[\s\S]*Bester Witz ever[\s\S]*discord\.com\/channels\//);
});

test('Protokoll: gelöscht/bearbeitet in den Protokoll-Kanal – nur, wenn an (sonst wird nichts gemerkt)', async () => {
  const { mods, calls, msg } = setup2();
  const LOG = '300000000000000008';
  const m = msg('Geheimer Text');
  await mods.onMessage(m); // Modul aus → nichts gemerkt
  await mods.onDelete({ id: m.id, channelId: CH });
  assert.equal(calls.length, 0);
  mods.set({ guildId: G, moduleId: 'logging', enabled: true, config: { channelId: LOG, deletes: true, edits: true } });
  const m2 = msg('Erster Text');
  await mods.onMessage(m2);
  await mods.onUpdate({ ...m2, content: 'Zweiter Text' });
  await mods.onDelete({ id: m2.id, channelId: CH });
  const sent = calls.filter((c) => c[0] === 'send');
  assert.equal(sent.length, 2);
  assert.match(sent[0][2], /bearbeitet[\s\S]*> Erster Text[\s\S]*> Zweiter Text/);
  assert.match(sent[1][2], /gelöscht[\s\S]*> Zweiter Text/);
  assert.ok(sent.every((c) => c[1] === LOG));
});

test('Neue Module: Eingaben werden geprüft', () => {
  const { mods } = setup2();
  assert.throws(() => mods.set({ guildId: G, moduleId: 'protection', enabled: true, config: { timeoutMinutes: 999 } }), /Timeout/);
  assert.throws(() => mods.set({ guildId: G, moduleId: 'protection', enabled: true, config: { massMentions: -1 } }), /Massen-Pings/);
  assert.throws(() => mods.set({ guildId: G, moduleId: 'starboard', enabled: true, config: { threshold: 0 } }), /Sterne/);
  assert.throws(() => mods.set({ guildId: G, moduleId: 'logging', enabled: true, config: { channelId: 'abc' } }), /Kanal/);
  assert.equal(mods.list({ guildId: G }).length, 7);
});
