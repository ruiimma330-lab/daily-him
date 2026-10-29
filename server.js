const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const store = require('./lib/store');
const relationship = require('./lib/relationship');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const AUDIO_DIR = path.join(ROOT, 'cache', 'audio');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PERSONA_PATH = path.join(ROOT, 'persona', 'system_prompt.md');

const BCRYPT_ROUNDS = 10;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const HISTORY_BODY_LIMIT = '1mb';

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

function buildRelationshipPrompt(base, tierId, rel) {
  const m = base.match(/<!-- RELATIONSHIP_TIERS_START -->([\s\S]*?)<!-- RELATIONSHIP_TIERS_END -->/);
  if (!m) return base;
  const block = m[1];
  const intro = block.split(/\n### /)[0].trim();
  const sec = block.split(/\n### /).slice(1).find((part) => part.startsWith(`${tierId}\n`));
  const body = sec ? sec.slice(tierId.length + 1).trim() : '';
  const facts = rel ? `\n(참고: 에리랑 알게 된 지 ${rel.daysKnown}일째, 지금까지 ${rel.totalTurns}번 대화했어. 숫자를 굳이 말하지는 마.)` : '';
  return `${base.replace(m[0], '').trim()}\n\n${intro}\n\n## 현재 관계 단계\n${body}${facts}`;
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
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const AUTH_GLOBAL_MAX_FAILURES = 100;
const AUTH_MAP_MAX_ENTRIES = 5000;
const AUTH_CLEANUP_INTERVAL_MS = 60 * 1000;
const authAttempts = new Map();
const authFailureTimes = [];
let lastAuthCleanup = 0;

const PUBLIC_PATHS = new Set([
  '/login',
  '/login.html',
  '/api/login',
  '/api/register',
  '/api/auth-config',
  '/api/site-login',
  '/manifest.webmanifest',
]);

function sha256Digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function sitePasswordMatches(supplied) {
  if (!GATE_ENABLED) return false;
  const a = sha256Digest(supplied);
  const b = sha256Digest(APP_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signSession(userId, exp) {
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
  let given;
  try {
    given = Buffer.from(parts[2], 'base64url');
  } catch (err) {
    return null;
  }
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  if (!/^[a-f0-9]{32}$/.test(parts[0])) return null;
  return { userId: parts[0], exp };
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

function getSession(req) {
  return verifySessionToken(readCookie(req, 'sid'));
}

function clientIp(req) {
  if (req.ip) return String(req.ip);
  if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  return 'unknown';
}

function cleanupAuthState(now) {
  if (now - lastAuthCleanup < AUTH_CLEANUP_INTERVAL_MS) return;
  lastAuthCleanup = now;
  for (const [key, stamps] of authAttempts) {
    const kept = stamps.filter((ts) => now - ts < AUTH_WINDOW_MS);
    if (kept.length) authAttempts.set(key, kept);
    else authAttempts.delete(key);
  }
  let expired = 0;
  while (expired < authFailureTimes.length && now - authFailureTimes[expired] >= AUTH_WINDOW_MS) {
    expired += 1;
  }
  if (expired) authFailureTimes.splice(0, expired);
}

function recentGlobalFailures(now) {
  let count = 0;
  for (let i = authFailureTimes.length - 1; i >= 0; i -= 1) {
    if (now - authFailureTimes[i] >= AUTH_WINDOW_MS) break;
    count += 1;
  }
  return count;
}

function storeAuthAttempts(ip, stamps) {
  if (!authAttempts.has(ip)) {
    while (authAttempts.size >= AUTH_MAP_MAX_ENTRIES) {
      const oldest = authAttempts.keys().next().value;
      if (oldest === undefined) break;
      authAttempts.delete(oldest);
    }
  }
  authAttempts.set(ip, stamps);
}

function authAllowed(ip) {
  const now = Date.now();
  cleanupAuthState(now);
  if (recentGlobalFailures(now) >= AUTH_GLOBAL_MAX_FAILURES) return false;
  const recent = (authAttempts.get(ip) || []).filter((ts) => now - ts < AUTH_WINDOW_MS);
  if (recent.length >= AUTH_MAX_ATTEMPTS) {
    storeAuthAttempts(ip, recent);
    return false;
  }
  recent.push(now);
  storeAuthAttempts(ip, recent);
  return true;
}

function recordAuthFailure() {
  authFailureTimes.push(Date.now());
}

function cookieFlags(req) {
  const parts = ['HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (process.env.NODE_ENV === 'production' || req.secure) parts.push('Secure');
  return parts;
}

function setSessionCookie(req, res, userId) {
  const exp = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const token = signSession(userId, exp);
  const parts = [
    `sid=${encodeURIComponent(token)}`,
    ...cookieFlags(req),
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = ['sid=', ...cookieFlags(req), 'Max-Age=0'];
  res.append('Set-Cookie', parts.join('; '));
}

function setGateCookie(req, res) {
  const exp = Date.now() + SESSION_MAX_AGE_SEC * 1000;
  const payload = `gate.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const token = `${payload}.${sig}`;
  const parts = [
    `gate=${encodeURIComponent(token)}`,
    ...cookieFlags(req),
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  res.append('Set-Cookie', parts.join('; '));
}

function verifyGateToken(token) {
  if (typeof token !== 'string' || token.length > 512) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'gate' || !parts[1] || !parts[2]) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
  let given;
  try {
    given = Buffer.from(parts[2], 'base64url');
  } catch (err) {
    return false;
  }
  if (given.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(given, expected)) return false;
  const exp = Number(parts[1]);
  return Number.isFinite(exp) && exp > Date.now();
}

function hasGate(req) {
  if (!GATE_ENABLED) return true;
  return verifyGateToken(readCookie(req, 'gate'));
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

function isGatePublicPath(p) {
  return (
    p === '/login'
    || p === '/login.html'
    || p === '/api/site-login'
    || p === '/api/auth-config'
    || p === '/manifest.webmanifest'
    || p.startsWith('/icons/')
  );
}

function gateMiddleware(req, res, next) {
  const p = normalizeRequestPath(req);
  if (p == null) return res.status(400).json({ error: 'Bad request' });

  // Optional site-wide lock (APP_PASSWORD). Does not replace user accounts.
  if (GATE_ENABLED && !hasGate(req) && !isGatePublicPath(p)) {
    if (p.startsWith('/api/') || p.startsWith('/audio/')) {
      return res.status(401).json({ error: 'Unauthorized', need: 'site' });
    }
    return res.redirect('/login');
  }

  if (isPublicPath(p)) return next();

  const session = getSession(req);
  if (session) {
    req.userId = session.userId;
    return next();
  }

  if (p.startsWith('/api/') || p.startsWith('/audio/')) {
    return res.status(401).json({ error: 'Unauthorized', need: 'login' });
  }
  return res.redirect('/login');
}

function requireUser(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  const user = store.findUserById(session.userId);
  if (!user) {
    clearSessionCookie(req, res);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = { id: user.id, username: user.username };
  req.userId = user.id;
  return next();
}

function validateUsername(username) {
  return typeof username === 'string' && USERNAME_RE.test(username.trim());
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
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
  app.use(gateMiddleware);
  app.use(express.json({ limit: HISTORY_BODY_LIMIT }));

  app.get('/login', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json');
    res.sendFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'));
  });

  // Optional site-wide password (APP_PASSWORD). Unlock register/login UI.
  app.post('/api/site-login', (req, res) => {
    if (!GATE_ENABLED) return res.json({ ok: true, gate: false });
    if (process.env.NODE_ENV === 'production' && !req.secure) {
      return res.status(400).json({ error: 'https required' });
    }
    if (!authAllowed(clientIp(req))) {
      return res.status(429).json({ error: 'Too many attempts' });
    }
    const supplied = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!sitePasswordMatches(supplied)) {
      recordAuthFailure();
      return res.status(401).json({ error: 'Unauthorized' });
    }
    setGateCookie(req, res);
    return res.json({ ok: true, gate: true });
  });

  app.get('/api/auth-config', (req, res) => {
    res.json({
      siteGate: GATE_ENABLED,
      siteUnlocked: hasGate(req),
      loggedIn: Boolean(getSession(req)),
    });
  });

  app.post('/api/register', async (req, res) => {
    if (GATE_ENABLED && !hasGate(req)) {
      return res.status(401).json({ error: 'Unauthorized', need: 'site' });
    }
    if (process.env.NODE_ENV === 'production' && !req.secure) {
      return res.status(400).json({ error: 'https required' });
    }
    if (!authAllowed(clientIp(req))) {
      return res.status(429).json({ error: 'Too many attempts' });
    }
    const username = req.body && req.body.username;
    const password = req.body && req.body.password;
    if (!validateUsername(username) || !validatePassword(password)) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }
    try {
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = store.createUser({ username, passwordHash });
      setSessionCookie(req, res, user.id);
      return res.status(201).json({ ok: true, user: { id: user.id, username: user.username } });
    } catch (err) {
      if (err && err.code === 'USERNAME_TAKEN') {
        recordAuthFailure();
        return res.status(409).json({ error: 'Username taken' });
      }
      console.error('Register failed');
      return res.status(500).json({ error: 'Something went wrong' });
    }
  });

  app.post('/api/login', async (req, res) => {
    if (GATE_ENABLED && !hasGate(req)) {
      return res.status(401).json({ error: 'Unauthorized', need: 'site' });
    }
    if (process.env.NODE_ENV === 'production' && !req.secure) {
      return res.status(400).json({ error: 'https required' });
    }
    if (!authAllowed(clientIp(req))) {
      return res.status(429).json({ error: 'Too many attempts' });
    }
    const username = req.body && req.body.username;
    const password = req.body && req.body.password;
    if (!validateUsername(username) || typeof password !== 'string' || !password) {
      recordAuthFailure();
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const user = store.findUserByUsername(username);
    if (!user) {
      recordAuthFailure();
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      recordAuthFailure();
      return res.status(401).json({ error: 'Unauthorized' });
    }
    setSessionCookie(req, res, user.id);
    return res.json({ ok: true, user: { id: user.id, username: user.username } });
  });

  app.post('/api/logout', (req, res) => {
    clearSessionCookie(req, res);
    return res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => {
    res.json({ ok: true, user: req.user });
  });

  app.get('/api/history', requireUser, (req, res) => {
    const messages = store.getHistory(req.userId);
    res.json({ messages });
  });

  app.put('/api/history', requireUser, (req, res) => {
    const messages = store.putHistory(req.userId, req.body && req.body.messages);
    res.json({ messages });
  });

  app.delete('/api/history', requireUser, (req, res) => {
    store.deleteHistory(req.userId);
    res.json({ messages: [] });
  });

  app.get('/api/relationship', requireUser, (req, res) => {
    res.json({ ok: true, relationship: relationship.view(relationship.load(req.userId)) });
  });

  app.delete('/api/relationship', requireUser, (req, res) => {
    if (!req.body || req.body.confirm !== 'RESET') return res.status(400).json({ error: 'confirm required' });
    relationship.reset(req.userId);
    res.json({ ok: true, relationship: relationship.view(relationship.load(req.userId)) });
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

  app.post('/api/chat', requireUser, async (req, res) => {
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
    const relNow = relationship.view(relationship.load(req.userId));
    const systemPrompt = buildRelationshipPrompt(loadSystemPrompt(), relNow.tier.id, relNow) + `\n\n## 현재 시각\n지금은 ${now} (사용자 기준 시간대)야. 날짜/시간 이야기를 할 때 이것을 기준으로 해. 공개 사실 목록 이후의 일은 모른다고 해.`;
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
          const code = err && err.cause && err.cause.code ? ` cause=${String(err.cause.code)}` : '';
          const vk = keys.voiceKey || '';
          const keyOk = /^[\x21-\x7e]+$/.test(vk) ? 'ascii' : 'has-invalid-chars';
          console.error(`TTS request failed (${err && err.name ? err.name : 'unknown'}${code}, key format ${keyOk}, key length ${vk.length})`);
          audioError = 'TTS failed';
        }
      }
    }

    let rel = null;
    try {
      rel = relationship.recordTurn(req.userId);
    } catch (err) {
      console.error('Relationship update failed');
    }
    const payload = { bubbles: displayBubbles, audioUrl, mood: delivery.mood, relationship: rel };
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
  if (process.env.NODE_ENV === 'production' && !readEnv('SESSION_SECRET')) {
    console.error('SESSION_SECRET is required when NODE_ENV=production. Refusing to start without it.');
    process.exit(1);
  }

  try {
    requireKeys();
  } catch (err) {
    console.error(`Missing required environment variable(s): ${(err.missing || []).join(', ')}`);
    process.exit(1);
  }

  store.ensureDirs();
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const portValue = Number.parseInt(process.env.PORT, 10);
  const port = Number.isFinite(portValue) && portValue > 0 ? portValue : 3000;
  const app = createApp();
  app.listen(port, '0.0.0.0', () => {
    console.log(`Listening on http://localhost:${port}`);
    if (GATE_ENABLED) console.log('Site gate (APP_PASSWORD) enabled; user accounts still required for chat.');
    else console.log('Site gate off; user register/login required for chat.');
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
  buildRelationshipPrompt,
  llmTimeoutMs,
  isLlmTimeout,
};
