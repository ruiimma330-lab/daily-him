'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-batch1-'));
process.env.STORE_DATA_DIR = data;
process.env.SESSION_SECRET = 'batch1-test-session-secret-123456789';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
const chars = require('../lib/characters');
const voice = require('../lib/voice-pack');
const age = require('../lib/age-policy');
const relationship = require('../lib/relationship');
const store = require('../lib/store');
const { isLaunch } = require('./helpers/launch10');
const ids = ['sehun','the8','jun','renjun','ningning','yuqi','shuhua','tzuyu','jacksonwang','layzhang'];
const fixtureId = 'zzagebatchapi';
const fixtureDir = path.join(chars.CHAR_DIR, fixtureId);
let server, base, cookie;
test.before(async () => {
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'character.json'), JSON.stringify({ id: fixtureId, name: '年龄测试', ageVerified: true, minor: true, allowedTiers: ['stranger','friend','close','flirty'] }));
  fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), JSON.stringify({ version: 1, files: ['character.json', 'persona.md'] }));
  fs.writeFileSync(path.join(fixtureDir, 'persona.md'), '测试角色');
  require('./helpers/complete-pack')(fixtureDir);
  await store.init();
  server = require('../server').createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'batch1tester', password: 'password123', age14: true }) });
  cookie = r.headers.get('set-cookie').match(/sid=[^;]+/)[0];

});
test.after(async () => {
  await store.flush({ shutdown: true });
  if (server && server.listening) await new Promise(resolve => server.close(resolve));

  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});
test('HTTP denies tier escalation, serves SVGs and rejects unavailable characters', async () => {
  for (const route of ['/api/chat','/api/tts']) {
    const r = await fetch(base + route + '?characterId=' + fixtureId, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ tierId: 'flirty', text: 'hello' }) });
    assert.equal(r.status, 403);
  }
  for (const suffix of ['avatar','portrait.jpg']) {
    const r = await fetch(base + '/characters/sehun/' + suffix, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /jpeg/);
  }
  const tts = await fetch(base + '/api/tts?characterId=sehun', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  assert.equal(tts.status, 404);
  const scenes = await fetch(base + '/api/scenes?characterId=sehun', { headers: { Cookie: cookie } });
  assert.equal(scenes.status, 404);
});

test('picker lists retained deferred characters and chat/TTS reject them while Baekhyun passes availability', async () => {
  const batch2 = ['sunghoon','niki','sunoo','jungwon','jimin','jungkook','taehyung','yeonjun','soobin','beomgyu','taehyun','hueningkai','martin','james','juhoon','seonghyeon','keonho'];
  const listing = await fetch(base + '/api/characters', { headers: { Cookie: cookie } });
  assert.equal(listing.status, 200);
  const data = await listing.json();
  for (const id of [...ids, ...batch2]) {
    const info = data.characters.find(c => c.id === id);
    assert.equal(Boolean(info), chars.isPublic(id), id);
    if (!info) continue;
    if (isLaunch(id)) {
      // jimin / jungkook / taehyung are open for the 10-person launch.
      assert.equal(info.available, true, id);
      assert.equal(info.availabilityLabel, '');
      continue;
    }
    assert.equal(info.available, false);
    assert.equal(info.availabilityLabel, '暂未开放');
    for (const route of ['/api/chat', '/api/tts']) {
      const r = await fetch(base + route, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: id, text: 'hello', voice: false }) });
      assert.equal(r.status, 404, id + route);
      assert.equal((await r.json()).error, 'character unavailable');
    }
  }
  assert.equal(data.characters.find(c => c.id === 'baekhyun').available, true);
  // Empty input reaches chat validation after the availability middleware, without calling any provider.
  const r = await fetch(base + '/api/chat', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'baekhyun', messages: [] }) });
  assert.equal(r.status, 400);
  assert.notEqual((await r.json()).error, 'character unavailable');
});

 test('discovery excludes archived packs; account history remains reachable and isolated', async () => {
  const expected = require('../config/public-roster.json');
  const get = (route, auth = cookie) => fetch(base + route, { headers: { Cookie: auth } });
  const listing = await (await get('/api/characters')).json();
  assert.deepEqual(listing.characters.map(ch => ch.id).sort(), [...expected].sort());
  const me = await (await get('/api/me')).json();
  const messages = [{ role: 'user', text: '历史消息', time: Date.now() }];
  store.putHistory(me.user.id, 'anton', messages);
  const saved = store.getHistory(me.user.id, 'anton');
  const histories = await (await get('/api/conversations')).json();
  assert.deepEqual(histories.conversations.map(ch => ch.id), ['anton']);
  const history = await get('/api/history?characterId=anton');
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).messages, saved);
  assert.deepEqual(store.getHistory(me.user.id, 'anton'), saved);
  const registration = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'rosterother', password: 'password123', age14: true }) });
  const other = registration.headers.get('set-cookie').match(/sid=[^;]+/)[0];
  assert.deepEqual((await (await get('/api/conversations', other)).json()).conversations, []);
  assert.equal((await get('/api/history?characterId=anton', other)).status, 404);
});
