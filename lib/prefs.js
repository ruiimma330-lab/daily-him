'use strict';

const store = require('./store');
const { readAccountDoc, writeAccountDoc } = require('./account-scope');

function defaults() {
  return {
    playback: 'tap',
    translation: 'collapsed',
    nickname: '',
    aiNoticeSeen: false,
  };
}

function load(userId) {
  const saved = readAccountDoc(store, 'prefs', userId) || {};
  return {
    ...defaults(),
    ...saved,
    aiNoticeSeen: saved.aiNoticeSeen === true,
  };
}

function save(userId, patch) {
  if (!patch || typeof patch !== 'object') {
    const err = new Error('bad body');
    err.code = 'BAD_BODY';
    throw err;
  }
  const next = load(userId);
  if (Object.prototype.hasOwnProperty.call(patch, 'playback')) {
    if (patch.playback !== 'tap' && patch.playback !== 'auto') {
      const err = new Error('bad playback');
      err.code = 'BAD_PLAYBACK';
      throw err;
    }
    next.playback = patch.playback;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'translation')) {
    if (patch.translation !== 'collapsed' && patch.translation !== 'expanded') {
      const err = new Error('bad translation');
      err.code = 'BAD_TRANSLATION';
      throw err;
    }
    next.translation = patch.translation;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'nickname')) {
    if (typeof patch.nickname !== 'string') {
      const err = new Error('bad nickname');
      err.code = 'BAD_NICKNAME';
      throw err;
    }
    next.nickname = patch.nickname.trim().slice(0, 20);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'aiNoticeSeen')) {
    if (typeof patch.aiNoticeSeen !== 'boolean') {
      const err = new Error('bad notice');
      err.code = 'BAD_NOTICE';
      throw err;
    }
    next.aiNoticeSeen = patch.aiNoticeSeen;
  }
  writeAccountDoc(store, 'prefs', userId, next);
  return next;
}

module.exports = { defaults, load, save };
