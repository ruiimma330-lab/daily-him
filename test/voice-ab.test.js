const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { digitUsername } = require('./helpers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-voice-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
delete process.env.MOMENTS_ADMINS;
delete process.env.ADMINS;
delete process.env.VOICE_ID;
delete process.env.TTS_MODEL;

const voiceAb = require('../lib/voice-ab');
const server = require('../server');
const store = require('../lib/store');
const { createApp } = require('../server');

const BASELINE = [
  '에리 뭐야 [chuckles] 그렇게 말하면 나 웃기잖아',
  '오늘 수고했어 [laughs softly] 이제 좀 쉬어',
  '아 진짜 [sighs] 그런 말 하면 부끄럽단 말이야',
];
const CURRENT = [
  '에리 뭐야 그렇게 말하면 나 웃기잖아',
  '오늘 수고했어 이제 좀 쉬어',
  '아 진짜 그런 말 하면 부끄럽단 말이야',
];

test('speech prep keeps the baseline tags and leaves the chat route unchanged', () => {
  const lines = voiceAb.LINES.map((line) => line.text);
  assert.deepEqual(lines, BASELINE);
  assert.deepEqual(lines.map((text) => voiceAb.baselineSpeech(text)), BASELINE);
  assert.deepEqual(lines.map((text) => voiceAb.currentSpeech(text)), CURRENT);
  assert.deepEqual(lines.map((text) => server.toSpeechText([text])), lines.map((text) => voiceAb.baselineSpeech(text)));
  assert.deepEqual(
    lines.map((text) => server.toSpeechText([server.stripAudioTags(text)]).slice(0, 1000)),
    lines.map((text) => voiceAb.currentSpeech(text)),
  );
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = src.slice(src.indexOf("app.post('/api/tts'"), src.indexOf("app.post('/api/chat'"));
  assert.equal(route.includes('stripAudioTags'), false);
  assert.equal(route.includes('toSpeechText'), false);
  assert.equal(route.includes('moodDelivery'), false);
  assert.match(route, /voicePack\.load\(req\.characterId\)/);
  assert.match(route, /voiceExec\.synthesize\(/);
  const chat = src.slice(src.indexOf("app.post('/api/chat'"), src.indexOf('if (require.main === module)'));
  assert.match(chat, /toSpeechText\(\[item\.raw\]\)/);
  assert.equal(chat.includes('stripAudioTags(item.raw)'), false);
});

test('env status never includes the secret value', () => {
  process.env.VOICE_ID = 'super-secret-voice';
  process.env.TTS_MODEL = 'eleven_v3';
  const voice = voiceAb.envFlag('VOICE_ID', 'zG6oPYFpVjyTj1zUmVTY');
  const model = voiceAb.envFlag('TTS_MODEL', 'eleven_v3');
  assert.equal(voice.set, true);
  assert.equal(voice.matchesCharacter, false);
  assert.equal(model.set, true);
  assert.equal(model.matchesCharacter, true);
  assert.equal(JSON.stringify({ voice, model }).includes('super-secret-voice'), false);
  delete process.env.VOICE_ID;
  delete process.env.TTS_MODEL;
  assert.equal(voiceAb.envFlag('VOICE_ID', 'zG6oPYFpVjyTj1zUmVTY').set, false);
  assert.equal(voiceAb.envFlag('VOICE_ID', 'zG6oPYFpVjyTj1zUmVTY').matchesCharacter, null);
});

let base;
let serverApp;
let fan;
let admin;

function cookieFrom(response, previous) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const sid = list.map((item) => item.split(';')[0]).find((item) => item.startsWith('sid='));
  if (sid) return sid;
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/sid=[^;]+/);
  return match ? match[0] : (previous || '');
}

async function request(pathname, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(base + pathname, {
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
  await store.init();
  serverApp = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => serverApp.once('listening', resolve));
  base = `http://127.0.0.1:${serverApp.address().port}`;
  const stamp = Date.now().toString(36);
  fan = await request('/api/register', { method: 'POST', body: { username: digitUsername(), password: 'password1', age14: true } });
  const adminName = digitUsername();
  admin = await request('/api/register', { method: 'POST', body: { username: adminName, password: 'password1', age14: true } });
  process.env.ADMINS = adminName;
});

test.after(async () => {
  delete process.env.ADMINS;
  await store.flush({ shutdown: true });
  await new Promise((resolve) => serverApp.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a non-admin cannot open the listening session', async () => {
  const closed = await request('/api/admin/voice-ab/status', { cookie: fan.cookie });
  assert.equal(closed.status, 403);
  const missing = await request('/api/admin/voice-ab/session', { method: 'POST', cookie: fan.cookie, body: {} });
  assert.equal(missing.status, 403);
  delete process.env.ADMINS;
  delete process.env.MOMENTS_ADMINS;
  const off = await request('/api/admin/voice-ab/status', { cookie: admin.cookie });
  assert.equal(off.status, 404);
  process.env.ADMINS = admin.json.user.username;
  const allowed = await request('/api/admin/voice-ab/status', { cookie: admin.cookie });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.json.voiceId.set, false);
  assert.equal(allowed.json.locked, true);
  assert.equal(allowed.json.lockVersion, 'baekhyun-voice-1');
  assert.equal(allowed.json.lockedTags, 'keep');
  assert.equal(JSON.stringify(allowed.json).includes('zG6oPYFpVjyTj1zUmVTY'), false);
});
