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
const report = require('../batch6-age-report.json');
const voice2 = ['jungkook','taehyung','jimin','zhanghao','karina','wonyoung','wonbin','myungjaehyun','dohoon']; // batch10 voice-2 packs (open for launch)
const ids = ['chaeunwoo','gdragon','taemin','juyeon','anxin','xinlong','sangwon','ricky','zhanghao','gyuvin','hanyujin'];

test('batch6 packs remain complete (zhanghao open for launch, the rest deferred); discovery follows the approved roster', () => {
  assert.deepEqual(report.map(r => r.id), ids);
  const visible = chars.list();
  for (const id of ids) {
    const dir = path.join(chars.CHAR_DIR, id);
    assert.equal(packs.inspect(id).ok, true, id);
    const meta = chars.loadMeta(id);
    for (const key of ['name','displayName','nameZh','nameRoman','company','group','gender','welcomeKo','welcomeZh','askNameKo','askNameZh','defaultUserName']) assert.ok(meta[key], `${id}:${key}`);
    assert.ok(meta.companyIds.length);
    assert.equal(visible.some(c => c.id === id), chars.isPublic(id), id);
    const info = chars.publicInfo(id);
    assert.ok(info, id);
    assert.equal(info.available, isLaunch(id), id);
    assert.equal(info.availabilityLabel, isLaunch(id) ? '' : '暂未开放');
    assert.equal(chars.loadMeta(id).avatar, 'avatar.jpg');
    assert.equal(chars.publicInfo(id).portrait, `/characters/${id}/portrait.jpg?v=dh-pwa-17`);
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
    } else {
      assert.equal(pack.lock.voiceId, '');
      assert.equal(pack.lock.placeholderVoice, 'male');
      assert.equal(pack.lock.version, `${id}-placeholder-voice-1`);
    }
    assert.deepEqual(pack.lock.pins, []);
    assert.equal(pack.lock.tags, 'keep');
    const fixture = require(`./fixtures/voice/${id}.json`);
    assert.equal(fixture.contentHash, voice.contentHash(id, pack.lock));
    assert.deepEqual(fixture.preparedSamples, pack.lock.samples.map(s => ({id:s.id,text:pack.prepare(s.text,s.mood,pack.lock)})));
    if (!voice2.includes(id)) {
      assert.match(fixture.preparedSamples[0].text, /\[chuckles\]/);
      assert.throws(() => voice.buildRequest({...pack,configuredVoiceId:''},'안녕'), /not configured/);
      assert.match(voice.buildRequest({...pack,configuredVoiceId:'offline-placeholder'},'안녕').endpoint,/offline-placeholder/);
    }
    assert.match(fs.readFileSync(path.join(dir,'facts.md'),'utf8'),/待人工核验/);
    const moments = JSON.parse(fs.readFileSync(path.join(dir,'moments.json'),'utf8'));
    for (const post of moments.posts) {
      assert.match(post.zh,/虚构日常/);
      assert.match(post.ko,/허구의 일상/);
      assert.deepEqual(post.images,[]);
    }
  }
  assert.equal(chars.loadMeta('gdragon').company, 'Galaxy Corporation');
  assert.equal(chars.loadMeta('juyeon').company, '78 Records（团体）');
});

test('age decisions agree with metadata and strict prompts override requested flirty tier', () => {
  for (const row of report) {
    const meta = chars.loadMeta(row.id);
    const persona = fs.readFileSync(path.join(chars.CHAR_DIR,row.id,'persona.md'),'utf8');
    assert.equal(age.policy(row.id).strict, row.strict, row.id);
    if (row.strict) {
      assert.equal(meta.ageVerified,false);
      assert.equal(meta.birthDate,null);
      assert.deepEqual(age.policy(row.id).allowedTiers,['stranger','friend','close']);
      assert.equal(age.clamp(row.id,'flirty'),'close');
      assert.doesNotMatch(persona,/### flirty/);
      const prompt = chars.buildPrompt(row.id,'flirty',null,'朋友');
      assert.match(prompt,/^【最高优先级年龄安全规则】/);
      assert.match(prompt,/仅限朋友式/);
      assert.doesNotMatch(prompt,/내 여자친구|### flirty/);
      assert.match(prompt,/熟悉的朋友式|熟悉队友/);
    } else {
      assert.equal(meta.ageVerified,true);
      assert.equal(meta.minor,false);
      const adult = new Date(meta.birthDate); adult.setUTCFullYear(adult.getUTCFullYear()+18);
      assert.ok(adult <= new Date('2026-11-01'),row.id);
      assert.equal(age.clamp(row.id,'flirty'),'flirty');
      for (const tier of ['stranger','friend','close','flirty']) assert.ok(persona.includes(`### ${tier}`));
    }
  }
});

test('real route guards reject batch6 and batch1 packs without opening a listening socket', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'idol-batch6-'));
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = tmp;
  try {
    const app = require('../server').createApp();
    const deferred = [...ids,'sehun','the8','jun','renjun','ningning','yuqi','shuhua','tzuyu','jacksonwang','layzhang'];
    for (const routePath of ['/api/chat','/api/tts','/api/scenes','/api/moments']) {
      const route = app._router.stack.find(l => l.route && l.route.path === routePath).route;
      const guard = route.stack.find(l => l.handle.name === 'requireAvailable').handle;
      for (const id of [...deferred, 'baekhyun']) expectGuard(assert, guard, id, routePath);
    }
    // GET /api/history is read-only: it lets an account reopen its own existing chats even when the
    // character is closed, and otherwise falls back to requireAvailable (see group-picker.test.js).
    const history = app._router.stack.find(l => l.route && l.route.path === '/api/history' && l.route.methods.get).route;
    assert.ok(history.stack.some(l => l.handle.name === 'allowHistoryRead'));
    const put = app._router.stack.find(l => l.route && l.route.path === '/api/history' && l.route.methods.put).route;
    assert.ok(put.stack.some(l => l.handle.name === 'requireAvailable'));
    const del = app._router.stack.find(l => l.route && l.route.path === '/api/history' && l.route.methods.delete).route;
    assert.ok(del.stack.some(l => l.handle.name === 'allowHistoryDelete'));
    assert.equal(del.stack.some(l => l.handle.name === 'requireAvailable'), false);
    for (const id of ['kai','mark']) assert.equal(chars.publicInfo(id).availabilityLabel,'');
  } finally {
    if (previous === undefined) delete process.env.STORE_DATA_DIR; else process.env.STORE_DATA_DIR=previous;
    fs.rmSync(tmp,{recursive:true,force:true});
  }
});
