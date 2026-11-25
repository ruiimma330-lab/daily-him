'use strict';

const path = require('path');
const crypto = require('crypto');
const { createFileBackend } = require('./storage/file');
const { createWriteQueue } = require('./write-queue');
const starlight = require('./starlight');

// All persistent data goes through one backend (file or libSQL/Turso), selected at init().
// Reads are served from an in-memory cache loaded at startup; writes update the cache and are
// written to the backend in order. To add another database, implement the same backend
// interface as lib/storage/file.js (init, loadAll, putUser, putDoc, delDoc, putSetting).

const DATA_DIR = process.env.STORE_DATA_DIR
  ? path.resolve(process.env.STORE_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DEFAULT_CHARACTER = 'baekhyun';
const USER_RE = /^[a-f0-9]{32}$/;
const CHAR_RE = /^[a-z0-9_-]{1,32}$/;

let backend = null;
let users = [];
const docs = new Map();
let settings = {};
let ready = false;
let writes = null;

const docKey = (kind, userId, characterId) => `${kind}|${userId}|${characterId}`;

function errName(err) {
  return (err && (err.code || err.name)) ? String(err.code || err.name) : 'Error';
}

function ensureQueue() {
  if (writes) return writes;
  writes = createWriteQueue({
    file: path.join(DATA_DIR, 'write-queue.json'),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: async (op) => {
      if (!backend) throw new Error('storage not ready');
      if (op.type === 'putDoc') await backend.putDoc(op.kind, op.userId, op.characterId, op.data);
      else if (op.type === 'delDoc') await backend.delDoc(op.kind, op.userId, op.characterId);
      else if (op.type === 'putUser') await backend.putUser(op.user);
      else if (op.type === 'deleteUser') await backend.deleteUser(op.userId);
      else if (op.type === 'putSetting') await backend.putSetting(op.settingKey, op.value);
      else throw new Error('unknown storage op');
    },
  });
  return writes;
}

function enqueue(op) {
  ensureQueue().push({ ...op, id: crypto.randomBytes(8).toString('hex') });
}

function applyPendingToMemory() {
  for (const op of ensureQueue().pending()) {
    if (op.type === 'putDoc') docs.set(docKey(op.kind, op.userId, op.characterId), op.data);
    else if (op.type === 'delDoc') docs.delete(docKey(op.kind, op.userId, op.characterId));
    else if (op.type === 'putUser' && op.user) {
      users = users.filter((item) => item.id !== op.user.id).concat([op.user]);
    } else if (op.type === 'deleteUser') {
      users = users.filter((item) => item.id !== op.userId);
      for (const key of [...docs.keys()]) {
        if (key.split('|')[1] === op.userId) docs.delete(key);
      }
    } else if (op.type === 'putSetting') settings[op.settingKey] = op.value;
  }
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

async function init(opts = {}) {
  ready = false;
  writes = null;
  const fileBackend = createFileBackend({ dataDir: DATA_DIR, defaultCharacter: DEFAULT_CHARACTER });
  const customBackend = opts && opts.backend ? opts.backend : null;
  const remote = customBackend ? null : selectBackend();
  if (customBackend) {
    if (typeof customBackend.init === 'function') await customBackend.init();
    backend = customBackend;
  } else if (remote) {
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
  applyPendingToMemory();
  if (starlight.chooseLedger(backend) === 'sql') await starlight.bindSql(backend.db);
  else await starlight.bindFile(DATA_DIR);
  await starlight.ensureSeedCodes();
  await starlight.backfill(users.map((user) => user.id));
  ensureQueue().start();
  ready = true;
  return backend.name;
}

function storageName() { return backend ? backend.name : 'none'; }
function flush(opts) { return ensureQueue().flush(opts || {}); }
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

function updateUser(userId, patch) {
  assertReady();
  const user = users.find((u) => u.id === userId);
  if (!user) return null;
  if (typeof patch.passwordHash === 'string' && patch.passwordHash) user.passwordHash = patch.passwordHash;
  if (typeof patch.aiDisclaimerAcknowledged === 'boolean') {
    user.aiDisclaimerAcknowledged = patch.aiDisclaimerAcknowledged;
  }
  const copy = {
    id: user.id,
    username: user.username,
    passwordHash: user.passwordHash,
    createdAt: user.createdAt,
    aiDisclaimerAcknowledged: user.aiDisclaimerAcknowledged !== false,
  };
  enqueue({ type: 'putUser', key: `user|${user.id}`, user: copy });
  return { id: user.id, username: user.username };
}

function deleteUser(userId) {
  assertReady();
  if (!USER_RE.test(String(userId || ''))) return false;
  const existed = users.some((u) => u.id === userId);
  users = users.filter((u) => u.id !== userId);
  for (const key of [...docs.keys()]) {
    if (key.split('|')[1] === userId) docs.delete(key);
  }
  enqueue({ type: 'deleteUser', key: `user|${userId}`, userId });
  return existed;
}

function createUser({ username, passwordHash }) {
  assertReady();
  const key = normalizeUsername(username);
  if (users.some((u) => u.username === key)) {
    const err = new Error('username taken');
    err.code = 'USERNAME_TAKEN';
    throw err;
  }
  const user = {
    id: crypto.randomBytes(16).toString('hex'),
    username: key,
    passwordHash,
    createdAt: Date.now(),
    aiDisclaimerAcknowledged: false,
  };
  users.push(user);
  enqueue({ type: 'putUser', key: `user|${user.id}`, user });
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

function normalizeDocRow(row, fallbackUserId) {
  if (!row) return null;
  const kind = row.kind;
  const characterId = row.characterId || row.character_id;
  let data = row.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { return null; }
  }
  if (!kind || !characterId || !data || typeof data !== 'object') return null;
  return {
    kind,
    userId: row.userId || row.user_id || fallbackUserId,
    characterId,
    data,
  };
}

function overlayPendingUserDocs(userId, rows) {
  const map = new Map();
  for (const row of rows || []) {
    const normalized = normalizeDocRow(row, userId);
    if (!normalized) continue;
    map.set(docKey(normalized.kind, userId, normalized.characterId), normalized);
  }
  for (const op of ensureQueue().pending()) {
    if (op.type === 'putDoc' && op.userId === userId) {
      map.set(docKey(op.kind, userId, op.characterId), {
        kind: op.kind,
        userId,
        characterId: op.characterId,
        data: JSON.parse(JSON.stringify(op.data)),
      });
    } else if (op.type === 'delDoc' && op.userId === userId) {
      map.delete(docKey(op.kind, userId, op.characterId));
    } else if (op.type === 'deleteUser' && op.userId === userId) {
      map.clear();
    }
  }
  return [...map.values()];
}

/** Read one user's docs: Turso when available, otherwise the in-memory map. */
async function exportUserDocs(userId) {
  assertReady();
  if (!USER_RE.test(String(userId || ''))) return [];
  if (backend && typeof backend.loadUserDocs === 'function') {
    try {
      const rows = await backend.loadUserDocs(userId);
      const normalized = (rows || []).map((row) => normalizeDocRow(row, userId)).filter(Boolean);
      return overlayPendingUserDocs(userId, normalized);
    } catch (err) {
      console.error('exportUserDocs failed', err && err.message ? err.message : err);
    }
  }
  const out = [];
  for (const [key, data] of docs.entries()) {
    const parts = key.split('|');
    if (parts.length < 3 || parts[1] !== userId) continue;
    out.push({ kind: parts[0], userId, characterId: parts.slice(2).join('|'), data });
  }
  return out;
}

/** Replace this user's in-memory docs with an exported snapshot (safe no-op if empty parse). */
function hydrateUserDocs(userId, rows) {
  assertReady();
  if (!USER_RE.test(String(userId || ''))) return;
  const next = [];
  for (const row of rows || []) {
    const normalized = normalizeDocRow(row, userId);
    if (normalized) next.push(normalized);
  }
  if ((rows || []).length > 0 && next.length === 0) return;
  const merged = overlayPendingUserDocs(userId, next);
  for (const key of [...docs.keys()]) {
    if (key.split('|')[1] === userId) docs.delete(key);
  }
  for (const row of merged) {
    docs.set(docKey(row.kind, userId, row.characterId), row.data);
  }
}

async function refreshUserDocs(userId) {
  const rows = await exportUserDocs(userId);
  hydrateUserDocs(userId, rows);
}

/** Character ids that have a stored doc of `kind` for this user. */
function listDocCharacterIds(kind, userId) {
  assertReady();
  if (!USER_RE.test(String(userId || ''))) return [];
  const prefix = `${kind}|${userId}|`;
  const ids = [];
  for (const key of docs.keys()) {
    if (!key.startsWith(prefix)) continue;
    const characterId = key.slice(prefix.length);
    if (CHAR_RE.test(characterId)) ids.push(characterId);
  }
  return ids;
}

function putDoc(kind, userId, characterId = DEFAULT_CHARACTER, data) {
  assertReady();
  checkIds(userId, characterId);
  const copy = JSON.parse(JSON.stringify(data));
  docs.set(docKey(kind, userId, characterId), copy);
  enqueue({ type: 'putDoc', key: docKey(kind, userId, characterId), kind, userId, characterId, data: copy });
}

function delDoc(kind, userId, characterId = DEFAULT_CHARACTER) {
  assertReady();
  checkIds(userId, characterId);
  docs.delete(docKey(kind, userId, characterId));
  enqueue({ type: 'delDoc', key: docKey(kind, userId, characterId), kind, userId, characterId });
}

function getSetting(key) { return settings[key]; }
function putSetting(key, value) {
  settings[key] = value;
  enqueue({ type: 'putSetting', key: `setting|${key}`, settingKey: key, value });
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
    if (
      typeof item.audioUrl === 'string' &&
      (/^\/audio\/[a-f0-9]{64}\.mp3$/.test(item.audioUrl) ||
        /^\/singing\/[a-z0-9_-]{1,32}\/[a-z0-9][a-z0-9_-]{0,60}\.mp3$/i.test(item.audioUrl))
    ) {
      audioUrl = item.audioUrl;
    }
    const entry = { role: item.role, text, time, audioUrl };
    if (typeof item.turnId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(item.turnId)) entry.turnId = item.turnId;
    if (item.voice === true) entry.voice = true;
    if (typeof item.zh === 'string' && item.zh) entry.zh = item.zh.slice(0, 2000);
    if (typeof item.mood === 'string' && /^[a-z_]{1,20}$/.test(item.mood)) entry.mood = item.mood;
    if (item.ttsFailed === true) entry.ttsFailed = true;
    if (item.fallback === true) entry.fallback = true;
    if (item.proactive === true) entry.proactive = true;
    if (typeof item.checkinKind === 'string' && /^(ask|life|scene)$/.test(item.checkinKind)) {
      entry.checkinKind = item.checkinKind;
    }
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
  updateUser,
  deleteUser,
  getHistory,
  putHistory,
  deleteHistory,
  sanitizeMessages,
  getDoc,
  listDocCharacterIds,
  exportUserDocs,
  hydrateUserDocs,
  overlayPendingUserDocs,
  refreshUserDocs,
  putDoc,
  delDoc,
  getSetting,
  putSetting,
};
