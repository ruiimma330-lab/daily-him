'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'starlight.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function dayKey(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}

function prevDay(day) {
  const [year, month, date] = day.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

function weekKey(day) {
  const [year, month, date] = day.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, date));
  const start = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - start) / 86400000) + start.getUTCDay() + 1) / 7);
  return `${utc.getUTCFullYear()}-W${week}`;
}

function priceText(userText, replyText) {
  const cfg = loadConfig();
  const userLen = [...String(userText || '')].length;
  const replyLen = [...String(replyText || '')].length;
  if (userLen > cfg.textLongUser || replyLen > cfg.textLongReply) return cfg.textLong;
  return cfg.text;
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function isValidCustomCode(code) {
  return typeof code === 'string' && /^[A-Z0-9][A-Z0-9_-]{3,31}$/.test(code);
}

function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

async function codeExists(codeHash) {
  if (mode === 'file') {
    const state = readFileState();
    return state.codes.some((item) => item.codeHash === codeHash && !item.disabledAt);
  }
  const found = await sql.execute({
    sql: 'SELECT id FROM token_redeem_codes WHERE code_hash = ? AND disabled_at IS NULL LIMIT 1',
    args: [codeHash],
  });
  return Boolean(found.rows && found.rows.length);
}

function emptyState() {
  return { wallets: {}, ledger: [], requests: {}, claims: {}, codes: [], redemptions: {}, voice: {}, site: {} };
}

let mode = null;
let filePath = '';
let sql = null;
let chain = Promise.resolve();
const hits = new Map();

/** Unlimited starlight removed — use redeem codes. Always false. */
function isUnlimited() {
  return false;
}

function lock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

function readFileState() {
  try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(filePath, 'utf8')) }; } catch (_) { return emptyState(); }
}

function writeFileState(state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, filePath);
}

function chooseLedger(backend) {
  const turso = String(process.env.TURSO_DATABASE_URL || '').trim();
  if (!turso) return 'file';
  if (!backend || !backend.db) {
    const err = new Error('starlight requires the Turso client');
    err.code = 'TURSO_REQUIRED';
    throw err;
  }
  return 'sql';
}

async function bindFile(dir) {
  filePath = path.join(dir, 'starlight.json');
  mode = 'file';
  sql = null;
  if (!fs.existsSync(filePath)) writeFileState(emptyState());
}

async function bindSql(db) {
  mode = 'sql';
  sql = db;
}

function assertReady() {
  if (!mode) throw new Error('starlight storage is not ready');
}

function allow(userId, bucket, limit) {
  const key = `${bucket}:${userId}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((ts) => now - ts < 60000);
  if (recent.length >= limit) return false;
  recent.push(now);
  hits.set(key, recent);
  return true;
}

function walletOf(state, userId) {
  if (!state.wallets[userId]) {
    state.wallets[userId] = {
      balance: 0, reserved: 0, updatedAt: Date.now(), claimStreak: 0, lastClaimDay: '', chatDays: [],
    };
  }
  return state.wallets[userId];
}

function pushLedger(state, userId, delta, balanceAfter, source, ref) {
  state.ledger.push({
    userId, delta, balanceAfter, source, ref: ref || '', createdAt: Date.now(),
  });
}

function grantSignup(state, userId) {
  const key = `${userId}|signup|once`;
  if (state.claims[key]) return false;
  const amount = loadConfig().signupGrant;
  const wallet = walletOf(state, userId);
  wallet.balance += amount;
  wallet.updatedAt = Date.now();
  state.claims[key] = Date.now();
  pushLedger(state, userId, amount, wallet.balance, 'signup', 'once');
  return true;
}

function fileEnsure(state, userId) {
  walletOf(state, userId);
  grantSignup(state, userId);
}

async function ensure(userId) {
  assertReady();
  if (mode === 'file') {
    return lock(async () => {
      const state = readFileState();
      fileEnsure(state, userId);
      writeFileState(state);
      return summaryFrom(state, userId);
    });
  }
  return sqlEnsure(userId);
}

async function backfill(userIds) {
  for (const userId of userIds || []) {
    if (userId) await ensure(userId);
  }
}

function summaryFrom(state, userId, now = Date.now()) {
  const cfg = loadConfig();
  const wallet = walletOf(state, userId);
  const day = dayKey(now);
  return {
    balance: wallet.balance,
    reserved: wallet.reserved,
    streak: wallet.claimStreak,
    claimedToday: Boolean(state.claims[`${userId}|daily|${day}`]),
    voiceToday: state.voice[`${userId}|${day}`] || 0,
    packages: cfg.packages,
    prices: {
      text: cfg.text,
      textLong: cfg.textLong,
      voice: cfg.voice,
    },
    ledger: state.ledger.filter((row) => row.userId === userId).slice(-30).reverse(),
    notice: '星光只能在 App 内使用，不能转让、不能提现',
  };
}

async function summary(userId, now) {
  await ensure(userId);
  if (mode === 'file') {
    return lock(async () => summaryFrom(readFileState(), userId, now));
  }
  return sqlSummary(userId, now);
}

async function reserve({ userId, requestId, action, amount, reason }) {
  assertReady();
  const cost = Math.max(0, Math.floor(Number(amount) || 0));
  if (!requestId || cost <= 0) return { ok: false, code: 'bad-amount', balance: 0, need: cost };
  if (mode === 'file') return lock(async () => fileReserve({ userId, requestId, action, amount: cost, reason }));
  return sqlReserve({ userId, requestId, action, amount: cost, reason });
}

function fileReserve({ userId, requestId, action, amount, reason }) {
  const state = readFileState();
  fileEnsure(state, userId);
  const existing = state.requests[requestId];
  const wallet = walletOf(state, userId);
  if (existing && existing.status !== 'released') {
    return {
      ok: existing.status !== 'rejected',
      reused: true,
      status: existing.status,
      balance: wallet.balance,
      amount: existing.amount,
      requestId,
    };
  }
  if (existing && existing.userId && existing.userId !== userId) {
    return { ok: false, code: 'conflict', balance: wallet.balance, need: amount };
  }
  const cfg = loadConfig();
  const now = Date.now();
  const day = dayKey(now);
  if (action === 'voice' && (state.voice[`${userId}|${day}`] || 0) >= cfg.dailyVoiceCap) {
    return { ok: false, code: 'voice-cap', balance: wallet.balance, need: amount };
  }
  if ((state.site[day] || 0) + amount > cfg.siteDailyCostCap) {
    return { ok: false, code: 'site-cap', balance: wallet.balance, need: amount };
  }
  if (wallet.balance < amount) return { ok: false, code: 'insufficient', balance: wallet.balance, need: amount };
  wallet.balance -= amount;
  wallet.reserved += amount;
  wallet.updatedAt = now;
  state.site[day] = (state.site[day] || 0) + amount;
  if (action === 'voice') {
    const voiceKey = `${userId}|${day}`;
    state.voice[voiceKey] = (state.voice[voiceKey] || 0) + 1;
  }
  state.requests[requestId] = {
    userId,
    action,
    amount,
    status: 'reserved',
    createdAt: now,
    settledAt: null,
    reason: reason ? String(reason).slice(0, 80) : null,
  };
  pushLedger(state, userId, -amount, wallet.balance, action, requestId);
  writeFileState(state);
  return { ok: true, reused: false, status: 'reserved', balance: wallet.balance, amount, requestId };
}

async function settle(requestId) {
  assertReady();
  if (mode === 'file') return lock(async () => fileFinish(requestId, 'settled'));
  return sqlFinish(requestId, 'settled');
}

async function release(requestId) {
  assertReady();
  if (mode === 'file') return lock(async () => fileFinish(requestId, 'released'));
  return sqlFinish(requestId, 'released');
}

function fileFinish(requestId, nextStatus) {
  const state = readFileState();
  const request = state.requests[requestId];
  if (!request) return { ok: false, code: 'missing' };
  if (request.status !== 'reserved') return { ok: true, status: request.status, reused: true };
  const wallet = walletOf(state, request.userId);
  const now = Date.now();
  if (nextStatus === 'released') {
    wallet.balance += request.amount;
    const day = dayKey(request.createdAt);
    state.site[day] = Math.max(0, (state.site[day] || 0) - request.amount);
    if (request.action === 'voice') {
      const voiceKey = `${request.userId}|${day}`;
      state.voice[voiceKey] = Math.max(0, (state.voice[voiceKey] || 0) - 1);
    }
    pushLedger(state, request.userId, request.amount, wallet.balance, 'release', requestId);
  } else {
    request.settledAt = now;
  }
  wallet.reserved = Math.max(0, wallet.reserved - request.amount);
  wallet.updatedAt = now;
  request.status = nextStatus;
  writeFileState(state);
  return { ok: true, status: nextStatus, balance: wallet.balance };
}

async function claim(userId, now = Date.now()) {
  assertReady();
  if (!allow(userId, 'claim', 8)) return { ok: false, code: 'rate' };
  if (mode === 'file') return lock(async () => fileClaim(userId, now));
  return sqlClaim(userId, now);
}

function fileClaim(userId, now) {
  const state = readFileState();
  fileEnsure(state, userId);
  const day = dayKey(now);
  const key = `${userId}|daily|${day}`;
  const wallet = walletOf(state, userId);
  if (state.claims[key]) return { ok: false, code: 'claimed', balance: wallet.balance, streak: wallet.claimStreak };
  const cfg = loadConfig();
  const streak = wallet.lastClaimDay && prevDay(day) === wallet.lastClaimDay ? wallet.claimStreak + 1 : 1;
  let bonus = 0;
  if (streak === 3) bonus += cfg.streak3;
  if (streak === 7) bonus += cfg.streak7;
  const amount = cfg.dailyGrant + bonus;
  wallet.balance += amount;
  wallet.claimStreak = streak;
  wallet.lastClaimDay = day;
  wallet.updatedAt = Date.now();
  state.claims[key] = Date.now();
  pushLedger(state, userId, amount, wallet.balance, bonus ? 'daily-streak' : 'daily', day);
  writeFileState(state);
  return { ok: true, balance: wallet.balance, amount, streak, bonus };
}

async function noteChat(userId, now = Date.now()) {
  assertReady();
  if (mode === 'file') return lock(async () => fileNoteChat(userId, now));
  return sqlNoteChat(userId, now);
}

function fileNoteChat(userId, now) {
  const state = readFileState();
  fileEnsure(state, userId);
  const wallet = walletOf(state, userId);
  const day = dayKey(now);
  if (!wallet.chatDays.includes(day)) wallet.chatDays.push(day);
  wallet.chatDays = wallet.chatDays.slice(-21);
  const cfg = loadConfig();
  let granted = 0;
  if (wallet.chatDays.includes(day) && wallet.chatDays.includes(prevDay(day)) && wallet.chatDays.includes(prevDay(prevDay(day)))) {
    const key = `${userId}|chat-streak|${weekKey(day)}`;
    if (!state.claims[key]) {
      granted = cfg.chatStreakReward;
      wallet.balance += granted;
      state.claims[key] = Date.now();
      pushLedger(state, userId, granted, wallet.balance, 'chat-streak', weekKey(day));
    }
  }
  wallet.updatedAt = Date.now();
  writeFileState(state);
  return { ok: true, granted, balance: wallet.balance };
}

const BATCH_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomBatchPart(len) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += BATCH_ALPHABET[crypto.randomInt(BATCH_ALPHABET.length)];
  }
  return out;
}

async function createCode({ amount, maxUses, expiresAt, createdBy, code, note }) {
  assertReady();
  const cfg = loadConfig();
  const value = Math.max(1, Math.min(cfg.adminGrantMax, Math.floor(Number(amount) || 0)));
  const uses = Math.max(1, Math.min(1000, Math.floor(Number(maxUses) || 1)));
  let plain;
  if (code != null && String(code).trim()) {
    plain = normalizeCode(code);
    if (!isValidCustomCode(plain)) return { ok: false, code: 'bad-code' };
  } else {
    plain = crypto.randomBytes(18).toString('base64url');
  }
  const codeHash = hashCode(plain);
  if (await codeExists(codeHash)) return { ok: false, code: 'taken' };
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 120) : null;
  const row = {
    id: crypto.randomBytes(8).toString('hex'),
    codeHash,
    amount: value,
    maxUses: uses,
    usedCount: 0,
    expiresAt: expiresAt ? Number(expiresAt) : null,
    createdBy: String(createdBy || ''),
    disabledAt: null,
    ...(cleanNote ? { note: cleanNote } : {}),
  };
  if (mode === 'file') {
    const inserted = await lock(async () => {
      const state = readFileState();
      if (state.codes.some((item) => item.codeHash === codeHash && !item.disabledAt)) return false;
      state.codes.push(row);
      writeFileState(state);
      return true;
    });
    if (!inserted) return { ok: false, code: 'taken' };
  } else {
    try {
      await sql.execute({
        sql: `INSERT INTO token_redeem_codes (id, code_hash, amount, max_uses, used_count, expires_at, created_by, disabled_at)
              VALUES (?, ?, ?, ?, 0, ?, ?, NULL)`,
        args: [row.id, row.codeHash, row.amount, row.maxUses, row.expiresAt, row.createdBy],
      });
    } catch (err) {
      const msg = String(err && err.message || err);
      if (/UNIQUE|unique|constraint/i.test(msg)) return { ok: false, code: 'taken' };
      throw err;
    }
  }
  return { ok: true, code: plain, amount: value, maxUses: uses, expiresAt: row.expiresAt };
}

async function createCodeBatch(adminId, options = {}) {
  assertReady();
  const cfg = loadConfig();
  const opts = options && typeof options === 'object' ? options : {};
  const count = opts.count !== undefined ? Number(opts.count) : 1;
  if (!Number.isFinite(count) || Math.floor(count) !== count || count < 1 || count > 100) {
    return { ok: false, code: 'bad-count' };
  }
  const amount = opts.amount !== undefined ? Number(opts.amount) : 200;
  if (!Number.isFinite(amount) || Math.floor(amount) !== amount || amount < 1 || amount > cfg.adminGrantMax) {
    return { ok: false, code: 'bad-amount' };
  }
  const maxUses = opts.maxUses !== undefined ? Number(opts.maxUses) : 1;
  if (!Number.isFinite(maxUses) || Math.floor(maxUses) !== maxUses || maxUses < 1 || maxUses > 1000) {
    return { ok: false, code: 'bad-uses' };
  }
  const defaultPrefix = `DH-${amount}`;
  let prefix = defaultPrefix;
  if (opts.prefix != null && String(opts.prefix).trim()) {
    const cleaned = normalizeCode(opts.prefix).replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
    if (!cleaned || !/^[A-Z0-9]/.test(cleaned)) return { ok: false, code: 'bad-prefix' };
    prefix = cleaned;
  }
  const note = typeof opts.note === 'string' && opts.note.trim() ? opts.note.trim().slice(0, 120) : '';
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    let created = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = `${prefix}-${randomBatchPart(4)}-${randomBatchPart(4)}`;
      const res = await createCode({
        code: candidate,
        amount,
        maxUses,
        expiresAt: opts.expiresAt,
        createdBy: adminId,
        note,
      });
      if (res.ok) {
        created = res;
        break;
      }
      if (res.code !== 'taken') return res;
    }
    if (!created) return { ok: false, code: 'generation-failed' };
    codes.push(created.code);
  }
  return { ok: true, count: codes.length, amount, maxUses, note, codes };
}

async function ensureSeedCodes() {
  assertReady();
  const cfg = loadConfig();
  const seeds = Array.isArray(cfg.seedCodes) ? cfg.seedCodes : [];
  const created = [];
  for (const seed of seeds) {
    if (!seed || !seed.code) continue;
    const result = await createCode({
      code: seed.code,
      amount: seed.amount,
      maxUses: seed.maxUses,
      expiresAt: seed.expiresAt,
      note: seed.note,
      createdBy: 'seed',
    });
    if (result.ok) created.push(result.code);
  }
  return { ok: true, created: created.length };
}

async function redeem(userId, code, now = Date.now()) {
  assertReady();
  if (!allow(userId, 'redeem', 8)) return { ok: false, code: 'rate' };
  const codeHash = hashCode(code);
  if (mode === 'file') return lock(async () => fileRedeem(userId, codeHash, now));
  return sqlRedeem(userId, codeHash, now);
}

function fileRedeem(userId, codeHash, now) {
  const state = readFileState();
  fileEnsure(state, userId);
  const row = state.codes.find((item) => item.codeHash === codeHash);
  const wallet = walletOf(state, userId);
  if (!row || row.disabledAt) return { ok: false, code: 'bad-code', balance: wallet.balance };
  if (row.expiresAt && now > row.expiresAt) return { ok: false, code: 'expired', balance: wallet.balance };
  if (row.usedCount >= row.maxUses) return { ok: false, code: 'used-up', balance: wallet.balance };
  const redemption = `${row.id}|${userId}`;
  if (state.redemptions[redemption]) return { ok: false, code: 'already', balance: wallet.balance };
  row.usedCount += 1;
  state.redemptions[redemption] = Date.now();
  wallet.balance += row.amount;
  wallet.updatedAt = Date.now();
  pushLedger(state, userId, row.amount, wallet.balance, 'redeem', row.id);
  writeFileState(state);
  return { ok: true, balance: wallet.balance, amount: row.amount };
}

async function grant(userId, amount, adminId) {
  assertReady();
  const cfg = loadConfig();
  const value = Math.floor(Number(amount) || 0);
  if (value <= 0 || value > cfg.adminGrantMax) return { ok: false, code: 'limit' };
  if (mode === 'file') {
    return lock(async () => {
      const state = readFileState();
      fileEnsure(state, userId);
      const wallet = walletOf(state, userId);
      wallet.balance += value;
      wallet.updatedAt = Date.now();
      pushLedger(state, userId, value, wallet.balance, 'admin', String(adminId || ''));
      writeFileState(state);
      return { ok: true, balance: wallet.balance, amount: value };
    });
  }
  return sqlGrant(userId, value, adminId);
}

function quote(packageId) {
  const cfg = loadConfig();
  const item = cfg.packages.find((row) => row.id === packageId);
  if (!item) return null;
  return { packageId: item.id, priceYuan: item.priceYuan, amount: item.amount, payable: false, message: '充值即将开放' };
}

async function sqlEnsure(userId) {
  const tx = await sql.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO token_wallets (user_id, balance, reserved, updated_at, claim_streak, last_claim_day, chat_days)
            VALUES (?, 0, 0, ?, 0, '', '[]') ON CONFLICT(user_id) DO NOTHING`,
      args: [userId, Date.now()],
    });
    const claim = await tx.execute({
      sql: 'INSERT INTO token_reward_claims (user_id, reward_type, period_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      args: [userId, 'signup', 'once', Date.now()],
    });
    if (Number(claim.rowsAffected) === 1) {
      const amount = loadConfig().signupGrant;
      await tx.execute({
        sql: 'UPDATE token_wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?',
        args: [amount, Date.now(), userId],
      });
      const row = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
      await tx.execute({
        sql: 'INSERT INTO token_ledger (user_id, delta, balance_after, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [userId, amount, Number(row.rows[0].balance), 'signup', 'once', Date.now()],
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  return sqlSummary(userId);
}

async function sqlSummary(userId, now = Date.now()) {
  const wallet = await sql.execute({ sql: 'SELECT * FROM token_wallets WHERE user_id = ?', args: [userId] });
  const row = wallet.rows[0] || { balance: 0, reserved: 0, claim_streak: 0 };
  const day = dayKey(now);
  const claimed = await sql.execute({
    sql: 'SELECT 1 FROM token_reward_claims WHERE user_id = ? AND reward_type = ? AND period_key = ?',
    args: [userId, 'daily', day],
  });
  const voice = await sql.execute({
    sql: 'SELECT count FROM token_voice_days WHERE user_id = ? AND day = ?',
    args: [userId, day],
  });
  const ledger = await sql.execute({
    sql: 'SELECT delta, balance_after, source, ref, created_at FROM token_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 30',
    args: [userId],
  });
  const cfg = loadConfig();
  return {
    balance: Number(row.balance || 0),
    reserved: Number(row.reserved || 0),
    streak: Number(row.claim_streak || 0),
    claimedToday: claimed.rows.length > 0,
    voiceToday: voice.rows[0] ? Number(voice.rows[0].count) : 0,
    packages: cfg.packages,
    prices: { text: cfg.text, textLong: cfg.textLong, voice: cfg.voice },
    ledger: ledger.rows.map((item) => ({
      userId,
      delta: Number(item.delta),
      balanceAfter: Number(item.balance_after),
      source: item.source,
      ref: item.ref,
      createdAt: Number(item.created_at),
    })),
    notice: '星光只能在 App 内使用，不能转让、不能提现',
  };
}

async function sqlReserve({ userId, requestId, action, amount }) {
  const tx = await sql.transaction('write');
  try {
    const now = Date.now();
    await tx.execute({
      sql: `INSERT INTO token_wallets (user_id, balance, reserved, updated_at) VALUES (?, 0, 0, ?)
            ON CONFLICT(user_id) DO NOTHING`,
      args: [userId, now],
    });
    const existing = await tx.execute({ sql: 'SELECT user_id, status, amount FROM token_requests WHERE request_id = ?', args: [requestId] });
    const existingRow = existing.rows[0] || null;
    if (existingRow && existingRow.status !== 'released') {
      const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
      await tx.commit();
      return {
        ok: existingRow.status !== 'rejected',
        reused: true,
        status: existingRow.status,
        balance: Number(current.rows[0].balance),
        amount: Number(existingRow.amount),
        requestId,
      };
    }
    if (existingRow && existingRow.user_id && existingRow.user_id !== userId) {
      const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
      await tx.commit();
      return { ok: false, code: 'conflict', balance: Number(current.rows[0].balance), need: amount };
    }
    const cfg = loadConfig();
    const day = dayKey(now);
    if (action === 'voice') {
      const voice = await tx.execute({ sql: 'SELECT count FROM token_voice_days WHERE user_id = ? AND day = ?', args: [userId, day] });
      if (voice.rows[0] && Number(voice.rows[0].count) >= cfg.dailyVoiceCap) {
        const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
        await tx.commit();
        return { ok: false, code: 'voice-cap', balance: Number(current.rows[0].balance), need: amount };
      }
    }
    const site = await tx.execute({ sql: 'SELECT spent FROM token_site_days WHERE day = ?', args: [day] });
    if ((site.rows[0] ? Number(site.rows[0].spent) : 0) + amount > cfg.siteDailyCostCap) {
      const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
      await tx.commit();
      return { ok: false, code: 'site-cap', balance: Number(current.rows[0].balance), need: amount };
    }
    const updated = await tx.execute({
      sql: 'UPDATE token_wallets SET balance = balance - ?, reserved = reserved + ?, updated_at = ? WHERE user_id = ? AND balance >= ?',
      args: [amount, amount, now, userId, amount],
    });
    if (Number(updated.rowsAffected) !== 1) {
      const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
      await tx.commit();
      return { ok: false, code: 'insufficient', balance: Number(current.rows[0].balance), need: amount };
    }
    if (existingRow) {
      await tx.execute({
        sql: "UPDATE token_requests SET action = ?, amount = ?, status = 'reserved', created_at = ? WHERE request_id = ? AND status = 'released'",
        args: [action, amount, now, requestId],
      });
    } else {
      await tx.execute({
        sql: 'INSERT INTO token_requests (request_id, user_id, action, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [requestId, userId, action, amount, 'reserved', now],
      });
    }
    await tx.execute({
      sql: `INSERT INTO token_site_days (day, spent) VALUES (?, ?)
            ON CONFLICT(day) DO UPDATE SET spent = spent + excluded.spent`,
      args: [day, amount],
    });
    if (action === 'voice') {
      await tx.execute({
        sql: `INSERT INTO token_voice_days (user_id, day, count) VALUES (?, ?, 1)
              ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`,
        args: [userId, day],
      });
    }
    const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
    await tx.execute({
      sql: 'INSERT INTO token_ledger (user_id, delta, balance_after, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [userId, -amount, Number(current.rows[0].balance), action, requestId, now],
    });
    await tx.commit();
    return { ok: true, reused: false, status: 'reserved', balance: Number(current.rows[0].balance), amount, requestId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function sqlFinish(requestId, nextStatus) {
  const tx = await sql.transaction('write');
  try {
    const found = await tx.execute({ sql: 'SELECT * FROM token_requests WHERE request_id = ?', args: [requestId] });
    if (!found.rows.length) {
      await tx.commit();
      return { ok: false, code: 'missing' };
    }
    const request = found.rows[0];
    if (request.status !== 'reserved') {
      await tx.commit();
      return { ok: true, status: request.status, reused: true };
    }
    const now = Date.now();
    if (nextStatus === 'released') {
      await tx.execute({
        sql: 'UPDATE token_wallets SET balance = balance + ?, reserved = MAX(0, reserved - ?), updated_at = ? WHERE user_id = ?',
        args: [Number(request.amount), Number(request.amount), now, request.user_id],
      });
      const day = dayKey(Number(request.created_at));
      await tx.execute({
        sql: 'UPDATE token_site_days SET spent = MAX(0, spent - ?) WHERE day = ?',
        args: [Number(request.amount), day],
      });
      if (request.action === 'voice') {
        await tx.execute({
          sql: 'UPDATE token_voice_days SET count = MAX(0, count - 1) WHERE user_id = ? AND day = ?',
          args: [request.user_id, day],
        });
      }
      const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [request.user_id] });
      await tx.execute({
        sql: 'INSERT INTO token_ledger (user_id, delta, balance_after, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [request.user_id, Number(request.amount), Number(current.rows[0].balance), 'release', requestId, now],
      });
    } else {
      await tx.execute({
        sql: 'UPDATE token_wallets SET reserved = MAX(0, reserved - ?), updated_at = ? WHERE user_id = ?',
        args: [Number(request.amount), now, request.user_id],
      });
    }
    await tx.execute({ sql: 'UPDATE token_requests SET status = ? WHERE request_id = ?', args: [nextStatus, requestId] });
    const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [request.user_id] });
    await tx.commit();
    return { ok: true, status: nextStatus, balance: Number(current.rows[0].balance) };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function sqlClaim(userId, now) {
  await sqlEnsure(userId);
  const tx = await sql.transaction('write');
  try {
    const day = dayKey(now);
    const inserted = await tx.execute({
      sql: 'INSERT INTO token_reward_claims (user_id, reward_type, period_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      args: [userId, 'daily', day, Date.now()],
    });
    const wallet = await tx.execute({ sql: 'SELECT balance, claim_streak, last_claim_day FROM token_wallets WHERE user_id = ?', args: [userId] });
    const row = wallet.rows[0];
    if (Number(inserted.rowsAffected) !== 1) {
      await tx.commit();
      return { ok: false, code: 'claimed', balance: Number(row.balance), streak: Number(row.claim_streak) };
    }
    const cfg = loadConfig();
    const streak = row.last_claim_day && prevDay(day) === row.last_claim_day ? Number(row.claim_streak) + 1 : 1;
    let bonus = 0;
    if (streak === 3) bonus += cfg.streak3;
    if (streak === 7) bonus += cfg.streak7;
    const amount = cfg.dailyGrant + bonus;
    await tx.execute({
      sql: 'UPDATE token_wallets SET balance = balance + ?, claim_streak = ?, last_claim_day = ?, updated_at = ? WHERE user_id = ?',
      args: [amount, streak, day, Date.now(), userId],
    });
    const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
    await tx.execute({
      sql: 'INSERT INTO token_ledger (user_id, delta, balance_after, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [userId, amount, Number(current.rows[0].balance), bonus ? 'daily-streak' : 'daily', day, Date.now()],
    });
    await tx.commit();
    return { ok: true, balance: Number(current.rows[0].balance), amount, streak, bonus };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function sqlNoteChat(userId, now) {
  await sqlEnsure(userId);
  const tx = await sql.transaction('write');
  try {
    const day = dayKey(now);
    const wallet = await tx.execute({ sql: 'SELECT balance, chat_days FROM token_wallets WHERE user_id = ?', args: [userId] });
    const days = JSON.parse(wallet.rows[0].chat_days || '[]');
    if (!days.includes(day)) days.push(day);
    const kept = days.slice(-21);
    let granted = 0;
    const cfg = loadConfig();
    if (kept.includes(day) && kept.includes(prevDay(day)) && kept.includes(prevDay(prevDay(day)))) {
      const week = weekKey(day);
      const inserted = await tx.execute({
        sql: 'INSERT INTO token_reward_claims (user_id, reward_type, period_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
        args: [userId, 'chat-streak', week, Date.now()],
      });
      if (Number(inserted.rowsAffected) === 1) granted = cfg.chatStreakReward;
    }
    await tx.execute({
      sql: 'UPDATE token_wallets SET balance = balance + ?, chat_days = ?, updated_at = ? WHERE user_id = ?',
      args: [granted, JSON.stringify(kept), Date.now(), userId],
    });
    if (granted) {
      const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
      await tx.execute({
        sql: 'INSERT INTO token_ledger (user_id, delta, balance_after, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [userId, granted, Number(current.rows[0].balance), 'chat-streak', weekKey(day), Date.now()],
      });
    }
    const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
    await tx.commit();
    return { ok: true, granted, balance: Number(current.rows[0].balance) };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function sqlRedeem(userId, codeHash, now) {
  await sqlEnsure(userId);
  const tx = await sql.transaction('write');
  try {
    const found = await tx.execute({ sql: 'SELECT * FROM token_redeem_codes WHERE code_hash = ?', args: [codeHash] });
    const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
    const balance = Number(current.rows[0].balance);
    if (!found.rows.length || found.rows[0].disabled_at) {
      await tx.commit();
      return { ok: false, code: 'bad-code', balance };
    }
    const row = found.rows[0];
    if (row.expires_at && now > Number(row.expires_at)) {
      await tx.commit();
      return { ok: false, code: 'expired', balance };
    }
    if (Number(row.used_count) >= Number(row.max_uses)) {
      await tx.commit();
      return { ok: false, code: 'used-up', balance };
    }
    const inserted = await tx.execute({
      sql: 'INSERT INTO token_redemptions (code_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      args: [row.id, userId, Date.now()],
    });
    if (Number(inserted.rowsAffected) !== 1) {
      await tx.commit();
      return { ok: false, code: 'already', balance };
    }
    const updated = await tx.execute({
      sql: 'UPDATE token_redeem_codes SET used_count = used_count + 1 WHERE id = ? AND used_count < max_uses',
      args: [row.id],
    });
    if (Number(updated.rowsAffected) !== 1) {
      await tx.rollback();
      return { ok: false, code: 'used-up', balance };
    }
    await tx.execute({
      sql: 'UPDATE token_wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?',
      args: [Number(row.amount), Date.now(), userId],
    });
    const after = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
    await tx.execute({
      sql: 'INSERT INTO token_ledger (user_id, delta, balance_after, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [userId, Number(row.amount), Number(after.rows[0].balance), 'redeem', row.id, Date.now()],
    });
    await tx.commit();
    return { ok: true, balance: Number(after.rows[0].balance), amount: Number(row.amount) };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function sqlGrant(userId, value, adminId) {
  await sqlEnsure(userId);
  const tx = await sql.transaction('write');
  try {
    await tx.execute({
      sql: 'UPDATE token_wallets SET balance = balance + ?, updated_at = ? WHERE user_id = ?',
      args: [value, Date.now(), userId],
    });
    const current = await tx.execute({ sql: 'SELECT balance FROM token_wallets WHERE user_id = ?', args: [userId] });
    await tx.execute({
      sql: 'INSERT INTO token_ledger (user_id, delta, balance_after, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [userId, value, Number(current.rows[0].balance), 'admin', String(adminId || ''), Date.now()],
    });
    await tx.commit();
    return { ok: true, balance: Number(current.rows[0].balance), amount: value };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function deleteUser(userId) {
  if (!userId) return false;
  assertReady();
  const id = String(userId);
  if (mode === 'file') {
    return lock(async () => {
      const state = readFileState();
      delete state.wallets[id];
      state.ledger = state.ledger.filter((row) => row.userId !== id);
      for (const reqId of Object.keys(state.requests)) {
        if (state.requests[reqId] && state.requests[reqId].userId === id) {
          delete state.requests[reqId];
        }
      }
      const prefix = `${id}|`;
      for (const key of Object.keys(state.claims)) {
        if (key.startsWith(prefix)) delete state.claims[key];
      }
      for (const key of Object.keys(state.voice)) {
        if (key.startsWith(prefix)) delete state.voice[key];
      }
      const suffix = `|${id}`;
      for (const key of Object.keys(state.redemptions)) {
        if (key.endsWith(suffix)) delete state.redemptions[key];
      }
      writeFileState(state);
      return true;
    });
  }
  const tx = await sql.transaction('write');
  try {
    await tx.execute({ sql: 'DELETE FROM token_wallets WHERE user_id = ?', args: [id] });
    await tx.execute({ sql: 'DELETE FROM token_ledger WHERE user_id = ?', args: [id] });
    await tx.execute({ sql: 'DELETE FROM token_requests WHERE user_id = ?', args: [id] });
    await tx.execute({ sql: 'DELETE FROM token_reward_claims WHERE user_id = ?', args: [id] });
    await tx.execute({ sql: 'DELETE FROM token_redemptions WHERE user_id = ?', args: [id] });
    await tx.execute({ sql: 'DELETE FROM token_voice_days WHERE user_id = ?', args: [id] });
    await tx.commit();
    return true;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

module.exports = {
  loadConfig,
  dayKey,
  prevDay,
  weekKey,
  priceText,
  normalizeCode,
  isValidCustomCode,
  chooseLedger,
  bindFile,
  bindSql,
  isUnlimited,
  ensure,
  ensureSeedCodes,
  backfill,
  summary,
  reserve,
  settle,
  release,
  claim,
  noteChat,
  createCode,
  createCodeBatch,
  redeem,
  grant,
  quote,
  deleteUser,
};
