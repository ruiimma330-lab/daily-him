'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const characterPack = require('./character-pack');

const TZ = 'Asia/Shanghai';

const DEFAULTS = {
  pointsPerActiveDay: 6,
  pointsPerTurn: 1,
  maxTurnPointsPerDay: 8,
  streakGraceDays: 1,
  tiers: [
    { id: 'stranger', name: '陌生', nameKo: '처음', minScore: 0, minDaysKnown: 1 },
    { id: 'friend', name: '朋友', nameKo: '친구', minScore: 15, minDaysKnown: 2 },
    { id: 'close', name: '好友', nameKo: '절친', minScore: 45, minDaysKnown: 4 },
    { id: 'flirty', name: '暧昧', nameKo: '썸', minScore: 90, minDaysKnown: 6 },
  ],
};

function loadRules() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    const r = cfg && cfg.relationship;
    if (r && typeof r === 'object') return { ...DEFAULTS, ...r, tiers: Array.isArray(r.tiers) && r.tiers.length ? r.tiers : DEFAULTS.tiers };
  } catch (_) { /* defaults */ }
  return DEFAULTS;
}

function rulesFor(characterId) {
  const base = loadRules();
  const overrides = characterId ? characterPack.tierOverrides(characterId) : null;
  if (!overrides || !overrides.length) return base;
  const tiers = base.tiers.map((tier) => {
    const over = overrides.find((item) => item && item.id === tier.id);
    if (!over) return tier;
    const next = { ...tier };
    if (Number.isFinite(over.minScore)) next.minScore = over.minScore;
    if (Number.isFinite(over.minDaysKnown)) next.minDaysKnown = over.minDaysKnown;
    return next;
  });
  return { ...base, tiers };
}

function dayKey(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

function empty() {
  return { firstMetAt: null, totalTurns: 0, activeDays: 0, score: 0, streak: 0, lastChatDay: null, todayTurns: 0, tierId: 'stranger' };
}

function load(userId, characterId) {
  return { ...empty(), ...(store.getDoc('relationship', userId, characterId) || {}) };
}

function save(userId, characterId, rel) {
  store.putDoc('relationship', userId, characterId, rel);
}

function tierFor(rel, rules, now) {
  const daysKnown = rel.firstMetAt ? dayDiff(dayKey(rel.firstMetAt), dayKey(now)) + 1 : 0;
  let tier = rules.tiers[0];
  for (const t of rules.tiers) {
    if (rel.score >= t.minScore && daysKnown >= (t.minDaysKnown || 0)) tier = t;
  }
  return { tier, daysKnown };
}

function view(rel, now = Date.now(), characterId) {
  const rules = rulesFor(characterId);
  const { tier, daysKnown } = tierFor(rel, rules, now);
  const today = dayKey(now);
  const gap = rel.lastChatDay ? dayDiff(rel.lastChatDay, today) : null;
  let streakState = 'none';
  let streak = rel.streak;
  if (gap === 0) streakState = 'lit';
  else if (gap !== null && gap <= 1 + rules.streakGraceDays) streakState = gap === 1 ? 'waiting' : 'dim';
  else if (gap !== null) { streakState = 'out'; streak = 0; }
  const idx = rules.tiers.findIndex((t) => t.id === tier.id);
  const next = rules.tiers[idx + 1] || null;
  return {
    firstMetAt: rel.firstMetAt,
    daysKnown,
    totalTurns: rel.totalTurns,
    score: rel.score,
    streak,
    streakState,
    tier: { id: tier.id, name: tier.name, nameKo: tier.nameKo, level: idx },
    next: next ? { name: next.name, minScore: next.minScore } : null,
  };
}

function recordTurn(userId, characterId, now = Date.now()) {
  const rules = rulesFor(characterId);
  const rel = load(userId, characterId);
  const before = tierFor(rel, rules, now).tier.id;
  const today = dayKey(now);
  if (!rel.firstMetAt) rel.firstMetAt = now;
  if (rel.lastChatDay !== today) {
    const gap = rel.lastChatDay ? dayDiff(rel.lastChatDay, today) : null;
    rel.streak = gap !== null && gap <= 1 + rules.streakGraceDays ? rel.streak + 1 : 1;
    rel.activeDays += 1;
    rel.todayTurns = 0;
    rel.score += rules.pointsPerActiveDay;
    rel.lastChatDay = today;
  }
  rel.totalTurns += 1;
  if (rel.todayTurns < rules.maxTurnPointsPerDay) rel.score += rules.pointsPerTurn;
  rel.todayTurns += 1;
  const after = tierFor(rel, rules, now).tier.id;
  rel.tierId = after;
  save(userId, characterId, rel);
  return { ...view(rel, now), tierUp: after !== before };
}

function reset(userId, characterId) {
  store.delDoc('relationship', userId, characterId);
}

module.exports = { load, view, recordTurn, reset, dayKey, loadRules, rulesFor };
