'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-reply-parser-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
delete process.env.ADMINS;
delete process.env.MOMENTS_ADMINS;
process.env.DEEPSEEK_CHAT_API_KEY = 'test-chat-key';
process.env.ELEVENLABS_API_KEY = 'test-voice-key';

const { digitUsername } = require('./helpers');
const store = require('../lib/store');
const friends = require('../lib/friends');
const replyParser = require('../lib/reply-parser');
const callName = require('../lib/call-name');
const moments = require('../lib/moments');
const momentsRefresh = require('../lib/moments-refresh');
const memory = require('../lib/memory');
const { createApp, parseReply, resolveRuntimeConfig } = require('../server');

const JUNGKOOK_MALFORMED = '{"messages":[{"mood":"cooking_steps","ko":"안녕~ 이 시간에 뭐 하고 있었어? 저녁은 먹었어?",zh":"你好呀～这个点儿在干嘛呢？吃晚饭了吗？"},{"mood":"playful","ko":" 나는 그냥 노래 듣고 있었는데, 혹시 요즘 꽂힌 노래 있어? 하나 추천해 줘.",zh":" 我就在听歌来着，你最近有特别上头的歌吗？推荐我一首呗。"}]}';

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

test.before(async () => {
  await store.init();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const created = await request('/api/register', {
    method: 'POST',
    body: { username: digitUsername(), password: 'password1', age14: true },
  });
  assert.ok(created.status === 200 || created.status === 201);
  cookie = created.cookie;
  userId = created.json.user.id;
});

test.after(async () => {
  await store.flush({ shutdown: true });
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('parses Jungkook malformed JSON missing opening quote on zh into 2 clean bubbles', () => {
  const config = resolveRuntimeConfig('jungkook');
  const items = parseReply(JUNGKOOK_MALFORMED, config);
  assert.equal(items.length, 2);
  assert.equal(items[0].ko, '안녕~ 이 시간에 뭐 하고 있었어? 저녁은 먹었어?');
  assert.equal(items[0].zh, '你好呀～这个点儿在干嘛呢？吃晚饭了吗？');
  assert.equal(items[0].mood, 'cooking_steps');
  assert.equal(items[1].ko, '나는 그냥 노래 듣고 있었는데, 혹시 요즘 꽂힌 노래 있어? 하나 추천해 줘.');
  assert.equal(items[1].zh, '我就在听歌来着，你最近有特别上头的歌吗？推荐我一首呗。');
  assert.equal(items[1].mood, 'cooking_steps');
});

test('unrecoverable broken JSON starting with {"messages":[ returns [] instead of leaking raw JSON', () => {
  const config = resolveRuntimeConfig('jungkook');
  assert.deepEqual(parseReply('{"messages":[{"mood":"cooking_steps","ko":"안녕', config), []);
  assert.deepEqual(parseReply('{"messages":[{"mood":"cooking_steps","ko":broken}]}', config), []);
  assert.deepEqual(parseReply('   {"unexpected":true}', config), []);
});

test('legacy [[mood:soft]] plain-text format still parses into 2 bubbles', () => {
  const config = resolveRuntimeConfig('baekhyun');
  const items = parseReply('[[mood:soft]]\n안녕\n잘 지냈어?', config);
  assert.equal(items.length, 2);
  assert.equal(items[0].ko, '안녕');
  assert.equal(items[1].ko, '잘 지냈어?');
  assert.equal(items[0].mood, 'soft');
  assert.equal(items[1].mood, 'soft');
});

test('GET /api/history auto-repairs malformed JSON assistant bubble and lib/friends preview hides raw JSON', async () => {
  const t0 = Date.now() - 2000;
  const t1 = Date.now() - 1000;
  store.putHistory(userId, 'jungkook', [
    { role: 'user', text: '뭐해?', time: t0, turnId: 'turnrepair1' },
    { role: 'assistant', text: JUNGKOOK_MALFORMED, time: t1, turnId: 'turnrepair1', audioUrl: null },
  ]);

  const listedBefore = await friends.listForUser(userId);
  const jkBefore = listedBefore.friends.find((item) => item.id === 'jungkook');
  assert.ok(jkBefore);
  assert.equal(jkBefore.preview, '안녕~ 이 시간에 뭐 하고 있었어? 저녁은 먹었어?');
  assert.equal(jkBefore.preview.startsWith('{'), false);

  const res = await request('/api/history?characterId=jungkook', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.messages.length, 3);
  assert.equal(res.json.messages[0].role, 'user');
  assert.equal(res.json.messages[1].role, 'assistant');
  assert.equal(res.json.messages[1].text, '안녕~ 이 시간에 뭐 하고 있었어? 저녁은 먹었어?');
  assert.equal(res.json.messages[1].zh, '你好呀～这个点儿在干嘛呢？吃晚饭了吗？');
  assert.equal(res.json.messages[1].mood, 'cooking_steps');
  assert.equal(res.json.messages[1].voice, true);
  assert.equal(res.json.messages[1].audioUrl, null);
  assert.equal(res.json.messages[1].turnId, 'turnrepair1');
  assert.equal(res.json.messages[2].role, 'assistant');
  assert.equal(res.json.messages[2].text, '나는 그냥 노래 듣고 있었는데, 혹시 요즘 꽂힌 노래 있어? 하나 추천해 줘.');
  assert.equal(res.json.messages[2].zh, '我就在听歌来着，你最近有特别上头的歌吗？推荐我一首呗。');
  assert.equal(res.json.messages[2].mood, 'cooking_steps');
  assert.equal(res.json.messages[2].voice, true);
  assert.equal(res.json.messages[2].audioUrl, null);
  assert.equal(res.json.messages[2].turnId, 'turnrepair1');

  const persisted = store.getHistory(userId, 'jungkook');
  assert.equal(persisted.length, 3);
  assert.equal(persisted[1].text, '안녕~ 이 시간에 뭐 하고 있었어? 저녁은 먹었어?');
  assert.equal(persisted[2].text, '나는 그냥 노래 듣고 있었는데, 혹시 요즘 꽂힌 노래 있어? 하나 추천해 줘.');
});

test('parseJsonLoose and downstream parsers handle malformed DeepSeek JSON across schemas', async () => {
  const settled = callName.settle(
    { callNameStatus: 'pending' },
    '{address:{name:"소연",confidence:"high"}}',
  );
  assert.equal(settled.patch.callName, '소연');
  assert.equal(settled.patch.callNameStatus, 'done');

  const settledMissingQuote = callName.settle(
    { callNameStatus: 'pending' },
    '{"address":{"name":"소연",confidence:"high"}}',
  );
  assert.equal(settledMissingQuote.patch.callName, '소연');

  const postId = moments.loadPosts('baekhyun')[0].id;
  const comment = await moments.addComment(userId, 'baekhyun', postId, '응원해!');
  const reply1 = await moments.maybeReply({
    userId,
    characterId: 'baekhyun',
    postId,
    comment,
    userName: '소연',
    llm: async () => '{ko:"고마워!"}',
  });
  assert.equal(reply1.text, '고마워!');
  assert.deepEqual(replyParser.parseJsonLoose('{"ko":"고마워!",}'), { ko: '고마워!' });

  const drafted = await momentsRefresh.draftFromItem(
    { title: '원본', url: 'https://example.com/news' },
    async () => '{"kind":"news",title":"공지","ko":"안녕",zh":"你好",}',
  );
  assert.deepEqual(drafted, {
    ko: '안녕',
    zh: '你好',
    title: '공지',
    kind: 'news',
    link: 'https://example.com/news',
  });

  assert.deepEqual(
    replyParser.parseJsonLoose('{"cards":[{"text":"좋아해",category":"preference",}]}'),
    { cards: [{ text: '좋아해', category: 'preference' }] },
  );

  await memory.afterTurn({
    userId,
    characterId: 'jungkook',
    userText: '나 딸기 좋아해',
    replyText: '딸기 좋지!',
    userName: '소연',
    llm: async () => '{"ops":[{"op":"add",text":"用户喜欢草莓","category":"preference","date":null,tags:["草莓","딸기"],}]}',
  });
  assert.equal(memory.load(userId, 'jungkook').cards.some((c) => c.text === '用户喜欢草莓'), true);

  // Valid JSON continues to take the strict JSON.parse fast path untouched.
  assert.deepEqual(
    replyParser.parseJsonLoose('{"ko":"hi, name: bob"}'),
    { ko: 'hi, name: bob' },
  );
});
