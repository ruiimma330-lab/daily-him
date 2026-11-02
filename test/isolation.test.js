const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const chatContext = require('../lib/chat-context');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-iso-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;

const store = require('../lib/store');
const { createApp } = require('../server');

const FIXTURE_ID = 'zztest';
const FIXTURE_DIR = path.join(__dirname, '..', 'characters', FIXTURE_ID);

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
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_DIR, 'character.json'), JSON.stringify({
    id: FIXTURE_ID,
    name: 'Fixture',
    displayName: 'Fixture',
    available: true,
    defaultUserName: 'you',
  }));
  await store.init();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await store.flush();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

test('missing or unknown character id is rejected', async () => {
  const created = await request('/api/register', {
    method: 'POST',
    body: { username: `iso${Date.now().toString(36)}`, password: 'password1', age14: true },
  });
  assert.equal(created.status, 201);
  const cookie = created.cookie;

  const missing = await request('/api/history', { cookie });
  assert.equal(missing.status, 400);

  const blank = await request('/api/history?characterId=', { cookie });
  assert.equal(blank.status, 400);

  const unknown = await request('/api/history?characterId=not-a-real-idol', { cookie });
  assert.equal(unknown.status, 404);

  const oldShape = await request('/api/chat?characterId=baekhyun', {
    method: 'POST',
    cookie,
    body: { messages: [{ role: 'user', content: 'should not be trusted' }] },
  });
  assert.equal(oldShape.status, 400);
});

test('two accounts and two characters keep separate histories', async () => {
  const stamp = Date.now().toString(36);
  const first = await request('/api/register', {
    method: 'POST',
    body: { username: `a${stamp}`, password: 'password1', age14: true },
  });
  const second = await request('/api/register', {
    method: 'POST',
    body: { username: `b${stamp}`, password: 'password1', age14: true },
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const writes = [
    [first.cookie, 'baekhyun', 'A-baek'],
    [first.cookie, FIXTURE_ID, 'A-fixture'],
    [second.cookie, 'baekhyun', 'B-baek'],
    [second.cookie, FIXTURE_ID, 'B-fixture'],
  ];
  for (const [cookie, characterId, text] of writes) {
    const saved = await request(`/api/history?characterId=${characterId}`, {
      method: 'PUT',
      cookie,
      body: { messages: [{ role: 'user', text, time: 1 }] },
    });
    assert.equal(saved.status, 200);
  }

  for (const [cookie, characterId, text] of writes) {
    const read = await request(`/api/history?characterId=${characterId}`, { cookie });
    assert.equal(read.status, 200);
    assert.equal(read.json.messages.length, 1);
    assert.equal(read.json.messages[0].text, text);
  }
});

test('model context is the stored transcript plus the new line', () => {
  const stored = [
    { role: 'user', text: 'server-user', time: 1 },
    { role: 'assistant', text: 'server-reply', zh: '服务器', time: 2 },
  ];
  const context = chatContext.fromHistory(stored, 'just-this-line');
  assert.deepEqual(context.map((item) => item.content), ['server-user', 'server-reply', 'just-this-line']);
  assert.equal(context[1].zh, '服务器');

  const deduped = chatContext.fromHistory(
    [{ role: 'user', text: 'just-this-line', time: 3 }],
    'just-this-line',
  );
  assert.equal(deduped.length, 1);

  const next = chatContext.appendTurn(stored, 'just-this-line', [{ ko: 'answer', zh: '答' }]);
  assert.equal(next[next.length - 2].text, 'just-this-line');
  assert.equal(next[next.length - 1].text, 'answer');
  assert.equal(next.filter((item) => item.text === 'just-this-line').length, 1);
});

test('service worker does not cache account APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(source, /Account data/);
  assert.match(source, /if \(!isCharacterConfig\(request, url\)\) return;/);
});
