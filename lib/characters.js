'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHAR_DIR = path.join(ROOT, 'characters');
const COMMON_PATH = path.join(ROOT, 'persona', 'common.md');
const DEFAULT_CHARACTER = 'baekhyun';
const ID_RE = /^[a-z0-9_-]{1,32}$/;

function exists(id) {
  return ID_RE.test(String(id || '')) && fs.existsSync(path.join(CHAR_DIR, id, 'character.json'));
}

function resolveId(id) {
  const v = String(id || '').trim().toLowerCase();
  if (!v) return DEFAULT_CHARACTER;
  return exists(v) ? v : null;
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
    available: m.available !== false,
    avatar: `/characters/${id}/avatar`,
    portrait: safeAsset(id, m.portrait) || `/characters/${id}/avatar`,
  };
}

function isAvailable(id) {
  try { return loadMeta(id).available !== false; } catch (_) { return false; }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch (_) { return ''; }
}

const TIER_RE = /<!-- RELATIONSHIP_TIERS_START -->([\s\S]*?)<!-- RELATIONSHIP_TIERS_END -->/;

function tierSection(block, tierId) {
  const parts = block.split(/\n### /);
  const sec = parts.slice(1).find((p) => p.startsWith(`${tierId}\n`));
  return { intro: parts[0].replace(/^### /, '').trim(), body: sec ? sec.slice(tierId.length + 1).trim() : '' };
}

// common.md + characters/<id>/persona.md, keeping only the current tier's section from each.
function buildPrompt(id, tierId, rel, userName) {
  const meta = loadMeta(id);
  const vars = { name: meta.name, userName: userName || meta.defaultUserName || '너' };
  const fill = (s) => s.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : ''));
  const common = readText(COMMON_PATH);
  const persona = readText(path.join(CHAR_DIR, id, 'persona.md'));
  const cm = common.match(TIER_RE);
  const pm = persona.match(TIER_RE);
  const c = cm ? tierSection(cm[1], tierId) : { intro: '', body: '' };
  const p = pm ? tierSection(pm[1], tierId) : { intro: '', body: '' };
  const facts = rel ? `\n(참고: {{userName}}랑 알게 된 지 ${rel.daysKnown}일째, 지금까지 ${rel.totalTurns}번 대화했어. 숫자를 굳이 말하지는 마.)` : '';
  const out = [
    common.replace(TIER_RE, '').trim(),
    persona.replace(TIER_RE, '').trim(),
    c.intro,
    `## 현재 관계 단계\n${[c.body, p.body].filter(Boolean).join('\n')}${facts}`,
  ].filter(Boolean).join('\n\n');
  return fill(out);
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

module.exports = { DEFAULT_CHARACTER, CHAR_DIR, resolveId, exists, isAvailable, list, loadMeta, publicInfo, buildPrompt, loadScenes, findScene };

