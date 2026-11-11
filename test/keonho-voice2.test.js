'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { buildPrompt } = require('../lib/build-prompt');
const voice = require('../lib/voice-pack');
const age = require('../lib/age-policy');
const chars = require('../lib/characters');
const baseline = require('./fixtures/keonho-voice2-baseline.json');
const tags = {
  low_tide: '[calm]',
  word_search: '[thoughtful]',
  warm_check: '[softly]',
  dry_return: '[deadpan]',
  sleeve_smile: '[chuckles]',
  small_spark: '[pleased]',
  hesitant_landing: '[nervous laugh]',
};

test('every other character retains byte-identical prompts and voice hashes', () => {
  assert.equal(Object.hasOwn(baseline.prompts, 'keonho'), false);
  assert.equal(Object.hasOwn(baseline.voiceHashes, 'keonho'), false);
  for (const [id, tiers] of Object.entries(baseline.prompts)) {
    assert.deepEqual(Object.keys(tiers), ['stranger', 'friend', 'close', 'flirty']);
    for (const [tier, expected] of Object.entries(tiers)) {
      const actual = crypto.createHash('sha256').update(buildPrompt(id, tier, {}, '테스트')).digest('hex');
      assert.equal(actual, expected, `${id}/${tier}`);
    }
  }
  for (const [id, expected] of Object.entries(baseline.voiceHashes)) {
    const lock = JSON.parse(fs.readFileSync(voice.lockPath(id)));
    assert.equal(lock.contentHash, expected, id);
    assert.equal(voice.contentHash(id, lock), expected, id);
  }
});

test('Keonho uses seven own moods and remains unavailable with strict age policy', () => {
  const meta = require('../characters/keonho/character.json');
  assert.equal(meta.moods.length, 7);
  assert.deepEqual(meta.moods.map(m => m.key), Object.keys(tags));
  assert.deepEqual(meta.moodTags, tags);
  assert.equal(meta.defaultMood, 'low_tide');
  for (const tier of ['stranger', 'friend', 'close', 'flirty']) {
    const prompt = buildPrompt('keonho', tier, {}, '테스트');
    assert.match(prompt, /^【最高优先级年龄安全规则】/);
    for (const {key, descKo} of meta.moods) assert.ok(prompt.includes(`- ${key}: ${descKo}`), key);
    assert.ok(prompt.includes('"mood":"low_tide"'));
    for (const tag of Object.values(tags)) assert.ok(prompt.includes(tag), tag);
    assert.doesNotMatch(prompt, /\[hesitant\]/);
  }
  assert.equal(meta.available, false);
  assert.equal(meta.availabilityLabel, '暂未开放');
  assert.equal(chars.isAvailable('keonho'), false);
  assert.equal(chars.isPublic('keonho'), false);
  assert.equal(meta.birthDate, null);
  assert.equal(meta.ageVerified, false);
  assert.equal(meta.minor, null);
  assert.equal(meta.ageVerificationBasis, '年龄未核实；按用户要求CORTIS全员严格模式');
  assert.equal(meta.avatar, 'avatar.jpg');
  assert.equal(meta.portrait, '/characters/keonho/portrait.jpg');
  assert.equal(age.policy('keonho').strict, true);
  assert.deepEqual(meta.allowedTiers, ['stranger', 'friend', 'close']);
  assert.deepEqual(age.policy('keonho').allowedTiers, meta.allowedTiers);
  assert.equal(age.clamp('keonho', 'flirty'), 'close');
  assert.doesNotMatch(fs.readFileSync('characters/keonho/persona.md', 'utf8'), /### flirty/);
});

test('Keonho voice fixture matches seven prepared samples and offline requests', () => {
  const meta = require('../characters/keonho/character.json');
  const pack = voice.load('keonho');
  const fixture = require('./fixtures/voice/keonho.json');
  assert.equal(pack.ok, true);
  assert.equal(pack.enabled, true);
  assert.equal(fixture.characterId, 'keonho');
  assert.equal(fixture.enabled, true);
  assert.equal(fixture.version, 'keonho-voice-2');
  assert.equal(pack.lock.version, fixture.version);
  assert.equal(pack.lock.contentHash, voice.contentHash('keonho', pack.lock));
  assert.equal(fixture.contentHash, pack.lock.contentHash);
  assert.equal(pack.lock.voiceId, '6KEnC1wm2MCbrIj7vXtU');
  assert.equal(meta.voiceId, pack.lock.voiceId);
  assert.equal(pack.lock.model, 'eleven_v3');
  assert.equal(meta.ttsModel, pack.lock.model);
  assert.equal(pack.lock.outputFormat, 'mp3_44100_128');
  assert.deepEqual(pack.lock.voiceSettings, {stability: 0, similarity_boost: 0.85});
  assert.deepEqual(meta.voiceSettings, pack.lock.voiceSettings);
  assert.equal(Object.hasOwn(meta, 'placeholderVoice'), false);
  assert.equal(Object.hasOwn(pack.lock, 'placeholderVoice'), false);
  assert.equal(pack.lock.speechPrefix, '');
  assert.equal(pack.lock.tags, 'keep');
  assert.deepEqual(pack.lock.pins, []);
  assert.equal(pack.lock.defaultMood, 'low_tide');
  assert.deepEqual(pack.lock.moodTags, tags);
  assert.equal(pack.lock.samples.length, 7);
  assert.deepEqual(pack.lock.samples.map(s => s.mood), Object.keys(tags));
  assert.deepEqual(pack.lock.samples.map(s => s.id), Object.keys(tags).map(key => `${key}_01`));
  assert.deepEqual(fixture.preparedSamples, pack.lock.samples.map(s => ({id:s.id,text:pack.prepare(s.text,s.mood,pack.lock)})));
  assert.deepEqual(fixture.requests, pack.lock.samples.map(s => ({id:s.id,...voice.buildRequest(pack,s.text,s.mood)})));
  for (const sample of pack.lock.samples) {
    const syllables = (sample.text.match(/[가-힣]/g) || []).length;
    assert.ok(syllables >= 10 && syllables <= 25, `${sample.id}: ${syllables}`);
    assert.doesNotMatch(sample.text, /[\[\]]/);
    assert.equal(pack.prepare(sample.text, sample.mood, pack.lock), `${tags[sample.mood]} ${sample.text}`);
  }
  assert.equal(pack.prepare('안녕.', 'unknown', pack.lock), '[calm] 안녕.');
  assert.equal(pack.prepare('안녕.', undefined, pack.lock), '[calm] 안녕.');
});
