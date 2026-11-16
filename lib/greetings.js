'use strict';

// Pre-stored first-enter greetings. The welcome copy is data, never generated:
// no LLM call and no TTS request happens while a greeting is chosen.
// Audio is optional. When a clip exists under characters/<id>/greetings/, it plays
// for free (no starlight); otherwise the first synthesis caches as usual.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'config', 'greetings.json');
const CHAR_DIR = path.join(ROOT, 'characters');
const TZ = 'Asia/Shanghai';
const SLOTS = Object.freeze(['morning', 'afternoon', 'evening']);
const SLOT_LABEL = Object.freeze({ morning: '早上', afternoon: '下午', evening: '晚上' });
const MAX_KO = 160;
const MAX_ZH = 200;
const AUDIO_RE = /^[a-z0-9][a-z0-9_-]{0,38}\.mp3$/;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/;
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

let cache = { mtime: -1, data: null };

function slotFor(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: 'numeric', hourCycle: 'h23',
  }).format(date));
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 18) return 'afternoon';
  return 'evening';
}

function cleanLine(value, { named = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ko = typeof value.ko === 'string' ? value.ko.trim().slice(0, MAX_KO) : '';
  const zh = typeof value.zh === 'string' ? value.zh.trim().slice(0, MAX_ZH) : '';
  if (!ko || !zh) return null;
  if (!HANGUL_RE.test(ko) || !HAN_RE.test(zh)) return null;
  if (named && (!ko.includes('{callName}') || !zh.includes('{callName}'))) return null;
  const line = { ko, zh };
  const audio = typeof value.audio === 'string' ? value.audio.trim() : '';
  if (audio && AUDIO_RE.test(audio)) line.audio = audio;
  return line;
}

function cleanSlots(source, options) {
  const out = {};
  for (const slot of SLOTS) {
    const raw = source && source[slot];
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    out[slot] = list.map((line) => cleanLine(line, options)).filter(Boolean);
  }
  return out;
}

// Strict: a half-written entry would otherwise ship an empty or nameless greeting.
function validateEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const slots = cleanSlots(raw.slots);
  const withName = cleanSlots(raw.withName, { named: true });
  for (const slot of SLOTS) {
    if (!slots[slot].length) return null;
    if (!withName[slot].length) return null;
  }
  const askName = cleanLine(raw.askName);
  if (!askName) return null;
  return { version: Number.isInteger(raw.version) ? raw.version : 1, slots, withName, askName };
}

function readData() {
  let stat;
  try { stat = fs.statSync(DATA_FILE); } catch (_) { return null; }
  if (cache.data && cache.mtime === stat.mtimeMs) return cache.data;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) { return null; }
  const characters = {};
  for (const [id, entry] of Object.entries((parsed && parsed.characters) || {})) {
    if (!/^[a-z0-9_-]{1,32}$/.test(id)) continue;
    const clean = validateEntry(entry);
    if (clean) characters[id] = clean;
  }
  cache = { mtime: stat.mtimeMs, data: characters };
  return characters;
}

function loadGreetings(characterId) {
  const all = readData();
  if (!all) return null;
  return all[String(characterId || '')] || null;
}

function hasAudio(characterId, line) {
  if (!line || !line.audio || !AUDIO_RE.test(line.audio)) return false;
  return fs.existsSync(path.join(CHAR_DIR, characterId, 'greetings', line.audio));
}

function fill(text, callName) {
  const name = String(callName || '').trim().slice(0, 12);
  if (!name) return String(text || '').replace(/\{callName\}\s*/g, '').trim();
  return String(text || '').replace(/\{callName\}/g, name).trim();
}

function sample(list, now) {
  if (!Array.isArray(list) || !list.length) return null;
  if (list.length === 1) return list[0];
  return list[Math.floor(now / (24 * 60 * 60 * 1000)) % list.length];
}

function greetingUrl(characterId, line) {
  if (!hasAudio(characterId, line)) return null;
  return `/characters/${characterId}/greetings/${line.audio}`;
}

// mode: 'ask' (name still unknown) or 'welcome'. Returns null when the character
// has no greetings file, so callers can keep welcomeKo / askNameKo as the fallback.
function pick(characterId, { mode = 'welcome', callName = '', now = Date.now() } = {}) {
  const entry = loadGreetings(characterId);
  if (!entry) return null;
  const slot = slotFor(new Date(now));
  if (mode === 'ask') {
    return {
      ko: entry.askName.ko,
      zh: entry.askName.zh,
      slot,
      source: 'ask',
      audioUrl: greetingUrl(characterId, entry.askName),
    };
  }
  const name = String(callName || '').trim();
  const line = name ? sample(entry.withName[slot], now) : sample(entry.slots[slot], now);
  if (!line) return null;
  return {
    ko: fill(line.ko, name),
    zh: fill(line.zh, name),
    slot,
    source: name ? 'named' : 'plain',
    audioUrl: greetingUrl(characterId, line),
  };
}

function listWithGreetings() {
  const all = readData();
  return all ? Object.keys(all).sort() : [];
}

module.exports = {
  DATA_FILE,
  SLOTS,
  SLOT_LABEL,
  TZ,
  slotFor,
  validateEntry,
  loadGreetings,
  pick,
  fill,
  greetingUrl,
  listWithGreetings,
};
