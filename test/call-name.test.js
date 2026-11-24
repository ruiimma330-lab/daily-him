const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { digitUsername } = require('./helpers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-call-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
process.env.DEEPSEEK_CHAT_API_KEY = 'test-chat-key';
process.env.ELEVENLABS_API_KEY = 'test-voice-key';

const callName = require('../lib/call-name');
const profile = require('../lib/profile');
const store = require('../lib/store');
const { createApp } = require('../server');

test('rules pull a name, a refusal, and leave a normal sentence alone', () => {
  assert.equal(callName.extract('叫我小星').name, '小星');
  assert.equal(callName.extract('我叫星星').name, '星星');
  assert.equal(callName.extract('就叫아리').name, '아리');
  assert.equal(callName.extract('星星就好').name, '星星');
  assert.equal(callName.extract('나는 별').name, '별');
  assert.equal(callName.extract('별이라고 불러줘').name, '별');
  assert.equal(callName.extract('call me Ari').name, 'Ari');
  assert.equal(callName.extract('小星').name, '小星');
  assert.equal(callName.extract('不知道').kind, 'refuse');
  assert.equal(callName.extract('随便').kind, 'refuse');
  assert.equal(callName.extract('비밀').kind, 'refuse');
  assert.equal(callName.extract('pass').kind, 'refuse');
  assert.equal(callName.extract('今天天气怎么样，我们去公园吧').kind, 'none');
  assert.equal(callName.extract('안녕').kind, 'none');
  assert.equal(callName.extract('这是一个超过十二个字的很长称呼吗').kind, 'none');
  assert.equal(callName.sanitize('小\n星{{'), '小星');
});

test('pending plans store a name, ask to confirm, or fall back', () => {
  const pending = { callName: '', callNameStatus: 'pending', callNameAsks: 0 };
  const named = callName.plan(pending, '叫我小星');
  assert.equal(named.mode, 'fixed');
  assert.equal(named.patch.callName, '小星');
  assert.equal(named.patch.callNameSource, 'asked');
  assert.match(named.ko, /기억했어/);
  const refused = callName.plan(pending, '不想说');
  assert.equal(refused.patch.callName, '에리');
  assert.equal(refused.patch.callNameSource, 'fallback');
  assert.match(refused.zh, /에리/);
  const chat = callName.plan(pending, '今天天气怎么样，我们去公园吧');
  assert.equal(chat.mode, 'chat');
  const low = callName.settle(pending, '{"messages":[{"ko":"응","zh":"嗯"}],"address":{"name":"星星","confidence":"low"}}');
  assert.equal(low.patch.callNameStatus, 'confirming');
  assert.equal(low.patch.callNameCandidate, '星星');
  assert.match(low.zh, /好不好/);
  const yes = callName.plan({ callNameStatus: 'confirming', callNameCandidate: '星星' }, '好');
  assert.equal(yes.patch.callName, '星星');
  assert.equal(yes.patch.callNameStatus, 'done');
  const high = callName.settle(pending, '{"messages":[{"ko":"응","zh":"嗯"}],"address":{"name":"阿星","confidence":"high"}}');
  assert.equal(high.patch.callName, '阿星');
  assert.equal(high.replace, undefined);
  const again = callName.settle({ callNameStatus: 'pending', callNameAsks: 1 }, '{"messages":[{"ko":"응","zh":"嗯"}]}');
  assert.equal(again.patch.callNameSource, 'fallback');
  const old = callName.plan({ callName: '에리', callNameStatus: '' }, '안녕');
  assert.equal(old.mode, 'normal');
});

let base;
let serverApp;
let fan;

function cookieFrom(response, previous) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const sid = list.map((item) => item.split(';')[0]).find((item) => item.startsWith('sid='));
  if (sid) return sid;
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/sid=[^;]+/);
  return match ? match[0] : (previous || '');
}

async function request(pathname, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
  return { status: response.status, json, cookie: cookieFrom(response, cookie) };
}

test.before(async () => {
  await store.init();
  serverApp = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => serverApp.once('listening', resolve));
  base = `http://127.0.0.1:${serverApp.address().port}`;
  const stamp = Date.now().toString(36);
  fan = await request('/api/register', { method: 'POST', body: { username: digitUsername(), password: 'password1', age14: true } });
});

test.after(async () => {
  await store.flush({ shutdown: true });
  await new Promise((resolve) => serverApp.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a chosen name is stored, a pending name is not filled with 에리, and an old 에리 stays', async () => {
  const self = await request('/api/profile?characterId=baekhyun', {
    method: 'PUT',
    cookie: fan.cookie,
    body: { callName: '小星', callNameStatus: 'done', callNameSource: 'user', onboarded: true },
  });
  assert.equal(self.status, 200);
  assert.equal(self.json.profile.callName, '小星');
  assert.equal(self.json.profile.callNameSource, 'user');
  const pending = await request('/api/profile?characterId=kai', {
    method: 'PUT',
    cookie: fan.cookie,
    body: { callName: '', callNameStatus: 'pending', onboarded: true },
  });
  assert.equal(pending.json.profile.callName, '');
  assert.equal(pending.json.profile.callNameStatus, 'pending');
  const again = await request('/api/profile?characterId=kai', { cookie: fan.cookie });
  assert.equal(again.json.profile.callNameStatus, 'pending');
  assert.equal(again.json.profile.callName, '');
  const legacy = profile.save(fan.json.user.id, 'mark', { callName: '에리', onboarded: true });
  assert.equal(legacy.callName, '에리');
  assert.equal(callName.statusOf(profile.load(fan.json.user.id, 'mark')), 'done');
  const kept = profile.save(fan.json.user.id, 'mark', { characterNickname: '马克' });
  assert.equal(kept.callName, '에리');
  assert.equal(kept.callNameSource, '');
});

test('a direct answer is confirmed without the model, and a refresh keeps the saved name', async () => {
  await request('/api/profile?characterId=baekhyun', {
    method: 'PUT',
    cookie: fan.cookie,
    body: { callName: '', callNameStatus: 'pending', callNameSource: '', onboarded: true },
  });
  const chat = await request('/api/chat?characterId=baekhyun', {
    method: 'POST',
    cookie: fan.cookie,
    body: { text: '叫我小星', turnId: 'turnname01' },
  });
  assert.equal(chat.status, 200);
  assert.match(chat.json.bubbles[0], /기억했어/);
  const saved = await request('/api/profile?characterId=baekhyun', { cookie: fan.cookie });
  assert.equal(saved.json.profile.callName, '小星');
  assert.equal(saved.json.profile.callNameSource, 'asked');
  assert.equal(saved.json.profile.callNameStatus, 'done');
  const history = await request('/api/history?characterId=baekhyun', { cookie: fan.cookie });
  assert.equal(history.json.messages.some((item) => item.text === '叫我小星'), true);
  const replay = await request('/api/profile?characterId=baekhyun', { cookie: fan.cookie });
  assert.equal(replay.json.profile.callName, '小星');
});
