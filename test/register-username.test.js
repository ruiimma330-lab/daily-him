'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-reg-user-'));
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
const { createApp } = require('../server');

let base;
let serverApp;

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
});

test.after(async () => {
  await store.flush({ shutdown: true });
  await new Promise((resolve) => serverApp.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('new accounts must be 8–12 digits and unique; legacy accounts still log in', async () => {
  const loginPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
  assert.match(loginPage, /\\\\d\{8,12\}/);
  assert.match(loginPage, /8–12 位数字/);

  assert.equal((await request('/api/register', {
    method: 'POST', body: { username: 'abc12345', password: 'password1', age14: true },
  })).status, 400);
  assert.equal((await request('/api/register', {
    method: 'POST', body: { username: '1234567', password: 'password1', age14: true },
  })).status, 400);
  assert.equal((await request('/api/register', {
    method: 'POST', body: { username: '1234567890123', password: 'password1', age14: true },
  })).status, 400);

  const username = digitUsername();
  assert.ok(/^\d{8,12}$/.test(username));
  const created = await request('/api/register', {
    method: 'POST', body: { username, password: 'password1', age14: true },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.user.username, username);

  const taken = await request('/api/register', {
    method: 'POST', body: { username, password: 'password1', age14: true },
  });
  assert.equal(taken.status, 409);

  const legacyName = `legacy_${Date.now().toString(36)}`;
  const passwordHash = await bcrypt.hash('password1', 4);
  store.createUser({ username: legacyName, passwordHash });
  const login = await request('/api/login', {
    method: 'POST', body: { username: legacyName, password: 'password1' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.username, legacyName);

  const digitLogin = await request('/api/login', {
    method: 'POST', body: { username, password: 'password1' },
  });
  assert.equal(digitLogin.status, 200);
});
