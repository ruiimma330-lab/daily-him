'use strict';

// libSQL / Turso backend. Same interface as the file backend.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     ai_disclaimer_acknowledged INTEGER NOT NULL DEFAULT 1
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
  `CREATE TABLE IF NOT EXISTS token_wallets (
     user_id TEXT PRIMARY KEY,
     balance INTEGER NOT NULL,
     reserved INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     claim_streak INTEGER NOT NULL DEFAULT 0,
     last_claim_day TEXT NOT NULL DEFAULT '',
     chat_days TEXT NOT NULL DEFAULT '[]'
   )`,
  `CREATE TABLE IF NOT EXISTS token_ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     delta INTEGER NOT NULL,
     balance_after INTEGER NOT NULL,
     source TEXT NOT NULL,
     ref TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS token_requests (
     request_id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     action TEXT NOT NULL,
     amount INTEGER NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS token_reward_claims (
     user_id TEXT NOT NULL,
     reward_type TEXT NOT NULL,
     period_key TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, reward_type, period_key)
   )`,
  `CREATE TABLE IF NOT EXISTS token_redeem_codes (
     id TEXT PRIMARY KEY,
     code_hash TEXT NOT NULL UNIQUE,
     amount INTEGER NOT NULL,
     max_uses INTEGER NOT NULL,
     used_count INTEGER NOT NULL,
     expires_at INTEGER,
     created_by TEXT NOT NULL,
     disabled_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS token_redemptions (
     code_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (code_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS token_voice_days (
     user_id TEXT NOT NULL,
     day TEXT NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (user_id, day)
   )`,
  `CREATE TABLE IF NOT EXISTS token_site_days (
     day TEXT PRIMARY KEY,
     spent INTEGER NOT NULL
   )`,
];

const TOKEN_COLUMNS = [
  'ALTER TABLE token_wallets ADD COLUMN claim_streak INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE token_wallets ADD COLUMN last_claim_day TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE token_wallets ADD COLUMN chat_days TEXT NOT NULL DEFAULT '[]'",
];

const USER_COLUMNS = [
  // Existing accounts predate the registration-only notice, so they default to acknowledged.
  'ALTER TABLE users ADD COLUMN ai_disclaimer_acknowledged INTEGER NOT NULL DEFAULT 1',
];

function createLibsqlBackend({ url, authToken }) {
  const { createClient } = require('@libsql/client');
  const db = createClient(authToken ? { url, authToken } : { url });
  return {
    name: 'turso',
    db,
    async init() {
      for (const sql of SCHEMA) await db.execute(sql);
      for (const sql of [...USER_COLUMNS, ...TOKEN_COLUMNS]) {
        try { await db.execute(sql); } catch (err) {
          if (!/duplicate column/i.test(String(err && err.message || err))) {
            console.warn(`Migration warning: ${err && err.message ? err.message : err}`);
          }
        }
      }
    },
    async isEmpty() {
      const r = await db.execute('SELECT COUNT(*) AS n FROM users');
      return Number(r.rows[0].n) === 0;
    },
    async loadAll() {
      const u = await db.execute('SELECT id, username, password_hash, created_at, ai_disclaimer_acknowledged FROM users');
      const d = await db.execute('SELECT kind, user_id, character_id, data FROM docs');
      const s = await db.execute('SELECT key, value FROM settings');
      const docs = [];
      for (const row of d.rows) {
        try { docs.push({ kind: row.kind, userId: row.user_id, characterId: row.character_id, data: JSON.parse(row.data) }); } catch (_) { /* skip */ }
      }
      const settings = {};
      for (const row of s.rows) settings[row.key] = row.value;
      return {
        users: u.rows.map((r) => ({
          id: r.id,
          username: r.username,
          passwordHash: r.password_hash,
          createdAt: Number(r.created_at),
          aiDisclaimerAcknowledged: Number(r.ai_disclaimer_acknowledged) !== 0,
        })),
        docs,
        settings,
      };
    },
    /** Reload one user's docs from Turso so list endpoints see the latest writes. */
    async loadUserDocs(userId) {
      const d = await db.execute({
        sql: 'SELECT kind, user_id, character_id, data FROM docs WHERE user_id = ?',
        args: [String(userId)],
      });
      const docs = [];
      for (const row of d.rows) {
        try {
          const kind = row.kind ?? row[0];
          const uid = row.user_id ?? row.userId ?? row[1];
          const characterId = row.character_id ?? row.characterId ?? row[2];
          const raw = row.data ?? row[3];
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!kind || !characterId || !data) continue;
          docs.push({ kind, userId: uid || userId, characterId, data });
        } catch (_) { /* skip corrupt */ }
      }
      return docs;
    },
    async putUser(user) {
      await db.execute({
        sql: 'INSERT INTO users (id, username, password_hash, created_at, ai_disclaimer_acknowledged) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, ai_disclaimer_acknowledged = excluded.ai_disclaimer_acknowledged',
        args: [user.id, user.username, user.passwordHash, user.createdAt, user.aiDisclaimerAcknowledged === false ? 0 : 1],
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
