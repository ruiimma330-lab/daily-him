const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const AUDIO_DIR = path.join(ROOT, 'cache', 'audio');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PERSONA_PATH = path.join(ROOT, 'persona', 'system_prompt.md');

const FALLBACK_PROMPT = [
  '너는 카카오톡으로 이야기하는 친근한 AI 모의 캐릭터 백현이야.',
  '실제 인물이 아니며, 사생활은 알지 못해.',
  '반말로 짧고 다정하게 한국어로만 답해.',
  '한 턴에 1~3개의 짧은 메시지를 보내고, 각 메시지는 줄바꿈으로 구분해.',
  '지문이나 서술은 쓰지 마.',
].join('\n');

const GENERIC_LLM_ERROR = 'Chat service is unavailable. Please try again.';

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function requireKeys() {
  const chatKey = readEnv('DEEPSEEK_CHAT_API_KEY');
  const voiceKey = readEnv('ELEVENLABS_API_KEY');
  const missing = [];
  if (!chatKey) missing.push('DEEPSEEK_CHAT_API_KEY');
  if (!voiceKey) missing.push('ELEVENLABS_API_KEY');
  if (missing.length) {
    const error = new Error('Missing required environment variables');
    error.missing = missing;
    throw error;
  }
  return { chatKey, voiceKey };
}

function readConfigFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read config.json');
  }
  return {};
}

function resolveRuntimeConfig() {
  const file = readConfigFile();
  return {
    llmModel: readEnv('LLM_MODEL') || file.llmModel || 'deepseek-v4-pro',
    ttsModel: readEnv('TTS_MODEL') || file.ttsModel || 'eleven_flash_v2_5',
    voiceId: readEnv('VOICE_ID') || (typeof file.voiceId === 'string' ? file.voiceId.trim() : ''),
    voiceSettings: file.voiceSettings && typeof file.voiceSettings === 'object'
      ? file.voiceSettings
      : { stability: 0.45, similarity_boost: 0.8, style: 0.3 },
    speechPrefix: typeof file.speechPrefix === 'string' ? file.speechPrefix : '',
    moodTags: readMoodTags(file.moodTags),
    defaultMood: typeof file.defaultMood === 'string' ? file.defaultMood.trim().toLowerCase() : '',
  };
}

function readMoodTags(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const tags = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    tags[String(key).toLowerCase()] = value;
  }
  return tags;
}

function loadSystemPrompt() {
  try {
    const text = fs.readFileSync(PERSONA_PATH, 'utf8').trim();
    if (text) return text;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read persona prompt');
  }
  return FALLBACK_PROMPT;
}

function parseMood(text) {
  const raw = String(text || '');
  const match = raw.match(/\[\[\s*mood\s*:\s*([a-z_]+)\s*\]\]/i);
  const mood = match ? match[1].toLowerCase() : null;
  const stripped = raw
    .replace(/\[\[[\s\S]*?\]\]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*(?:\[[a-z_]+\]\s*)+$/i.test(line))
    .join('\n');
  return { mood, text: stripped };
}

function moodDelivery(config, parsedMood) {
  const tags = config.moodTags && typeof config.moodTags === 'object' ? config.moodTags : {};
  const defaultMood = typeof config.defaultMood === 'string' ? config.defaultMood : '';
  if (parsedMood && typeof tags[parsedMood] === 'string') {
    return { mood: parsedMood, prefix: tags[parsedMood] };
  }
  if (defaultMood && typeof tags[defaultMood] === 'string') {
    return { mood: defaultMood, prefix: tags[defaultMood] };
  }
  return {
    mood: parsedMood || defaultMood || '',
    prefix: typeof config.speechPrefix === 'string' ? config.speechPrefix : '',
  };
}

function splitBubbles(text) {
  let raw = String(text || '').replace(/\r\n/g, '\n');
  if (!raw.includes('\n') && raw.includes('\\n')) {
    raw = raw.replace(/\\n/g, '\n');
  }
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function stripAudioTags(line) {
  return String(line || '')
    .replace(/\[\s*[A-Za-z][A-Za-z ,'-]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toSpeechText(bubbles) {
  const joined = bubbles.join(' ');
  return joined
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\p{Emoji_Modifier}/gu, '')
    .replace(/[\u200D\uFE0F\u20E3]/g, '')
    .replace(/[ㅋㅎ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSpeakable(text) {
  return /[\p{L}\p{N}]/u.test(text);
}

function voiceReady(voiceId) {
  return Boolean(voiceId) && voiceId !== 'PLACEHOLDER';
}

function llmTimeoutMs() {
  const raw = readEnv('LLM_TIMEOUT_MS');
  if (!raw) return 90000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 90000;
  return parsed;
}

function isLlmTimeout(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const cause = err.cause;
  return Boolean(cause && typeof cause === 'object' && (cause.name === 'TimeoutError' || cause.name === 'AbortError'));
}

const APP_PASSWORD = readEnv('APP_PASSWORD');
const GATE_ENABLED = APP_PASSWORD.length > 0;
const SESSION_SECRET = readEnv('SESSION_SECRET') || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_GLOBAL_MAX_FAILURES = 100;
const LOGIN_MAP_MAX_ENTRIES = 5000;
const LOGIN_CLEANUP_INTERVAL_MS = 60 * 1000;
const loginAttempts = new Map();
const loginFailureTimes = [];
let lastLoginCleanup = 0;

const PUBLIC_PATHS = new Set([
  '/login',
  '/login.html',
  '/api/login',
  '/manifest.webmanifest',
]);

function sha256Digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function passwordMatches(supplied) {
  return crypto.timingSafeEqual(sha256Digest(supplied), sha256Digest(APP_PASSWORD));
}

function signSession(exp) {
  const payload = String(exp);
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (typeof token !== 'string' || token.length > 512) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(parts[0]).digest();
  const given = Buffer.from(parts[1], 'base64url');
  if (given.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(given, expected)) return false;
  const exp = Number(parts[0]);
  return Number.isFinite(exp) && exp > Date.now();
}

function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (typeof header !== 'string' || !header) return '';
  const pieces = header.split(';');
  for (const piece of pieces) {
    const idx = piece.indexOf('=');
    if (idx === -1) continue;
    if (piece.slice(0, idx).trim() !== name) continue;
    const raw = piece.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch (err) {
      return raw;
    }
  }
  return '';
}

function hasSession(req) {
  return verifySessionToken(readCookie(req, 'sid'));
}

function clientIp(req) {
  if (req.ip) return String(req.ip);
  if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  return 'unknown';
}

function cleanupLoginState(now) {
  if (now - lastLoginCleanup < LOGIN_CLEANUP_INTERVAL_MS) return;
  lastLoginCleanup = now;
  for (const [key, stamps] of loginAttempts) {
    const kept = stamps.filter((ts) => now - ts < LOGIN_WINDOW_MS);
    if (kept.length) loginAttempts.set(key, kept);
    else loginAttempts.delete(key);
  }
  let expired = 0;
  while (expired < loginFailureTimes.length && now - loginFailureTimes[expired] >= LOGIN_WINDOW_MS) {
    expired += 1;
  }
  if (expired) loginFailureTimes.splice(0, expired);
}

function recentGlobalFailures(now) {
  let count = 0;
  for (let i = loginFailureTimes.length - 1; i >= 0; i -= 1) {
    if (now - loginFailureTimes[i] >= LOGIN_WINDOW_MS) break;
    count += 1;
  }
  return count;
}

function storeLoginAttempts(ip, stamps) {
  if (!loginAttempts.has(ip)) {
    while (loginAttempts.size >= LOGIN_MAP_MAX_ENTRIES) {
      const oldest = loginAttempts.keys().next().value;
      if (oldest === undefined) break;
      loginAttempts.delete(oldest);
    }
  }
  loginAttempts.set(ip, stamps);
}

function loginAllowed(ip) {
  const now = Date.now();
  cleanupLoginState(now);
  if (recentGlobalFailures(now) >= LOGIN_GLOBAL_MAX_FAILURES) return false;
  const recent = (loginAttempts.get(ip) || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX_ATTEMPTS) {
    storeLoginAttempts(ip, recent);
    return false;
  }
  recent.push(now);
  storeLoginAttempts(ip, recent);
  return true;
}

function recordLoginFailure() {
  loginFailureTimes.push(Date.now());
}

function setSessionCookie(req, res) {
  const exp = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const token = signSession(exp);
  const parts = [
    `sid=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  if (process.env.NODE_ENV === 'production' || req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function normalizeRequestPath(req) {
  const raw = typeof req.path === 'string' && req.path ? req.path : '/';
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch (err) {
    return null;
  }
  const collapsed = decoded.replace(/\/{2,}/g, '/');
  let normalized = path.posix.normalize(collapsed);
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  return normalized.toLowerCase();
}

function isPublicPath(p) {
  return PUBLIC_PATHS.has(p) || p.startsWith('/icons/');
}

function gateMiddleware(req, res, next) {
  const p = normalizeRequestPath(req);
  if (p == null) return res.status(400).json({ error: 'Bad request' });
  if (isPublicPath(p) || hasSession(req)) return next();
  if (p.startsWith('/api/') || p.startsWith('/audio/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
}

function audioFileHash(voiceId, model, text) {
  return crypto.createHash('sha256').update(voiceId + model + text).digest('hex');
}

function normalizeMessages(input) {
  if (!Array.isArray(input)) return null;
  const cleaned = [];
  for (const message of input.slice(-40)) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (typeof message.content !== 'string') continue;
    const content = message.content.trim().slice(0, 4000);
    if (!content) continue;
    cleaned.push({ role: message.role, content });
  }
  return cleaned.slice(-20);
}

async function synthesize(voiceId, model, text, apiKey, voiceSettings) {
  const hash = audioFileHash(voiceId, model, text);
  const filename = `${hash}.mp3`;
  const filePath = path.join(AUDIO_DIR, filename);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return `/audio/${filename}`;
  }

  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: voiceSettings || { stability: 0.45, similarity_boost: 0.8, style: 0.3 },
    }),
    signal: AbortSignal.timeout(45000),
  });

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || contentType.includes('json') || contentType.startsWith('text/')) {
    console.error(`TTS request failed (${response.status})`);
    throw new Error('TTS failed');
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 64) {
    console.error('TTS request failed (empty audio)');
    throw new Error('TTS failed');
  }

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const tempPath = path.join(AUDIO_DIR, `.${hash}.${process.pid}.tmp`);
  fs.writeFileSync(tempPath, audio);
  fs.renameSync(tempPath, filePath);
  return `/audio/${filename}`;
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.set('strict routing', false);
  app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
  if (GATE_ENABLED) app.use(gateMiddleware);
  app.use(express.json({ limit: '200kb' }));

  app.get('/login', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json');
    res.sendFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'));
  });

  app.post('/api/login', (req, res) => {
    if (!GATE_ENABLED) return res.status(404).json({ error: 'Not found' });
    if (process.env.NODE_ENV === 'production' && !req.secure) {
      return res.status(400).json({ error: 'https required' });
    }
    if (!loginAllowed(clientIp(req))) {
      return res.status(429).json({ error: 'Too many attempts' });
    }
    const supplied = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!passwordMatches(supplied)) {
      recordLoginFailure();
      return res.status(401).json({ error: 'Unauthorized' });
    }
    setSessionCookie(req, res);
    return res.json({ ok: true });
  });

  app.get('/api/health', (req, res) => {
    const config = resolveRuntimeConfig();
    res.json({
      ok: true,
      model: config.llmModel,
      voiceId: config.voiceId,
      ttsModel: config.ttsModel,
    });
  });

  app.post('/api/chat', async (req, res) => {
    let keys;
    try {
      keys = requireKeys();
    } catch (err) {
      console.error(`Missing required environment variable(s): ${(err.missing || []).join(', ')}`);
      return res.status(500).json({ error: 'Server is not configured' });
    }

    const recent = normalizeMessages(req.body && req.body.messages);
    if (!recent || recent.length === 0) {
      return res.status(400).json({ error: 'messages required' });
    }

    const config = resolveRuntimeConfig();
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' });
    const systemPrompt = loadSystemPrompt() + `\n\n## 현재 시각\n지금은 ${now} (사용자 기준 시간대)야. 날짜/시간 이야기를 할 때 이것을 기준으로 해. 공개 사실 목록 이후의 일은 모른다고 해.`;
    let replyText = '';

    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keys.chatKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.llmModel,
          temperature: 0.9,
          reasoning_effort: process.env.LLM_EFFORT || 'low',
          messages: [{ role: 'system', content: systemPrompt }, ...recent],
        }),
        signal: AbortSignal.timeout(llmTimeoutMs()),
      });

      if (!response.ok) {
        console.error(`LLM request failed (${response.status})`);
        return res.status(502).json({ error: GENERIC_LLM_ERROR });
      }

      let data;
      try {
        data = await response.json();
      } catch (err) {
        if (isLlmTimeout(err)) throw err;
        console.error('LLM request failed');
        return res.status(502).json({ error: GENERIC_LLM_ERROR });
      }

      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      if (typeof content !== 'string') {
        console.error('LLM request failed (no content in response)');
        return res.status(502).json({ error: GENERIC_LLM_ERROR });
      }
      replyText = content;
    } catch (err) {
      if (isLlmTimeout(err)) {
        console.error('LLM request timed out');
        return res.status(504).json({ error: 'timeout' });
      }
      const code = err && err.cause && err.cause.code ? ` cause=${String(err.cause.code)}` : '';
      const keyOk = /^[\x21-\x7e]+$/.test(keys.chatKey) ? 'ascii' : 'has-invalid-chars';
      console.error(`LLM request failed (fetch error ${err && err.name ? err.name : 'unknown'}${code}, key format ${keyOk}, key length ${keys.chatKey.length})`);
      return res.status(502).json({ error: GENERIC_LLM_ERROR });
    }

    const parsed = parseMood(replyText);
    const delivery = moodDelivery(config, parsed.mood);
    const speechLines = splitBubbles(parsed.text);
    if (!speechLines.length) {
      console.error('LLM request failed (empty reply after parsing)');
      return res.status(502).json({ error: GENERIC_LLM_ERROR });
    }

    const displayBubbles = speechLines.map((line) => stripAudioTags(line)).filter(Boolean);
    const voiceOff = Boolean(req.body && req.body.voice === false);
    const speech = toSpeechText(speechLines);
    let audioUrl = null;
    let audioError;

    if (!voiceOff && isSpeakable(speech)) {
      if (!voiceReady(config.voiceId)) {
        audioError = 'Voice is not configured';
      } else {
        try {
          const ttsText = `${delivery.prefix} ${speech}`;
          audioUrl = await synthesize(config.voiceId, config.ttsModel, ttsText, keys.voiceKey, config.voiceSettings);
        } catch (err) {
          console.error('TTS request failed');
          audioError = 'TTS failed';
        }
      }
    }

    const payload = { bubbles: displayBubbles, audioUrl, mood: delivery.mood };
    if (audioError) payload.audioError = audioError;
    return res.json(payload);
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use('/audio', express.static(AUDIO_DIR, { fallthrough: true, maxAge: '7d' }));
  app.use(express.static(PUBLIC_DIR));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('Request error');
    const status = err && err.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({
      error: status === 400 ? 'Invalid JSON' : 'Something went wrong',
    });
  });

  return app;
}

function main() {
  if (process.env.NODE_ENV === 'production' && !GATE_ENABLED) {
    console.error('APP_PASSWORD is required when NODE_ENV=production. Refusing to start without it.');
    process.exit(1);
  }

  try {
    requireKeys();
  } catch (err) {
    console.error(`Missing required environment variable(s): ${(err.missing || []).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const portValue = Number.parseInt(process.env.PORT, 10);
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : 3000;
  const app = createApp();
  app.listen(port, '0.0.0.0', () => {
    console.log(`Listening on http://localhost:${port}`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  createApp,
  parseMood,
  splitBubbles,
  stripAudioTags,
  toSpeechText,
  isSpeakable,
  resolveRuntimeConfig,
  audioFileHash,
  voiceReady,
  loadSystemPrompt,
  llmTimeoutMs,
  isLlmTimeout,
};
