'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { digitUsername } = require('./helpers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-fish-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
delete process.env.MOMENTS_ADMINS;
delete process.env.ADMINS;
delete process.env.VOICE_ID;
delete process.env.TTS_MODEL;
delete process.env.FISH_AUDIO_API_BASE;
process.env.DEEPSEEK_CHAT_API_KEY = 'test-chat-key';
process.env.ELEVENLABS_API_KEY = 'test-eleven-key';
process.env.FISH_AUDIO_API_KEY = 'test-fish-secret-key-999';

const ttsFish = require('../lib/tts-fish');
const voicePack = require('../lib/voice-pack');
const fishCli = require('../scripts/fish-voice');
const store = require('../lib/store');
const { createApp } = require('../server');

const ROOT = path.join(__dirname, '..');
const CHAR_DIR = path.join(ROOT, 'characters');
const AUDIO_DIR = path.join(ROOT, 'cache', 'audio');

const PREPARE_SOURCE = [
  "'use strict';",
  'function prepare(text, mood, pack) {',
  '  const tags = pack && pack.moodTags ? pack.moodTags : {};',
  '  const prefix = (mood && tags[mood]) || (pack && pack.speechPrefix) || "";',
  '  return `${prefix} ${String(text || "").trim()}`.trim();',
  '}',
  'function canSpeak(text) {',
  '  return /[\\p{L}\\p{N}]/u.test(String(text || ""));',
  '}',
  'module.exports = { prepare, canSpeak };',
  '',
].join('\n');

function makeTempVoicePack({ provider = 'fish', model = 's2-pro', voiceId = 'fish-ref-abc12345', voiceSettings } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-fish-pack-'));
  const charId = 'fishchar';
  const voiceDir = path.join(root, charId, 'voice');
  fs.mkdirSync(voiceDir, { recursive: true });
  fs.writeFileSync(path.join(voiceDir, 'prepare.js'), PREPARE_SOURCE, 'utf8');
  const lock = {
    version: `${charId}-voice-1`,
    provider,
    tags: 'keep',
    model,
    outputFormat: 'mp3_44100_128',
    voiceId,
    voiceSettings: voiceSettings || { temperature: 0.7, top_p: 0.7, latency: 'balanced' },
    speechPrefix: '[soft]',
    defaultMood: 'soft',
    moodTags: {
      soft: '[whispers]',
      playful: '[chuckles]',
    },
    samples: [{ id: 's1', mood: 'soft', text: '안녕' }],
    pins: [],
  };
  lock.contentHash = voicePack.contentHash(charId, lock, root);
  fs.writeFileSync(path.join(voiceDir, 'voice.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return { root, charId, lock };
}

test('adaptTagsForFish normalizes ElevenLabs tags for s2-pro and s1', () => {
  const input = '[Chuckles] 안녕 [WHISPERS] 잘 자 [sighs] [Laughs] [laughs softly] [SINGS SOFTLY] [Hums] [playful]';
  assert.equal(
    ttsFish.adaptTagsForFish(input, 's2-pro'),
    '[chuckling] 안녕 [whispering] 잘 자 [sighing] [laughing] [laughing softly] [singing softly] [humming] [playful]',
  );
  assert.equal(
    ttsFish.adaptTagsForFish(input),
    '[chuckling] 안녕 [whispering] 잘 자 [sighing] [laughing] [laughing softly] [singing softly] [humming] [playful]',
  );
  assert.equal(
    ttsFish.adaptTagsForFish(input, 's1'),
    '(chuckling) 안녕 (whispering) 잘 자 (sighing) (laughing) (laughing softly) (singing softly) (humming) (playful)',
  );
});

test('buildRequest filters ElevenLabs-only fields, preserves Fish settings, and builds distinct cacheKey', () => {
  const pack = {
    characterId: 'demo',
    lock: {
      version: 'demo-v1',
      model: 's2-pro',
      voiceSettings: {
        stability: 0.2,
        similarity_boost: 0.85,
        style: 0.4,
        mp3_bitrate: 192,
        temperature: 0.75,
        top_p: 0.8,
        latency: 'balanced',
        chunk_length: 200,
        normalize: true,
        prosody: { speed: 1.05, volume: -1 },
      },
    },
  };
  const req = ttsFish.buildRequest(pack, '[whispers] 오늘 고생했어 [chuckles]', 'ref-voice-001');
  assert.equal(req.provider, 'fish');
  assert.equal(req.characterId, 'demo');
  assert.equal(req.version, 'demo-v1');
  assert.equal(req.model, 's2-pro');
  assert.equal(req.endpoint, 'https://api.fish.audio/v1/tts');
  assert.deepEqual(req.body, {
    text: '[whispering] 오늘 고생했어 [chuckling]',
    reference_id: 'ref-voice-001',
    format: 'mp3',
    mp3_bitrate: 192,
    temperature: 0.75,
    top_p: 0.8,
    latency: 'balanced',
    chunk_length: 200,
    normalize: true,
    prosody: { speed: 1.05, volume: -1 },
  });
  assert.equal('stability' in req.body, false);
  assert.equal('similarity_boost' in req.body, false);
  assert.equal('style' in req.body, false);

  const otherModel = ttsFish.buildRequest(
    { ...pack, lock: { ...pack.lock, model: 's1' } },
    '[whispers] 오늘 고생했어 [chuckles]',
    'ref-voice-001',
  );
  assert.notEqual(otherModel.cacheKey, req.cacheKey);
  assert.equal(otherModel.body.text, '(whispering) 오늘 고생했어 (chuckling)');
});

test('fetchOnce sends expected Fish headers/body, returns MP3 buffer, and never leaks key on errors', async () => {
  const req = ttsFish.buildRequest(
    { characterId: 'demo', lock: { version: 'v1', model: 's2-pro' } },
    '[chuckles] 반가워',
    'ref-1234567890',
  );
  let captured = null;
  const mockAudio = Buffer.alloc(128, 0x42);
  const okFetch = async (url, opts) => {
    captured = { url, opts };
    return new Response(mockAudio, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };
  const buf = await ttsFish.fetchOnce(req, 'secret-fish-key-xyz', okFetch);
  assert.equal(Buffer.isBuffer(buf), true);
  assert.equal(buf.equals(mockAudio), true);
  assert.equal(captured.url, 'https://api.fish.audio/v1/tts');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers.Authorization, 'Bearer secret-fish-key-xyz');
  assert.equal(captured.opts.headers.model, 's2-pro');
  assert.equal(captured.opts.headers['Content-Type'], 'application/json');
  assert.equal(captured.opts.headers.Accept, 'audio/mpeg');
  assert.deepEqual(JSON.parse(captured.opts.body), {
    text: '[chuckling] 반가워',
    reference_id: 'ref-1234567890',
    format: 'mp3',
  });

  const origErr = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    await assert.rejects(
      () => ttsFish.fetchOnce(req, 'secret-fish-key-xyz', async () => new Response(
        JSON.stringify({ message: 'bad key secret-fish-key-xyz' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )),
      (err) => err.status === 401 && !String(err.detail).includes('secret-fish-key-xyz'),
    );
    assert.equal(logs.some((line) => line.includes('secret-fish-key-xyz')), false);
    assert.equal(logs.some((line) => line.includes('referenceId=ref-1234')), true);

    await assert.rejects(
      () => ttsFish.fetchOnce(req, 'secret-fish-key-xyz', async () => new Response(
        Buffer.alloc(10, 1),
        { status: 200, headers: { 'content-type': 'audio/mpeg' } },
      )),
      (err) => err.detail === 'empty audio',
    );
  } finally {
    console.error = origErr;
  }

  const prevFish = process.env.FISH_AUDIO_API_KEY;
  const prevAlias = process.env.FISH_API_KEY;
  delete process.env.FISH_AUDIO_API_KEY;
  delete process.env.FISH_API_KEY;
  try {
    await assert.rejects(
      () => ttsFish.fetchOnce(req, ''),
      (err) => err.status === 503 && err.detail === 'FISH_AUDIO_API_KEY missing',
    );
  } finally {
    if (prevFish !== undefined) process.env.FISH_AUDIO_API_KEY = prevFish;
    if (prevAlias !== undefined) process.env.FISH_API_KEY = prevAlias;
  }
});

test('voicePack.load and voicePack.buildRequest respect provider=fish and FISH_AUDIO_API_KEY', () => {
  const { root, charId } = makeTempVoicePack({ provider: 'fish', model: 's2-pro' });
  const prevKey = process.env.FISH_AUDIO_API_KEY;
  try {
    delete process.env.FISH_AUDIO_API_KEY;
    const disabledPack = voicePack.load(charId, root);
    assert.equal(disabledPack.ok, true);
    assert.equal(disabledPack.provider, 'fish');
    assert.equal(disabledPack.enabled, false);

    process.env.FISH_AUDIO_API_KEY = 'test-fish-secret-key-999';
    const enabledPack = voicePack.load(charId, root);
    assert.equal(enabledPack.ok, true);
    assert.equal(enabledPack.provider, 'fish');
    assert.equal(enabledPack.enabled, true);

    const req = voicePack.buildRequest(enabledPack, '오늘 [chuckles] 좋았어', 'soft');
    assert.equal(req.provider, 'fish');
    assert.equal(req.endpoint, 'https://api.fish.audio/v1/tts');
    assert.equal(req.body.text, '[whispering] 오늘 [chuckling] 좋았어');
    assert.equal(req.body.reference_id, 'fish-ref-abc12345');

    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-fish-bad-'));
    fs.mkdirSync(path.join(badRoot, 'badchar', 'voice'), { recursive: true });
    fs.writeFileSync(path.join(badRoot, 'badchar', 'voice', 'voice.lock.json'), JSON.stringify({
      version: 'v1',
      provider: 'unknown-tts',
      tags: 'keep',
      model: 's2-pro',
      outputFormat: 'mp3',
      voiceId: 'abc',
      voiceSettings: {},
      speechPrefix: '',
      defaultMood: 'soft',
      moodTags: {},
      samples: [{ id: '1', text: 'hi' }],
      pins: [],
      contentHash: '0'.repeat(64),
    }));
    const badPack = voicePack.load('badchar', badRoot);
    assert.equal(badPack.ok, false);
    assert.equal(badPack.error, 'voice lock provider is invalid');
    fs.rmSync(badRoot, { recursive: true, force: true });
  } finally {
    if (prevKey === undefined) delete process.env.FISH_AUDIO_API_KEY;
    else process.env.FISH_AUDIO_API_KEY = prevKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scripts/fish-voice.js supports --help and set --dry-run', async () => {
  const cliPath = path.join(ROOT, 'scripts', 'fish-voice.js');
  const helpRun = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  assert.equal(helpRun.status, 0);
  assert.match(helpRun.stdout, /fish-voice\.js search/);
  assert.match(helpRun.stdout, /fish-voice\.js set/);
  assert.match(helpRun.stdout, /fish-voice\.js test/);

  const tempCharRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-fish-cli-'));
  const charId = 'sampleidol';
  const charPath = path.join(tempCharRoot, charId);
  fs.mkdirSync(path.join(charPath, 'voice'), { recursive: true });
  const initialMeta = { id: charId, name: '샘플', placeholderVoice: 'male' };
  const initialLock = {
    version: 'sample-voice-1',
    placeholderVoice: 'male',
    voiceId: '',
    model: 'eleven_multilingual_v2',
    outputFormat: 'mp3_44100_128',
    voiceSettings: { stability: 0.5, similarity_boost: 0.5 },
    speechPrefix: '',
    defaultMood: 'soft',
    moodTags: { soft: '[whispers]' },
    tags: 'keep',
    pins: [],
    samples: [{ id: 'n', text: '안녕', mood: 'soft' }],
    contentHash: '0'.repeat(64),
  };
  fs.writeFileSync(path.join(charPath, 'character.json'), `${JSON.stringify(initialMeta, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(charPath, 'voice', 'voice.lock.json'), `${JSON.stringify(initialLock, null, 2)}\n`, 'utf8');
  // Write prepare.js with CRLF to verify computeLfContentHash normalizes to LF
  fs.writeFileSync(path.join(charPath, 'voice', 'prepare.js'), PREPARE_SOURCE.replace(/\n/g, '\r\n'), 'utf8');

  try {
    const res = await fishCli.run([
      'set',
      '--character', charId,
      '--reference-id', 'fish-model-987654',
      '--model', 's2-pro',
      '--dry-run',
    ], { charactersDir: tempCharRoot });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.characterJson.ttsProvider, 'fish');
    assert.equal(res.characterJson.ttsModel, 's2-pro');
    assert.equal(res.characterJson.voiceId, 'fish-model-987654');
    assert.equal('placeholderVoice' in res.characterJson, false);
    assert.equal(res.voiceLock.provider, 'fish');
    assert.equal(res.voiceLock.model, 's2-pro');
    assert.equal(res.voiceLock.voiceId, 'fish-model-987654');
    assert.equal('placeholderVoice' in res.voiceLock, false);
    assert.match(res.voiceLock.contentHash, /^[a-f0-9]{64}$/);
    // Verify dry-run did not mutate disk
    const onDisk = JSON.parse(fs.readFileSync(path.join(charPath, 'voice', 'voice.lock.json'), 'utf8'));
    assert.equal(onDisk.voiceId, '');
  } finally {
    fs.rmSync(tempCharRoot, { recursive: true, force: true });
  }
});

const TEMP_FISH_CHAR = `fishtest_${process.pid}`;
const TEMP_FISH_DIR = path.join(CHAR_DIR, TEMP_FISH_CHAR);
const createdHashes = new Set();

function setupTempCharacterInRepo() {
  fs.mkdirSync(path.join(TEMP_FISH_DIR, 'voice'), { recursive: true });
  const meta = {
    id: TEMP_FISH_CHAR,
    name: '피쉬테스트',
    displayName: 'FishTest',
    available: true,
    ttsProvider: 'fish',
    ttsModel: 's2-pro',
    voiceId: 'fish-ref-e2e-001',
    defaultUserName: '친구',
    welcomeKo: '안녕',
    welcomeZh: '你好',
    askNameKo: '이름이 뭐야?',
    askNameZh: '叫什么名字？',
    birthDate: '1999-01-01',
    ageVerified: true,
    minor: false,
    allowedTiers: ['stranger', 'friend', 'close', 'flirty'],
  };
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'character.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'persona.md'), '# Persona\n테스트 캐릭터.\n', 'utf8');
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'facts.md'), '1. 테스트 사실이다.\n', 'utf8');
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'catchphrases.md'), '응응\n', 'utf8');
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'scenes.json'), JSON.stringify({ scenes: [] }), 'utf8');
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'moments.json'), JSON.stringify({ posts: [] }), 'utf8');
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'sources.json'), JSON.stringify({ sources: [] }), 'utf8');
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'fallbacks.json'), JSON.stringify({
    lines: [{ ko: '안녕 [chuckles]', zh: '你好' }],
  }), 'utf8');
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'manifest.json'), JSON.stringify({
    version: 1,
    files: [
      'character.json',
      'persona.md',
      'facts.md',
      'catchphrases.md',
      'scenes.json',
      'moments.json',
      'fallbacks.json',
      'sources.json',
    ],
  }), 'utf8');
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'voice', 'prepare.js'), PREPARE_SOURCE, 'utf8');
  const lock = {
    version: `${TEMP_FISH_CHAR}-voice-1`,
    provider: 'fish',
    tags: 'keep',
    model: 's2-pro',
    outputFormat: 'mp3_44100_128',
    voiceId: 'fish-ref-e2e-001',
    voiceSettings: {
      stability: 0.1,
      similarity_boost: 0.9,
      temperature: 0.7,
      latency: 'balanced',
    },
    speechPrefix: '[soft]',
    defaultMood: 'soft',
    moodTags: {
      soft: '[whispers]',
      playful: '[chuckles]',
    },
    samples: [{ id: 's1', mood: 'soft', text: '안녕' }],
    pins: [],
  };
  lock.contentHash = voicePack.contentHash(TEMP_FISH_CHAR, lock);
  fs.writeFileSync(path.join(TEMP_FISH_DIR, 'voice', 'voice.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

function cookieFrom(response, previous) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const sid = list.map((item) => item.split(';')[0]).find((item) => item.startsWith('sid='));
  if (sid) return sid;
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/sid=[^;]+/);
  return match ? match[0] : (previous || '');
}

test('E2E /api/chat and /api/tts route Fish character to Fish Audio while baekhyun hits ElevenLabs', async () => {
  setupTempCharacterInRepo();
  const stamp = Date.now().toString(36);
  const realFetch = global.fetch;
  const fishCalls = [];
  const elevenCalls = [];
  let serverApp;
  let base;

  global.fetch = async (url, opts) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost')) {
      return realFetch(url, opts);
    }
    if (target.includes('api.deepseek.com')) {
      const parsed = JSON.parse(opts.body);
      const last = parsed.messages[parsed.messages.length - 1].content;
      const replyKo = last.includes('백현')
        ? `백현답장${stamp}`
        : `피쉬답장${stamp} [chuckles]`;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              messages: [{ ko: replyKo, zh: '测试回复', mood: 'soft' }],
            }),
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.startsWith('https://api.fish.audio/v1/tts')) {
      const headers = opts.headers || {};
      fishCalls.push({
        url: target,
        headers,
        body: JSON.parse(opts.body),
      });
      return new Response(Buffer.alloc(120, 0x33), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    }
    if (target.startsWith('https://api.elevenlabs.io/')) {
      elevenCalls.push({
        url: target,
        body: JSON.parse(opts.body),
      });
      return new Response(Buffer.alloc(120, 0x44), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    }
    throw new Error(`Unexpected outbound fetch: ${target}`);
  };

  async function reqJson(pathname, { method = 'GET', body, cookie } = {}) {
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

  try {
    await store.init();
    serverApp = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => serverApp.once('listening', resolve));
    base = `http://127.0.0.1:${serverApp.address().port}`;

    const fan = await reqJson('/api/register', {
      method: 'POST',
      body: { username: digitUsername(), password: 'password1', age14: true },
    });
    assert.equal(fan.status, 201);
    const startBalance = (await reqJson('/api/starlight', { cookie: fan.cookie })).json.balance;

    // Track expected audio hashes for cleanup
    const pack = voicePack.load(TEMP_FISH_CHAR);
    const chatReq = voicePack.buildRequest(pack, `피쉬답장${stamp} [chuckles]`, 'soft');
    createdHashes.add(chatReq.cacheKey);
    const ttsLine = `직접호출${stamp} [sighs]`;
    const ttsReq = voicePack.buildRequest(pack, ttsLine, 'playful');
    createdHashes.add(ttsReq.cacheKey);

    // 1) /api/chat on Fish character
    const chatRes = await reqJson(`/api/chat?characterId=${TEMP_FISH_CHAR}`, {
      method: 'POST',
      cookie: fan.cookie,
      body: { text: '안녕 테스트', turnId: `fishchat1_${stamp}` },
    });
    assert.equal(chatRes.status, 200);
    assert.ok(chatRes.json.messages[0].audioUrl);
    assert.equal(chatRes.json.messages[0].audioUrl, `/audio/${chatReq.cacheKey}.mp3`);
    assert.equal(fishCalls.length, 1);
    assert.equal(fishCalls[0].url, 'https://api.fish.audio/v1/tts');
    assert.equal(fishCalls[0].headers.model, 's2-pro');
    assert.equal(fishCalls[0].headers.Authorization, 'Bearer test-fish-secret-key-999');
    assert.equal(fishCalls[0].body.reference_id, 'fish-ref-e2e-001');
    assert.equal(fishCalls[0].body.text, `[whispering] 피쉬답장${stamp} [chuckling]`);
    assert.equal('stability' in fishCalls[0].body, false);
    assert.equal(elevenCalls.length, 0);

    const afterChatBalance = (await reqJson('/api/starlight', { cookie: fan.cookie })).json.balance;
    assert.equal(afterChatBalance, startBalance - 18);

    // Repeating same clip via /api/tts hits cache without another Fish call
    const chatCachedTts = await reqJson('/api/tts', {
      method: 'POST',
      cookie: fan.cookie,
      body: { characterId: TEMP_FISH_CHAR, text: `피쉬답장${stamp} [chuckles]`, mood: 'soft' },
    });
    assert.equal(chatCachedTts.status, 200);
    assert.equal(chatCachedTts.json.cached, true);
    assert.equal(chatCachedTts.json.audioUrl, chatRes.json.messages[0].audioUrl);
    assert.equal(fishCalls.length, 1);

    // 2) Uncached /api/tts on Fish character bills Starlight once and caches MP3
    const balanceBeforeTts = (await reqJson('/api/starlight', { cookie: fan.cookie })).json.balance;
    const ttsRes = await reqJson('/api/tts', {
      method: 'POST',
      cookie: fan.cookie,
      body: { characterId: TEMP_FISH_CHAR, text: ttsLine, mood: 'playful' },
    });
    assert.equal(ttsRes.status, 200);
    assert.equal(ttsRes.json.audioUrl, `/audio/${ttsReq.cacheKey}.mp3`);
    assert.equal(fishCalls.length, 2);
    assert.equal(fishCalls[1].body.text, `[chuckling] 직접호출${stamp} [sighing]`);
    assert.equal(
      (await reqJson('/api/starlight', { cookie: fan.cookie })).json.balance,
      balanceBeforeTts - 15,
    );

    const ttsCachedAgain = await reqJson('/api/tts', {
      method: 'POST',
      cookie: fan.cookie,
      body: { characterId: TEMP_FISH_CHAR, text: ttsLine, mood: 'playful' },
    });
    assert.equal(ttsCachedAgain.status, 200);
    assert.equal(ttsCachedAgain.json.cached, true);
    assert.equal(fishCalls.length, 2);

    // 3) baekhyun /api/chat still hits ElevenLabs
    const baekChat = await reqJson('/api/chat?characterId=baekhyun', {
      method: 'POST',
      cookie: fan.cookie,
      body: { text: '백현 안녕', turnId: `baekchat1_${stamp}` },
    });
    assert.equal(baekChat.status, 200);
    assert.ok(baekChat.json.messages[0].audioUrl);
    assert.equal(elevenCalls.length, 1);
    assert.match(elevenCalls[0].url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\//);
    assert.equal(fishCalls.length, 2);

    const elevenHash = path.basename(baekChat.json.messages[0].audioUrl, '.mp3');
    createdHashes.add(elevenHash);
  } finally {
    global.fetch = realFetch;
    if (serverApp) await new Promise((resolve) => serverApp.close(resolve));
    await store.flush({ shutdown: true });
    fs.rmSync(TEMP_FISH_DIR, { recursive: true, force: true });
    for (const hash of createdHashes) {
      fs.rmSync(path.join(AUDIO_DIR, `${hash}.mp3`), { force: true });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('FISH_AUDIO_MODEL overrides lock model cleanly and jungkook/taehyung locks validate as fish s2.1-pro-free', () => {
  const prevModel = process.env.FISH_AUDIO_MODEL;
  const prevKey = process.env.FISH_AUDIO_API_KEY;
  try {
    delete process.env.FISH_AUDIO_MODEL;
    assert.equal(ttsFish.resolveModel('s2.1-pro-free'), 's2.1-pro-free');
    assert.equal(ttsFish.resolveModel(''), ttsFish.DEFAULT_MODEL);

    process.env.FISH_AUDIO_MODEL = '  s2-pro  ';
    assert.equal(ttsFish.resolveModel('s2.1-pro-free'), 's2-pro');

    const basePack = {
      characterId: 'demo',
      lock: { version: 'demo-v1', model: 's2.1-pro-free', voiceSettings: {} },
    };
    const overriddenReq = ttsFish.buildRequest(basePack, '[laughs] 반가워', 'ref-xyz');
    assert.equal(overriddenReq.model, 's2-pro');

    delete process.env.FISH_AUDIO_MODEL;
    const defaultReq = ttsFish.buildRequest(basePack, '[laughs] 반가워', 'ref-xyz');
    assert.equal(defaultReq.model, 's2.1-pro-free');
    assert.notEqual(overriddenReq.cacheKey, defaultReq.cacheKey);

    process.env.FISH_AUDIO_API_KEY = 'test-fish-secret-key-999';
    const expected = {
      jungkook: '5fd8fda12193470f96153288210c4f2a',
      taehyung: '164f558a941a4d1db4620f90ca6f954f',
    };
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-fish-bts-'));
    try {
      for (const [id, expectedVoiceId] of Object.entries(expected)) {
        const meta = JSON.parse(fs.readFileSync(path.join(CHAR_DIR, id, 'character.json'), 'utf8'));
        const lock = JSON.parse(fs.readFileSync(voicePack.lockPath(id), 'utf8'));
        assert.equal(meta.ttsProvider, 'fish');
        assert.equal(meta.ttsModel, 's2.1-pro-free');
        assert.equal(meta.voiceId, expectedVoiceId);
        assert.equal(lock.provider, 'fish');
        assert.equal(lock.model, 's2.1-pro-free');
        assert.equal(lock.voiceId, expectedVoiceId);
        assert.equal(fishCli.computeLfContentHash(id, lock), lock.contentHash);

        // Load through voicePack.load using LF-normalized prepare.js so it passes on Windows CRLF checkouts too.
        const tmpVoiceDir = path.join(tmpRoot, id, 'voice');
        fs.mkdirSync(tmpVoiceDir, { recursive: true });
        fs.writeFileSync(path.join(tmpVoiceDir, 'voice.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
        const lfPrepare = fs.readFileSync(voicePack.preparePath(id), 'utf8').replace(/\r\n/g, '\n');
        fs.writeFileSync(path.join(tmpVoiceDir, 'prepare.js'), lfPrepare, 'utf8');
        const pack = voicePack.load(id, tmpRoot);
        assert.equal(pack.ok, true, pack && pack.error);
        assert.equal(pack.enabled, true);
        assert.equal(pack.provider, 'fish');
        assert.equal(pack.lock.model, 's2.1-pro-free');
        assert.equal(pack.lock.voiceId, expectedVoiceId);
        const req = voicePack.buildRequest(pack, lock.samples[0].text, lock.samples[0].mood);
        assert.equal(req.provider, 'fish');
        assert.equal(req.model, 's2.1-pro-free');
        assert.equal(req.body.reference_id, expectedVoiceId);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  } finally {
    if (prevModel === undefined) delete process.env.FISH_AUDIO_MODEL;
    else process.env.FISH_AUDIO_MODEL = prevModel;
    if (prevKey === undefined) delete process.env.FISH_AUDIO_API_KEY;
    else process.env.FISH_AUDIO_API_KEY = prevKey;
  }
});
