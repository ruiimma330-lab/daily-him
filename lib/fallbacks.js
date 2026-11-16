'use strict';

const fs = require('fs');
const path = require('path');

const recent = new Map();
const DEFAULT_LINE = Object.freeze({ ko: '잠깐, 다시 한 번만 말해 줄래?', zh: '等一下，再说一遍好吗？' });

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((line) => line && typeof line.ko === 'string' && line.ko.trim() && typeof line.zh === 'string' && line.zh.trim())
    .map((line) => ({ ko: line.ko.trim(), zh: line.zh.trim() }));
}

function loadPack(characterId) {
  try {
    const file = path.join(__dirname, '..', 'characters', characterId, 'fallbacks.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function loadLines(characterId, scene) {
  const parsed = loadPack(characterId);
  if (scene) {
    const sceneLines = normalizeLines(parsed.scenes && parsed.scenes[scene]);
    if (sceneLines.length) return sceneLines;
    if (scene !== 'text') return [];
  }
  return normalizeLines(parsed.lines);
}

function loadScenes(characterId) {
  return Object.fromEntries(['offline', 'voice', 'text'].map((scene) => [scene, loadLines(characterId, scene)]));
}

function pickFallback(characterId, historyTexts, random = Math.random, scene) {
  const lines = loadLines(characterId, scene);
  if (!lines.length) return { ...DEFAULT_LINE };
  const recentKey = `${characterId}:${scene || 'lines'}`;
  const remembered = recent.get(recentKey) || [];
  const banned = new Set([...(historyTexts || []), ...remembered]);
  let pool = lines.filter((line) => !banned.has(line.ko));
  if (!pool.length) pool = lines;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  const choice = pool[index];
  recent.set(recentKey, [...remembered, choice.ko].slice(-Math.max(1, lines.length - 1)));
  return choice;
}

function resetRecent() { recent.clear(); }

module.exports = { DEFAULT_LINE, loadLines, loadScenes, pickFallback, resetRecent };
