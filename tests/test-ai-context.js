'use strict';

// #119: Kleines Kontextfenster (LM Studio: „request (2939 tokens) exceeds the available context size (2816 tokens)“)
// → verständlicher Fehler; PKMessenger antwortet trotzdem: erst ohne Werkzeuge, dann mit kurzem Prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiManager } = require('../src/main/ai');
const { createMemory } = require('../src/main/ai-memory');
const { validators } = require('../src/main/validate');

const OVERFLOW = { error: 'request (2939 tokens) exceeds the available context size (2816 tokens), try increasing it' };

function setup({ limit }) {
  const data = {};
  const store = { get: () => ({ ...data }), set: (k, v) => (data[k] = v) };
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    const size = JSON.stringify(b).length;
    if (size > limit) return { ok: false, status: 400, json: async () => OVERFLOW };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Kurze Antwort 👍' } }] }) };
  };
  const sent = [];
  const service = { getStatus: () => ({ bot: { id: '900000000000000001', displayName: 'Joni' } }), sendTyping: async () => {}, sendMessage: async (p) => sent.push(p), getMessages: async () => ({ messages: [] }) };
  let raw = null;
  const memory = createMemory({ vault: { get: () => raw, set: (v) => (raw = v), clear: () => (raw = null) } });
  memory.remember('500000000000000001', 'Jonimoni', 'Erzähl mir alles '.repeat(200), 'Okay '.repeat(200));
  const ai = createAiManager({ store, secret: { has: () => false, get: () => null }, service, fetchImpl, memory });
  ai.setConfig({ enabled: true, provider: 'openai', baseUrl: 'http://192.168.178.61:1234/v1', model: 'google/gemma-4-26b-a4b' });
  ai.setResponder(validators.aiResponder({ enabled: true, channelIds: ['300000000000000001'], dms: true, allowUsers: [], blockUsers: [], instructions: '', context: false, notify: false, memory: true, web: true }));
  const msg = { id: '910000000000000001', channelId: '300000000000000001', guildId: '100000000000000001', toBot: true, content: 'Wie spät ist es?', author: { id: '500000000000000001', name: 'Jonimoni', bot: false }, mentions: { users: [] }, attachments: [] };
  return { ai, bodies, sent, msg };
}

test('Kontext zu klein: erst ohne Werkzeuge, dann kurzer Prompt – der Bot antwortet trotzdem', async () => {
  const { ai, bodies, sent, msg } = setup({ limit: 1500 });
  await ai.onMessage(msg);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Kurze Antwort/);
  assert.ok(bodies[0].tools?.length > 0); // 1. Versuch mit Werkzeugen
  assert.ok(!bodies.at(-1).tools); // zuletzt ohne
  assert.doesNotMatch(bodies.at(-1).messages.at(-1).content, /<memory/); // ohne Gedächtnis
  assert.match(bodies.at(-1).messages.at(-1).content, /Wie spät ist es\?/);
  assert.ok(ai.getConfig().toolLog.some((t) => /Kontextfenster zu klein/.test(t.detail)));
});

test('Passt gar nichts: verständliche Meldung mit Tipp für LM Studio', async () => {
  const { ai, sent, msg } = setup({ limit: 10 });
  await ai.onMessage(msg);
  assert.equal(sent.length, 0);
  const last = ai.getConfig().recent[0];
  assert.equal(last.ok, false);
  assert.match(last.answer,/Kontextfenster des Modells \(2816 Tokens\)/);
});
