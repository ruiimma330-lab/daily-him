'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { buildPrompt } = require('../lib/build-prompt');
const voice = require('../lib/voice-pack');
const chars = require('../lib/characters');
// Captured before the voice-2 change, across every other character and tier.
const baseline = require('./fixtures/batch10-voice2-baseline.json');
const voiceIds = {
  jungkook: '5fd8fda12193470f96153288210c4f2a',
  taehyung: '164f558a941a4d1db4620f90ca6f954f',
  jimin: 'qFXWyEzH208iC0VGeu1p',
  zhanghao: '6Lbvo0Mhoi76A1Cjsrtt',
  karina: '3720mcZIsm2L1TgRNjxU',
  wonyoung: 'CQsxAisrNbwF3bKufT9U',
  wonbin: '2RLkFWqg37l6O4F9kz1J',
  myungjaehyun: 'MK090xTm93AZXdILmI6C',
  dohoon: 'MSahSHbNx0vA7BIFnopC',
};
const ids = Object.keys(voiceIds);

test('every other character retains byte-identical prompts and voice hashes', () => {
  for (const id of ids) {
    assert.equal(Object.hasOwn(baseline.prompts, id), false, id);
    assert.equal(Object.hasOwn(baseline.voiceHashes, id), false, id);
  }
  assert.ok(Object.keys(baseline.prompts).length > 80);
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
  assert.equal(voice.load('baekhyun').lock.version, 'baekhyun-voice-1');
});

for (const id of ids) {
  test(`${id} uses its own moods, voice-2 pack and is open for launch`, () => {
    const meta = JSON.parse(fs.readFileSync(`characters/${id}/character.json`));
    const prevFishKey = process.env.FISH_AUDIO_API_KEY;
    const prevFishModel = process.env.FISH_AUDIO_MODEL;
    if (meta.ttsProvider === 'fish' && !prevFishKey) {
      process.env.FISH_AUDIO_API_KEY = 'test-fish-key';
    }
    if (meta.ttsProvider === 'fish') {
      delete process.env.FISH_AUDIO_MODEL;
    }
    try {
      const pack = voice.load(id);
      const fixture = JSON.parse(fs.readFileSync(`test/fixtures/voice/${id}.json`));
      const keys = meta.moods.map(m => m.key);
      assert.ok(keys.length >= 7 && keys.length <= 8, id);
      assert.deepEqual(keys, Object.keys(meta.moodTags));
      assert.ok(keys.includes(meta.defaultMood));
      for (const tier of ['stranger', 'friend', 'close', 'flirty']) {
        const prompt = buildPrompt(id, tier, {}, '테스트');
        for (const {key, descKo} of meta.moods) assert.ok(prompt.includes(`- ${key}: ${descKo}`), `${id}/${key}`);
        assert.ok(prompt.includes(`"mood":"${meta.defaultMood}"`));
        for (const tag of Object.values(meta.moodTags)) {
          for (const token of tag.match(/\[[^\]]+\]/g)) assert.ok(prompt.includes(token), token);
        }
      }
      // Opened for the 10-person launch (group picker PR); persona text is untouched.
      assert.equal(meta.available, true);
      assert.equal(Object.hasOwn(meta, 'availabilityLabel'), false);
      assert.equal(chars.isAvailable(id), true);
      assert.equal(chars.publicInfo(id).availabilityLabel, '');
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(`characters/${id}/persona.md`)).digest('hex'), baseline.personaHashes[id]);

      assert.equal(pack.ok, true, pack.error);
      assert.equal(pack.enabled, true);
      assert.equal(pack.lock.version, `${id}-voice-2`);
      assert.equal(fixture.version, pack.lock.version);
      assert.equal(pack.lock.contentHash, voice.contentHash(id, pack.lock));
      assert.equal(fixture.contentHash, pack.lock.contentHash);
      assert.equal(pack.lock.voiceId, voiceIds[id]);
      assert.equal(meta.voiceId, voiceIds[id]);
      if (pack.provider === 'fish') {
        assert.equal(pack.lock.model, 's2.1-pro-free');
        assert.equal(meta.ttsModel, 's2.1-pro-free');
        assert.equal(meta.ttsProvider, 'fish');
      } else {
        assert.equal(pack.lock.model, 'eleven_v3');
        assert.equal(meta.ttsModel, 'eleven_v3');
      }
      assert.equal(pack.lock.outputFormat, 'mp3_44100_128');
      assert.deepEqual(pack.lock.voiceSettings, {stability: 0, similarity_boost: 0.85});
      assert.deepEqual(meta.voiceSettings, pack.lock.voiceSettings);
      assert.equal(Object.hasOwn(meta, 'placeholderVoice'), false);
      assert.equal(Object.hasOwn(pack.lock, 'placeholderVoice'), false);
      assert.equal(pack.lock.speechPrefix, '');
      assert.equal(pack.lock.tags, 'keep');
      assert.deepEqual(pack.lock.pins, []);
      assert.equal(pack.lock.defaultMood, meta.defaultMood);
      assert.deepEqual(pack.lock.moodTags, meta.moodTags);
      assert.deepEqual(pack.lock.samples.map(s => s.mood), keys);
      assert.deepEqual(pack.lock.samples.map(s => s.id), keys.map(k => `${k}_01`));
      assert.deepEqual(fixture.preparedSamples, pack.lock.samples.map(s => ({id:s.id,text:pack.prepare(s.text,s.mood,pack.lock)})));
      assert.deepEqual(fixture.requests, pack.lock.samples.map(s => ({id:s.id,...voice.buildRequest(pack,s.text,s.mood)})));
      for (const s of pack.lock.samples) {
        assert.doesNotMatch(s.text, /[\[\]]/);
        assert.equal(pack.prepare(s.text, s.mood, pack.lock), `${meta.moodTags[s.mood]} ${s.text}`);
      }
      const fallback = meta.moodTags[meta.defaultMood];
      assert.equal(pack.prepare('안녕.', 'unknown', pack.lock), `${fallback} 안녕.`);
      assert.equal(pack.prepare('안녕.', undefined, pack.lock), `${fallback} 안녕.`);
    } finally {
      if (prevFishKey === undefined) delete process.env.FISH_AUDIO_API_KEY;
      else process.env.FISH_AUDIO_API_KEY = prevFishKey;
      if (prevFishModel === undefined) delete process.env.FISH_AUDIO_MODEL;
      else process.env.FISH_AUDIO_MODEL = prevFishModel;
    }
  });
}
