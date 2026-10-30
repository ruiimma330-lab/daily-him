'use strict';

const store = require('./store');

const DOC = 'user';

function defaults() {
  return {
    playback: 'tap',
    translation: 'collapsed',
    textSize: 'm',
    nickname: '',
  };
}

function load(userId) {
  return { ...defaults(), ...(store.getDoc('prefs', userId, DOC) || {}) };
}

function save(userId, patch) {
  const cur = load(userId);
  const next = { ...cur };
  if (!patch || typeof patch !== 'object') {
    const err = new Error('bad body');
    err.code = 'BAD_BODY';
    throw err;
  }
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
  if (Object.prototype.hasOwnProperty.call(patch, 'textSize')) {
    if (patch.textSize !== 's' && patch.textSize !== 'm' && patch.textSize !== 'l') {
      const err = new Error('bad text size');
      err.code = 'BAD_TEXT_SIZE';
      throw err;
    }
    next.textSize = patch.textSize;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'nickname')) {
    if (typeof patch.nickname !== 'string') {
      const err = new Error('bad nickname');
      err.code = 'BAD_NICKNAME';
      throw err;
    }
    next.nickname = patch.nickname.trim().slice(0, 20);
  }
  store.putDoc('prefs', userId, DOC, next);
  return next;
}

module.exports = { defaults, load, save };
