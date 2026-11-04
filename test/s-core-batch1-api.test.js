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
const ids = ['sehun','the8','jun','renjun','ningning','yuqi','shuhua','tzuyu','jacksonwang','layzhang'];
const fixtureId = 'zzagebatchapi';
const fixtureDir = path.join(chars.CHAR_DIR, fixtureId);
let server, base, cookie;
test.before(async () => {
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'character.json'), JSON.stringify({ id: fixtureId, name: '年龄测试', ageVerified: true, minor: true, allowedTiers: ['stranger','friend','close','flirty'] }));
  fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), JSON.stringify({ version: 1, files: ['character.json', 'persona.md'] }));
  fs.writeFileSync(path.join(fixtureDir, 'persona.md'), '测试角色');
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
test('HTTP denies tier escalation, serves SVGs, disables TTS while keeping text endpoints open', async () => {
  for (const route of ['/api/chat','/api/tts']) {
    const r = await fetch(base + route + '?characterId=' + fixtureId, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ tierId: 'flirty', text: 'hello' }) });
    assert.equal(r.status, 403);
  }
  for (const suffix of ['avatar','portrait.svg']) {
    const r = await fetch(base + '/characters/sehun/' + suffix, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /svg/);
  }
  const tts = await fetch(base + '/api/tts?characterId=sehun', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  assert.equal(tts.status, 503);
  const scenes = await fetch(base + '/api/scenes?characterId=sehun', { headers: { Cookie: cookie } });
  assert.equal(scenes.status, 200);
});
