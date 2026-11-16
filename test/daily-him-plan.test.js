'use strict';

// 「他记得的你」 + pre-stored greetings + chat voice default, over real HTTP.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-dailyhim-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
delete process.env.MOMENTS_ADMINS;
delete process.env.ADMINS;
delete process.env.VOICE_ID;
delete process.env.TTS_MODEL;
process.env.DEEPSEEK_CHAT_API_KEY = 'test-chat-key';
process.env.ELEVENLABS_API_KEY = 'test-voice-key';

const store = require('../lib/store');
const relationship = require('../lib/relationship');
const memory = require('../lib/memory');
const profile = require('../lib/profile');
const starlight = require('../lib/starlight');
const voicePack = require('../lib/voice-pack');
const { createApp } = require('../server');
const { LAUNCH } = require('./helpers/launch10');

let base;
let server;
let cookie;
let userId;

function cookieFrom(response, previous) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const sid = list.map((item) => item.split(';')[0]).find((item) => item.startsWith('sid='));
  if (sid) return sid;
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/sid=[^;]+/);
  return match ? match[0] : (previous || '');
}

async function request(pathname, { method = 'GET', body, cookie: jar } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(jar ? { Cookie: jar } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
  return { status: response.status, json, cookie: cookieFrom(response, jar) };
}

const realFetch = global.fetch;
let elevenCalls = 0;
let elevenMode = 'ok';
let seq = 0;
// A fresh, unique token per test: a reused line would hit the audio cache and skip TTS.
const freshToken = () => `${Date.now().toString(36)}${(seq += 1)}`;
// The repo-level audio cache outlives a test run, so drop the clip this line would reuse.
function clearChatClip(characterId, ko, mood = 'soft') {
  const pack = voicePack.load(characterId);
  if (!pack || !pack.ok) return;
  const request = voicePack.buildRequest(pack, ko, mood);
  fs.rmSync(path.join(__dirname, '..', 'cache', 'audio', `${request.cacheKey}.mp3`), { force: true });
}

test.before(async () => {
  global.fetch = async (url, opts) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost')) return realFetch(url, opts);
    if (target.includes('api.elevenlabs.io')) {
      elevenCalls += 1;
      if (elevenMode === 'fail') return new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } });
      if (elevenMode === 'slow') await new Promise((resolve) => setTimeout(resolve, 120));
      return new Response(Buffer.alloc(80, 5), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    const body = String((opts && opts.body) || '');
    // History is part of the request body, so take the LAST tag (this turn's message).
    const matches = [...body.matchAll(/tag([a-z0-9]+)/g)];
    const tag = matches.length ? matches[matches.length - 1][1] : '';
    return new Response(JSON.stringify({
      choices: [{ message: { content: `{"messages":[{"mood":"soft","ko":"응${tag}","zh":"嗯"}]}` } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await store.init();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const created = await request('/api/register', {
    method: 'POST',
    body: { username: `dh${Date.now().toString(36)}`, password: 'password1', age14: true },
  });
  assert.equal(created.status, 201);
  cookie = created.cookie;
  userId = created.json.user.id;
});

test.after(async () => {
  global.fetch = realFetch;
  await store.flush({ shutdown: true });
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the greeting route serves pre-stored copy for every launch character without calling the model', async () => {
  const before = elevenCalls;
  const llmBefore = store.getHistory(userId, 'baekhyun').length;
  for (const id of LAUNCH) {
    const first = await request(`/api/greeting?characterId=${id}`, { cookie });
    assert.equal(first.status, 200, id);
    assert.ok(first.json.greeting, id);
    assert.match(first.json.greeting.ko, /[\uac00-\ud7a3]/, id);
    assert.match(first.json.greeting.zh, /[\u4e00-\u9fff]/, id);
    assert.equal(['morning', 'afternoon', 'evening'].includes(first.json.greeting.slot), true, id);
    assert.equal(first.json.greeting.audioUrl, null, `${id} has no clip yet`);
  }
  assert.equal(elevenCalls, before, 'greeting text must not synthesize audio');
  assert.equal(store.getHistory(userId, 'baekhyun').length, llmBefore, 'greeting must not write history');
});

test('a stored callName is filled into the pre-stored greeting, and a missing file falls back', async () => {
  const saved = await request('/api/memory/personal?characterId=baekhyun', {
    method: 'PUT', cookie, body: { callName: '小星' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.personal.callName, '小星');
  assert.equal(saved.json.personal.callNameStatus, 'done');

  const named = await request('/api/greeting?characterId=baekhyun', { cookie });
  assert.match(named.json.greeting.ko, /小星/);
  assert.equal(named.json.greeting.source, 'named');
  assert.equal(named.json.greeting.ko.includes('{callName}'), false);

  // A character with no greetings file gives null, so the client keeps askNameKo/welcomeKo.
  const missing = await request('/api/greeting?characterId=kai', { cookie });
  assert.equal(missing.status, 200);
  assert.equal(missing.json.greeting, null);
  assert.equal(missing.json.reason, 'none');
});

test('a pending name asks with the pre-stored ask line instead of a generated one', async () => {
  const pending = await request('/api/memory/personal?characterId=karina', {
    method: 'PUT', cookie, body: { callName: '' },
  });
  assert.equal(pending.status, 200);
  assert.equal(pending.json.personal.callName, '');
  await request('/api/profile?characterId=karina', {
    method: 'PUT', cookie, body: { callNameStatus: 'pending' },
  });
  const welcome = await request('/api/greeting?characterId=karina', { cookie });
  assert.equal(welcome.json.greeting, null);
  assert.equal(welcome.json.reason, 'naming');
  const ask = await request('/api/greeting?characterId=karina&mode=ask', { cookie });
  assert.equal(ask.json.greeting.source, 'ask');
  assert.match(ask.json.greeting.zh, /[？?]/);
  assert.match(ask.json.greeting.ko, /[\uac00-\ud7a3]/);
});

test('a memory card can be edited, the edit wins over extraction, and the model sees the new text', async () => {
  store.putDoc('memory', userId, 'taehyung', {
    cards: [{ id: 'aaaaaaaabbbb', text: '用户喜欢草莓', category: 'preference', createdAt: 1, updatedAt: 1, tags: ['草莓'] }],
    deleted: [],
    summary: '',
    openings: [],
  });
  const patched = await request('/api/memory/aaaaaaaabbbb?characterId=taehyung', {
    method: 'PATCH', cookie, body: { text: '用户喜欢草莓，但对草莓蛋糕过敏' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.card.text, '用户喜欢草莓，但对草莓蛋糕过敏');
  assert.equal(patched.json.card.edited, true);
  const view = patched.json.cards.find((item) => item.id === 'aaaaaaaabbbb');
  assert.equal(view.text, '用户喜欢草莓，但对草莓蛋糕过敏');
  assert.equal(view.edited, true);

  // Extraction never overwrites a card the user edited.
  const mem = memory.load(userId, 'taehyung');
  const changed = memory.applyOps(mem, [{ op: 'update', id: 'aaaaaaaabbbb', text: '用户讨厌草莓', category: 'preference' }], Date.now());
  assert.equal(changed, 0);
  assert.equal(mem.cards[0].text, '用户喜欢草莓，但对草莓蛋糕过敏');

  // A same-topic add is treated as a duplicate of the edited card, not a second card.
  const mem2 = memory.load(userId, 'taehyung');
  memory.applyOps(mem2, [{ op: 'add', text: '用户喜欢吃草莓', category: 'preference', tags: ['草莓'] }], Date.now());
  assert.equal(mem2.cards.length, 1);
  assert.equal(mem2.cards[0].text, '用户喜欢草莓，但对草莓蛋糕过敏');

  // The model is handed the edited wording, marked as authoritative.
  const block = memory.promptBlock(userId, 'taehyung', '딸기', '에리', { now: Date.now() });
  assert.match(block, /草莓蛋糕过敏/);
  assert.match(block, /사용자가 직접 고친 문장/);
});

test('editing rejects unknown ids, empty text, and foreign categories without touching the card', async () => {
  store.putDoc('memory', userId, 'jimin', {
    cards: [{ id: 'ccccccccdddd', text: '用户周三有考试', category: 'promise', date: '2026-12-02', createdAt: 1, updatedAt: 1 }],
    deleted: [], summary: '', openings: [],
  });
  const missing = await request('/api/memory/eeeeeeeeffff?characterId=jimin', {
    method: 'PATCH', cookie, body: { text: '改一下' },
  });
  assert.equal(missing.status, 404);
  const blank = await request('/api/memory/ccccccccdddd?characterId=jimin', {
    method: 'PATCH', cookie, body: { text: '   ' },
  });
  assert.equal(blank.status, 400);
  const badCategory = await request('/api/memory/ccccccccdddd?characterId=jimin', {
    method: 'PATCH', cookie, body: { text: '改一下', category: 'secret' },
  });
  assert.equal(badCategory.status, 400);
  const badId = await request('/api/memory/not-an-id?characterId=jimin', {
    method: 'PATCH', cookie, body: { text: '改一下' },
  });
  assert.equal(badId.status, 400);
  assert.equal(store.getDoc('memory', userId, 'jimin').cards[0].text, '用户周三有考试');
});

test('another account cannot edit or read this account memory', async () => {
  const other = await request('/api/register', {
    method: 'POST', body: { username: `dh2${Date.now().toString(36)}`, password: 'password1', age14: true },
  });
  const stolen = await request('/api/memory/aaaaaaaabbbb?characterId=taehyung', {
    method: 'PATCH', cookie: other.cookie, body: { text: '偷改' },
  });
  assert.equal(stolen.status, 404);
  assert.match(store.getDoc('memory', userId, 'taehyung').cards[0].text, /草莓蛋糕过敏/);
  const ownView = await request('/api/memory?characterId=taehyung', { cookie: other.cookie });
  assert.deepEqual(ownView.json.cards, []);
});

test('the memory view groups cards by category and lists forgotten entries', async () => {
  store.putDoc('memory', userId, 'wonyoung', {
    cards: [
      { id: '111111111111', text: '用户喜欢热可可', category: 'preference', createdAt: 1, updatedAt: 3 },
      { id: '222222222222', text: '用户下周搬家', category: 'recent', createdAt: 2, updatedAt: 2 },
    ],
    deleted: [{ text: '用户的公司名', at: 5 }],
    summary: '之前聊过搬家。',
    summaryUpdatedAt: 6,
    openings: [],
  });
  const view = await request('/api/memory?characterId=wonyoung', { cookie });
  assert.equal(view.status, 200);
  assert.equal(view.json.cards.length, 2);
  assert.deepEqual(view.json.groups.map((group) => group.category).sort(), ['preference', 'recent']);
  assert.equal(view.json.groups.find((group) => group.category === 'preference').cards.length, 1);
  assert.equal(view.json.forgotten.length, 1);
  assert.equal(view.json.forgotten[0].text, '用户的公司名');
  assert.equal(view.json.summary, '之前聊过搬家。');
  assert.deepEqual(
    view.json.categories.map((item) => item.id),
    ['preference', 'recent', 'promise', 'address'],
  );
  assert.equal(view.json.personal.habits, '');
});

test('clearing the summary keeps cards, personal fields, history, and intimacy', async () => {
  store.putHistory(userId, 'wonyoung', [{ role: 'user', text: '下周搬家', time: 9 }]);
  profile.save(userId, 'wonyoung', { callName: '小英', habits: '晚上容易失眠' });
  relationship.recordTurn(userId, 'wonyoung', Date.parse('2026-11-16T03:00:00Z'));
  const relBefore = relationship.load(userId, 'wonyoung');
  const cleared = await request('/api/memory/summary?characterId=wonyoung', { method: 'DELETE', cookie });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.summary, '');
  assert.equal(cleared.json.cards.length, 2);
  const doc = store.getDoc('memory', userId, 'wonyoung');
  assert.equal(doc.cards.length, 2);
  assert.equal(doc.summary, '');
  assert.equal(profile.load(userId, 'wonyoung').callName, '小英');
  assert.equal(profile.load(userId, 'wonyoung').habits, '晚上容易失眠');
  assert.equal(store.getHistory(userId, 'wonyoung').length, 1);
  assert.deepEqual(relationship.load(userId, 'wonyoung'), relBefore);
});

test('clearing all memory keeps history, personal fields, and intimacy', async () => {
  relationship.recordTurn(userId, 'wonyoung', Date.parse('2026-11-16T04:00:00Z'));
  const relBefore = relationship.load(userId, 'wonyoung');
  const cleared = await request('/api/memory?characterId=wonyoung', {
    method: 'DELETE', cookie, body: { confirm: 'CLEAR' },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json.cards, []);
  assert.equal(cleared.json.forgotten.some((item) => item.text === '用户喜欢热可可'), true);
  assert.equal(cleared.json.forgotten.some((item) => item.text === '用户下周搬家'), true);
  assert.equal(store.getHistory(userId, 'wonyoung').length, 1, 'chat history survives');
  assert.equal(profile.load(userId, 'wonyoung').habits, '晚上容易失眠');
  assert.deepEqual(relationship.load(userId, 'wonyoung'), relBefore);
  const noConfirm = await request('/api/memory?characterId=wonyoung', { method: 'DELETE', cookie, body: {} });
  assert.equal(noConfirm.status, 400);
});

test('deleting one card keeps history, intimacy, personal fields, and the other card', async () => {
  store.putDoc('memory', userId, 'wonbin', {
    cards: [
      { id: '999999999999', text: '用户喜欢吉他泛音', category: 'preference', createdAt: 1, updatedAt: 1 },
      { id: '888888888888', text: '用户周四有演出', category: 'promise', date: '2026-12-03', createdAt: 1, updatedAt: 1 },
    ],
    deleted: [], summary: '聊过吉他。', openings: [],
  });
  store.putHistory(userId, 'wonbin', [{ role: 'user', text: '最近在练吉他', time: 11 }]);
  profile.save(userId, 'wonbin', { callName: '小斌' });
  relationship.recordTurn(userId, 'wonbin', Date.parse('2026-11-16T05:00:00Z'));
  const relBefore = relationship.load(userId, 'wonbin');
  const removed = await request('/api/memory/999999999999?characterId=wonbin', { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.cards.length, 1);
  assert.equal(removed.json.forgotten.some((item) => item.text === '用户喜欢吉他泛音'), true);
  assert.equal(store.getHistory(userId, 'wonbin').length, 1);
  assert.deepEqual(relationship.load(userId, 'wonbin'), relBefore);
  assert.equal(profile.load(userId, 'wonbin').callName, '小斌');
  // The forgotten text never comes back through extraction.
  const mem = memory.load(userId, 'wonbin');
  memory.applyOps(mem, [{ op: 'add', text: '用户喜欢吉他泛音', category: 'preference' }], Date.now());
  assert.equal(mem.cards.some((card) => card.text === '用户喜欢吉他泛音'), false);
});

test('personal fields reject an unusable call name and keep habits separate from cards', async () => {
  const bad = await request('/api/memory/personal?characterId=dohoon', {
    method: 'PUT', cookie, body: { callName: '这个名字太长了完全超过十二个字了吧' },
  });
  assert.equal(bad.status, 400);
  const empty = await request('/api/memory/personal?characterId=dohoon', {
    method: 'PUT', cookie, body: {},
  });
  assert.equal(empty.status, 400);
  const saved = await request('/api/memory/personal?characterId=dohoon', {
    method: 'PUT', cookie, body: { habits: '喜欢被夸配色', characterNickname: '道勋' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.personal.habits, '喜欢被夸配色');
  assert.equal(saved.json.personal.characterNickname, '道勋');
  const doc = store.getDoc('memory', userId, 'dohoon');
  assert.equal(doc, null, 'personal fields are not memory cards');
});

test('one extraction turn adds at most one new card and merges near duplicates', () => {
  const mem = { cards: [], deleted: [], summary: '' };
  const added = memory.applyOps(mem, [
    { op: 'add', text: '用户喜欢草莓', category: 'preference', tags: ['草莓'] },
    { op: 'add', text: '用户住在杭州', category: 'recent', tags: ['杭州'] },
    { op: 'add', text: '用户养了一只猫', category: 'recent', tags: ['猫'] },
  ], Date.now());
  assert.equal(added, 1);
  assert.equal(mem.cards.length, 1);
  assert.equal(memory.MAX_NEW_PER_TURN, 1);

  memory.applyOps(mem, [{ op: 'add', text: '用户很喜欢吃草莓', category: 'preference', tags: ['草莓'] }], Date.now());
  assert.equal(mem.cards.length, 1, 'a similar card merges into the existing one');
});

test('the chat request now carries voice by default and reports pending clips', async () => {
  const token = freshToken();
  elevenMode = 'ok';
  clearChatClip('baekhyun', `응${token}`);
  const before = elevenCalls;
  const chat = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie, body: { text: `tag${token}`, turnId: 'turnvoiceok1' },
  });
  assert.equal(chat.status, 200);
  assert.ok(chat.json.messages[0].audioUrl, 'voice is synthesized inside the chat request');
  assert.equal(chat.json.messages[0].ttsPending, false);
  assert.equal(elevenCalls, before + 1);
});

test('a slow clip is not awaited: the text arrives with ttsPending, and /api/tts joins the same charge', async () => {
  const token = freshToken();
  clearChatClip('baekhyun', `응${token}`);
  elevenMode = 'slow';
  const balanceBefore = (await request('/api/starlight', { cookie })).json.balance;
  const before = elevenCalls;
  const chat = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie, body: { text: `tag${token}`, turnId: 'turnvoiceslow1', voiceWaitMs: 50 },
  });
  assert.equal(chat.status, 200);
  assert.ok(chat.json.bubbles[0]);
  assert.equal(Boolean(chat.json.messages[0].audioUrl), false, 'text is not held for voice');
  assert.equal(chat.json.messages[0].ttsPending, true);
  assert.equal(elevenCalls, before + 1);

  // Follow-up call joins the clip the chat request already started (same audio, one charge).
  const followUp = await request('/api/tts', {
    method: 'POST',
    cookie,
    body: {
      characterId: 'baekhyun',
      text: chat.json.bubbles[0],
      mood: chat.json.mood,
      voiceToken: chat.json.messages[0].voiceToken,
    },
  });
  assert.equal(followUp.status, 200);
  assert.ok(followUp.json.audioUrl);
  assert.equal(followUp.json.joined, true);
  const balanceAfter = (await request('/api/starlight', { cookie })).json.balance;
  // One synthesis (15) + one text turn (1) — never a second voice charge.
  assert.equal(balanceBefore - balanceAfter, 16);
  assert.equal(elevenCalls, before + 1, 'the follow-up call must not synthesize again');
  elevenMode = 'ok';
});

test('a voice failure still returns the text and marks ttsFailed so the fallback line is used', async () => {
  const token = freshToken();
  clearChatClip('baekhyun', `응${token}`);
  elevenMode = 'fail';
  const chat = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie, body: { text: `tag${token}`, turnId: 'turnvoicefail1', voiceWaitMs: 5000 },
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.json.messages[0].audioUrl, null);
  assert.equal(chat.json.messages[0].ttsFailed, true);
  assert.equal(chat.json.messages[0].ttsPending, false);
  assert.ok(chat.json.bubbles[0], 'text is still delivered');
  elevenMode = 'ok';
});

test('an empty balance answers immediately with the 先看文字 notice and no synthesis', async () => {
  const poor = await request('/api/register', {
    method: 'POST', body: { username: `poor${Date.now().toString(36)}`, password: 'password1', age14: true },
  });
  await starlight.reserve({ userId: poor.json.user.id, requestId: 'drain-dh', action: 'text', amount: 99 });
  await starlight.settle('drain-dh');
  const before = elevenCalls;
  const chat = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: poor.cookie, body: { text: '안녕', turnId: 'turnpoorvoice1' },
  });
  assert.equal(chat.status, 200);
  assert.ok(chat.json.bubbles[0], 'text is shown without waiting for voice');
  assert.equal(chat.json.messages[0].audioUrl, null);
  assert.match(chat.json.starlight.notice, /15 星光/);
  assert.equal(elevenCalls, before, 'no synthesis without starlight');
});

test('a cached clip is not charged again when the chat request replays it', async () => {
  const token = freshToken();
  clearChatClip('baekhyun', `응${token}`);
  const text = `tag${token}`;
  await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie, body: { text, turnId: 'turncachevoice1' },
  });
  const charged = (await request('/api/starlight', { cookie })).json.balance;
  const replay = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie, body: { text, turnId: 'turncachevoice2' },
  });
  assert.ok(replay.json.messages[0].audioUrl);
  assert.equal((await request('/api/starlight', { cookie })).json.balance, charged - 1);
});
