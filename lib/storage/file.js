'use strict';

// File backend: data/users.json, data/settings.json, data/<kind>/<characterId>/<userId>.json.
// Also reads legacy single-character files data/<kind>/<userId>.json as the default character.

const fs = require('fs');
const path = require('path');

const KINDS = ['history', 'relationship', 'memory', 'moments', 'profile', 'wallet', 'avatar', 'prefs', 'feedback'];
const ID_RE = /^[a-f0-9]{32}$/;
const CHAR_RE = /^[a-z0-9_-]{1,32}$/;

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

function createFileBackend({ dataDir, defaultCharacter }) {
  const usersPath = path.join(dataDir, 'users.json');
  const settingsPath = path.join(dataDir, 'settings.json');
  let users = [];
  let settings = {};
  const docPath = (kind, userId, characterId) => path.join(dataDir, kind, characterId, `${userId}.json`);

  return {
    name: 'file',
    async init() { fs.mkdirSync(dataDir, { recursive: true }); },
    async loadAll() {
      const u = readJson(usersPath, { users: [] });
      users = Array.isArray(u && u.users) ? u.users : [];
      settings = readJson(settingsPath, {}) || {};
      const docs = [];
      for (const kind of KINDS) {
        const base = path.join(dataDir, kind);
        if (!fs.existsSync(base)) continue;
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.json')) {
            const userId = entry.name.slice(0, -5);
            if (!ID_RE.test(userId)) continue;
            // legacy layout -> move into default character dir
            const target = docPath(kind, userId, defaultCharacter);
            if (!fs.existsSync(target)) {
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.renameSync(path.join(base, entry.name), target);
            }
          }
        }
        for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
          if (!dir.isDirectory() || !CHAR_RE.test(dir.name)) continue;
          for (const f of fs.readdirSync(path.join(base, dir.name))) {
            if (!f.endsWith('.json')) continue;
            const userId = f.slice(0, -5);
            if (!ID_RE.test(userId)) continue;
            try { docs.push({ kind, userId, characterId: dir.name, data: readJson(path.join(base, dir.name, f), null) }); } catch (_) { /* skip corrupt */ }
          }
        }
      }
      return { users: users.map((x) => ({ ...x })), docs: docs.filter((d) => d.data), settings: { ...settings } };
    },
    async putUser(user) {
      users = users.filter((x) => x.id !== user.id).concat([user]);
      atomicWrite(usersPath, `${JSON.stringify({ users }, null, 2)}\n`);
    },
    async putDoc(kind, userId, characterId, data) {
      atomicWrite(docPath(kind, userId, characterId), `${JSON.stringify(data, null, 2)}\n`);
    },
    async delDoc(kind, userId, characterId) {
      try { fs.unlinkSync(docPath(kind, userId, characterId)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    },
    async putSetting(key, value) {
      settings[key] = value;
      atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    },
    async deleteUser(userId) {
      users = users.filter((x) => x.id !== userId);
      atomicWrite(usersPath, `${JSON.stringify({ users }, null, 2)}\n`);
      for (const kind of KINDS) {
        const base = path.join(dataDir, kind);
        if (!fs.existsSync(base)) continue;
        try { fs.unlinkSync(path.join(base, `${userId}.json`)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          try { fs.unlinkSync(path.join(base, dir.name, `${userId}.json`)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
      }
    },
  };
}

module.exports = { createFileBackend };
