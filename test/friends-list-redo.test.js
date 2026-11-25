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
  assert.match(sw, /dh-pwa-23/);
});

test('5-friend account and corrupt onboardedAt still return all 5 friends with finite lastAt', async () => {
  const created = await request('/api/register', {
    method: 'POST',
    body: { username: digitUsername(), password: 'password1', age14: true },
  });
  assert.ok(created.status === 200 || created.status === 201);
  const uid = created.json.user.id;
  for (const id of ['baekhyun', 'jimin', 'jungkook', 'myungjaehyun']) {
    profile.save(uid, id, { onboarded: true });
  }
  store.putDoc('profile', uid, 'dohoon', { ...profile.empty(), onboardedAt: 'not-a-date' });
  await store.flush();

  const res = await request('/api/friends', { cookie: created.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.friends.length, 5);
  assert.deepEqual(
    res.json.friends.map((f) => f.id).sort(),
    ['baekhyun', 'dohoon', 'jimin', 'jungkook', 'myungjaehyun']
  );
  for (const f of res.json.friends) {
    assert.equal(typeof f.lastAt, 'number');
    assert.ok(Number.isFinite(f.lastAt), `${f.id} lastAt must be finite`);
  }
});

test('write-queue race: pending profile.save survives stale backend loadUserDocs without wiping memory', async () => {
  const created = await request('/api/register', {
    method: 'POST',
    body: { username: digitUsername(), password: 'password1', age14: true },
  });
  assert.ok(created.status === 200 || created.status === 201);
  const uid = created.json.user.id;
  profile.save(uid, 'baekhyun', { onboarded: true });
  await store.flush();

  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const staleUser = store.findUserById(uid);
  const staleBaekProfile = store.getDoc('profile', uid, 'baekhyun');
  const slowBackend = {
    name: 'slow-turso-test',
    async init() {},
    async loadAll() {
      return {
        users: staleUser ? [staleUser] : [],
        docs: [{ kind: 'profile', userId: uid, characterId: 'baekhyun', data: staleBaekProfile }],
        settings: {},
      };
    },
    async loadUserDocs() {
      // Stale snapshot from Turso before pending myungjaehyun write completes.
      return [{ kind: 'profile', userId: uid, characterId: 'baekhyun', data: staleBaekProfile }];
    },
    async putDoc() { await writeGate; },
    async delDoc() {},
    async putUser() {},
    async deleteUser() {},
    async putSetting() {},
  };

  try {
    await store.init({ backend: slowBackend });
    profile.save(uid, 'myungjaehyun', { onboarded: true });
    store.putDoc('profile', uid, 'account', { onboardedAt: Date.now() });

    const listed = await friends.listForUser(uid);
    const ids = listed.friends.map((f) => f.id).sort();
    assert.deepEqual(ids, ['baekhyun', 'myungjaehyun']);
    assert.ok(profile.load(uid, 'myungjaehyun').onboardedAt, 'in-memory onboardedAt must not be wiped');
  } finally {
    releaseWrite();
    await store.flush();
    await store.init();
  }
});

test('FriendsList client DOM behavior: 5 rows, retry on failure, preserve rows, invalid lastAt', async () => {
  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      className: '',
      textContent: '',
      type: '',
      hidden: false,
      dateTime: '',
      dataset: {},
      style: {},
      children: [],
      listeners: {},
      setAttribute() {},
      addEventListener(ev, fn) { this.listeners[ev] = fn; },
      click() { if (this.listeners.click) this.listeners.click(); },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = [...nodes]; },
      querySelector(sel) {
        if (sel.startsWith('.')) {
          const cls = sel.slice(1);
          const queue = [...this.children];
          while (queue.length) {
            const cur = queue.shift();
            if (cur.className && cur.className.split(/\s+/).includes(cls)) return cur;
            if (cur.children) queue.push(...cur.children);
          }
        }
        return null;
      },
    };
    return el;
  }

  const root = makeEl('div');
  const prevDoc = global.document;
  const prevFetch = global.fetch;
  global.document = {
    getElementById(id) { return id === 'friends-section' ? root : null; },
    createElement(tag) { return makeEl(tag); },
    querySelector() { return null; },
  };

  const friendsList = require('../public/friends-list.js');
  try {
    const five = ['baekhyun', 'dohoon', 'jimin', 'jungkook', 'myungjaehyun'].map((id, i) => ({
      id,
      name: id,
      displayName: id,
      lastAt: i === 1 ? 'not-a-date' : Date.now() - i * 1000,
      preview: `msg-${id}`,
    }));

    // 1. 5 friends + invalid lastAt renders 5 rows without RangeError, click triggers onOpen
    friendsList.resetState();
    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() { return { ok: true, friends: five }; },
    });
    let opened = null;
    const loaded = await friendsList.load({ onOpen: (f) => { opened = f; }, retryDelayMs: 0 });
    assert.equal(loaded.length, 5);
    assert.equal(root.children.length, 5);
    assert.equal(root.children[1].dataset.friendId, 'dohoon');
    root.children[2].click();
    assert.equal(opened && opened.id, 'jimin');

    // 2. API failure after 5 friends were already rendered keeps all 5 rows intact
    global.fetch = async () => ({
      ok: false,
      status: 500,
      async json() { return { ok: false, error: 'friends_failed', friends: [] }; },
    });
    const kept = await friendsList.load({ retry: false });
    assert.equal(kept.length, 5);
    assert.equal(root.children.length, 5);

    // 3. Initial API failure renders .friends-retry and NEVER shows empty-state copy
    friendsList.resetState();
    root.replaceChildren();
    await friendsList.load({ retryDelayMs: 0 });
    assert.ok(root.querySelector('.friends-retry'), 'retry button must render on persistent failure');
    assert.equal(root.querySelector('.friends-empty').textContent, '没能加载聊天列表');
    assert.notEqual(root.querySelector('.friends-empty').textContent, '还没有聊天，点右上角 + 添加');
  } finally {
    friendsList.resetState();
    global.document = prevDoc;
    global.fetch = prevFetch;
  }
});

test('public assets (friends-list.js, playback.js) and /api/health contract', async () => {
  for (const asset of ['/friends-list.js', '/playback.js']) {
    const res = await fetch(base + asset, { redirect: 'manual' });
    assert.equal(res.status, 200, `${asset} must return 200 when logged out`);
  }
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(typeof health.json.commit, 'string');
  assert.ok(health.json.commit.length > 0);
  assert.equal(health.json.assetVersion, 'dh-pwa-23');
});

test('deploy/hk/update.sh contract enforces single instance, commit verification, and /friends-list.js smoke check', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'hk', 'update.sh'), 'utf8');
  assert.match(script, /-i 1/);
  assert.doesNotMatch(script, /--exec-mode/);
  assert.match(script, /\/api\/health/);
  assert.match(script, /\\"commit\\"/);
  assert.match(script, /EXPECTED_COMMIT/);
  assert.match(script, /\/friends-list\.js/);
});
