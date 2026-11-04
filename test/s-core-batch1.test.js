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
const fixtureId = 'zzagebatch';
const fixtureDir = path.join(chars.CHAR_DIR, fixtureId);
let server, base, cookie;
test.before(async () => {
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'character.json'), JSON.stringify({ id: fixtureId, name: '年龄测试', ageVerified: true, minor: true, allowedTiers: ['stranger','friend','close','flirty'] }));
  fs.writeFileSync(path.join(fixtureDir, 'manifest.json'), JSON.stringify({ version: 1, files: ['character.json', 'persona.md'] }));
  fs.writeFileSync(path.join(fixtureDir, 'persona.md'), '测试角色');
  await store.init();

});
test.after(async () => {
  await store.flush({ shutdown: true });

  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});
test('ten complete adult packs open independently of unconfigured placeholder voices', () => {
  for (const id of ids) {
    const report = require('../lib/character-pack').inspect(id);
    assert.equal(report.online, true, report.error);
    const info = chars.publicInfo(id);
    assert.ok(info.allowedTiers.includes('flirty'));
    assert.ok(info.companyIds.length);
    assert.equal(info.voiceAvailable, false);
    assert.match(info.disclaimer, /并非本人声音/);
    const pack = voice.load(id);
    assert.equal(pack.ok, true, pack.error);
    assert.equal(pack.enabled, false);
    assert.equal(pack.lock.version, `${id}-placeholder-voice-1`);
    assert.deepEqual(pack.lock.pins, []);
    assert.equal(pack.lock.tags, 'keep');
    const fixture = require(`./fixtures/voice/${id}.json`);
    assert.equal(fixture.contentHash, pack.lock.contentHash);
    assert.equal(pack.prepare(pack.lock.samples[0].text), fixture.preparedSamples[0].text);
    assert.match(fixture.preparedSamples[0].text, /\[chuckles\]/);
    assert.throws(() => voice.buildRequest(pack, 'hello'), /not configured/);
    const configured = { ...pack, configuredVoiceId: 'test-generic-voice' };
    const request = voice.buildRequest(configured, 'hello');
    assert.match(request.endpoint, /test-generic-voice/);
    assert.notEqual(request.cacheKey, voice.buildRequest({ ...configured, characterId: 'other' }, 'hello').cacheKey);
    const p = path.join(chars.CHAR_DIR, id, 'voice', 'prepare.js');
    const original = fs.readFileSync(p);
    try { fs.appendFileSync(p, '\n'); assert.equal(voice.load(id).ok, false); }
    finally { fs.writeFileSync(p, original); }
    assert.equal(chars.isAvailable(id), true);
  }
  assert.deepEqual(chars.publicInfo('baekhyun').companyIds, ['inb100','sm']);
  assert.equal(chars.list().filter(c => c.companyIds.includes('inb100')).some(c => c.id === 'baekhyun'), true);
});
test('minor and unknown age clamp saved and computed tiers and override common prompt', () => {
  const user = 'c'.repeat(32);
  const old = { firstMetAt: Date.now() - 30 * 86400000, score: 999, tierId: 'flirty', totalTurns: 200 };
  store.putDoc('relationship', user, fixtureId, old);
  assert.equal(relationship.load(user, fixtureId).tierId, 'close');
  assert.equal(store.getDoc('relationship', user, fixtureId).tierId, 'close');
  assert.equal(relationship.view(old, Date.now(), fixtureId).tier.id, 'close');
  assert.equal(relationship.recordTurn(user, fixtureId).tier.id, 'close');
  assert.equal(age.policy('missing').strict, true);
  assert.equal(age.clamp('missing', 'flirty'), 'close');
  const prompt = chars.buildPrompt(fixtureId, 'flirty', old, '朋友');
  assert.match(prompt, /^【最高优先级年龄安全规则】/);
  assert.match(prompt, /禁止暧昧/);
  assert.doesNotMatch(prompt, /내 여자친구/);
});
