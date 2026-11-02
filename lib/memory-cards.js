'use strict';

// Account × character memory cards: categories, promise status, cooldown, and matching.
// The character pack is not a source of cards. A card only exists because the user said it.

const CATEGORIES = ['preference', 'recent', 'promise', 'address'];
const CATEGORY_LABEL = { preference: '喜好', recent: '近况', promise: '约定', address: '称呼' };
const STATUS_LABEL = { pending: '待发生', ask: '已过期待问', archived: '已归档' };

const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
const PROACTIVE_GAP = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

// Same idea in Chinese and Korean. Used when a card has no model-made tags yet.
const ALIASES = [
  ['草莓', '딸기'],
  ['咖啡', '커피'],
  ['考试', '시험'],
  ['生日', '생일'],
  ['旅行', '여행'],
  ['生病', '아파'],
  ['约定', '약속'],
  ['喜欢', '좋아'],
  ['讨厌', '싫어'],
];

const GENERIC_TAGS = new Set(['用户', '喜欢', '讨厌', '좋아', '싫어', '今天', '明天']);

function ymd(now, tz = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

function dayNumber(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!match) return null;
  return Math.round(Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`) / DAY_MS);
}

function inferCategory(card) {
  const text = String(card.text || '');
  if (card.date || /考试|约定|见面|旅行|생일|시험|약속/.test(text)) return 'promise';
  if (/叫我|称呼|名字叫|불러|이름/.test(text)) return 'address';
  if (/喜欢|讨厌|爱吃|爱好|좋아|싫어/.test(text)) return 'preference';
  return 'recent';
}

function inferTags(text) {
  const raw = String(text || '');
  const tags = new Set();
  for (const group of ALIASES) {
    if (group.some((word) => raw.includes(word))) group.forEach((word) => tags.add(word));
  }
  return [...tags].slice(0, 8);
}

function cleanTags(input, text) {
  const fromInput = Array.isArray(input) ? input : [];
  const tags = new Set();
  for (const tag of [...fromInput, ...inferTags(text)]) {
    const word = String(tag || '').trim().slice(0, 20);
    if (word) tags.add(word);
  }
  return [...tags].slice(0, 8);
}

function normalizeCard(card, now = Date.now()) {
  const next = { ...card };
  next.text = String(next.text || '').trim().slice(0, 120);
  next.category = CATEGORIES.includes(next.category) ? next.category : inferCategory(next);
  next.tags = cleanTags(next.tags, next.text);
  next.date = typeof next.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(next.date) ? next.date : null;
  if (next.category === 'promise') {
    const today = ymd(now);
    if (next.date && next.date < today) {
      next.status = next.askedAt ? 'archived' : 'ask';
    } else if (next.status !== 'archived') {
      next.status = 'pending';
    }
  } else {
    next.status = null;
  }
  return next;
}

function expandTags(tags) {
  const out = new Set();
  for (const tag of tags || []) {
    const word = String(tag || '').trim();
    if (!word) continue;
    out.add(word);
    for (const group of ALIASES) {
      if (group.some((item) => item.toLowerCase() === word.toLowerCase())) group.forEach((item) => out.add(item));
    }
  }
  return [...out];
}

function bigrams(value) {
  const text = String(value || '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

function jaccard(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  const union = left.size + right.size - shared;
  return union ? shared / union : 0;
}

function contentTags(tags) {
  return expandTags(tags).filter((tag) => tag.length >= 2 && !GENERIC_TAGS.has(tag));
}

function similar(a, b) {
  if (!a || !b) return false;
  if (a.category && b.category && a.category !== b.category && jaccard(a.text, b.text) < 0.72) return false;
  const left = new Set(contentTags(a.tags));
  const shared = contentTags(b.tags).some((tag) => left.has(tag));
  if (shared) return true;
  return jaccard(a.text, b.text) >= 0.55;
}

function matchScore(card, userText) {
  const text = String(userText || '').trim().toLowerCase();
  if (!text) return 0;
  let score = 0;
  for (const tag of expandTags(card.tags)) {
    if (tag && text.includes(String(tag).toLowerCase())) score += 3;
  }
  let hits = 0;
  const query = bigrams(text);
  for (const gram of bigrams(card.text)) if (query.has(gram)) hits += 1;
  if (hits >= 2) score += hits;
  return score;
}

function daysUntil(today, date) {
  const a = dayNumber(today);
  const b = dayNumber(date);
  if (a == null || b == null) return null;
  return b - a;
}

function selectForPrompt(cards, { userText = '', now = Date.now(), turnsSinceProactive = 0 } = {}) {
  const today = ymd(now);
  const normalized = (cards || []).map((card) => normalizeCard(card, now));
  const mentioned = [];
  const urgent = [];
  const normal = [];
  for (const card of normalized) {
    const matched = matchScore(card, userText) > 0;
    if (matched) mentioned.push(card);
    if (card.status === 'archived') continue;
    if (matched) continue;
    const cooled = !card.raisedAt || (now - card.raisedAt) >= COOLDOWN_MS;
    const soon = card.category === 'promise' && card.date ? daysUntil(today, card.date) : null;
    const upcoming = soon != null && soon >= 0 && soon <= 1;
    const overdue = card.category === 'promise' && card.status === 'ask';
    if (upcoming || overdue) urgent.push(card);
    else if (cooled) normal.push(card);
  }
  urgent.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  normal.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  let proactive = null;
  if (urgent.length) proactive = urgent[0];
  else if (turnsSinceProactive >= PROACTIVE_GAP && normal.length) proactive = normal[0];
  return {
    cards: normalized,
    mentioned: mentioned.slice(0, 6),
    proactive,
    turnsSinceProactive,
  };
}

function cleanSummary(summary, factText) {
  const banned = String(factText || '').split('\n')
    .map((line) => line.replace(/^\d+\.\s*/, '').trim())
    .filter((line) => line.length >= 8)
    .map((line) => line.slice(0, 18));
  const kept = String(summary || '').split(/(?<=[。！？\n])/).filter((part) => {
    const text = part.trim();
    if (!text) return false;
    return !banned.some((fact) => text.includes(fact));
  });
  return kept.join('').trim().slice(0, 400);
}

function categoryLabel(category) {
  return CATEGORY_LABEL[category] || '';
}

function statusLabel(status) {
  return STATUS_LABEL[status] || '';
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABEL,
  STATUS_LABEL,
  COOLDOWN_MS,
  PROACTIVE_GAP,
  normalizeCard,
  similar,
  matchScore,
  selectForPrompt,
  cleanSummary,
  categoryLabel,
  statusLabel,
  inferTags,
  ymd,
};
