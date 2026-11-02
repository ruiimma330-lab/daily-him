'use strict';

const fs = require('fs');
const path = require('path');

const recent = new Map();

function loadLines(characterId) {
  try {
    const file = path.join(__dirname, '..', 'characters', characterId, 'fallbacks.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.lines)) return [];
    return parsed.lines.filter((line) => line && typeof line.ko === 'string' && line.ko.trim() && typeof line.zh === 'string' && line.zh.trim())
      .map((line) => ({ ko: line.ko.trim(), zh: line.zh.trim() }));
  } catch (_) {
    return [];
  }
}

function pickFallback(characterId, historyTexts, random = Math.random) {
  const lines = loadLines(characterId);
  if (!lines.length) return { ko: '잠깐, 다시 한 번만 말해 줄래?', zh: '等一下，再说一遍好吗？' };
  const remembered = recent.get(characterId) || [];
  const banned = new Set([...(historyTexts || []), ...remembered]);
  let pool = lines.filter((line) => !banned.has(line.ko));
  if (!pool.length) pool = lines;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  const choice = pool[index];
  recent.set(characterId, [...remembered, choice.ko].slice(-Math.max(1, lines.length - 1)));
  return choice;
}

function resetRecent() { recent.clear(); }

module.exports = { loadLines, pickFallback, resetRecent };
