'use strict';

// DEMO-MODUS (nur Entwicklung, `npm run demo`): simulierte Server/Kanäle/Nachrichten OHNE Discord-Verbindung.
// Dient für Screenshots und UI-Tests ohne Token. Die Oberfläche zeigt deutlich "DEMO" an.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SnowflakeUtil, PermissionFlagsBits: PF } = require('discord.js');
const { createFakeWorld, FAKE_TOKEN, makeMessage, Events } = require('../../tests/helpers/fake-discord');
const { createFakeVoiceLib } = require('../../tests/helpers/fake-voice');

// Keine Discord-Standardavatare: PKMessenger zeigt eigene Initialen-Avatare.
function avatarFor() {
  return () => null;
}

function createDemo() {
  const world = createFakeWorld({ withExtraTypes: true });
  const { guild, channels, client } = world;
  guild.name = 'PK Testserver';
  guild.nameAcronym = 'PK';
  client.user.username = 'PKBot';
  client.user.displayAvatarURL = avatarFor(5);

  const people = [
    ['555555555555555501', 'Anna'],
    ['555555555555555502', 'Bernd'],
    ['555555555555555503', 'Chiara'],
  ].map(([id, name], i) => {
    const u = world.addMember(id, name);
    u.globalName = name;
    u.displayAvatarURL = avatarFor(i + 1);
    guild.members.cache.get(id).displayAvatarURL = avatarFor(i + 1);
    return u;
  });
  const [anna, bernd, chiara] = people;
  // Demo-Bot darf moderieren (Rollen, Timeout, Kick) – Bannen bewusst NICHT, damit der Hinweis sichtbar ist
  for (const p of [PF.ManageRoles, PF.ModerateMembers, PF.KickMembers, PF.ManageChannels, PF.ViewChannel, PF.SendMessages, PF.ReadMessageHistory, PF.Connect, PF.Speak]) guild.members.me.permFlags.add(p);
  // #projekt-a darf der Demo-Bot verwalten (umbenennen/verschieben per Rechtsklick)
  {
    const pa = channels.projektA;
    const before = pa.permissionsFor;
    pa.permissionsFor = (me) => ({ has: (f) => f === PF.ManageChannels || before(me).has(f) });
  }
  const mods = guild.roles.cache.get('333333333333333301');

  const now = Date.now();
  const add = (ch, author, content, minutesAgo, mentions) => {
    const ts = now - minutesAgo * 60000;
    const m = makeMessage({ id: SnowflakeUtil.generate({ timestamp: ts }).toString(), channel: ch, author, content, createdTimestamp: ts, mentions });
    ch.store.push(m);
    ch.lastMessageId = m.id;
    return m;
  };

  const a = channels.allgemein;
  a.topic = 'Alles rund um den Server – bitte freundlich bleiben';
  add(a, bernd, 'Moin zusammen! Hat jemand Lust, heute Abend das neue Projekt zu besprechen?', 26 * 60);
  add(a, anna, 'Klar, ab 19 Uhr bin ich da.', 26 * 60 - 2);
  add(a, anna, 'Ich bringe die Notizen von letzter Woche mit.', 26 * 60 - 1);
  add(a, chiara, 'Super, ich schau auch rein 👍', 25 * 60);
  // Systemnachrichten (Discord schickt dafür keinen Text, nur den Typ): Beitritt + Boost
  for (const [author, type, min] of [
    [chiara, 7, 61],
    [bernd, 8, 59],
  ]) {
    const ts = now - min * 60000;
    a.store.push(makeMessage({ id: SnowflakeUtil.generate({ timestamp: ts }).toString(), channel: a, author, content: '', createdTimestamp: ts, type }));
  }
  add(a, bernd, 'Kurzer Reminder für alle: das **Repo** ist jetzt umgezogen → https://example.com/pk-projekt', 95);
  add(a, client.user, `Willkommen <@${chiara.id}>! Die Regeln findest du in <#${channels.ankuendigungen.id}>.`, 60, { users: [chiara], channels: [channels.ankuendigungen] });
  add(a, anna, `Danke! <@&${mods.id}> könnt ihr mir die Rolle "Projekt" geben?`, 40, { roles: [mods] });
  add(a, chiara, 'Hier ein Code-Beispiel aus dem Bot:\n```js\nchannel.send({ content: "Hallo", allowedMentions: { parse: [] } });\n```', 12);
  add(a, bernd, 'Sieht gut aus. `allowedMentions` ist wichtig, damit niemand aus Versehen gepingt wird.', 9);
  const last = add(a, anna, 'Genau, und @everyone nur mit Bestätigung 😄', 8);
  // #93: Spoiler, der eine Erwähnung umschließt – muss als Spoiler verdeckt werden (nicht als roher ||…||-Text)
  add(a, bernd, `Gewinner (nicht spoilern!): ||<@${chiara.id}>|| 🏆`, 7, { users: [chiara] });

  // F7–F13 in der Demo: Rechte, Reaktionen, Antwort, Embed, Pin, Thread
  const extra = new Set([PF.AddReactions, PF.AttachFiles, PF.EmbedLinks, PF.PinMessages, PF.CreatePublicThreads, PF.SendMessagesInThreads, PF.ManageMessages]);
  const basePerms = a.permissionsFor;
  a.permissionsFor = (me) => ({ has: (f) => extra.has(f) || basePerms(me).has(f) });
  const repoMsg = a.store.find((m) => m.content.includes('Repo'));
  repoMsg.pinned = true;
  // Reaktionen über die Fake-Logik anlegen (Entfernen funktioniert so wie echt)
  repoMsg.react('👍');
  repoMsg.reactions.cache.get('👍').count = 3;
  repoMsg.react('🎉');
  Object.assign(repoMsg.reactions.cache.get('🎉'), { count: 2, me: false });
  last.react('😂');
  Object.assign(last.reactions.cache.get('😂'), { count: 2, me: false });
  const reply = add(a, client.user, 'Wir treffen uns um 19 Uhr im Sprachkanal 🔊 Lounge!', 5);
  reply.reference = { messageId: a.store.find((m) => m.content.startsWith('Klar, ab 19 Uhr')).id, channelId: a.id };
  const rel = add(a, client.user, '', 3);
  rel.embeds = [{ title: 'PKMessenger 0.3.0', description: 'Neu: **Antworten**, **Reaktionen**, Threads, Pins, Dateien und die Serversuche.', color: 0x2dd4bf, footer: { text: 'Release-Notizen' }, fields: [{ name: 'Tests', value: '129/129 grün', inline: true }, { name: 'Lizenz', value: 'MIT', inline: true }] }];
  // Thread an Bernds Nachricht
  const threadMsg = a.store.find((m) => m.content.startsWith('Moin zusammen'));
  const thread = { id: '777000000000000001', name: 'Projekt-Abend', parentId: a.id, guildId: guild.id, guild, type: 11, archived: false, messageCount: 4, lastMessageId: threadMsg.id, permissionsFor: (me) => a.permissionsFor(me), messages: { cache: new Map(), fetch: async () => new Map(), fetchPins: async () => ({ items: [], hasMore: false }) }, send: async () => threadMsg, sendTyping: async () => {} };
  threadMsg.hasThread = true;
  threadMsg.thread = thread;
  a.threads.list.push(thread);
  client.channels.cache.set(thread.id, thread);
  // Beispiel-Umfrage des Bots mit Stimmen
  const pollMsg = add(a, client.user, '', 2);
  pollMsg.poll = { question: { text: 'Welcher Abend passt euch?' }, allowMultiselect: false, expiresTimestamp: Date.now() + 20 * 3600000, resultsFinalized: false, channel: a, messageId: pollMsg.id, answers: new Map(), end: async () => { pollMsg.poll.resultsFinalized = true; } };
  [['Freitag', 5], ['Samstag', 8], ['Sonntag', 2]].forEach(([text, n], i) => pollMsg.poll.answers.set(i + 1, { id: i + 1, text, voteCount: n, poll: pollMsg.poll }));
  extra.add(PF.SendPolls);

  // #86 Beispiel: Nachricht eines anderen Bots mit Knöpfen (nur Ansicht) + Link-Knopf + Auswahlmenü
  const btnMsg = add(a, bernd, 'Willkommen! Bitte bestätige kurz, dass du ein Mensch bist – danach siehst du alle Kanäle.', 3);
  btnMsg.components = [
    { type: 1, components: [
      { type: 2, style: 3, label: 'Verifizieren', customId: 'verify' },
      { type: 2, style: 5, url: 'https://example.com/hilfe', label: 'Mehr Infos' },
    ] },
    { type: 1, components: [{ type: 3, placeholder: 'Rolle wählen …' }] },
    // #129: Musik-Bot-Knöpfe nur mit Emoji
    { type: 1, components: ['⏮️', '⏸️', '⏭️', '🔁', '🔀'].map((e, i) => ({ type: 2, style: i === 1 ? 1 : 2, customId: `m${i}`, emoji: { name: e } })) },
  ];

  // eigenes Server-Emoji für die Reaktionsauswahl
  guild.emojis = { cache: new Map() };

  // F14 Serversuche in der Demo: durchsucht die Demo-Nachrichten wie der echte Endpoint
  client.rest.get = async (route, { query } = {}) => {
    if (!String(route).includes('/messages/search')) throw new Error('Demo: Route nicht simuliert');
    const needle = (query?.get?.('content') || '').toLowerCase();
    const hits = [];
    for (const ch of Object.values(channels)) for (const m of ch.store || []) if (needle && (m.content || '').toLowerCase().includes(needle)) hits.push(m);
    return {
      total_results: hits.length,
      messages: hits.slice(-25).reverse().map((m) => [{ id: m.id, channel_id: m.channelId, author: { username: m.author.username, global_name: m.author.globalName }, content: m.content, timestamp: new Date(m.createdTimestamp).toISOString(), attachments: [] }]),
    };
  };

  channels.ankuendigungen.topic = 'Wichtige Infos';
  add(channels.ankuendigungen, client.user, '📢 Server-Regeln:\n1. Respektvoll bleiben\n2. Kein Spam\n3. Bot-Befehle nur in #projekt-a', 3 * 24 * 60);
  // Issue #1: GIF (Tenor kommt als „gifv“-Video über Discords Proxy) + Link mit Warnung
  const gif = add(channels.ankuendigungen, chiara, 'Wenn das Update endlich da ist 😂 https://tenor.com/view/katze-tanzt', 60);
  gif.embeds = [{ type: 'gifv', url: 'https://tenor.com/view/katze-tanzt', provider: { name: 'Tenor' }, video: { proxyURL: 'https://images-ext-1.discordapp.net/external/demo/https/media.tenor.com/katze.mp4' }, thumbnail: { proxyURL: 'https://images-ext-1.discordapp.net/external/demo/https/media.tenor.com/katze.png' } }];
  // Issue #38: Link-Schutz – normaler unbekannter Link und ein IP-Grabber
  add(channels.ankuendigungen, anna, 'Neuer Shop für Merch: https://beispiel-shop.de/angebot', 40);
  add(channels.ankuendigungen, chiara, 'Krass, guck mal 😱 https://grabify.link/K4TZE7', 20);
  add(channels.ankuendigungen, bernd, 'Hab den Film gesehen. Das Ende: ||Der Butler war es!|| 🍿', 30);
  add(channels.projektA, chiara, 'Projekt A startet nächste Woche!', 300);
  add(channels.nurLesen, bernd, 'Dieser Kanal ist für den Bot nur lesbar.', 500);
  // Wie echtes Discord: auch eigene Bot-Nachrichten kommen live über das Gateway zurück
  // (wichtig für Nachrichten, die nicht aus dem Eingabefeld stammen, z. B. KI-Agenten)
  for (const ch of Object.values(channels)) {
    if (typeof ch?.send !== 'function') continue;
    const send = ch.send;
    ch.send = async (options) => {
      const m = await send(options);
      setTimeout(() => client.emit(Events.MessageCreate, m), 60);
      return m;
    };
  }

  // Privatchat mit Chiara (sie hat dem Bot privat geschrieben)
  const dm = world.makeDM(chiara);
  add(dm, chiara, 'Hey Bot, kannst du mich morgen an das Treffen erinnern? 🙏', 30);
  add(dm, client.user, 'Klar, mache ich! Um 18 Uhr bekommst du eine Nachricht.', 28);

  for (let i = 0; i < 260; i++) add(channels.projektA, i % 2 ? anna : bernd, `Testnachricht Nr. ${i + 1} für das Nachladen & die Virtualisierung`, 290 - i);

  // Live-Simulation: gelegentlich tippt jemand und schreibt eine Nachricht.
  const lines = ['Hat jemand die neue Version schon getestet?', 'Läuft bei mir flüssig 🚀', 'Ich bin gleich wieder da.', 'Top, danke für die Info!'];
  let i = 0;
  const live = setInterval(() => {
    const who = people[i % people.length];
    const ch = i % 3 === 2 ? channels.projektA : channels.allgemein;
    client.emit(Events.TypingStart, { guild, channel: ch, user: who, member: { displayName: who.globalName } });
    setTimeout(() => {
      const m = makeMessage({ id: SnowflakeUtil.generate().toString(), channel: ch, author: who, content: lines[i++ % lines.length], createdTimestamp: Date.now() });
      ch.store.push(m);
      ch.lastMessageId = m.id;
      client.emit(Events.MessageCreate, m);
    }, 3500);
  }, 15000);
  live.unref?.();

  // Sprachkanal "Lounge" mit Anna und Bernd; der Bot darf verbinden und sprechen.
  const vc = channels.voice;
  vc.name = 'Lounge';
  const vcPerms = new Set([PF.ViewChannel, PF.Connect, PF.Speak]);
  vc.permissionsFor = () => ({ has: (f) => vcPerms.has(f) });
  for (const [u, muted] of [
    [anna, false],
    [bernd, true],
  ]) {
    guild.voiceStates.cache.set(u.id, { id: u.id, channelId: vc.id, member: guild.members.cache.get(u.id), selfMute: muted, selfDeaf: false });
  }

  // Simulierte Sprach-Bibliothek: Beitritt klappt, Anna und Bernd "sprechen" abwechselnd.
  // Spricht der Bot (Mikro an), wird sein Ton als "Anna" zurückgespielt → testet Senden UND Empfangen komplett.
  const voiceLib = createFakeVoiceLib();
  const stats = { micPackets: 0, echoedPackets: 0 };
  const realResource = voiceLib.createAudioResource;
  voiceLib.createAudioResource = (stream, opts) => {
    stream.on('data', (pkt) => {
      stats.micPackets++;
      const conn = voiceLib.connections.at(-1);
      for (const sub of conn?.receiver.subscriptions || []) {
        if (sub.userId === anna.id && !sub.stream.destroyed && sub.stream.writable) {
          sub.stream.write(pkt);
          stats.echoedPackets++;
        }
      }
    });
    return realResource(stream, opts);
  };
  const realJoin = voiceLib.joinVoiceChannel;
  voiceLib.joinVoiceChannel = (cfg) => {
    const conn = realJoin(cfg);
    guild.voiceStates.cache.set(client.user.id, { id: client.user.id, channelId: cfg.channelId, member: null, selfMute: cfg.selfMute, selfDeaf: cfg.selfDeaf });
    client.emit(Events.VoiceStateUpdate, {}, { guild });
    let turn = 0;
    // Anna "spricht" sofort (damit ihr Empfangs-Abo für den Echo-Test steht), danach abwechselnd mit Bernd.
    setTimeout(() => conn.receiver.speaking.emit('start', anna.id), 300);
    const t = setInterval(() => {
      const who = turn++ % 2 ? anna : bernd;
      conn.receiver.speaking.emit('start', who.id);
      setTimeout(() => who !== anna && conn.receiver.speaking.emit('end', who.id), 1800);
    }, 2600);
    t.unref?.();
    conn.on('stateChange', (_o, n) => {
      if (n.status === 'destroyed') {
        clearInterval(t);
        guild.voiceStates.cache.delete(client.user.id);
        client.emit(Events.VoiceStateUpdate, {}, { guild });
      }
    });
    return conn;
  };

  // Demo-Einladung für „Server beitreten“ (simuliert den offiziellen Endpoint GET /invites/{code})
  client.fetchInvite = async (code) => {
    if (code === 'ungueltig') {
      const e = new Error('Unknown Invite');
      e.code = 10006;
      throw e;
    }
    return { code, guild: { id: '888888888888888888', name: 'Moin Club', iconURL: () => null }, memberCount: 128, presenceCount: 37, channel: { name: 'willkommen' } };
  };

  const envPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-demo-')), '.env');
  fs.writeFileSync(envPath, `DISCORD_TOKEN=${FAKE_TOKEN}\n`);
  // KI-Agenten (Beta) im Demo: simulierter Anbieter (OpenAI-Format), Schlüssel nur im Speicher – keine echten Anfragen
  let demoKey = null;
  const aiSecret = { has: () => Boolean(demoKey), get: () => demoKey, set: (v) => (demoKey = v), clear: () => (demoKey = null) };
  const aiFetch = async (url, init = {}) => {
    // Modelle abfragen (GET …/models): im Demo „läuft“ nur Ollama auf diesem PC
    if (!init.body) {
      if (url.startsWith('http://localhost:') && !url.startsWith('http://localhost:11434/')) throw new Error('ECONNREFUSED');
      const data = url.startsWith('http://localhost:11434/') ? ['llama3.2:latest', 'qwen3:8b', 'gemma3:4b'] : ['demo-modell', 'demo-modell-mini'];
      return { ok: true, status: 200, json: async () => ({ data: data.map((id) => ({ id })) }) };
    }
    const body = JSON.parse(init.body);
    const user = body.messages?.at(-1)?.content || '';
    const sys = body.messages?.[0]?.content || '';
    let content = /Verbindung/.test(user) ? 'OK – Verbindung steht.' : / asks:/.test(user) ? 'Heute um **19 Uhr** in der Lounge 🎉 Bis später, Anna!' : '☀️ **Guten Morgen, Team!** Heute steht das Treffen um 19 Uhr an. Bringt eure Ideen mit 🚀';
    if (/ asks:/.test(user)) await new Promise((r) => setTimeout(r, 1800)); // Demo: Antwort dauert kurz (Anzeige „KI schreibt …“)
    // Gedächtnis zusammenfassen (Demo): kurze Fakten
    if (/private memory/.test(sys)) content = '- Anna fragt nach dem Treffen (19 Uhr, Lounge)';
    // Websuche: erst suchen, dann mit Quelle antworten
    if (/SEARCH: <short/.test(sys)) content = /<web_results/.test(user) ? '🌤 **Wetter heute:** sonnig, bis 21 °C – perfekt fürs Treffen um 19 Uhr! (Quelle: wetter.example)' : 'SEARCH: wetter heute berlin';
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  // Sperrlisten im Demo: kleine Listen statt Download
  const blocklistFetch = async (url) => ({
    ok: true,
    status: 200,
    text: async () => (url.endsWith('.txt') ? 'grabify.link\nfree-nitro-demo.example\n' : url.includes('suspicious') ? '{"domains":["komisch-demo.example"]}' : '{"domains":["steam-gift-demo.example"]}'),
  });
  // Gedächtnis im Demo: nur im Arbeitsspeicher
  let memRaw = null;
  const memoryVault = { get: () => memRaw, set: (v) => (memRaw = v), clear: () => (memRaw = null) };
  // Demo-GitHub (kein Netz): neueste Version = eigene Version, zwei Releases mit Notizen
  const githubFetch = (url, version) =>
    new Promise((resolve) =>
      setTimeout(() => {
        const [ma, mi, pa] = version.split('.').map(Number);
        // bei x.y.0 nicht dieselbe Version doppelt (sonst doppelte Schlüssel in „Was ist neu“)
        const prev = pa > 0 ? `${ma}.${mi}.${pa - 1}` : `${ma}.${Math.max(0, mi - 1)}.9`;
        const rel = (v, notes, d) => ({ tag_name: `v${v}`, name: `v${v}`, published_at: d, html_url: `https://github.com/Morni-Team/pkmessenger/releases/tag/v${v}`, body: notes.map((n, i) => `* ${n} by @MoinMornhart in https://github.com/Morni-Team/pkmessenger/pull/${40 + i}`).join('\n'), assets: [{ name: 'PKMessenger-Setup.exe', browser_download_url: `https://github.com/Morni-Team/pkmessenger/releases/download/v${v}/PKMessenger-Setup.exe` }] });
        if (url.includes('/releases?'))
          return resolve({ ok: true, json: async () => [rel(version, ['Updates: Was ist neu?, neu installieren', 'Im Hintergrund weiterlaufen', 'Windows Hello zum Entsperren'], new Date().toISOString()), rel(prev, ['Profile anklicken', '@ im Privatchat', 'Unscharfe Namenssuche'], new Date(Date.now() - 3600000).toISOString())] });
        if (url.includes('/compare/')) return resolve({ ok: true, json: async () => ({ commits: [] }) });
        return resolve({ ok: true, json: async () => ({ tag_name: `v${version}` }) });
      }, 500),
    );
  const aiSearch = async (query) => ({ source: 'DuckDuckGo', results: [{ title: `Wetter: ${query}`, url: 'https://wetter.example/berlin', snippet: 'Sonnig, bis 21 °C, kaum Wind.' }] });
  // Für den Screenshot-Lauf: Anna erwähnt den Bot in #allgemein (wie eine echte Nachricht über das Gateway)
  const simulate = {
    // Mehrere tippen gleichzeitig (Tippanzeige wie Discord)
    typingAll() {
      for (const who of people) client.emit(Events.TypingStart, { guild, channel: channels.allgemein, user: who, member: { displayName: who.globalName } });
    },
    mention(text) {
      const ch = channels.allgemein;
      const m = makeMessage({ id: SnowflakeUtil.generate().toString(), channel: ch, author: anna, content: `<@${client.user.id}> ${text}`, createdTimestamp: Date.now(), mentions: { users: [client.user] } });
      ch.store.push(m);
      ch.lastMessageId = m.id;
      client.emit(Events.MessageCreate, m);
    },
  };
  // Simulierter Updater (nur Demo): „Suchen“ → kurz „Suche …“ → „neueste Version“
  const { EventEmitter } = require('node:events');
  const autoUpdater = new EventEmitter();
  autoUpdater.setFeedURL = () => {};
  autoUpdater.quitAndInstall = () => {};
  autoUpdater.checkForUpdates = () => {
    autoUpdater.emit('checking-for-update');
    setTimeout(() => autoUpdater.emit('update-not-available'), 1200);
  };
  return { world, envPath, createClient: () => client, voiceLib, stats, aiSecret, aiFetch, aiSearch, githubFetch, simulate, autoUpdater, memoryVault, blocklistFetch };
}

module.exports = { createDemo };
