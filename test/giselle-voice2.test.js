'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { buildPrompt } = require('../lib/build-prompt');
const voice = require('../lib/voice-pack');
// Captured before the mood-table change, across every other character and tier.
const baseline = require('./fixtures/giselle-voice2-baseline.json');

test('every other character retains byte-identical prompts and voice hashes', () => {
  for (const [id, tiers] of Object.entries(baseline.prompts)) {
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

test('Giselle uses her own mood descriptions, default and audio tags', () => {
  const meta = require('../characters/giselle/character.json');
  const prompt = buildPrompt('giselle', 'flirty', {}, '테스트');
  assert.equal(meta.moods.length, 8);
  assert.deepEqual(meta.moods.map(m => m.key), Object.keys(meta.moodTags));
  for (const {key, descKo} of meta.moods) assert.ok(prompt.includes(`- ${key}: ${descKo}`), key);
  assert.ok(prompt.includes('"mood":"easygoing"'));
  for (const old of ['playful', '칭찬을 받으면 반드시 shy', '반드시 excited', '세 가지뿐']) assert.ok(!prompt.includes(old), old);
  for (const tag of Object.values(meta.moodTags)) {
    for (const token of tag.match(/\[[^\]]+\]/g)) assert.ok(prompt.includes(token), token);
  }
});

test('Giselle voice fixture matches all eight prepared samples and requests', () => {
  const pack = voice.load('giselle');
  const fixture = require('./fixtures/voice/giselle.json');
  assert.equal(pack.ok, true);
  assert.equal(pack.enabled, true);
  assert.equal(fixture.version, 'giselle-voice-2');
  assert.equal(fixture.contentHash, voice.contentHash('giselle', pack.lock));
  assert.equal(pack.lock.samples.length, 8);
  assert.deepEqual(fixture.preparedSamples, pack.lock.samples.map(s => ({id:s.id,text:pack.prepare(s.text,s.mood,pack.lock)})));
  assert.deepEqual(fixture.requests, pack.lock.samples.map(s => ({id:s.id,...voice.buildRequest(pack,s.text,s.mood)})));
});


test('Giselle has the eight revised tags and short untagged Korean samples', () => {
  const meta = require('../characters/giselle/character.json');
  const pack = voice.load('giselle');
  assert.equal(pack.ok, true);
  const tags = {
    easygoing: '[calm]',
    teasing: '[mischievously] [chuckles]',
    amused: '[chuckles softly]',
    reflective: '[thoughtful]',
    intimate: '[softly]',
    pleased: '[pleased]',
    deadpan: '[deadpan]',
    awkward: '[nervous laugh]',
  };
  assert.deepEqual(meta.moodTags, tags);
  assert.deepEqual(pack.lock.moodTags, tags);
  assert.equal(meta.defaultMood, 'easygoing');
  assert.equal(pack.lock.defaultMood, 'easygoing');
  assert.deepEqual(pack.lock.samples.map(s => s.mood), Object.keys(tags));
  assert.equal(new Set(pack.lock.samples.map(s => s.id)).size, 8);
  for (const sample of pack.lock.samples) {
    const syllables = (sample.text.match(/[가-힣]/g) || []).length;
    assert.ok(syllables >= 10 && syllables <= 25, `${sample.id}: ${syllables}`);
    assert.ok(!/[\[\]]/.test(sample.text), sample.id);
  }
  assert.ok(pack.lock.samples.find(s => s.mood === 'reflective').text.includes('음…'));
});
