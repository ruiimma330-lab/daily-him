'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const chars = require('../lib/characters');
const packs = require('../lib/character-pack');
const voice = require('../lib/voice-pack');
const age = require('../lib/age-policy');
const { isLaunch, expectGuard } = require('./helpers/launch10');
const report = require('../batch4-age-report.json');
const voice2 = ['jungkook','taehyung','jimin','zhanghao','karina','wonyoung','wonbin','myungjaehyun','dohoon']; // batch10 voice-2 packs (open for launch)
const ids = ["jeno", "jaemin", "jisung", "haechan", "chenle", "yushi", "sakuya", "riku", "sion", "wonbin", "anton", "sungchan", "karina", "winter", "giselle", "nct-jaehyun", "ten", "chanyeol", "irene"];

test('19 complete packs are visible (karina/wonbin open, giselle back to deferred), with adult policy and valid voice locks', () => {
  assert.deepEqual(report.map(r => r.id), ids);
  for (const id of ids) {
    const dir = path.join(chars.CHAR_DIR, id);
    assert.equal(packs.inspect(id).ok, true, id);
    const meta = chars.loadMeta(id);
    for (const key of ['name','displayName','nameZh','nameRoman','company','group','gender','welcomeKo','welcomeZh','askNameKo','askNameZh','defaultUserName']) assert.ok(meta[key], id + ':' + key);
    assert.ok(meta.companyIds.includes('sm'));
    assert.equal(chars.resolveId(id), id);
    const publicInfo = chars.publicInfo(id);
    if (isLaunch(id)) {
      assert.equal(publicInfo.available, true, id);
      assert.equal(publicInfo.availabilityLabel, '');
    } else {
      assert.equal(publicInfo.available, false);
      assert.equal(publicInfo.availabilityLabel, '暂未开放');
    }
    assert.equal(age.policy(id).strict, false);
    assert.deepEqual(age.policy(id).allowedTiers, ['stranger','friend','close','flirty']);
    const adultDate = new Date(meta.birthDate); adultDate.setUTCFullYear(adultDate.getUTCFullYear() + 18);
    assert.ok(adultDate <= new Date('2026-11-01'));
    assert.match(fs.readFileSync(path.join(dir,'persona.md'),'utf8'), /### flirty/);
    assert.match(fs.readFileSync(path.join(dir,'facts.md'),'utf8'), /待人工核验/);
    assert.match(fs.readFileSync(path.join(dir,'moments.json'),'utf8'), /虚构日常/);
    assert.equal(chars.loadMeta(id).avatar, 'avatar.jpg');
    assert.equal(chars.publicInfo(id).portrait, `/characters/${id}/portrait.jpg?v=dh-pwa-21`);
    for (const asset of ['avatar.jpg','portrait.jpg']) {
      const file = path.join(dir, asset);
      assert.ok(fs.existsSync(file), `${id}/${asset}`);
      assert.deepEqual(fs.readFileSync(file).subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]), `${id}/${asset}`);
    }
    const pack = voice.load(id);
    assert.equal(pack.ok, true, id);
    if (voice2.includes(id)) {
      assert.equal(pack.enabled, true);
      assert.equal(pack.lock.version, `${id}-voice-2`);
      assert.equal(pack.lock.model, 'eleven_v3');
      assert.equal(Object.hasOwn(pack.lock, 'placeholderVoice'), false);
    } else if (id === 'giselle') {
      assert.equal(pack.enabled, true);
      assert.equal(pack.lock.version, 'giselle-voice-2');
      assert.equal(pack.lock.voiceId, 'qSzKWGBeVKcNKj2uo6U3');
      assert.equal(pack.lock.model, 'eleven_v3');
      assert.equal(pack.lock.placeholderVoice, undefined);
      assert.equal(meta.placeholderVoice, undefined);
      assert.equal(publicInfo.disclaimer.includes('占位'), false);
    } else {
      assert.equal(pack.enabled, false);
      assert.equal(pack.lock.voiceId, '');
      assert.equal(pack.lock.placeholderVoice, meta.gender);
      assert.equal(pack.lock.version, `${id}-placeholder-voice-1`);
    }
    assert.equal(pack.lock.tags, 'keep');
    assert.deepEqual(pack.lock.pins, []);
    const fixture = require(`./fixtures/voice/${id}.json`);
    assert.equal(fixture.contentHash, voice.contentHash(id,pack.lock));
    assert.deepEqual(fixture.preparedSamples, pack.lock.samples.map(s => ({id:s.id,text:pack.prepare(s.text,s.mood,pack.lock)})));
    if (id !== 'giselle' && !voice2.includes(id)) {
      assert.match(fixture.preparedSamples[0].text, /\[chuckles\]/);
      assert.throws(() => voice.buildRequest(pack, 'hello'), /not configured/);
      const configured = {...pack,configuredVoiceId:'offline-placeholder'};
      assert.match(voice.buildRequest(configured,'hello').endpoint, /offline-placeholder/);
    }
  }
});

test('chat and TTS reject deferred batch4 packs (now including giselle) through actual middleware without listening', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-batch4-'));
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = data;
  try {
    const app = require('../server').createApp();
    for (const route of ['/api/chat','/api/tts']) {
      const layer = app._router.stack.find(l => l.route && l.route.path === route && l.route.methods.post);
      const guard = layer.route.stack.find(l => l.handle.name === 'requireAvailable').handle;
      // giselle went back to 待开放 for the 10-person launch; karina and wonbin are open.
      assert.equal(isLaunch('giselle'), false);
      for (const id of [...ids, 'baekhyun']) expectGuard(assert, guard, id, route);
    }
    for (const id of ['kai','mark']) assert.equal(chars.publicInfo(id).availabilityLabel,'');
  } finally {
    if (previous === undefined) delete process.env.STORE_DATA_DIR; else process.env.STORE_DATA_DIR = previous;
    fs.rmSync(data,{recursive:true,force:true});
  }
});
