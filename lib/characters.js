'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHAR_DIR = path.join(ROOT, 'characters');
const DEFAULT_CHARACTER = 'baekhyun';
const characterPack = require('./character-pack');
const prompt = require('./build-prompt');
const ID_RE = /^[a-z0-9_-]{1,32}$/;

function exists(id) {
  return ID_RE.test(String(id || '')) && fs.existsSync(path.join(CHAR_DIR, id, 'character.json'));
}

function resolveId(id) {
  const v = String(id || '').trim().toLowerCase();
  if (!v || !exists(v)) return null;
  return v;
}

function list() {
  try {
    return fs.readdirSync(CHAR_DIR).filter(exists).map((id) => publicInfo(id));
  } catch (_) { return []; }
}

function loadMeta(id) {
  return JSON.parse(fs.readFileSync(path.join(CHAR_DIR, id, 'character.json'), 'utf8'));
}

function safeAsset(id, value) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  const prefix = `/characters/${id}/`;
  if (!s.startsWith(prefix) || s.includes('..') || s.includes('\\') || /[\s?#]/.test(s)) return '';
  return s;
}

function publicInfo(id) {
  const m = loadMeta(id);
  return {
    id,
    name: m.name,
    displayName: m.displayName || m.name,
    nameZh: typeof m.nameZh === 'string' ? m.nameZh : '',
    nameRoman: typeof m.nameRoman === 'string' ? m.nameRoman : '',
    company: typeof m.company === 'string' ? m.company : '',
    group: typeof m.group === 'string' ? m.group : '',
    displayEmoji: m.displayEmoji || '',
    available: characterPack.inspect(id).online,
    defaultCallName: typeof m.defaultUserName === 'string' ? m.defaultUserName : '',
    welcomeKo: typeof m.welcomeKo === 'string' ? m.welcomeKo.slice(0, 400) : '',
    welcomeZh: typeof m.welcomeZh === 'string' ? m.welcomeZh.slice(0, 400) : '',
    avatar: `/characters/${id}/avatar`,
    portrait: safeAsset(id, m.portrait) || `/characters/${id}/avatar`,
  };
}

function isAvailable(id) {
  return characterPack.inspect(id).online;
}

function buildPrompt(id, tierId, rel, userName, context) {
  return prompt.buildPrompt(id, tierId, rel, userName, context);
}

function loadScenes(id) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CHAR_DIR, id, 'scenes.json'), 'utf8'));
    if (!raw || !Array.isArray(raw.scenes)) return [];
    return raw.scenes
      .filter((x) => x && typeof x.id === 'string' && typeof x.label === 'string' && typeof x.messageKo === 'string')
      .map((x) => ({
        id: String(x.id).slice(0, 40),
        label: String(x.label).slice(0, 20),
        hintZh: typeof x.hintZh === 'string' ? x.hintZh.slice(0, 40) : '',
        messageKo: String(x.messageKo).trim().slice(0, 200),
        promptHint: typeof x.promptHint === 'string' ? x.promptHint.slice(0, 300) : '',
      }))
      .filter((x) => x.messageKo);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read scenes.json');
    return [];
  }
}

function findScene(id, sceneId) {
  return loadScenes(id).find((s) => s.id === sceneId) || null;
}

module.exports = { DEFAULT_CHARACTER, CHAR_DIR, resolveId, exists, isAvailable, list, loadMeta, publicInfo, buildPrompt, loadScenes, findScene, assemble: prompt.assemble };

