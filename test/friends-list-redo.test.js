'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-friends-redo-'));
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
const profile = require('../lib/profile');
const friends = require('../lib/friends');
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

test('listForUser returns onboarded and history chat entries', async () => {
  profile.save(userId, 'baekhyun', { onboarded: true, characterNickname: '伯贤' });
  store.putHistory(userId, 'jimin', [
    { role: 'user', text: 'hi', time: Date.now() - 1000 },
    { role: 'assistant', text: '안녕', time: Date.now(), zh: '你好' },
  ]);

  const listed = await friends.listForUser(userId);
  assert.equal(listed.hasFriends, true);
  const ids = listed.friends.map((item) => item.id).sort();
  assert.deepEqual(ids, ['baekhyun', 'jimin']);
  const baek = listed.friends.find((item) => item.id === 'baekhyun');
  assert.equal(baek.characterNickname, '伯贤');
});

test('GET /api/friends uses the rebuilt chat-entry API', async () => {
  const response = await request('/api/friends', { cookie });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.ok(response.json.hasFriends);
  assert.ok(response.json.friends.some((item) => item.id === 'baekhyun'));
  assert.ok(response.json.friends.some((item) => item.id === 'jimin'));
});

test('chat-entry client module and index wire FriendsList', () => {
  const listJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'friends-list.js'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(listJs, /global\.FriendsList/);
  assert.match(listJs, /点击进入聊天/);
  assert.match(index, /friends-list\.js/);
  assert.match(index, />聊天</);
  assert.match(app, /FriendsList\.load/);
  assert.match(app, /open=1/);
  assert.doesNotMatch(app, /location\.replace\('\/shell\/pick\.html\?from=chat'\)/);
  assert.match(sw, /friends-list\.js/);
  assert.match(sw, /dh-pwa-22/);
});
