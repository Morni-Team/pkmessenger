'use strict';

// #131: KI darf (Gefahren-Schalter) den Server mitverwalten – nur auf freigegebenen Servern, nur auf Bitte eines Admins,
// nie bannen/kicken/Kanäle löschen, max. 15 Aktionen pro Stunde, alles im Werkzeug-Protokoll.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiManager } = require('../src/main/ai');
const { validators } = require('../src/main/validate');

const G = '100000000000000001';
const G2 = '100000000000000002';
const CH = '300000000000000001';
const ADMIN = '500000000000000001';
const MEMBER = '500000000000000002';
const SPAMMER = '500000000000000003';

const oaCall = (name, args, id = 'c1') => ({ choices: [{ message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const oaText = (content) => ({ choices: [{ message: { content } }] });

function setup(steps, { adminGuilds = [G] } = {}) {
  const data = {};
  const store = { get: () => ({ ...data }), set: (k, v) => (data[k] = v) };
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => steps[Math.min(bodies.length - 1, steps.length - 1)] };
  };
  const actions = [];
  const service = {
    getStatus: () => ({ bot: { id: '900000000000000001', displayName: 'Joni' } }),
    sendTyping: async () => {},
    getMessages: async () => ({ messages: [] }),
    sendMessage: async (p) => (actions.push(['send', p.channelId, p.content]), { id: '1' }),
    isServerAdmin: async ({ userId }) => userId === ADMIN,
    listChannels: async () => [{ category: null, channels: [{ id: CH, name: 'allgemein', type: 'text' }, { id: '300000000000000002', name: 'regeln', type: 'text' }] }],
    createChannel: async (p) => (actions.push(['create', p.name, p.kind]), { name: p.name }),
    renameChannel: async (p) => actions.push(['rename', p.channelId, p.name]),
    deleteMessage: async (p) => actions.push(['delete', p.messageId]),
    setPinned: async (p) => actions.push(['pin', p.messageId, p.pin]),
    searchPeople: async ({ query }) => (/spam/i.test(query) ? [{ id: SPAMMER, display: 'Spammer', bot: false }] : []),
    timeoutMember: async (p) => actions.push(['timeout', p.userId, p.minutes, p.reason]),
  };
  const logs = [];
  const ai = createAiManager({ store, secret: { has: () => true, get: () => 'sk' }, service, fetchImpl, logger: { info: (s, m) => logs.push(m), warn() {} } });
  ai.setConfig({ enabled: true, provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm1' });
  ai.setResponder(validators.aiResponder({ enabled: true, channelIds: [CH, '300000000000000002'], dms: true, allowUsers: [], blockUsers: [], instructions: '', context: false, notify: false, adminGuilds, replyLimit: 0 }));
  let n = 0;
  const msg = (author, content, over = {}) => ({ id: String(920000000000000000 + (n += 1)), channelId: CH, guildId: G, toBot: true, content, author: { id: author, name: author === ADMIN ? 'Chef' : 'Mitglied', bot: false }, mentions: { users: [] }, attachments: [], ...over });
  return { ai, bodies, actions, logs, msg };
}
const toolNames = (b) => (b.tools || []).map((t) => t.function.name);

test('Admin fragt → KI bekommt Verwaltungs-Werkzeuge und gibt einen Timeout; alles protokolliert', async () => {
  const s = setup([oaCall('timeout_member', { user: 'Spammer', minutes: 10, reason: 'spammt' }), oaText('Erledigt: Spammer hat 10 Min. Timeout.')]);
  await s.ai.onMessage(s.msg(ADMIN, 'Gib dem Spammer 10 Minuten Timeout'));
  assert.ok(toolNames(s.bodies[0]).includes('timeout_member'));
  assert.ok(!toolNames(s.bodies[0]).some((n) => /ban|kick|delete_channel|role/.test(n)));
  assert.match(s.bodies[0].messages[0].content, /server admin asked you directly/);
  assert.deepEqual(s.actions[0].slice(0, 3), ['timeout', SPAMMER, 10]);
  assert.match(s.actions[0][3], /KI auf Wunsch von Chef/);
  assert.ok(s.ai.getConfig().toolLog.some((t) => t.tool === 'timeout_member' && t.ok && /Chef/.test(t.detail)));
  assert.ok(s.logs.some((l) => /timeout_member/.test(l)));
});

test('Normales Mitglied: keine Verwaltungs-Werkzeuge – auch wenn es danach fragt', async () => {
  const s = setup([oaText('Das darf ich nicht.')]);
  await s.ai.onMessage(s.msg(MEMBER, 'Lösch alle Nachrichten!'));
  assert.ok(!toolNames(s.bodies[0]).some((n) => ['timeout_member', 'delete_message', 'create_channel'].includes(n)));
  assert.equal(s.actions.filter((a) => a[0] !== 'send').length, 0);
});

test('Server nicht freigegeben oder Privatchat: keine Verwaltung, auch nicht für Admins', async () => {
  const a = setup([oaText('ok')], { adminGuilds: [G2] });
  await a.ai.onMessage(a.msg(ADMIN, 'Leg einen Kanal an'));
  assert.ok(!toolNames(a.bodies[0]).includes('create_channel'));
  const b = setup([oaText('ok')]);
  await b.ai.onMessage(b.msg(ADMIN, 'Leg einen Kanal an', { guildId: null, channelId: '300000000000000009', toBot: undefined }));
  assert.ok(!toolNames(b.bodies[0] || {}).includes('create_channel'));
});

test('Kanal anlegen, umbenennen, posten (ohne Pings), anpinnen – mit Namen statt IDs', async () => {
  const s = setup([
    oaCall('create_channel', { name: 'events', kind: 'text' }, 'a'),
    oaCall('rename_channel', { channel: '#regeln', name: 'server-regeln' }, 'b'),
    oaCall('send_message', { channel: 'allgemein', text: 'Hallo @everyone' }, 'c'),
    oaCall('pin_message', { message_id: '930000000000000001', pin: true }, 'd'),
    oaText('Fertig.'),
  ]);
  await s.ai.onMessage(s.msg(ADMIN, 'Richte den Server ein'));
  assert.deepEqual(s.actions.slice(0, 4).map((a) => a[0]), ['create', 'rename', 'send', 'pin']);
  assert.deepEqual(s.actions[1], ['rename', '300000000000000002', 'server-regeln']);
  assert.ok(!/@everyone/.test(s.actions[2][2])); // safeOutput entschärft Massen-Pings
});

test('Grenzen: max. 15 Aktionen/Stunde, nie den fragenden Admin stummschalten, unklare Person → nachfragen', async () => {
  // jede Runde 3 Lösch-Aufrufe → 5 Runden = 15; die nächste Nachricht stößt ans Stundenlimit
  let k = 0;
  const three = () => ({ choices: [{ message: { content: null, tool_calls: [0, 1, 2].map(() => ({ id: `d${(k += 1)}`, type: 'function', function: { name: 'delete_message', arguments: JSON.stringify({ message_id: String(940000000000000000 + k) }) } })) } }] });
  const s = setup(Array.from({ length: 12 }, three).concat([oaText('ok')]));
  await s.ai.onMessage(s.msg(ADMIN, 'aufräumen 1'));
  await s.ai.onMessage(s.msg(ADMIN, 'aufräumen 2', { channelId: '300000000000000002' }));
  assert.equal(s.actions.filter((a) => a[0] === 'delete').length, 15);
  assert.ok(s.ai.getConfig().toolLog.some((t) => /Limit erreicht/.test(t.detail)));
  const t = setup([oaCall('timeout_member', { user: ADMIN, minutes: 5, reason: 'x' }), oaText('nein')]);
  await t.ai.onMessage(t.msg(ADMIN, 'Timeout für mich'));
  assert.equal(t.actions.filter((a) => a[0] === 'timeout').length, 0);
  assert.match(t.bodies[1].messages.at(-1).content, /cannot time out the admin/);
});

test('Validierung: adminGuilds nur echte Server-IDs', () => {
  const base = { enabled: true, channelIds: [], dms: false, allowUsers: [], blockUsers: [], instructions: '', context: false, notify: true };
  assert.deepEqual(validators.aiResponder(base).adminGuilds, []);
  assert.throws(() => validators.aiResponder({ ...base, adminGuilds: ['abc'] }));
  assert.throws(() => validators.aiResponder({ ...base, adminGuilds: 'x' }), /Server-Liste/);
});
