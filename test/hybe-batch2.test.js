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
const voice2 = ['jungkook','taehyung','jimin','zhanghao','karina','wonyoung','wonbin','myungjaehyun','dohoon']; // batch10 voice-2 packs (open for launch)
const adults = ['sunghoon','niki','sunoo','jungwon','jimin','jungkook','taehyung','yeonjun','soobin','beomgyu','taehyun','hueningkai'];
const strict = ['martin','james','juhoon','seonghyeon','keonho'];
const batch1 = ['sehun','the8','jun','renjun','ningning','yuqi','shuhua','tzuyu','jacksonwang','layzhang'];
const deferred = [...batch1, ...adults, ...strict].filter(id => !isLaunch(id));
const opened = [...batch1, ...adults, ...strict].filter(isLaunch);
test('deferred batch packs remain valid and unavailable; launch packs are open; only approved packs are listed', () => {
  const list = chars.list();
  assert.deepEqual(opened, ['jimin','jungkook','taehyung']);
  for (const id of opened) {
    assert.equal(chars.isAvailable(id), true, id);
    assert.equal(chars.publicInfo(id).availabilityLabel, '', id);
  }
  for (const id of deferred) {
    assert.equal(packs.inspect(id).ok, true, id + ': ' + packs.inspect(id).error);
    assert.equal(chars.isAvailable(id), false, id);
    assert.equal(list.some(c => c.id === id), chars.isPublic(id), id);
    const info = chars.publicInfo(id);
    assert.ok(info, id);
    assert.equal(info.available, false);
    assert.equal(info.availabilityLabel, '暂未开放');
  }
  assert.equal(chars.isAvailable('baekhyun'), true);
  for (const id of ['kai','mark']) {
    assert.equal(packs.inspect(id).placeholder, true);
    assert.equal(chars.publicInfo(id).availabilityLabel, '');
  }
});
test('17 HYBE packs have JPEG art, fixtures, expected voices and age-appropriate prompts', () => {
  for (const id of [...adults, ...strict]) {
    const m = chars.loadMeta(id);
    for (const key of ['name','displayName','nameZh','nameRoman','company','group','gender','welcomeKo','welcomeZh','askNameKo','askNameZh','defaultUserName']) assert.ok(m[key], id + key);
    assert.ok(m.companyIds.includes('hybe'));
    const dir = path.join(chars.CHAR_DIR, id);
    assert.equal(chars.loadMeta(id).avatar, 'avatar.jpg');
    assert.equal(chars.publicInfo(id).portrait, `/characters/${id}/portrait.jpg?v=dh-pwa-13`);
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
    } else if (id === 'keonho') {
      assert.equal(pack.enabled, true);
      assert.equal(pack.lock.voiceId, '6KEnC1wm2MCbrIj7vXtU');
      assert.equal(pack.lock.version, 'keonho-voice-2');
      assert.equal(Object.hasOwn(pack.lock, 'placeholderVoice'), false);
    } else {
      assert.equal(pack.enabled, false);
      assert.equal(pack.lock.voiceId, '');
      assert.equal(pack.lock.placeholderVoice, 'male');
      assert.equal(pack.lock.version, `${id}-placeholder-voice-1`);
    }
    assert.equal(pack.lock.tags, 'keep');
    assert.deepEqual(pack.lock.pins, []);
    const fixture = require(`./fixtures/voice/${id}.json`);
    assert.equal(fixture.contentHash, voice.contentHash(id, pack.lock));
    assert.deepEqual(fixture.preparedSamples, pack.lock.samples.map(s => ({ id: s.id, text: pack.prepare(s.text, s.mood, pack.lock) })));
    assert.equal(age.policy(id).strict, strict.includes(id));
    const persona = fs.readFileSync(path.join(dir, 'persona.md'), 'utf8');
    if (strict.includes(id)) {
      assert.equal(m.ageVerified, false);
      assert.deepEqual(age.policy(id).allowedTiers, ['stranger','friend','close']);
      assert.doesNotMatch(persona, /### flirty/);
      const prompt = chars.buildPrompt(id, 'flirty', null, '朋友');
      assert.match(prompt, /^【最高优先级年龄安全规则】/);
      assert.doesNotMatch(prompt, /내 여자친구|둘만의 데이트|나도 사랑해/);
    } else {
      assert.ok(age.policy(id).allowedTiers.includes('flirty'));
      assert.match(persona, /### flirty/);
    }
    if (id !== 'keonho') assert.match(fs.readFileSync(path.join(dir, 'facts.md'), 'utf8'), /待人工核验/);
    assert.match(fs.readFileSync(path.join(dir, 'moments.json'), 'utf8'), /虚构日常/);
  }
});
test('each required file must both be listed and exist; failures stay isolated', () => {
  const id = 'zzbatch2manifest';
  const dir = path.join(chars.CHAR_DIR, id);
  assert.equal(fs.existsSync(dir), false);
  fs.mkdirSync(dir);
  try {
    for (const name of packs.REQUIRED_FILES) fs.copyFileSync(path.join(chars.CHAR_DIR, 'baekhyun', name), path.join(dir, name));
    const meta = JSON.parse(fs.readFileSync(path.join(dir,'character.json')));
    meta.id = id; meta.available = true;
    fs.writeFileSync(path.join(dir,'character.json'), JSON.stringify(meta));
    const manifest = { version: 1, files: [...packs.REQUIRED_FILES] };
    const save = m => fs.writeFileSync(path.join(dir,'manifest.json'), JSON.stringify(m));
    save(manifest);
    assert.equal(packs.inspect(id).online, true);
    for (const name of packs.REQUIRED_FILES) {
      save({ ...manifest, files: manifest.files.filter(f => f !== name) });
      assert.equal(packs.inspect(id).online, false, 'unlisted ' + name);
      save(manifest);
      const p = path.join(dir,name), body = fs.readFileSync(p);
      fs.unlinkSync(p);
      assert.equal(packs.inspect(id).online, false, 'missing ' + name);
      fs.writeFileSync(p, body);
      assert.equal(packs.inspect(id).online, true);
    }
    assert.equal(packs.inspect('baekhyun').online, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('actual chat and TTS middleware reject deferred packs before provider calls, offline', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-batch2-middleware-'));
  const previous = process.env.STORE_DATA_DIR;
  process.env.STORE_DATA_DIR = data;
  try {
    const app = require('../server').createApp();
    for (const route of ['/api/chat','/api/tts']) {
      const layer = app._router.stack.find(l => l.route && l.route.path === route && l.route.methods.post);
      const guard = layer.route.stack.find(l => l.handle.name === 'requireAvailable').handle;
      for (const id of deferred) {
        let status, body, passed = false;
        const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
        guard({ characterId: id, body: {} }, res, () => { passed = true; });
        assert.equal(passed, false, id + route);
        assert.equal(status, 404);
        assert.equal(body.error, 'character unavailable');
      }
      for (const id of ['baekhyun', ...opened]) expectGuard(assert, guard, id, route);
    }
  } finally {
    if (previous === undefined) delete process.env.STORE_DATA_DIR; else process.env.STORE_DATA_DIR = previous;
    fs.rmSync(data, { recursive: true, force: true });
  }
});
