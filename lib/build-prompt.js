'use strict';

const fs = require('fs');
const path = require('path');
const pack = require('./character-pack');
const layers = require('./prompt-layers');

const COMMON_PATH = path.join(__dirname, '..', 'persona', 'common.md');
const TIER_RE = /<!-- RELATIONSHIP_TIERS_START -->([\s\S]*?)<!-- RELATIONSHIP_TIERS_END -->/;

// Fixed layer order. Empty sections are omitted so a deduped or blank layer does not add a gap.
// global + persona + catchphrases = layers 1–2. account = layer 3. tier + relation = layer 4.
const SECTION_ORDER = ['global', 'persona', 'catchphrases', 'account', 'tierIntro', 'tier', 'relation'];

const LIMITS = {
  global: 8000,
  persona: 8000,
  facts: 6000,
  catchphrases: 4000,
  account: layers.LIMITS.account,
  tierIntro: 4000,
  tier: 4000,
  relation: layers.LIMITS.relation,
};

function cap(text, limit) {
  const s = String(text || '');
  if (s.length <= limit) return s;
  return s.slice(0, limit);
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

function factBody(raw) {
  return String(raw || '').split('\n').filter((line) => /^\d+\.\s+\S/.test(line)).join('\n');
}

function assemble(id, tierId, rel, userName, context) {
  const report = pack.inspect(id);
  const meta = report.meta || {};
  const dir = path.join(pack.CHAR_DIR, id);
  const factsRaw = readText(path.join(dir, 'facts.md'));
  const catchRaw = readText(path.join(dir, 'catchphrases.md'));
  const facts = cap(factBody(factsRaw), LIMITS.facts);
  let personaRaw = readText(path.join(dir, 'persona.md'));
  if (personaRaw.includes('<!-- FACTS -->')) personaRaw = personaRaw.replace('<!-- FACTS -->', facts);

  const common = readText(COMMON_PATH).trim();
  const persona = personaRaw.trim();
  const commonTier = common.match(TIER_RE);
  const personaTier = persona.match(TIER_RE);
  const tier = layers.relationTier({
    tierId,
    rel,
    commonTier: commonTier ? commonTier[1] : '',
    personaTier: personaTier ? personaTier[1] : '',
  });
  const ctx = context || {};
  const filledName = userName || meta.defaultUserName || '너';

  const personaBody = persona.replace(TIER_RE, '').trim();
  const catchIncluded = Boolean(catchRaw.trim()) && !personaBody.includes('## 말버릇');
  const sections = [
    { id: 'global', text: cap(common.replace(TIER_RE, '').trim(), LIMITS.global) },
    { id: 'persona', text: cap(personaBody, LIMITS.persona + LIMITS.facts) },
    {
      id: 'catchphrases',
      text: catchIncluded ? cap(catchRaw.trim(), LIMITS.catchphrases) : '',
      bytesRead: Buffer.byteLength(catchRaw),
      included: catchIncluded,
    },
    { id: 'account', text: layers.accountSection(ctx.account) },
    { id: 'tierIntro', text: cap(tier.tierIntro, LIMITS.tierIntro) },
    { id: 'tier', text: cap(tier.tier, LIMITS.tier) },
    { id: 'relation', text: layers.relationExtra(ctx.relation, filledName) },
  ];
  const byId = new Map(sections.map((section) => [section.id, section]));
  const ordered = SECTION_ORDER.map((key) => byId.get(key)).filter(Boolean);
  const vars = { name: meta.name || '', userName: filledName };
  const text = ordered.map((section) => section.text).filter(Boolean).join('\n\n')
    .replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : ''));
  return { text, sections: ordered, limits: LIMITS };
}

function buildPrompt(id, tierId, rel, userName, context) {
  return assemble(id, tierId, rel, userName, context).text;
}

module.exports = { assemble, buildPrompt, cap, LIMITS, SECTION_ORDER };
