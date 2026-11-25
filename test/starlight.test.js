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

const { digitUsername } = require('./helpers');
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
  global.voiceCalls = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const target = String(url);
    const body = String(opts && opts.body || '');
    if (target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost')) return realFetch(url, opts);
    calls += 1;
    if (target.includes('api.elevenlabs.io')) {
      global.voiceCalls += 1;
      if (body.includes('깨져')) return new Response('no', { status: 500, headers: { 'content-type': 'text/plain' } });
      return new Response(Buffer.alloc(80, 4), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    if (body.includes('失败')) {
      return new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
    const tag = (body.match(/tag([a-z0-9]+)/) || [])[1] || '';
    let ko = tag ? `응${tag}` : '응';
    if (body.includes('깨져')) ko = `깨져${tag}`;
    else if (body.includes('다른말')) ko = `다른${tag}`;
    return new Response(JSON.stringify({
      choices: [{ message: { content: `{"messages":[{"mood":"soft","ko":"${ko}","zh":"嗯"}]}` } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  serverApp = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => serverApp.once('listening', resolve));
  base = `http://127.0.0.1:${serverApp.address().port}`;
  fan = await request('/api/register', { method: 'POST', body: { username: digitUsername(), password: 'password1', age14: true } });
});

test.after(async () => {
  await store.flush({ shutdown: true });
  await new Promise((resolve) => serverApp.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a reply spends three stars, a failed reply is returned, and an empty balance never calls the model', async () => {
  const opened = await request('/api/starlight', { cookie: fan.cookie });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.balance, 100);
  assert.equal(opened.json.prices.text, 3);
  assert.equal(opened.json.prices.voice, 15);
  const chat = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: fan.cookie, body: { text: '안녕', turnId: 'turnstar01', voice: false },
  });
  assert.equal(chat.status, 200);
  assert.equal(calls > 0, true);
  const after = await request('/api/starlight', { cookie: fan.cookie });
  assert.equal(after.json.balance, 97);
  const beforeFail = calls;
  const failed = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: fan.cookie, body: { text: '这次失败', turnId: 'turnstar02', voice: false },
  });
  assert.equal(failed.status, 200);
  assert.equal(calls > beforeFail, true);
  assert.equal(failed.json.messages[0].fallback, true);
  const textFallbacks = require('../lib/fallbacks').loadLines('baekhyun', 'text').map((line) => line.ko);
  assert.ok(textFallbacks.includes(failed.json.messages[0].ko));
  assert.equal(store.getHistory(fan.json.user.id, 'baekhyun').at(-1).fallback, true);
  const refunded = await request('/api/starlight', { cookie: fan.cookie });
  assert.equal(refunded.json.balance, 97);
  await starlight.reserve({
    userId: fan.json.user.id, requestId: 'drain', action: 'text', amount: 97,
  });
  await starlight.settle('drain');
  const drained = calls;
  const blocked = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: fan.cookie, body: { text: '더 말해', turnId: 'turnstar03', voice: false },
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

test('chat voice uses the same charge, and Turso never falls back to the file ledger', async () => {
  assert.equal(starlight.chooseLedger({}), 'file');
  process.env.TURSO_DATABASE_URL = 'libsql://example.turso.io';
  assert.throws(() => starlight.chooseLedger({}), /Turso/);
  assert.equal(starlight.chooseLedger({ db: {} }), 'sql');
  delete process.env.TURSO_DATABASE_URL;

  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal(src.includes('await voiceExec.synthesize'), false);
  assert.equal(src.includes('await synthesize('), false);
  assert.equal((src.match(/speak: \(\) => lockedRequest \? voiceExec\.synthesize\(lockedRequest, keys\.voiceKey\) : synthesize\(/g) || []).length, 1);
  assert.equal((src.match(/speak: \(\) => voiceExec\.synthesize/g) || []).length, 2);

  const stamp = Date.now().toString(36);
  const speaker = await request('/api/register', { method: 'POST', body: { username: digitUsername(), password: 'password1', age14: true } });
  const start = (await request('/api/starlight', { cookie: speaker.cookie })).json.balance;
  const before = global.voiceCalls;
  const first = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: speaker.cookie, body: { text: `tag${stamp}`, turnId: 'turnvoice01' },
  });
  assert.equal(first.status, 200);
  assert.ok(first.json.messages[0].audioUrl);
  assert.equal(global.voiceCalls, before + 1);
  const charged = (await request('/api/starlight', { cookie: speaker.cookie })).json.balance;
  assert.equal(charged, start - 18);

  const replay = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: speaker.cookie, body: { text: `tag${stamp} 다시`, turnId: 'turnvoice02' },
  });
  assert.equal(replay.status, 200);
  assert.ok(replay.json.messages[0].audioUrl);
  assert.equal(global.voiceCalls, before + 1);
  assert.equal((await request('/api/starlight', { cookie: speaker.cookie })).json.balance, charged - 3);

  const brokenBefore = (await request('/api/starlight', { cookie: speaker.cookie })).json.balance;
  const broken = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: speaker.cookie, body: { text: `깨져tag${stamp}`, turnId: 'turnvoice03' },
  });
  assert.equal(broken.status, 200);
  assert.equal(broken.json.messages[0].audioUrl, null);
  assert.equal((await request('/api/starlight', { cookie: speaker.cookie })).json.balance, brokenBefore - 3);

  const poor = await request('/api/register', { method: 'POST', body: { username: digitUsername(), password: 'password1', age14: true } });
  await starlight.reserve({ userId: poor.json.user.id, requestId: 'leave-one', action: 'text', amount: 97 });
  await starlight.settle('leave-one');
  const voices = global.voiceCalls;
  const short = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: poor.cookie, body: { text: `다른말tag${stamp}`, turnId: 'turnvoice04' },
  });
  assert.equal(short.status, 200);
  assert.equal(short.json.bubbles[0], `다른${stamp}`);
  assert.equal(short.json.messages[0].audioUrl, null);
  assert.match(short.json.starlight.notice, /15 星光/);
  assert.equal(global.voiceCalls, voices);
});

test('the starlight station is the only recharge UI and keeps redemption folded below unavailable packages', () => {
  const station = fs.readFileSync(path.join(__dirname, '..', 'public', 'shell', 'starlight.html'), 'utf8');
  const legacy = fs.readFileSync(path.join(__dirname, '..', 'public', 'shell', 'recharge.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const loading = fs.readFileSync(path.join(__dirname, '..', 'public', 'shell', 'loading.html'), 'utf8');
  assert.match(station, /充值尚未开通，星光可每日领取或使用兑换码。/);
  assert.match(station, /充值（即将开通）/);
  assert.match(station, /id="redeem-panel" hidden/);
  assert.match(station, /id="prices"/);
  assert.match(station, /id="code-custom"/);
  assert.match(station, /data\.unlimited \? '无限'/);
  assert.ok(station.indexOf('id="packages"') < station.indexOf('id="redeem-section"'));
  assert.match(station, /alert\('测试环境，暂未开通'\)/);
  assert.doesNotMatch(station, /class="price">¥/);
  assert.match(legacy, /location\.replace\('\/shell\/starlight\.html#recharge'\)/);
  assert.doesNotMatch(legacy, /\/api\/wallet\/purchase/);
  assert.doesNotMatch(app, /\/shell\/recharge\.html/);
  assert.doesNotMatch(loading, /\/shell\/recharge\.html/);
});

test('ADMINS users get unlimited starlight and can still chat at zero balance', async () => {
  const stamp = Date.now().toString(36);
  const username = digitUsername();
  const admin = await request('/api/register', {
    method: 'POST', body: { username, password: 'password1', age14: true },
  });
  assert.ok(admin.status === 200 || admin.status === 201);
  process.env.ADMINS = `'${username}'`;
  const view = await request('/api/starlight', { cookie: admin.cookie });
  assert.equal(view.status, 200);
  assert.equal(view.json.unlimited, true);
  assert.match(view.json.notice, /星光无限/);

  const balance = view.json.balance;
  await starlight.reserve({
    userId: admin.json.user.id, requestId: `drain-admin-${stamp}`, action: 'text', amount: Math.max(1, balance),
  });
  // waived: balance untouched even when amount exceeds what a normal wallet would allow
  const drained = await request('/api/starlight', { cookie: admin.cookie });
  assert.equal(drained.json.unlimited, true);
  assert.equal(drained.json.balance, balance);

  const hold = await starlight.reserve({
    userId: admin.json.user.id, requestId: `waive-${stamp}`, action: 'voice', amount: 15,
  });
  assert.equal(hold.ok, true);
  assert.equal(hold.status, 'waived');
  assert.equal(hold.unlimited, true);

  const beforeCalls = calls;
  const chat = await request('/api/chat?characterId=baekhyun', {
    method: 'POST', cookie: admin.cookie, body: { text: '안녕', turnId: `turnadm${stamp}`, voice: false },
  });
  assert.equal(chat.status, 200);
  assert.equal(calls > beforeCalls, true);
  assert.equal((await request('/api/starlight', { cookie: admin.cookie })).json.balance, balance);
  delete process.env.ADMINS;

  // MOMENTS_ADMINS alone is enough for unlimited starlight.
  const other = digitUsername();
  const momentsAdmin = await request('/api/register', {
    method: 'POST', body: { username: other, password: 'password1', age14: true },
  });
  process.env.MOMENTS_ADMINS = other;
  const momentsView = await request('/api/starlight', { cookie: momentsAdmin.cookie });
  assert.equal(momentsView.json.unlimited, true);
  delete process.env.MOMENTS_ADMINS;
});

test('seed codes and custom redeem codes work once', async () => {
  assert.equal(starlight.priceText('hi', 'yo'), 3);
  assert.equal(starlight.loadConfig().voice, 15);
  const seeded = await starlight.ensureSeedCodes();
  assert.equal(seeded.ok, true);
  const user = 'c'.repeat(32);
  await starlight.ensure(user);
  const before = (await starlight.summary(user)).balance;
  const once = await starlight.redeem(user, 'DH-STAR-100');
  assert.equal(once.ok, true);
  assert.equal(once.amount, 100);
  assert.equal((await starlight.summary(user)).balance, before + 100);
  assert.equal((await starlight.redeem(user, 'dh-star-100')).code, 'already');
  const custom = await starlight.createCode({
    code: 'promo-vip-88', amount: 88, maxUses: 2, createdBy: 'test',
  });
  assert.equal(custom.ok, true);
  assert.equal(custom.code, 'PROMO-VIP-88');
  const taken = await starlight.createCode({
    code: 'PROMO-VIP-88', amount: 10, maxUses: 1, createdBy: 'test',
  });
  assert.equal(taken.ok, false);
  assert.equal(taken.code, 'taken');
  const other = 'd'.repeat(32);
  await starlight.ensure(other);
  assert.equal((await starlight.redeem(other, 'PROMO-VIP-88')).ok, true);
});
