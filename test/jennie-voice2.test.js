'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { buildPrompt } = require('../lib/build-prompt');
const voice = require('../lib/voice-pack');
const age = require('../lib/age-policy');
const chars = require('../lib/characters');
const baseline = require('./fixtures/jennie-voice2-baseline.json');
const tags = {
  "rain_window": "[calm]",
  "question_murmur": "[thoughtful]",
  "hair_tuck": "[nervous laugh]",
  "pout_nudge": "[mischievously]",
  "tiny_applause": "[pleased]",
  "clear_velvet": "[calm]",
  "blank_sigh": "[deadpan]",
  "sister_pause": "[softly]"
};

test('every other character retains byte-identical prompts and voice hashes', () => {
  assert.equal(Object.hasOwn(baseline.prompts, 'jennie'), false);
  assert.equal(Object.hasOwn(baseline.voiceHashes, 'jennie'), false);
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

test('Jennie uses eight own moods, flirty enabled, back to 待开放 for the 10-person launch', () => {
  const meta = require('../characters/jennie/character.json');
  assert.equal(meta.moods.length, 8);
  assert.deepEqual(meta.moods.map(m => m.key), Object.keys(tags));
  assert.deepEqual(meta.moodTags, tags);
  assert.deepEqual(Object.keys(tags).filter(key => tags[key] === '[calm]'), ['rain_window', 'clear_velvet']);
  assert.equal(meta.defaultMood, 'rain_window');
  for (const tier of ['stranger', 'friend', 'close', 'flirty']) {
    const prompt = buildPrompt('jennie', tier, {}, '테스트');
    for (const {key, descKo} of meta.moods) assert.ok(prompt.includes(`- ${key}: ${descKo}`), key);
    assert.ok(prompt.includes('"mood":"rain_window"'));
    for (const tag of Object.values(tags)) assert.ok(prompt.includes(tag), tag);
    assert.doesNotMatch(prompt, /\[hesitant\]/);
  }
  assert.equal(meta.available, false);
  assert.equal(meta.availabilityLabel, '暂未开放');
  assert.equal(chars.isAvailable('jennie'), false);
  assert.equal(chars.isPublic('jennie'), true);
  assert.equal(meta.birthDate, '1996-01-16');
  assert.equal(meta.ageVerified, true);
  assert.equal(meta.minor, false);
  assert.equal(age.policy('jennie').strict, false);
  assert.deepEqual(meta.allowedTiers, ['stranger', 'friend', 'close', 'flirty']);
  assert.equal(age.clamp('jennie', 'flirty'), 'flirty');
  const persona = fs.readFileSync('characters/jennie/persona.md');
  assert.match(persona.toString(), /### flirty/);
  assert.equal(crypto.createHash('sha256').update(persona).digest('hex'), baseline.personaHash);
});

test('Jennie voice fixture matches eight prepared samples and offline requests', () => {
  const meta = require('../characters/jennie/character.json');
  const pack = voice.load('jennie');
  const fixture = require('./fixtures/voice/jennie.json');
  assert.equal(pack.ok, true);
  assert.equal(pack.enabled, true);
  assert.equal(fixture.characterId, 'jennie');
  assert.equal(fixture.enabled, true);
  assert.equal(fixture.version, 'jennie-voice-2');
  assert.equal(pack.lock.version, fixture.version);
  assert.equal(pack.lock.contentHash, voice.contentHash('jennie', pack.lock));
  assert.equal(fixture.contentHash, pack.lock.contentHash);
  assert.equal(pack.lock.voiceId, 'on8L60PoQoe0cAf9QzqR');
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
  assert.equal(pack.lock.defaultMood, 'rain_window');
  assert.deepEqual(pack.lock.moodTags, tags);
  assert.equal(pack.lock.samples.length, 8);
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
  assert.doesNotMatch(pack.lock.samples.find(s => s.mood === 'tiny_applause').text, /박수|拍手|clap/i);
  assert.equal(pack.prepare('안녕.', 'unknown', pack.lock), '[calm] 안녕.');
  assert.equal(pack.prepare('안녕.', undefined, pack.lock), '[calm] 안녕.');
});
