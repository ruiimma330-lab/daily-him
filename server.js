const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const store = require('./lib/store');
const relationship = require('./lib/relationship');
const characters = require('./lib/characters');
const memory = require('./lib/memory');
const moments = require('./lib/moments');
const profile = require('./lib/profile');
const wallet = require('./lib/wallet');
const prefs = require('./lib/prefs');
const { readAccountDoc, writeAccountDoc, deleteAccountDoc } = require('./lib/account-scope');
const chatContext = require('./lib/chat-context');
const PKG = require('./package.json');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const AUDIO_DIR = path.join(ROOT, 'cache', 'audio');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const BCRYPT_ROUNDS = 10;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const HISTORY_BODY_LIMIT = '1mb';

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

function resolveRuntimeConfig(characterId = characters.DEFAULT_CHARACTER) {
  let meta = {};
  try { meta = characters.loadMeta(characterId); } catch (_) { meta = {}; }
  const file = { ...readConfigFile(), ...meta };
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

// Small DeepSeek helper for background memory work (never logs the key).
function makeLlm(chatKey, model) {
  return async (messages, opts = {}) => {
    const body = { model, temperature: opts.temperature ?? 0.3, messages };
    if (opts.json) body.response_format = { type: 'json_object' };
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${chatKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(llmTimeoutMs()),
    });
    console.log(`Memory LLM call (${opts.json ? 'extract' : 'summary'}) status ${r.status}`);
    if (!r.ok) throw new Error(`llm ${r.status}`);
    const d = await r.json();
    return d && d.choices && d.choices[0] && d.choices[0].message ? d.choices[0].message.content : '';
  };
}

// JSON mode needs prior assistant turns in the same JSON shape, or DeepSeek returns blanks.
function toLlmMessages(recent) {
  const out = [];
  for (const m of recent) {
    if (m.role === 'assistant') {
      const prev = out[out.length - 1];
      const item = { ko: m.content, zh: m.zh || '' };
      if (prev && prev.role === 'assistant' && prev._items) prev._items.push(item);
      else out.push({ role: 'assistant', _items: [item] });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out.map((m) => (m._items ? { role: 'assistant', content: JSON.stringify({ messages: m._items }) } : m));
}

// Vary how many clips a reply has: short inputs lean to 1, longer ones to 2-3.
function suggestCount(text) {
  const len = String(text || '').trim().length;
  const r = Math.random();
  if (len <= 6) return r < 0.6 ? 1 : (r < 0.9 ? 2 : 3);
  if (len <= 20) return r < 0.3 ? 1 : (r < 0.75 ? 2 : 3);
  return r < 0.2 ? 1 : (r < 0.6 ? 2 : 3);
}

function dayPeriod(date = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' }).format(date));
  if (h >= 5 && h < 11) return '아침';
  if (h >= 11 && h < 14) return '점심';
  if (h >= 14 && h < 18) return '오후';
  if (h >= 18 && h < 23) return '저녁/밤';
  return '늦은 밤(새벽)';
}

function recentOpenings(recent) {
  return recent.filter((m) => m.role === 'assistant').slice(-4)
    .map((m) => String(m.content).replace(/\[\[[\s\S]*?\]\]/g, '').trim().split('\n')[0].slice(0, 14))
    .filter(Boolean);
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

// Reply format: {"messages":[{"mood","ko","zh"}]} (1-3). Falls back to the legacy
// "[[mood:x]]\nline\nline" text format if the model doesn't return JSON.
function parseReply(text, config) {
  const tags = (config && config.moodTags) || {};
  const pickMood = (m) => {
    const v = String(m || '').toLowerCase().trim();
    return tags[v] ? v : (config && config.defaultMood) || v || '';
  };
  let data = null;
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) { try { data = JSON.parse(m[0]); } catch (_) { data = null; } }
  const list = data && Array.isArray(data.messages) ? data.messages : null;
  if (list) {
    return list.slice(0, 3).map((x) => {
      const raw = String((x && x.ko) || '').replace(/\[\[[\s\S]*?\]\]/g, '').trim();
      return { raw, ko: stripAudioTags(raw), zh: String((x && x.zh) || '').trim().slice(0, 600), mood: pickMood(x && x.mood) };
    }).filter((x) => x.ko);
  }
  const legacy = parseMood(text);
  return splitBubbles(legacy.text).slice(0, 3).map((raw) => ({ raw, ko: stripAudioTags(raw), zh: '', mood: pickMood(legacy.mood) })).filter((x) => x.ko);
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
let SESSION_SECRET = readEnv('SESSION_SECRET') || crypto.randomBytes(32).toString('hex');

// Without SESSION_SECRET, keep a generated secret in storage so logins survive restarts.
function loadSessionSecret() {
  if (readEnv('SESSION_SECRET')) return;
  const saved = store.getSetting('session_secret');
  if (typeof saved === 'string' && saved.length >= 32) { SESSION_SECRET = saved; return; }
  store.putSetting('session_secret', SESSION_SECRET);
}
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
  '/api/health',
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

function isLegalPath(p) {
  return p === '/legal/privacy.html' || p === '/legal/terms.html';
}

function isBrandPath(p) {
  return p.startsWith('/brand/');
}

function isPwaAsset(p) {
  return p === '/sw.js' || p === '/pwa.js' || p === '/pwa.css' || p === '/offline.html'
    || p === '/app.js' || p === '/style.css' || p === '/moments.css' || p === '/moments.js' || p === '/memory.js'
    || p.startsWith('/me/')
    || p.startsWith('/shell/');
}

function isPublicPath(p) {
  return PUBLIC_PATHS.has(p)
    || p.startsWith('/icons/')
    || p.startsWith('/brand/')
    || isPwaAsset(p)
    || isLegalPath(p)
    || p === '/shell/cover.html'
    || p === '/shell/shell.css'
    || p === '/shell/shell.js'
    || p === '/shell/copy.json';
}

function isGatePublicPath(p) {
  return (
    p === '/login'
    || p === '/login.html'
    || p === '/api/site-login'
    || p === '/api/auth-config'
    || p === '/manifest.webmanifest'
    || p.startsWith('/icons/')
    || isBrandPath(p)
    || isPwaAsset(p)
    || isLegalPath(p)
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
  if (p === '/' || p === '/index.html') return res.redirect('/shell/cover.html');
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

function requireCharacter(req, res, next) {
  const raw = (req.query && req.query.characterId) || (req.body && req.body.characterId) || '';
  if (!String(raw).trim()) return res.status(400).json({ error: 'characterId required' });
  const id = characters.resolveId(raw);
  if (!id) return res.status(404).json({ error: 'unknown character' });
  req.characterId = id;
  return next();
}

function requireAvailable(req, res, next) {
  if (!characters.isAvailable(req.characterId)) {
    return res.status(404).json({ error: 'character unavailable' });
  }
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
    const entry = { role: message.role, content };
    if (message.role === 'assistant' && typeof message.zh === 'string') entry.zh = message.zh.slice(0, 2000);
    cleaned.push(entry);
  }
  return cleaned.slice(-20);
}

const synthInflight = new Map();

async function synthesize(voiceId, model, text, apiKey, voiceSettings) {
  const hash = audioFileHash(voiceId, model, text);
  const filename = `${hash}.mp3`;
  const filePath = path.join(AUDIO_DIR, filename);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return `/audio/${filename}`;
  }
  const pending = synthInflight.get(hash);
  if (pending) return pending;
  const job = requestTts(voiceId, model, text, apiKey, voiceSettings, hash, filename, filePath)
    .finally(() => { synthInflight.delete(hash); });
  synthInflight.set(hash, job);
  return job;
}

async function requestTts(voiceId, model, text, apiKey, voiceSettings, hash, filename, filePath) {
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
    if (!validateUsername(username) || !validatePassword(password) || !req.body || req.body.age14 !== true) {
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
    const avatar = readAccountDoc(store, 'avatar', req.userId);
    res.json({ ok: true, user: req.user, hasAvatar: Boolean(avatar && avatar.data) });
  });

  function readUserJpeg(body) {
    let raw = body && typeof body.image === 'string' ? body.image.trim() : '';
    const wrapped = raw.match(/^data:image\/jpeg;base64,([\s\S]+)$/i);
    if (wrapped) raw = wrapped[1];
    raw = raw.replace(/\s/g, '');
    if (!raw || raw.length > 160000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
    const buf = Buffer.from(raw, 'base64');
    if (buf.length < 64 || buf.length > 120000) return null;
    if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
    return buf;
  }

  app.get('/api/me/avatar', requireUser, (req, res) => {
    const avatar = readAccountDoc(store, 'avatar', req.userId);
    if (!avatar || typeof avatar.data !== 'string') return res.status(404).end();
    const buf = Buffer.from(avatar.data, 'base64');
    if (buf.length < 64 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(404).end();
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(buf);
  });

  app.put('/api/me/avatar', requireUser, (req, res) => {
    const buf = readUserJpeg(req.body);
    if (!buf) return res.status(400).json({ error: 'jpeg required' });
    writeAccountDoc(store, 'avatar', req.userId, { data: buf.toString('base64'), updatedAt: Date.now() });
    return res.json({ ok: true });
  });

  app.delete('/api/me/avatar', requireUser, (req, res) => {
    deleteAccountDoc(store, 'avatar', req.userId);
    return res.json({ ok: true });
  });

  app.get('/api/me/settings', requireUser, (req, res) => {
    res.json({ ok: true, settings: prefs.load(req.userId) });
  });

  app.put('/api/me/settings', requireUser, (req, res) => {
    try {
      return res.json({ ok: true, settings: prefs.save(req.userId, req.body || {}) });
    } catch (err) {
      if (err && String(err.code || '').startsWith('BAD_')) return res.status(400).json({ error: err.code });
      throw err;
    }
  });

  app.put('/api/me/password', requireUser, async (req, res) => {
    const oldPassword = req.body && req.body.oldPassword;
    const newPassword = req.body && req.body.newPassword;
    if (typeof oldPassword !== 'string' || !oldPassword || !validatePassword(newPassword)) {
      return res.status(400).json({ error: 'Invalid password' });
    }
    const user = store.findUserById(req.userId);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const matches = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!matches) return res.status(401).json({ error: 'Unauthorized' });
    store.updateUser(req.userId, { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) });
    return res.json({ ok: true });
  });

  app.delete('/api/me', requireUser, (req, res) => {
    const confirm = req.body && typeof req.body.confirm === 'string' ? req.body.confirm.trim() : '';
    if (confirm !== '注销') return res.status(400).json({ error: 'confirm required' });
    store.deleteUser(req.userId);
    clearSessionCookie(req, res);
    return res.json({ ok: true });
  });

  app.get('/api/feedback', requireUser, (req, res) => {
    const doc = readAccountDoc(store, 'feedback', req.userId) || { items: [] };
    res.json({ ok: true, items: Array.isArray(doc.items) ? doc.items : [] });
  });

  app.post('/api/feedback', requireUser, (req, res) => {
    const text = req.body && typeof req.body.text === 'string' ? req.body.text.trim() : '';
    const kind = req.body && req.body.kind === 'report' ? 'report' : 'feedback';
    if (!text || text.length > 1000) return res.status(400).json({ error: 'text required' });
    const doc = readAccountDoc(store, 'feedback', req.userId) || { items: [] };
    const items = Array.isArray(doc.items) ? doc.items.slice(-29) : [];
    const item = { id: crypto.randomBytes(6).toString('hex'), kind, text, createdAt: Date.now() };
    items.push(item);
    writeAccountDoc(store, 'feedback', req.userId, { items });
    return res.status(201).json({ ok: true, item });
  });

  app.get('/api/about', requireUser, (req, res) => {
    res.json({
      ok: true,
      version: typeof PKG.version === 'string' ? PKG.version : '',
      notice: 'AI 模拟角色，非本人',
    });
  });

  app.get('/api/history', requireUser, requireCharacter, requireAvailable, (req, res) => {
    const messages = store.getHistory(req.userId, req.characterId);
    res.json({ messages });
  });

  app.put('/api/history', requireUser, requireCharacter, requireAvailable, (req, res) => {
    const messages = store.putHistory(req.userId, req.characterId, req.body && req.body.messages);
    res.json({ messages });
  });

  app.delete('/api/history', requireUser, requireCharacter, requireAvailable, async (req, res) => {
    store.deleteHistory(req.userId, req.characterId);
    if (req.query.summary === '1') await memory.clearSummary(req.userId, req.characterId);
    res.json({ messages: [], summaryCleared: req.query.summary === '1' });
  });

  app.delete('/api/histories', requireUser, async (req, res) => {
    if (!req.body || req.body.confirm !== 'CLEAR') return res.status(400).json({ error: 'confirm required' });
    const ids = characters.list().map((item) => item.id);
    for (const id of ids) {
      store.deleteHistory(req.userId, id);
      await memory.clearSummary(req.userId, id);
    }
    res.json({ ok: true, cleared: ids });
  });

  app.get('/api/relationship', requireUser, requireCharacter, (req, res) => {
    res.json({ ok: true, relationship: relationship.view(relationship.load(req.userId, req.characterId), Date.now(), req.characterId) });
  });

  app.delete('/api/relationship', requireUser, requireCharacter, (req, res) => {
    if (!req.body || req.body.confirm !== 'RESET') return res.status(400).json({ error: 'confirm required' });
    relationship.reset(req.userId, req.characterId);
    res.json({ ok: true, relationship: relationship.view(relationship.load(req.userId, req.characterId), Date.now(), req.characterId) });
  });

  app.get('/api/memory', requireUser, requireCharacter, (req, res) => {
    res.json({ ok: true, ...memory.publicView(memory.load(req.userId, req.characterId)) });
  });

  app.delete('/api/memory/:id', requireUser, requireCharacter, async (req, res) => {
    if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).json({ error: 'bad id' });
    const ok = await memory.deleteCard(req.userId, req.characterId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true, ...memory.publicView(memory.load(req.userId, req.characterId)) });
  });

  app.delete('/api/memory', requireUser, requireCharacter, async (req, res) => {
    if (!req.body || req.body.confirm !== 'CLEAR') return res.status(400).json({ error: 'confirm required' });
    await memory.clearAll(req.userId, req.characterId);
    return res.json({ ok: true, ...memory.publicView(memory.load(req.userId, req.characterId)) });
  });

  app.get('/api/moments', requireUser, requireCharacter, requireAvailable, (req, res) => {
    res.json({ ok: true, posts: moments.list(req.userId, req.characterId) });
  });

  app.post('/api/moments/:id/like', requireUser, requireCharacter, requireAvailable, (req, res) => {
    const result = moments.toggleLike(req.userId, req.characterId, req.params.id);
    if (!result) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true, ...result });
  });

  app.get('/api/moments/:id/comments', requireUser, requireCharacter, requireAvailable, (req, res) => {
    if (!moments.loadPosts(req.characterId).some((p) => p.id === req.params.id)) {
      return res.status(404).json({ error: 'not found' });
    }
    res.json({ ok: true, comments: moments.commentsFor(req.userId, req.characterId, req.params.id) });
  });

  app.post('/api/moments/:id/comments', requireUser, requireCharacter, requireAvailable, async (req, res) => {
    let comment;
    try {
      comment = moments.addComment(req.userId, req.characterId, req.params.id, req.body && req.body.text);
    } catch (err) {
      if (err.code === 'EMPTY') return res.status(400).json({ error: 'text required' });
      if (err.code === 'LIMIT') return res.status(400).json({ error: 'too many comments' });
      throw err;
    }
    if (!comment) return res.status(404).json({ error: 'not found' });

    const wantReply = req.body && req.body.reply !== false;
    let reply = null;
    if (wantReply) {
      try {
        const keys = requireKeys();
        const config = resolveRuntimeConfig(req.characterId);
        const meta = characters.loadMeta(req.characterId);
        const task = moments.maybeReply({
          userId: req.userId,
          characterId: req.characterId,
          postId: req.params.id,
          comment,
          llm: makeLlm(keys.chatKey, config.llmModel),
          userName: profile.callNameFor(req.userId, req.characterId) || meta.defaultUserName || '',
        });
        if (process.env.MOMENTS_SYNC === '1') reply = await task;
        else task.catch(() => {});
      } catch (err) {
        console.error('Moments reply skipped');
      }
    }
    return res.json({
      ok: true,
      comment: {
        id: comment.id,
        text: comment.text,
        createdAt: comment.createdAt,
        reply: reply || comment.reply || null,
      },
    });
  });

  app.get('/api/profile', requireUser, requireCharacter, (req, res) => {
    res.json({ ok: true, profile: profile.load(req.userId, req.characterId) });
  });

  app.put('/api/profile', requireUser, requireCharacter, (req, res) => {
    const body = req.body || {};
    const saved = profile.save(req.userId, req.characterId, body);
    res.json({ ok: true, profile: saved });
  });

  app.get('/api/wallet', requireUser, (req, res) => {
    res.json({ ok: true, ...wallet.load(req.userId) });
  });

  app.post('/api/wallet/purchase', requireUser, (req, res) => {
    try {
      const result = wallet.purchase(req.userId, req.body && req.body.packageId);
      return res.json({ ok: true, ...result });
    } catch (err) {
      if (err.code === 'UNKNOWN_PACKAGE') return res.status(400).json({ error: 'unknown package' });
      throw err;
    }
  });

  app.get('/api/scenes', requireUser, requireCharacter, requireAvailable, (req, res) => {
    const scenes = characters.loadScenes(req.characterId).map(({ id, label, hintZh, messageKo }) => ({ id, label, hintZh, messageKo }));
    res.json({ ok: true, scenes });
  });

  app.get('/api/characters', requireUser, (req, res) => {
    res.json({ ok: true, defaultId: characters.DEFAULT_CHARACTER, characters: characters.list() });
  });

  app.get('/characters/:id/avatar', requireUser, (req, res) => {
    const id = characters.resolveId(req.params.id);
    if (!id) return res.status(404).end();
    const meta = characters.loadMeta(id);
    const name = path.basename(String(meta.avatar || 'avatar.svg'));
    if (!name || name === '.' || name === '..') return res.status(404).end();
    const candidates = [
      path.join(PUBLIC_DIR, 'characters', id, name),
      path.join(characters.CHAR_DIR, id, name),
    ];
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    if (!file) return res.status(404).end();
    return res.sendFile(file);
  });

  app.get('/api/health', (req, res) => {
    if (!getSession(req)) return res.json({ ok: true, storage: store.storageName() });
    const raw = req.query && req.query.characterId;
    if (raw == null || String(raw).trim() === '') {
      return res.json({ ok: true, storage: store.storageName() });
    }
    const id = characters.resolveId(raw);
    if (!id) return res.status(404).json({ error: 'unknown character' });
    const config = resolveRuntimeConfig(id);
    res.json({
      ok: true,
      model: config.llmModel,
      voiceId: config.voiceId,
      ttsModel: config.ttsModel,
      storage: store.storageName(),
    });
  });

  // On-demand TTS. Chat sends voice:false so unplayed replies do not spend credits.
  app.post('/api/tts', requireUser, requireCharacter, requireAvailable, async (req, res) => {
    let keys;
    try {
      keys = requireKeys();
    } catch (err) {
      console.error(`Missing required environment variable(s): ${(err.missing || []).join(', ')}`);
      return res.status(500).json({ error: 'Server is not configured' });
    }

    const config = resolveRuntimeConfig(req.characterId);
    if (!voiceReady(config.voiceId)) {
      return res.status(503).json({ error: 'Voice is not configured', audioError: 'Voice is not configured' });
    }

    const rawText = req.body && typeof req.body.text === 'string' ? req.body.text : '';
    const mood = req.body && typeof req.body.mood === 'string' ? req.body.mood.slice(0, 20) : '';
    const speech = toSpeechText([stripAudioTags(rawText)]).slice(0, 1000);
    if (!speech || !isSpeakable(speech)) {
      return res.status(400).json({ error: 'nothing to speak' });
    }

    const ttsText = `${moodDelivery(config, mood).prefix} ${speech}`.trim();
    try {
      const audioUrl = await synthesize(config.voiceId, config.ttsModel, ttsText, keys.voiceKey, config.voiceSettings);
      return res.json({ audioUrl });
    } catch (err) {
      const code = err && err.cause && err.cause.code ? ` cause=${String(err.cause.code)}` : '';
      const vk = keys.voiceKey || '';
      const keyOk = /^[\x21-\x7e]+$/.test(vk) ? 'ascii' : 'has-invalid-chars';
      console.error(`TTS request failed (${err && err.name ? err.name : 'unknown'}${code}, key format ${keyOk}, key length ${vk.length})`);
      return res.status(502).json({ error: 'TTS failed', audioError: 'TTS failed' });
    }
  });

  app.post('/api/chat', requireUser, requireCharacter, requireAvailable, async (req, res) => {
    const text = req.body && typeof req.body.text === 'string' ? req.body.text.trim() : '';
    const recent = chatContext.fromHistory(store.getHistory(req.userId, req.characterId), text);
    if (!recent) {
      return res.status(400).json({ error: 'text required' });
    }

    let keys;
    try {
      keys = requireKeys();
    } catch (err) {
      console.error(`Missing required environment variable(s): ${(err.missing || []).join(', ')}`);
      return res.status(500).json({ error: 'Server is not configured' });
    }

    const config = resolveRuntimeConfig(req.characterId);
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit' });
    const relNow = relationship.view(relationship.load(req.userId, req.characterId), Date.now(), req.characterId);
    const lastUserText = text;
    const sceneId = req.body && typeof req.body.sceneId === 'string' ? req.body.sceneId.slice(0, 40) : '';
    const scene = sceneId ? characters.findScene(req.characterId, sceneId) : null;
    const sceneHint = scene && scene.promptHint
      ? `\n\n## 지금 상황\n사용자가 장면 버튼「${scene.label}」을 눌렀어. ${scene.promptHint} 시스템·설정 이야기는 하지 마.`
      : '';
    const userName = profile.callNameFor(req.userId, req.characterId);
    const memBlock = memory.promptBlock(req.userId, req.characterId, lastUserText, userName);
    const openings = [...new Set([...memory.recentOpenings(req.userId, req.characterId), ...recentOpenings(recent)])].slice(-6);
    const want = suggestCount(lastUserText);
    const memoryPrompt = (memBlock ? `\n\n${memBlock}` : '')
      + (openings.length ? `\n\n## 반복 피하기\n네 최근 답장 첫머리: ${openings.map((o) => `「${o}」`).join(' ')}\n이번 답장은 이것들과 다른 말로 시작하고, 다른 문장 구조로 말해.` : '')
      + `\n\n## 이번 답장\n이번엔 음성 ${want}개로 보내(상황상 정말 어색하면 ±1).`;
    const systemPrompt = characters.buildPrompt(req.characterId, relNow.tier.id, relNow, userName) + memoryPrompt + sceneHint + `\n\n## 현재 시각\n지금은 ${now} (베이징 시간)이고, 지금 시간대는 '${dayPeriod()}'야. 인사, 식사, 잠 이야기, '아침부터/오늘 밤' 같은 표현은 반드시 이 시간대에 맞게 해(예: 저녁에 '아침부터'라고 하지 마). 날짜/요일 계산도 이것을 기준으로 해. 공개 사실 목록 이후의 일은 모른다고 해.`;
    let replyText = '';

    for (let attempt = 0; attempt < 2 && !replyText.trim(); attempt += 1) {
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keys.chatKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.llmModel,
          temperature: 1.0,
          reasoning_effort: process.env.LLM_EFFORT || 'low',
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: systemPrompt }, ...toLlmMessages(recent)],
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
      if (!replyText.trim()) console.error('LLM returned a blank reply');
    }

    const items = parseReply(replyText, config);
    if (!items.length) {
      console.error('LLM request failed (empty reply after parsing)');
      if (process.env.DEBUG_REPLY === '1') console.error(`raw reply: ${String(replyText).slice(0, 500)}`);
      return res.status(502).json({ error: GENERIC_LLM_ERROR });
    }

    const voiceOff = Boolean(req.body && req.body.voice === false);
    let audioError;
    let ttsChars = 0;
    const voiceOk = voiceReady(config.voiceId);
    if (!voiceOff && !voiceOk) audioError = 'Voice is not configured';
    // One TTS clip per message, in parallel; each with its own mood tag.
    await Promise.all(items.map(async (item) => {
      item.audioUrl = null;
      const speech = toSpeechText([item.raw]);
      if (voiceOff || !voiceOk || !isSpeakable(speech)) return;
      const ttsText = `${moodDelivery(config, item.mood).prefix} ${speech}`.trim();
      ttsChars += ttsText.length;
      try {
        item.audioUrl = await synthesize(config.voiceId, config.ttsModel, ttsText, keys.voiceKey, config.voiceSettings);
      } catch (err) {
        const code = err && err.cause && err.cause.code ? ` cause=${String(err.cause.code)}` : '';
        const vk = keys.voiceKey || '';
        const keyOk = /^[\x21-\x7e]+$/.test(vk) ? 'ascii' : 'has-invalid-chars';
        console.error(`TTS request failed (${err && err.name ? err.name : 'unknown'}${code}, key format ${keyOk}, key length ${vk.length})`);
        item.ttsFailed = true;
        audioError = 'TTS failed';
      }
    }));
    if (ttsChars) console.log(`TTS chars this turn: ${ttsChars}`);
    const displayBubbles = items.map((it) => it.ko);
    const outMessages = items.map((it) => ({ ko: it.ko, zh: it.zh, mood: it.mood, audioUrl: it.audioUrl, ttsFailed: Boolean(it.ttsFailed) }));
    const audioUrl = outMessages.length && outMessages[0].audioUrl ? outMessages[0].audioUrl : null;

    try {
      store.putHistory(
        req.userId,
        req.characterId,
        chatContext.appendTurn(store.getHistory(req.userId, req.characterId), lastUserText, items),
      );
    } catch (err) {
      console.error('History update failed');
    }

    let rel = null;
    try {
      rel = relationship.recordTurn(req.userId, req.characterId);
    } catch (err) {
      console.error('Relationship update failed');
    }
    memory.noteOpening(req.userId, req.characterId, displayBubbles[0]);
    const memTask = memory.afterTurn({
      userId: req.userId,
      characterId: req.characterId,
      userText: lastUserText,
      replyText: displayBubbles.join('\n'),
      llm: makeLlm(keys.chatKey, config.llmModel),
      userName,
      getHistory: () => store.getHistory(req.userId, req.characterId),
    });
    if (process.env.MEMORY_SYNC === '1') await memTask; // tests only
    const payload = { messages: outMessages, bubbles: displayBubbles, audioUrl, mood: items[0].mood, ttsChars, relationship: rel };
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

async function main() {
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

  try {
    const kind = await store.init();
    console.log(`Storage: ${kind}`);
  } catch (err) {
    console.error('Storage could not start; exiting.');
    process.exit(1);
  }
  loadSessionSecret();
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
  const shutdown = () => { store.flush().finally(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  createApp,
  loadSessionSecret,
  parseMood,
  splitBubbles,
  stripAudioTags,
  toSpeechText,
  toLlmMessages,
  dayPeriod,
  isSpeakable,
  parseReply,
  resolveRuntimeConfig,
  audioFileHash,
  voiceReady,
  buildPrompt: characters.buildPrompt,
  llmTimeoutMs,
  isLlmTimeout,
};
