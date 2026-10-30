const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-me-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;

const store = require('../lib/store');
const { createApp } = require('../server');

let base;
let server;

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

async function register(username) {
  const res = await request('/api/register', {
    method: 'POST',
    body: { username, password: 'password1' },
  });
  assert.equal(res.status, 201);
  return res;
}

test.before(async () => {
  await store.init();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await store.flush();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('me settings, password, feedback, credits, memory, and account deletion', async () => {
  const anon = await request('/api/me/settings');
  assert.equal(anon.status, 401);

  const a = await register(`me${Date.now().toString(36)}`);
  const b = await register(`ot${Date.now().toString(36)}x`);
  const cookie = a.cookie;
  const other = b.cookie;
  const userId = a.json.user.id;

  const defaults = await request('/api/me/settings', { cookie });
  assert.equal(defaults.status, 200);
  assert.deepEqual(defaults.json.settings, {
    playback: 'tap',
    translation: 'collapsed',
    textSize: 'm',
    nickname: '',
  });

  const bad = await request('/api/me/settings', { method: 'PUT', cookie, body: { textSize: 'xl' } });
  assert.equal(bad.status, 400);
  const still = await request('/api/me/settings', { cookie });
  assert.equal(still.json.settings.textSize, 'm');

  const saved = await request('/api/me/settings', {
    method: 'PUT',
    cookie,
    body: { playback: 'auto', translation: 'expanded', textSize: 'l', nickname: '  小星  ' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.nickname, '小星');
  assert.equal(saved.json.settings.playback, 'auto');

  const partial = await request('/api/me/settings', { method: 'PUT', cookie, body: { playback: 'tap' } });
  assert.equal(partial.json.settings.playback, 'tap');
  assert.equal(partial.json.settings.nickname, '小星');
  assert.equal(partial.json.settings.translation, 'expanded');

  const short = await request('/api/me/password', {
    method: 'PUT',
    cookie,
    body: { oldPassword: 'password1', newPassword: 'short' },
  });
  assert.equal(short.status, 400);
  const wrong = await request('/api/me/password', {
    method: 'PUT',
    cookie,
    body: { oldPassword: 'not-the-old', newPassword: 'password2' },
  });
  assert.equal(wrong.status, 401);
  const changed = await request('/api/me/password', {
    method: 'PUT',
    cookie,
    body: { oldPassword: 'password1', newPassword: 'password2' },
  });
  assert.equal(changed.status, 200);
  const oldLogin = await request('/api/login', {
    method: 'POST',
    body: { username: a.json.user.username, password: 'password1' },
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await request('/api/login', {
    method: 'POST',
    body: { username: a.json.user.username, password: 'password2' },
  });
  assert.equal(newLogin.status, 200);

  const emptyFeedback = await request('/api/feedback', { method: 'POST', cookie, body: { text: '   ' } });
  assert.equal(emptyFeedback.status, 400);
  const tooLong = await request('/api/feedback', { method: 'POST', cookie, body: { text: 'x'.repeat(1001) } });
  assert.equal(tooLong.status, 400);
  const posted = await request('/api/feedback', { method: 'POST', cookie, body: { text: '字太小了' } });
  assert.equal(posted.status, 201);
  const mine = await request('/api/feedback', { cookie });
  assert.equal(mine.json.items.length, 1);
  assert.equal(mine.json.items[0].text, '字太小了');
  const theirs = await request('/api/feedback', { cookie: other });
  assert.deepEqual(theirs.json.items, []);

  const credits = await request('/api/credits', { cookie });
  assert.equal(credits.status, 200);
  const baek = credits.json.credits.find((item) => item.id === 'baekhyun' && item.file === 'ATTRIBUTION.txt');
  assert.ok(baek);
  assert.match(baek.text, /CC BY/);
  const about = await request('/api/about', { cookie });
  assert.equal(about.json.version, '1.0.0');
  assert.match(about.json.notice, /AI 模拟角色/);

  store.putDoc('memory', userId, 'baekhyun', {
    cards: [{ id: 'abc123abc123', text: '喜欢下雨天', date: null, createdAt: 1, updatedAt: 2 }],
    deleted: [],
    summary: '',
    summaryUpdatedAt: null,
    summarizedUntil: 0,
    pending: [],
    pendingTurns: 0,
    openings: [],
  });
  const missing = await request('/api/memory/abc123abc123?characterId=baekhyun', { method: 'DELETE', cookie: other });
  assert.equal(missing.status, 404);
  assert.equal(store.getDoc('memory', userId, 'baekhyun').cards.length, 1);
  const removed = await request('/api/memory/abc123abc123?characterId=baekhyun', { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.cards.length, 0);

  store.putHistory(userId, 'baekhyun', [{ role: 'user', text: '你好', time: 1 }]);
  store.putDoc('profile', userId, 'baekhyun', {
    characterNickname: '伯贤',
    callName: '에리',
    displayName: '',
    onboardedAt: 1,
  });
  const cleared = await request('/api/history?characterId=baekhyun', { method: 'DELETE', cookie });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json.messages, []);
  const profile = await request('/api/profile?characterId=baekhyun', { cookie });
  assert.equal(profile.json.profile.characterNickname, '伯贤');
  const memoryLeft = store.getDoc('memory', userId, 'baekhyun');
  assert.equal(memoryLeft.cards.length, 0);

  const badDelete = await request('/api/me', { method: 'DELETE', cookie, body: { confirm: 'nope' } });
  assert.equal(badDelete.status, 400);
  const stillMe = await request('/api/me', { cookie });
  assert.equal(stillMe.status, 200);

  const gone = await request('/api/me', { method: 'DELETE', cookie, body: { confirm: a.json.user.username } });
  assert.equal(gone.status, 200);
  const after = await request('/api/me', { cookie: gone.cookie });
  assert.equal(after.status, 401);
  assert.equal(store.findUserById(userId), null);
  assert.equal(store.getDoc('feedback', userId, 'user'), null);
  assert.equal(store.getDoc('profile', userId, 'baekhyun'), null);
  const relog = await request('/api/login', {
    method: 'POST',
    body: { username: a.json.user.username, password: 'password2' },
  });
  assert.equal(relog.status, 401);
});
