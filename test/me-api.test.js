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

test('age gate, prefs, history summary, and account deletion', async () => {
  const username = `me${Date.now().toString(36)}`;
  const blocked = await request('/api/register', {
    method: 'POST',
    body: { username, password: 'password1' },
  });
  assert.equal(blocked.status, 400);

  const created = await request('/api/register', {
    method: 'POST',
    body: { username, password: 'password1', age14: true },
  });
  assert.equal(created.status, 201);
  const cookie = created.cookie;
  const userId = created.json.user.id;

  const other = await request('/api/register', {
    method: 'POST',
    body: { username: `${username}b`, password: 'password1', age14: true },
  });
  assert.equal(other.status, 201);

  const defaults = await request('/api/me/settings', { cookie });
  assert.equal(defaults.json.settings.playback, 'tap');
  assert.equal(defaults.json.settings.translation, 'collapsed');
  assert.equal(defaults.json.settings.aiNoticeSeen, false);

  const saved = await request('/api/me/settings', {
    method: 'PUT',
    cookie,
    body: { playback: 'auto', translation: 'expanded', nickname: '  小星  ', aiNoticeSeen: true },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.nickname, '小星');
  assert.equal(saved.json.settings.aiNoticeSeen, true);
  const again = await request('/api/me/settings', { cookie });
  assert.equal(again.json.settings.playback, 'auto');
  assert.equal(again.json.settings.translation, 'expanded');

  const badPlayback = await request('/api/me/settings', { method: 'PUT', cookie, body: { playback: 'loud' } });
  assert.equal(badPlayback.status, 400);

  store.putHistory(userId, 'baekhyun', [{ role: 'user', text: '你好', time: 1 }]);
  store.putDoc('memory', userId, 'baekhyun', {
    cards: [{ id: 'abc123abc123', text: '喜欢热可可', createdAt: 1, updatedAt: 2 }],
    deleted: [],
    summary: '旧摘要',
    summaryUpdatedAt: 3,
    summarizedUntil: 1,
    pending: [{ u: '你好', a: '嗯', t: 1 }],
    pendingTurns: 1,
    openings: [],
  });
  store.putDoc('moments', userId, 'baekhyun', { liked: { a: true }, comments: [{ id: 'c1', text: '好看' }], lastReplyAt: 0 });
  const cleared = await request('/api/history?characterId=baekhyun&summary=1', { method: 'DELETE', cookie });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json.messages, []);
  const memory = store.getDoc('memory', userId, 'baekhyun');
  assert.equal(memory.summary, '');
  assert.equal(memory.cards.length, 1);
  assert.equal(memory.pending.length, 0);

  const stranger = await request('/api/memory/abc123abc123?characterId=baekhyun', { method: 'DELETE', cookie: other.cookie });
  assert.equal(stranger.status, 404);
  assert.equal(store.getDoc('memory', userId, 'baekhyun').cards.length, 1);

  store.putHistory(userId, 'baekhyun', [{ role: 'assistant', text: '又来了', time: 4 }]);
  const all = await request('/api/histories', { method: 'DELETE', cookie, body: { confirm: 'CLEAR' } });
  assert.equal(all.status, 200);
  assert.deepEqual(store.getHistory(userId, 'baekhyun'), []);
  const noConfirm = await request('/api/histories', { method: 'DELETE', cookie, body: {} });
  assert.equal(noConfirm.status, 400);

  const posted = await request('/api/feedback', { method: 'POST', cookie, body: { kind: 'report', text: '这条回复不合适' } });
  assert.equal(posted.status, 201);
  const feedback = await request('/api/feedback', { cookie: other.cookie });
  assert.deepEqual(feedback.json.items, []);

  const wrong = await request('/api/me/password', {
    method: 'PUT', cookie, body: { oldPassword: 'nope-nope', newPassword: 'password2' },
  });
  assert.equal(wrong.status, 401);
  const changed = await request('/api/me/password', {
    method: 'PUT', cookie, body: { oldPassword: 'password1', newPassword: 'password2' },
  });
  assert.equal(changed.status, 200);

  const badDelete = await request('/api/me', { method: 'DELETE', cookie, body: { confirm: '删除' } });
  assert.equal(badDelete.status, 400);
  const gone = await request('/api/me', { method: 'DELETE', cookie, body: { confirm: '注销' } });
  assert.equal(gone.status, 200);
  assert.equal(store.findUserById(userId), null);
  assert.equal(store.getDoc('memory', userId, 'baekhyun'), null);
  assert.equal(store.getDoc('moments', userId, 'baekhyun'), null);
  assert.equal(store.getDoc('prefs', userId, 'user'), null);
  assert.equal(store.getDoc('prefs', userId, 'account'), null);
  assert.equal(store.getDoc('feedback', userId, 'user'), null);
  assert.equal(store.getDoc('feedback', userId, 'account'), null);
  assert.deepEqual(store.getHistory(userId, 'baekhyun'), []);
  const relog = await request('/api/login', {
    method: 'POST',
    body: { username, password: 'password2' },
  });
  assert.equal(relog.status, 401);
});
