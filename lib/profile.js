'use strict';

const store = require('./store');
const characters = require('./characters');

function empty() {
  return {
    characterNickname: '',
    callName: '',
    displayName: '',
    onboardedAt: null,
  };
}

function load(userId, characterId) {
  return { ...empty(), ...(store.getDoc('profile', userId, characterId) || {}) };
}

function save(userId, characterId, patch) {
  const cur = load(userId, characterId);
  const next = {
    characterNickname: typeof patch.characterNickname === 'string' ? patch.characterNickname.trim().slice(0, 20) : cur.characterNickname,
    callName: typeof patch.callName === 'string' ? patch.callName.trim().slice(0, 20) : cur.callName,
    displayName: typeof patch.displayName === 'string' ? patch.displayName.trim().slice(0, 20) : cur.displayName,
    onboardedAt: cur.onboardedAt,
  };
  if (patch.onboarded === true) next.onboardedAt = cur.onboardedAt || Date.now();
  if (patch.onboarded === false) next.onboardedAt = null;
  if (!next.callName) {
    const meta = characters.loadMeta(characterId);
    next.callName = meta.defaultUserName || '';
  }
  store.putDoc('profile', userId, characterId, next);
  return next;
}

function callNameFor(userId, characterId) {
  const p = load(userId, characterId);
  if (p.callName) return p.callName;
  try { return characters.loadMeta(characterId).defaultUserName || ''; } catch (_) { return ''; }
}

module.exports = { load, save, callNameFor, empty };
