'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-friends-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.CHECKIN_IDLE_MS = String(60 * 60 * 1000);
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
delete process.env.ADMINS;
delete process.env.MOMENTS_ADMINS;
process.env.DEEPSEEK_CHAT_API_KEY = 'test-chat-key';
process.env.ELEVENLABS_API_KEY = 'test-voice-key';

const { digitUsername } = require('./helpers');
const store = require('../lib/store');
const profile = require('../lib/profile');
const checkins = require('../lib/checkins');
const { createApp } = require('../server');

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

test('friends lists onboarded idols even without messages', async () => {
  const empty = await request('/api/friends', { cookie });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.hasFriends, false);
  assert.deepEqual(empty.json.friends, []);

  profile.save(userId, 'baekhyun', { onboarded: true });
  profile.save(userId, 'jimin', { onboarded: true, characterNickname: '智旻哥' });

  const me = await request('/api/me', { cookie });
  assert.equal(me.json.hasFriends, true);

  const friends = await request('/api/friends', { cookie });
  assert.equal(friends.json.hasFriends, true);
  assert.equal(friends.json.friends.length, 2);
  const ids = friends.json.friends.map((item) => item.id).sort();
  assert.deepEqual(ids, ['baekhyun', 'jimin']);
  const jimin = friends.json.friends.find((item) => item.id === 'jimin');
  assert.equal(jimin.characterNickname, '智旻哥');
});

test('legacy chat history counts as friends and backfills onboardedAt', async () => {
  store.putHistory(userId, 'jungkook', [
    { role: 'user', text: 'hi', time: Date.now() - 1000 },
    { role: 'assistant', text: 'hey', time: Date.now(), zh: '嘿' },
  ]);
  assert.equal(profile.load(userId, 'jungkook').onboardedAt, null);

  const friends = await request('/api/friends', { cookie });
  assert.equal(friends.status, 200);
  assert.ok(friends.json.friends.some((item) => item.id === 'jungkook'));
  assert.equal(friends.json.hasFriends, true);
  assert.ok(profile.load(userId, 'jungkook').onboardedAt);

  const me = await request('/api/me', { cookie });
  assert.equal(me.json.hasFriends, true);
});

test('idle check-in appends one proactive line after a quiet stretch', async () => {
  const old = Date.now() - (9 * 60 * 60 * 1000);
  store.putHistory(userId, 'baekhyun', [
    { role: 'user', text: '안녕', time: old },
    { role: 'assistant', text: '응', time: old + 1000, zh: '嗯' },
  ]);

  const first = await request('/api/checkin?characterId=baekhyun', { method: 'POST', cookie });
  assert.equal(first.status, 200);
  assert.equal(first.json.appended, true);
  assert.ok(first.json.message);
  assert.equal(first.json.message.proactive, true);
  assert.ok(['ask', 'life', 'scene'].includes(first.json.kind));
  assert.match(first.json.message.text, /[\uac00-\ud7a3]/);
  assert.match(first.json.message.zh, /[\u4e00-\u9fff]/);

  const again = await request('/api/checkin?characterId=baekhyun', { method: 'POST', cookie });
  assert.equal(again.json.appended, false);
  assert.equal(again.json.reason, 'today');

  const fresh = checkins.maybeAppend({
    userId,
    characterId: 'jimin',
    now: Date.now(),
  });
  assert.equal(fresh.appended, false);
  assert.equal(fresh.reason, 'empty');
});

test('cover and chat clients route returning users to the list, not the picker', () => {
  const cover = fs.readFileSync(path.join(__dirname, '..', 'public', 'shell', 'cover.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const login = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
  const picker = fs.readFileSync(path.join(__dirname, '..', 'public', 'shell', 'picker.js'), 'utf8');
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(cover, /\/api\/friends/);
  assert.match(cover, /Shell\.go\('\/'/);
  assert.match(app, /renderFriendsList/);
  assert.match(app, /\/api\/checkin/);
  // After 开始聊天 / onboard, welcome seeds a greeting but must NOT openRoom.
  assert.match(app, /fromWelcome/);
  assert.doesNotMatch(app, /if \(wantRoom\) openRoom\(\)/);
  assert.doesNotMatch(app, /if \(fromWelcome\) openRoom\(\)/);
  assert.match(login, /destinationAfterAuth/);
  assert.match(picker, /qs\('from'\) === 'chat'/);
  // 开始聊天 immediately PUTs onboarded:true before onboard / list.
  assert.match(picker, /onboarded:\s*true/);
  assert.match(picker, /method:\s*'PUT'/);
  assert.match(manifest, /"start_url": "\/"/);
  assert.match(sw, /dh-pwa-19/);
});
