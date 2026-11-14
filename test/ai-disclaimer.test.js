'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-ai-disclaimer-'));
const existingId = 'a'.repeat(32);
const existingPassword = 'existing-password';

fs.writeFileSync(path.join(dataDir, 'users.json'), `${JSON.stringify({
  users: [{
    id: existingId,
    username: 'existing_notice_user',
    passwordHash: bcrypt.hashSync(existingPassword, 4),
    createdAt: 1,
    // Deliberately no aiDisclaimerAcknowledged field: this is a pre-migration account.
  }],
}, null, 2)}\n`);

process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'ai-disclaimer-test-session-secret-123456';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;

const store = require('../lib/store');
const { createApp } = require('../server');

let server;
let base;

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/sid=[^;]+/);
  return match ? match[0] : '';
}

async function request(route, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, json: await response.json(), cookie: cookieFrom(response) };
}

test.before(async () => {
  await store.init();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await store.flush({ shutdown: true });
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('new registration requires one server-persisted acknowledgement', async () => {
  const username = `notice_${Date.now().toString(36)}`;
  const registered = await request('/api/register', {
    method: 'POST',
    body: { username, password: 'password123', age14: true },
  });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.json.aiDisclaimerAcknowledged, false);

  const before = await request('/api/me', { cookie: registered.cookie });
  assert.equal(before.json.aiDisclaimerAcknowledged, false);

  const acknowledged = await request('/api/me/ai-disclaimer', {
    method: 'POST',
    cookie: registered.cookie,
  });
  assert.equal(acknowledged.response.status, 200);
  assert.equal(acknowledged.json.aiDisclaimerAcknowledged, true);

  await request('/api/logout', { method: 'POST', cookie: registered.cookie });
  const loggedIn = await request('/api/login', {
    method: 'POST',
    body: { username, password: 'password123' },
  });
  const after = await request('/api/me', { cookie: loggedIn.cookie });
  assert.equal(after.json.aiDisclaimerAcknowledged, true);
});

test('pre-migration users are already acknowledged', async () => {
  const loggedIn = await request('/api/login', {
    method: 'POST',
    body: { username: 'existing_notice_user', password: existingPassword },
  });
  assert.equal(loggedIn.response.status, 200);
  const me = await request('/api/me', { cookie: loggedIn.cookie });
  assert.equal(me.json.aiDisclaimerAcknowledged, true);
});

test('registration and app clients use the account endpoint, not a character flag', () => {
  const login = fs.readFileSync(path.join(ROOT, 'public/login.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const wording = '这里的角色由 AI 模拟，不是本人。聊天内容会用于生成回复，不代表艺人本人的意思。';
  assert.match(login, new RegExp(wording));
  assert.match(login, /mode === 'register' && data\.aiDisclaimerAcknowledged === false/);
  assert.match(login, /fetch\('\/api\/me\/ai-disclaimer', \{ method: 'POST' \}\)/);
  assert.match(app, /me\.aiDisclaimerAcknowledged !== false/);
  assert.match(app, /fetch\('\/api\/me\/ai-disclaimer', \{ method: 'POST' \}\)/);
  assert.equal(app.includes('idol-disclaimer-v2-'), false);
  assert.equal(app.includes('character-disclaimer'), false);
});
