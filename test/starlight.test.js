const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-star-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
delete process.env.ADMINS;
delete process.env.MOMENTS_ADMINS;
process.env.DEEPSEEK_CHAT_API_KEY = 'test-chat-key';
process.env.ELEVENLABS_API_KEY = 'test-voice-key';

const starlight = require('../lib/starlight');
const store = require('../lib/store');
const { createApp } = require('../server');

const day = (iso) => Date.parse(iso);

test('claims, codes, refunds, and concurrent spends stay consistent', async () => {
  const user = 'a'.repeat(32);
  const other = 'b'.repeat(32);
  const first = await starlight.ensure(user);
  assert.equal(first.balance, 100);
  const again = await starlight.ensure(user);
  assert.equal(again.balance, 100);

  const one = await starlight.claim(user, day('2026-11-01T04:00:00Z'));
  const dup = await starlight.claim(user, day('2026-11-01T06:00:00Z'));
  assert.equal(one.ok, true);
  assert.equal(one.amount, 50);
  assert.equal(dup.ok, false);
  await starlight.claim(user, day('2026-11-02T04:00:00Z'));
  const third = await starlight.claim(user, day('2026-11-03T04:00:00Z'));
  assert.equal(third.streak, 3);
  assert.equal(third.bonus, 5);
  assert.equal(third.balance, 100 + 50 + 50 + 55);

  const created = await starlight.createCode({ amount: 20, maxUses: 1, createdBy: 'admin' });
  const redeemed = await starlight.redeem(user, created.code);
  assert.equal(redeemed.ok, true);
  assert.equal((await starlight.redeem(user, created.code)).ok, false);
  assert.equal((await starlight.redeem(other, created.code)).code, 'used-up');

  const before = (await starlight.summary(user)).balance;
  const hold = await starlight.reserve({ userId: user, requestId: 'hold-1', action: 'text', amount: 1 });
  assert.equal(hold.ok, true);
  await starlight.release('hold-1');
  assert.equal((await starlight.summary(user)).balance, before);

  const left = (await starlight.summary(other)).balance;
  assert.equal(left, 100);
  const spend = await Promise.all([
    starlight.reserve({ userId: other, requestId: 'race-1', action: 'text', amount: left }),
    starlight.reserve({ userId: other, requestId: 'race-2', action: 'text', amount: left }),
  ]);
  assert.equal(spend.filter((item) => item.ok).length, 1);
  assert.equal(spend.filter((item) => item.code === 'insufficient').length, 1);
});

let base;
let serverApp;
let fan;
let calls;

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
  calls = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost')) return realFetch(url, opts);
    calls += 1;
    if (String(opts && opts.body || '').includes('失败')) {
      return new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"messages":[{"mood":"soft","ko":"응","zh":"嗯"}]}' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  serverApp = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => serverApp.once('listening', resolve));
  base = `http://127.0.0.1:${serverApp.address().port}`;
  const stamp = Date.now().toString(36);
  fan = await request('/api/register', { method: 'POST', body: { username: `star${stamp}`, password: 'password1', age14: true } });
});

test.after(async () => {
  await store.flush({ shutdown: true });
  await new Promise((resolve) => serverApp.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a reply spends one star, a failed reply is returned, and an empty balance never calls the model', async () => {
  const opened = await request('/api/starlight', { cookie: fan.cookie });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.balance, 100);
  const chat = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: fan.cookie, body: { text: '안녕', turnId: 'turnstar01' },
  });
  assert.equal(chat.status, 200);
  assert.equal(calls > 0, true);
  const after = await request('/api/starlight', { cookie: fan.cookie });
  assert.equal(after.json.balance, 99);
  const beforeFail = calls;
  const failed = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: fan.cookie, body: { text: '这次失败', turnId: 'turnstar02' },
  });
  assert.equal(failed.status, 200);
  assert.equal(calls > beforeFail, true);
  const refunded = await request('/api/starlight', { cookie: fan.cookie });
  assert.equal(refunded.json.balance, 99);
  await starlight.reserve({
    userId: fan.json.user.id, requestId: 'drain', action: 'text', amount: 99,
  });
  await starlight.settle('drain');
  const drained = calls;
  const blocked = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: fan.cookie, body: { text: '더 말해', turnId: 'turnstar03' },
  });
  assert.equal(blocked.status, 402);
  assert.equal(blocked.json.notice, '星光不够啦');
  assert.equal(calls, drained);
  const quoted = await request('/api/starlight/purchase', {
    method: 'POST', cookie: fan.cookie, body: { packageId: 's6' },
  });
  assert.equal(quoted.json.payable, false);
  assert.equal(quoted.json.message, '充值即将开放');
  assert.equal(quoted.json.amount, 300);
});
