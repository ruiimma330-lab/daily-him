'use strict';

const store = require('./store');
const callName = require('./call-name');

function empty() {
  return {
    characterNickname: '',
    callName: '',
    callNameStatus: '',
    callNameSource: '',
    callNameCandidate: '',
    callNameAsks: 0,
    displayName: '',
    habits: '',
    onboardedAt: null,
  };
}

function load(userId, characterId) {
  return { ...empty(), ...(store.getDoc('profile', userId, characterId) || {}) };
}

function save(userId, characterId, patch) {
  const cur = load(userId, characterId);
  const next = { ...cur };
  if (typeof patch.characterNickname === 'string') next.characterNickname = patch.characterNickname.trim().slice(0, 20);
  if (typeof patch.callName === 'string') next.callName = callName.sanitize(patch.callName);
  if (typeof patch.callNameStatus === 'string') next.callNameStatus = patch.callNameStatus;
  if (typeof patch.callNameSource === 'string') next.callNameSource = patch.callNameSource;
  if (typeof patch.callNameCandidate === 'string') next.callNameCandidate = callName.sanitize(patch.callNameCandidate);
  if (Number.isFinite(patch.callNameAsks)) next.callNameAsks = Math.max(0, Math.floor(patch.callNameAsks));
  if (typeof patch.displayName === 'string') next.displayName = patch.displayName.trim().slice(0, 20);
  if (typeof patch.habits === 'string') next.habits = patch.habits.trim().slice(0, 200);
  if (patch.onboarded === true) next.onboardedAt = cur.onboardedAt || Date.now();
  if (patch.onboarded === false) next.onboardedAt = null;
  store.putDoc('profile', userId, characterId, next);
  return next;
}

function callNameFor(userId, characterId) {
  const p = load(userId, characterId);
  return p.callName || '';
}

/** Character ids this account has completed first-time setup for. */
function listOnboardedIds(userId) {
  return store.listDocCharacterIds('profile', userId).filter((id) => {
    const doc = store.getDoc('profile', userId, id);
    return Boolean(doc && doc.onboardedAt);
  });
}

module.exports = { load, save, callNameFor, empty, listOnboardedIds };
