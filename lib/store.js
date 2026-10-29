'use strict';

const path = require('path');
const crypto = require('crypto');
const { createFileBackend } = require('./storage/file');

// All persistent data goes through one backend (file or libSQL/Turso), selected at init().
// Reads are served from an in-memory cache loaded at startup; writes update the cache and are
// written to the backend in order. To add another database, implement the same backend
// interface as lib/storage/file.js (init, loadAll, putUser, putDoc, delDoc, putSetting).

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_CHARACTER = 'baekhyun';
const USER_RE = /^[a-f0-9]{32}$/;
const CHAR_RE = /^[a-z0-9_-]{1,32}$/;

let backend = null;
let users = [];
const docs = new Map();
let settings = {};
let queue = Promise.resolve();
let ready = false;

const docKey = (kind, userId, characterId) => `${kind}|${userId}|${characterId}`;

function errName(err) {
  return (err && (err.code || err.name)) ? String(err.code || err.name) : 'Error';
}

function enqueue(label, fn) {
  queue = queue.then(fn).catch((err) => console.error(`Storage write failed (${label}: ${errName(err)})`));
  return queue;
}

function selectBackend() {
  const url = String(process.env.TURSO_DATABASE_URL || '').trim();
  const token = String(process.env.TURSO_AUTH_TOKEN || '').trim();
  if (url && token) {
    const { createLibsqlBackend } = require('./storage/libsql');
    return createLibsqlBackend({ url, authToken: token });
  }
  return null;
}

async function init() {
  const fileBackend = createFileBackend({ dataDir: DATA_DIR, defaultCharacter: DEFAULT_CHARACTER });
  const remote = selectBackend();
  if (remote) {
    let lastErr;
    for (let i = 0; i < 3; i += 1) {
      try { await remote.init(); lastErr = null; break; } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 1500)); }
    }
    if (lastErr) {
      console.error(`Database connection failed (${errName(lastErr)})`);
      throw new Error('storage init failed');
    }
    if (await remote.isEmpty()) {
      await fileBackend.init();
      const local = await fileBackend.loadAll();
      if (local.users.length) {
        for (const u of local.users) await remote.putUser(u);
        for (const d of local.docs) await remote.putDoc(d.kind, d.userId, d.characterId, d.data);
        for (const [k, v] of Object.entries(local.settings || {})) await remote.putSetting(k, v);
        console.log(`Imported local data into database (${local.users.length} users, ${local.docs.length} docs)`);
      }
    }
    backend = remote;
  } else {
    await fileBackend.init();
    backend = fileBackend;
  }
  const all = await backend.loadAll();
  users = all.users;
  docs.clear();
  for (const d of all.docs) docs.set(docKey(d.kind, d.userId, d.characterId), d.data);
  settings = all.settings || {};
  ready = true;
  return backend.name;
}

function storageName() { return backend ? backend.name : 'none'; }
function flush() { return queue; }
function assertReady() { if (!ready) throw new Error('storage not initialized'); }

function ensureDirs() { /* kept for compatibility; backends create what they need */ }

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function findUserByUsername(username) {
  assertReady();
  const key = normalizeUsername(username);
  if (!key) return null;
  return users.find((u) => u.username === key) || null;
}

function findUserById(id) {
  assertReady();
  if (!id) return null;
  return users.find((u) => u.id === id) || null;
}

function createUser({ username, passwordHash }) {
  assertReady();
  const key = normalizeUsername(username);
  if (users.some((u) => u.username === key)) {
    const err = new Error('username taken');
    err.code = 'USERNAME_TAKEN';
    throw err;
  }
  const user = { id: crypto.randomBytes(16).toString('hex'), username: key, passwordHash, createdAt: Date.now() };
  users.push(user);
  enqueue('user', () => backend.putUser(user));
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

function checkIds(userId, characterId) {
  if (!USER_RE.test(String(userId || '')) || !CHAR_RE.test(String(characterId || ''))) {
    const err = new Error('invalid user/character id');
    err.code = 'INVALID_USER';
    throw err;
  }
}

function getDoc(kind, userId, characterId = DEFAULT_CHARACTER) {
  assertReady();
  checkIds(userId, characterId);
  const v = docs.get(docKey(kind, userId, characterId));
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

function putDoc(kind, userId, characterId = DEFAULT_CHARACTER, data) {
  assertReady();
  checkIds(userId, characterId);
  const copy = JSON.parse(JSON.stringify(data));
  docs.set(docKey(kind, userId, characterId), copy);
  enqueue(kind, () => backend.putDoc(kind, userId, characterId, copy));
}

function delDoc(kind, userId, characterId = DEFAULT_CHARACTER) {
  assertReady();
  checkIds(userId, characterId);
  docs.delete(docKey(kind, userId, characterId));
  enqueue(kind, () => backend.delDoc(kind, userId, characterId));
}

function getSetting(key) { return settings[key]; }
function putSetting(key, value) {
  settings[key] = value;
  enqueue('setting', () => backend.putSetting(key, value));
}

function sanitizeMessages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input.slice(-500)) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue;
    if (typeof item.text !== 'string') continue;
    const text = item.text.slice(0, 4000);
    const time = typeof item.time === 'number' && Number.isFinite(item.time) ? item.time : Date.now();
    let audioUrl = null;
    if (typeof item.audioUrl === 'string' && /^\/audio\/[a-f0-9]{64}\.mp3$/.test(item.audioUrl)) {
      audioUrl = item.audioUrl;
    }
    const entry = { role: item.role, text, time, audioUrl };
    if (item.voice === true) entry.voice = true;
    if (typeof item.zh === 'string' && item.zh) entry.zh = item.zh.slice(0, 2000);
    if (typeof item.mood === 'string' && /^[a-z_]{1,20}$/.test(item.mood)) entry.mood = item.mood;
    if (item.ttsFailed === true) entry.ttsFailed = true;
    out.push(entry);
  }
  return out;
}

function getHistory(userId, characterId) {
  const data = getDoc('history', userId, characterId);
  return sanitizeMessages(data && data.messages);
}

function putHistory(userId, characterId, messages) {
  const cleaned = sanitizeMessages(messages);
  putDoc('history', userId, characterId, { messages: cleaned, updatedAt: Date.now() });
  return cleaned;
}

function deleteHistory(userId, characterId) {
  delDoc('history', userId, characterId);
  return [];
}

module.exports = {
  DATA_DIR,
  DEFAULT_CHARACTER,
  init,
  flush,
  storageName,
  ensureDirs,
  normalizeUsername,
  findUserByUsername,
  findUserById,
  createUser,
  getHistory,
  putHistory,
  deleteHistory,
  sanitizeMessages,
  getDoc,
  putDoc,
  delDoc,
  getSetting,
  putSetting,
};
