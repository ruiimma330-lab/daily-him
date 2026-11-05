const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-voice-pack-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
delete process.env.MOMENTS_ADMINS;
delete process.env.ADMINS;
delete process.env.VOICE_ID;
delete process.env.TTS_MODEL;
process.env.DEEPSEEK_CHAT_API_KEY = 'test-chat-key';
process.env.ELEVENLABS_API_KEY = 'test-voice-key';

const voicePack = require('../lib/voice-pack');
const voiceExec = require('../lib/voice-exec');
const characters = require('../lib/characters');
const store = require('../lib/store');
const { createApp } = require('../server');

// Approved package. A voice change updates this version and contentHash,
// characters/<id>/voice/voice.lock.json, and test/fixtures/voice/<id>.json together.
const APPROVED = {
  baekhyun: {
    version: 'baekhyun-voice-1',
    contentHash: '4af3b1144db61cc3a7e3964a7c523d8ef8700cc4a70eb2322bada78b57fdbff3',
  },
};

const SPOKEN = {
  playful: '[playful] 에리 뭐야 [chuckles] 그렇게 말하면 나 웃기잖아',
  soft: '[whispers] 오늘 수고했어 [laughs softly] 이제 좀 쉬어',
  shy: '[shy] [whispers] 아 진짜 [sighs] 그런 말 하면 부끄럽단 말이야',
};

const OPEN_LATER = ['kai', 'gdragon', 'hyunjin', 'mark'];

test('every voice package matches its lock hash and golden ElevenLabs request', () => {
  const ids = voicePack.listPacks();
  assert.equal(ids.length, 43);
  for (const id of ids.filter(id => id === 'baekhyun')) {
    const pack = voicePack.load(id);
    assert.equal(pack.ok, true, pack && pack.error);
    const approved = APPROVED[id];
    assert.ok(approved, `missing approved version for ${id}`);
    assert.equal(pack.lock.version, approved.version);
    assert.equal(pack.lock.contentHash, approved.contentHash);
    assert.equal(voicePack.contentHash(id, pack.lock), pack.lock.contentHash);
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'voice', `${id}.json`), 'utf8'));
    assert.equal(fixture.characterId, id);
    assert.equal(fixture.version, pack.lock.version);
    assert.equal(fixture.contentHash, pack.lock.contentHash);
    assert.equal(fixture.requests.length, pack.lock.samples.length);
    pack.lock.samples.forEach((sample, index) => {
      const request = voicePack.buildRequest(pack, sample.text, sample.mood);
      const expected = fixture.requests[index];
      assert.equal(expected.id, sample.id);
      assert.equal(request.endpoint, expected.endpoint);
      assert.deepEqual(request.body, expected.body);
      assert.equal(request.cacheKey, expected.cacheKey);
      assert.equal(request.body.text, SPOKEN[sample.id]);
      assert.equal(request.body.model_id, 'eleven_v3');
      assert.deepEqual(request.body.voice_settings, { stability: 0, similarity_boost: 0.85 });
      assert.equal(request.endpoint.includes('output_format=mp3_44100_128'), true);
      assert.equal(request.endpoint.includes('zG6oPYFpVjyTj1zUmVTY'), true);
      assert.equal(request.characterId, id);
      assert.equal(request.version, approved.version);
    });
  }
});

test('env voice settings do not change a locked request, and the cache key includes character and version', () => {
  const pack = voicePack.load('baekhyun');
  const sample = pack.lock.samples[0];
  const before = voicePack.buildRequest(pack, sample.text, sample.mood);
  process.env.VOICE_ID = 'other-voice';
  process.env.TTS_MODEL = 'eleven_flash_v2_5';
  const after = voicePack.buildRequest(pack, sample.text, sample.mood);
  delete process.env.VOICE_ID;
  delete process.env.TTS_MODEL;
  assert.deepEqual(after, before);
  assert.equal(after.body.text.includes('[chuckles]'), true);
  assert.equal(after.body.model_id, 'eleven_v3');
  const renamed = voicePack.buildRequest(
    { ...pack, lock: { ...pack.lock, version: 'baekhyun-voice-2' } },
    sample.text,
    sample.mood,
  );
  assert.notEqual(renamed.cacheKey, before.cacheKey);
  assert.equal(renamed.body.text, before.body.text);
  const otherCharacter = voicePack.buildRequest({ ...pack, characterId: 'kai' }, sample.text, sample.mood);
  assert.notEqual(otherCharacter.cacheKey, before.cacheKey);
  assert.equal(otherCharacter.body.text, before.body.text);
  const otherLine = voicePack.buildRequest(pack, `${sample.text} 응`, sample.mood);
  assert.notEqual(otherLine.cacheKey, before.cacheKey);
});

test('a package edit without a new content hash disables that voice only', () => {
  for (const id of OPEN_LATER) {
    assert.equal(voicePack.load(id), null);
    assert.equal(fs.existsSync(voicePack.lockPath(id)), false);
    assert.equal(characters.isAvailable(id), false);
  }
  assert.equal(characters.isAvailable('baekhyun'), true);
  const packSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'character-pack.js'), 'utf8');
  assert.equal(packSrc.includes('voice.lock'), false);
  const prep = fs.readFileSync(voicePack.preparePath('baekhyun'), 'utf8');
  assert.equal(prep.includes('stripAudioTags'), false);
  assert.equal(prep.includes('require('), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-voice-tamper-'));
  fs.cpSync(path.join(__dirname, '..', 'characters', 'baekhyun', 'voice'), path.join(root, 'baekhyun', 'voice'), { recursive: true });
  fs.appendFileSync(path.join(root, 'baekhyun', 'voice', 'prepare.js'), '\n');
  const broken = voicePack.load('baekhyun', root);
  assert.equal(broken.ok, false);
  assert.match(broken.error, /contentHash/);
  assert.equal(characters.isAvailable('baekhyun'), true);
  assert.equal(voicePack.load('baekhyun').ok, true);

  const badJson = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-voice-json-'));
  fs.mkdirSync(path.join(badJson, 'baekhyun', 'voice'), { recursive: true });
  fs.writeFileSync(path.join(badJson, 'baekhyun', 'voice', 'voice.lock.json'), '{');
  fs.writeFileSync(path.join(badJson, 'baekhyun', 'voice', 'prepare.js'), 'module.exports = { prepare() { return ""; }, canSpeak() { return false; } };\n');
  assert.equal(voicePack.load('baekhyun', badJson).ok, false);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(badJson, { recursive: true, force: true });
});

test('tts executor retries once and then reuses the versioned file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-voice-audio-'));
  const request = { cacheKey: 'abc123', endpoint: 'https://example.invalid/tts', body: { text: 'hi' } };
  let calls = 0;
  const fetchAudio = async () => {
    calls += 1;
    if (calls === 1) throw new Error('nope');
    return Buffer.alloc(80, 1);
  };
  const url = await voiceExec.synthesize(request, 'key', fetchAudio, dir);
  assert.equal(url, '/audio/abc123.mp3');
  assert.equal(calls, 2);
  assert.equal(fs.statSync(path.join(dir, 'abc123.mp3')).size, 80);
  const again = await voiceExec.synthesize(request, 'key', fetchAudio, dir);
  assert.equal(again, url);
  assert.equal(calls, 2);
  await assert.rejects(voiceExec.synthesize(
    { ...request, cacheKey: 'missing' },
    'key',
    async () => { throw new Error('down'); },
    dir,
  ));
  fs.rmSync(dir, { recursive: true, force: true });
});

let base;
let serverApp;
let fan;
const outbound = [];
const realFetch = global.fetch;

function cookieFrom(response, previous) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const sid = list.map((item) => item.split(';')[0]).find((item) => item.startsWith('sid='));
  if (sid) return sid;
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/sid=[^;]+/);
  return match ? match[0] : (previous || '');
}

async function request(pathname, { method = 'GET', body, cookie } = {}) {
  const response = await realFetch(base + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
  return { status: response.status, json, cookie: cookieFrom(response, cookie) };
}

test.before(async () => {
  let elevenFails = 0;
  global.fetch = async (url, opts) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost')) {
      return realFetch(url, opts);
    }
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    outbound.push({ url: target, body });
    if (body && String(body.text).includes('실패')) {
      elevenFails += 1;
      if (elevenFails === 1) {
        return new Response(JSON.stringify({ error: 'nope' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    if (body && String(body.text).includes('둘다')) {
      return new Response(JSON.stringify({ error: 'nope' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(Buffer.alloc(80, 7), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  await store.init();
  serverApp = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => serverApp.once('listening', resolve));
  base = `http://127.0.0.1:${serverApp.address().port}`;
  const stamp = Date.now().toString(36);
  fan = await request('/api/register', { method: 'POST', body: { username: `fan${stamp}`, password: 'password1', age14: true } });
});

test.after(async () => {
  global.fetch = realFetch;
  delete process.env.VOICE_ID;
  delete process.env.TTS_MODEL;
  await store.flush({ shutdown: true });
  await new Promise((resolve) => serverApp.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function clearClip(text, mood) {
  const pack = voicePack.load('baekhyun');
  const request = voicePack.buildRequest(pack, text, mood);
  fs.rmSync(path.join(__dirname, '..', 'cache', 'audio', `${request.cacheKey}.mp3`), { force: true });
}

test('api tts sends the locked request and does not let env replace it', async () => {
  process.env.VOICE_ID = 'other-voice';
  process.env.TTS_MODEL = 'eleven_flash_v2_5';
  outbound.length = 0;
  const line = '에리 뭐야 [chuckles] 그렇게 말하면 나 웃기잖아';
  clearClip(line, 'playful');
  const first = await request('/api/tts', {
    method: 'POST',
    cookie: fan.cookie,
    body: { characterId: 'baekhyun', text: line, mood: 'playful' },
  });
  assert.equal(first.status, 200);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url.includes('zG6oPYFpVjyTj1zUmVTY'), true);
  assert.equal(outbound[0].url.includes('other-voice'), false);
  assert.equal(outbound[0].url.includes('output_format=mp3_44100_128'), true);
  assert.equal(outbound[0].body.text, SPOKEN.playful);
  assert.equal(outbound[0].body.model_id, 'eleven_v3');
  assert.deepEqual(outbound[0].body.voice_settings, { stability: 0, similarity_boost: 0.85 });
  const cached = await request('/api/tts', {
    method: 'POST',
    cookie: fan.cookie,
    body: { characterId: 'baekhyun', text: line, mood: 'playful' },
  });
  assert.equal(cached.status, 200);
  assert.equal(cached.json.audioUrl, first.json.audioUrl);
  assert.equal(outbound.length, 1);
  const quiet = await request('/api/tts', {
    method: 'POST',
    cookie: fan.cookie,
    body: { characterId: 'baekhyun', text: 'ㅋㅋㅋ', mood: 'playful' },
  });
  assert.equal(quiet.status, 400);
});

test('api tts retries once and then returns the existing failure', async () => {
  const retryLine = '이번은 실패 한번';
  const downLine = '둘다 실패';
  clearClip(retryLine, 'soft');
  clearClip(downLine, 'soft');
  const before = outbound.length;
  const retried = await request('/api/tts', {
    method: 'POST',
    cookie: fan.cookie,
    body: { characterId: 'baekhyun', text: retryLine, mood: 'soft' },
  });
  assert.equal(retried.status, 200);
  assert.equal(outbound.length, before + 2);
  assert.equal(outbound[outbound.length - 1].body.text.includes('[laughs'), false);
  assert.equal(outbound[outbound.length - 1].body.text.includes('실패'), true);
  const down = await request('/api/tts', {
    method: 'POST',
    cookie: fan.cookie,
    body: { characterId: 'baekhyun', text: '둘다 실패', mood: 'soft' },
  });
  assert.equal(down.status, 502);
  delete process.env.VOICE_ID;
  delete process.env.TTS_MODEL;
});
