'use strict';

/**
 * Chat-entry / friends list — rebuilt as a single source of truth.
 *
 * A character is a friend (shows as a chat entry) when:
 * - profile.onboardedAt is set (user tapped 开始聊天), or
 * - there is at least one saved chat message (legacy accounts).
 *
 * Listing prefers a direct backend read (Turso) so PM2 memory drift cannot
 * hide rows that already exist in the database.
 */

const store = require('./store');
const profile = require('./profile');
const characters = require('./characters');
const { ACCOUNT_SCOPE_KEYS } = require('./account-scope');
const { isMessagesPayload, extractPreviewKo } = require('./reply-parser');

const RESERVED_ACCOUNT_KEYS = new Set(ACCOUNT_SCOPE_KEYS);

function safeTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim();
    if (/^\d{10,}$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : 0;
    }
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function previewFromHistory(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  const last = messages[messages.length - 1];
  if (!last) return '';
  if (typeof last.text === 'string' && last.text) {
    if (isMessagesPayload(last.text)) {
      const extracted = extractPreviewKo(last.text);
      if (extracted) return extracted;
    } else {
      return last.text;
    }
  }
  if (last.audioUrl) return '음성';
  return '';
}

function characterCard(id) {
  try {
    return characters.publicInfo(id);
  } catch (_) {
    return { id, name: id, displayName: id, nameZh: '', group: '', available: false, avatar: '' };
  }
}

function friendFromDocs(userId, characterId, profileDoc, historyDoc) {
  const p = { ...profile.empty(), ...(profileDoc || {}) };
  const messages = store.sanitizeMessages(historyDoc && historyDoc.messages);
  const onboarded = Boolean(p.onboardedAt);
  if (!onboarded && !messages.length) return null;

  const ch = characterCard(characterId);
  const last = messages.length ? messages[messages.length - 1] : null;
  const onboardedAt = safeTimestamp(p.onboardedAt) || null;
  const lastAt = safeTimestamp(last && last.time) || safeTimestamp(p.onboardedAt) || 0;
  return {
    id: characterId,
    name: ch.name,
    displayName: ch.displayName || ch.name,
    nameZh: ch.nameZh || '',
    group: ch.group || '',
    available: ch.available !== false,
    avatar: ch.avatar || '',
    characterNickname: p.characterNickname || '',
    onboardedAt,
    preview: previewFromHistory(messages),
    lastAt,
  };
}

/**
 * @returns {Promise<{ friends: object[], hasFriends: boolean }>}
 */
async function listForUser(userId) {
  const rows = await store.exportUserDocs(userId);
  // Keep the worker cache aligned for chat/history reads after this listing.
  store.hydrateUserDocs(userId, rows);

  const profiles = new Map();
  const histories = new Map();
  for (const row of rows) {
    if (!row || !row.characterId) continue;
    if (RESERVED_ACCOUNT_KEYS.has(row.characterId) && !characters.exists(row.characterId)) continue;
    if (row.kind === 'profile') profiles.set(row.characterId, row.data);
    if (row.kind === 'history') histories.set(row.characterId, row.data);
  }

  const ids = new Set([...profiles.keys(), ...histories.keys()]);
  const friends = [];
  for (const id of ids) {
    let profileDoc = profiles.get(id);
    const historyDoc = histories.get(id);
    const messages = store.sanitizeMessages(historyDoc && historyDoc.messages);
    // Best-effort: history without onboardedAt still counts; stamp onboarded for check-ins.
    if (messages.length && !(profileDoc && profileDoc.onboardedAt)) {
      try {
        profileDoc = profile.save(userId, id, { onboarded: true });
        profiles.set(id, profileDoc);
      } catch (_) { /* listing must not fail */ }
    }
    const item = friendFromDocs(userId, id, profileDoc, historyDoc);
    if (item) friends.push(item);
  }
  friends.sort((a, b) => Number(b.lastAt || 0) - Number(a.lastAt || 0));
  return { friends, hasFriends: friends.length > 0 };
}

function hasFriendsSync(userId) {
  return profile.listFriendIds(userId).length > 0;
}

module.exports = { listForUser, hasFriendsSync, friendFromDocs, safeTimestamp };
