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

function previewFromHistory(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  const last = messages[messages.length - 1];
  if (!last) return '';
  if (typeof last.text === 'string' && last.text) return last.text;
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
  return {
    id: characterId,
    name: ch.name,
    displayName: ch.displayName || ch.name,
    nameZh: ch.nameZh || '',
    group: ch.group || '',
    available: ch.available !== false,
    avatar: ch.avatar || '',
    characterNickname: p.characterNickname || '',
    onboardedAt: p.onboardedAt || null,
    preview: previewFromHistory(messages),
    lastAt: (last && last.time) || p.onboardedAt || 0,
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

module.exports = { listForUser, hasFriendsSync, friendFromDocs };
