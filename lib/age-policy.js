'use strict';
const fs = require('fs');
const path = require('path');
const TIERS = ['stranger', 'friend', 'close', 'flirty'];
function policy(id) {
  let m = {};
  try { m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'characters', id, 'character.json'), 'utf8')); } catch (_) {}
  const birth = typeof m.birthDate === 'string' ? Date.parse(m.birthDate) : NaN;
  const adultDate = Number.isFinite(birth) ? new Date(birth) : null;
  if (adultDate) adultDate.setUTCFullYear(adultDate.getUTCFullYear() + 18);
  const strict = m.ageVerified !== true || m.minor !== false || (adultDate && adultDate.getTime() > Date.now());
  const allowed = TIERS.filter(t => (!strict || t !== 'flirty') && (!Array.isArray(m.allowedTiers) || m.allowedTiers.includes(t)));
  return { strict: Boolean(strict), allowedTiers: allowed.length ? allowed : ['stranger'] };
}
function clamp(id, tier) {
  const allowed = policy(id).allowedTiers;
  const rank = Math.max(0, TIERS.indexOf(tier));
  return TIERS.filter((t, i) => i <= rank && allowed.includes(t)).pop() || allowed[0];
}
module.exports = { policy, clamp };
