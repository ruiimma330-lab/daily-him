'use strict';

// libSQL / Turso backend. Same interface as the file backend.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS docs (
     kind TEXT NOT NULL,
     user_id TEXT NOT NULL,
     character_id TEXT NOT NULL,
     data TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (kind, user_id, character_id)
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

function createLibsqlBackend({ url, authToken }) {
  const { createClient } = require('@libsql/client');
  const db = createClient(authToken ? { url, authToken } : { url });
  return {
    name: 'turso',
    async init() {
      for (const sql of SCHEMA) await db.execute(sql);
    },
    async isEmpty() {
      const r = await db.execute('SELECT COUNT(*) AS n FROM users');
      return Number(r.rows[0].n) === 0;
    },
    async loadAll() {
      const u = await db.execute('SELECT id, username, password_hash, created_at FROM users');
      const d = await db.execute('SELECT kind, user_id, character_id, data FROM docs');
      const s = await db.execute('SELECT key, value FROM settings');
      const docs = [];
      for (const row of d.rows) {
        try { docs.push({ kind: row.kind, userId: row.user_id, characterId: row.character_id, data: JSON.parse(row.data) }); } catch (_) { /* skip */ }
      }
      const settings = {};
      for (const row of s.rows) settings[row.key] = row.value;
      return {
        users: u.rows.map((r) => ({ id: r.id, username: r.username, passwordHash: r.password_hash, createdAt: Number(r.created_at) })),
        docs,
        settings,
      };
    },
    async putUser(user) {
      await db.execute({
        sql: 'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash',
        args: [user.id, user.username, user.passwordHash, user.createdAt],
      });
    },
    async putDoc(kind, userId, characterId, data) {
      await db.execute({
        sql: 'INSERT INTO docs (kind, user_id, character_id, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind, user_id, character_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
        args: [kind, userId, characterId, JSON.stringify(data), Date.now()],
      });
    },
    async delDoc(kind, userId, characterId) {
      await db.execute({ sql: 'DELETE FROM docs WHERE kind = ? AND user_id = ? AND character_id = ?', args: [kind, userId, characterId] });
    },
    async putSetting(key, value) {
      await db.execute({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', args: [key, String(value)] });
    },
    async deleteUser(userId) {
      await db.execute({ sql: 'DELETE FROM docs WHERE user_id = ?', args: [userId] });
      await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [userId] });
    },
    close() { db.close(); },
  };
}

module.exports = { createLibsqlBackend };
