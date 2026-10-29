'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function atomicWrite(filePath, data) {
  ensureDirs();
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function loadUsers() {
  const data = readJson(USERS_PATH, { users: [] });
  if (!data || !Array.isArray(data.users)) return { users: [] };
  return data;
}

function saveUsers(data) {
  atomicWrite(USERS_PATH, `${JSON.stringify(data, null, 2)}\n`);
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function findUserByUsername(username) {
  const key = normalizeUsername(username);
  if (!key) return null;
  return loadUsers().users.find((u) => u.username === key) || null;
}

function findUserById(id) {
  if (!id) return null;
  return loadUsers().users.find((u) => u.id === id) || null;
}

function createUser({ username, passwordHash }) {
  const key = normalizeUsername(username);
  const users = loadUsers();
  if (users.users.some((u) => u.username === key)) {
    const err = new Error('username taken');
    err.code = 'USERNAME_TAKEN';
    throw err;
  }
  const user = {
    id: crypto.randomBytes(16).toString('hex'),
    username: key,
    passwordHash,
    createdAt: Date.now(),
  };
  users.users.push(user);
  saveUsers(users);
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

function historyPath(userId) {
  if (!/^[a-f0-9]{32}$/.test(String(userId || ''))) {
    const err = new Error('invalid user id');
    err.code = 'INVALID_USER';
    throw err;
  }
  return path.join(HISTORY_DIR, `${userId}.json`);
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
    out.push({ role: item.role, text, time, audioUrl });
  }
  return out;
}

function getHistory(userId) {
  ensureDirs();
  const data = readJson(historyPath(userId), { messages: [] });
  return sanitizeMessages(data && data.messages);
}

function putHistory(userId, messages) {
  ensureDirs();
  const cleaned = sanitizeMessages(messages);
  atomicWrite(historyPath(userId), `${JSON.stringify({ messages: cleaned, updatedAt: Date.now() }, null, 2)}\n`);
  return cleaned;
}

function deleteHistory(userId) {
  ensureDirs();
  const file = historyPath(userId);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return [];
}

module.exports = {
  DATA_DIR,
  ensureDirs,
  normalizeUsername,
  findUserByUsername,
  findUserById,
  createUser,
  getHistory,
  putHistory,
  deleteHistory,
  sanitizeMessages,
};
