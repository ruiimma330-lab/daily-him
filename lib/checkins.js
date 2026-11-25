'use strict';

// Idle check-ins: when a friend has been quiet for a while, the idol can
// leave one short proactive line in history (no LLM, no starlight).

const fs = require('fs');
const path = require('path');
const store = require('./store');
const profile = require('./profile');
const greetings = require('./greetings');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'config', 'checkins.json');
const KINDS = Object.freeze(['ask', 'life', 'scene']);
const DEFAULT_IDLE_MS = 8 * 60 * 60 * 1000;
const TZ = 'Asia/Shanghai';

function dayKey(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}
const MAX_KO = 180;
const MAX_ZH = 220;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/;
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

let cache = { mtime: -1, data: null };

function idleMs() {
  const raw = Number(process.env.CHECKIN_IDLE_MS);
  if (Number.isFinite(raw) && raw >= 60 * 60 * 1000) return Math.floor(raw);
  return DEFAULT_IDLE_MS;
}

function cleanLine(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ko = typeof value.ko === 'string' ? value.ko.trim().slice(0, MAX_KO) : '';
  const zh = typeof value.zh === 'string' ? value.zh.trim().slice(0, MAX_ZH) : '';
  if (!ko || !zh) return null;
  if (!HANGUL_RE.test(ko) || !HAN_RE.test(zh)) return null;
  const kind = KINDS.includes(value.kind) ? value.kind : 'ask';
  return { ko, zh, kind };
}

function readData() {
  let stat;
  try { stat = fs.statSync(DATA_FILE); } catch (_) { return { shared: [], characters: {} }; }
  if (cache.data && cache.mtime === stat.mtimeMs) return cache.data;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {
    return { shared: [], characters: {} };
  }
  const shared = Array.isArray(parsed.shared)
    ? parsed.shared.map(cleanLine).filter(Boolean)
    : [];
  const characters = {};
  for (const [id, list] of Object.entries((parsed && parsed.characters) || {})) {
    if (!/^[a-z0-9_-]{1,32}$/.test(id) || !Array.isArray(list)) continue;
    characters[id] = list.map(cleanLine).filter(Boolean);
  }
  cache = { mtime: stat.mtimeMs, data: { shared, characters } };
  return cache.data;
}

function poolFor(characterId) {
  const data = readData();
  const own = data.characters[String(characterId || '')] || [];
  return own.length ? own.concat(data.shared) : data.shared.slice();
}

function pickLine(characterId, now = Date.now()) {
  const pool = poolFor(characterId);
  if (!pool.length) return null;
  const day = Math.floor(now / (24 * 60 * 60 * 1000));
  const kindIndex = day % KINDS.length;
  const preferred = pool.filter((line) => line.kind === KINDS[kindIndex]);
  const use = preferred.length ? preferred : pool;
  return use[(day + characterId.length) % use.length];
}

function lastActivityAt(history) {
  if (!Array.isArray(history) || !history.length) return 0;
  let latest = 0;
  for (const item of history) {
    // Proactive check-ins do not reset the idle clock.
    if (!item || item.proactive === true) continue;
    const t = Number(item.time);
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest;
}

function alreadyCheckedInToday(history, day) {
  if (!Array.isArray(history)) return false;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (!item || item.role !== 'assistant' || item.proactive !== true) continue;
    if (dayKey(Number(item.time) || Date.now()) === day) return true;
  }
  return false;
}

function maybeAppend({ userId, characterId, now = Date.now() }) {
  const prof = profile.load(userId, characterId);
  if (!prof.onboardedAt) return { ok: true, appended: false, reason: 'not-onboarded' };

  const history = store.getHistory(userId, characterId);
  if (!history.length) return { ok: true, appended: false, reason: 'empty' };

  const day = dayKey(now);
  if (alreadyCheckedInToday(history, day)) {
    return { ok: true, appended: false, reason: 'today' };
  }

  const idle = idleMs();
  const lastAt = lastActivityAt(history);
  if (!lastAt || now - lastAt < idle) {
    return { ok: true, appended: false, reason: 'fresh', idleMs: idle, lastAt };
  }

  const line = pickLine(characterId, now);
  if (!line) return { ok: true, appended: false, reason: 'no-copy' };

  const callName = profile.callNameFor(userId, characterId);
  const message = {
    role: 'assistant',
    text: greetings.fill(line.ko, callName),
    time: now,
    audioUrl: null,
    zh: greetings.fill(line.zh, callName),
    proactive: true,
    checkinKind: line.kind,
  };
  const next = store.putHistory(userId, characterId, history.concat([message]));
  return {
    ok: true,
    appended: true,
    message,
    kind: line.kind,
    history: next,
  };
}

module.exports = {
  DATA_FILE,
  KINDS,
  idleMs,
  pickLine,
  lastActivityAt,
  maybeAppend,
  readData,
};
