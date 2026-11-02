'use strict';

const fs = require('fs');
const path = require('path');
const pack = require('./character-pack');

const COMMON_PATH = path.join(__dirname, '..', 'persona', 'common.md');
const TIER_RE = /<!-- RELATIONSHIP_TIERS_START -->([\s\S]*?)<!-- RELATIONSHIP_TIERS_END -->/;

// Fixed layer order. Empty sections are omitted so a deduped file does not add a blank gap.
const SECTION_ORDER = ['global', 'persona', 'catchphrases', 'tierIntro', 'tier'];

const LIMITS = {
  global: 8000,
  persona: 8000,
  facts: 6000,
  catchphrases: 4000,
  tierIntro: 4000,
  tier: 4000,
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

function tierSection(block, tierId) {
  const parts = block.split(/\n### /);
  const sec = parts.slice(1).find((part) => part.startsWith(`${tierId}\n`));
  return { intro: parts[0].replace(/^### /, '').trim(), body: sec ? sec.slice(tierId.length + 1).trim() : '' };
}

function assemble(id, tierId, rel, userName) {
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
  const commonPart = commonTier ? tierSection(commonTier[1], tierId) : { intro: '', body: '' };
  const personaPart = personaTier ? tierSection(personaTier[1], tierId) : { intro: '', body: '' };
  const relNote = rel
    ? `\n(참고: {{userName}}랑 알게 된 지 ${rel.daysKnown}일째, 지금까지 ${rel.totalTurns}번 대화했어. 숫자를 굳이 말하지는 마.)`
    : '';

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
    { id: 'tierIntro', text: cap(commonPart.intro, LIMITS.tierIntro) },
    {
      id: 'tier',
      text: cap(`## 현재 관계 단계\n${[commonPart.body, personaPart.body].filter(Boolean).join('\n')}${relNote}`, LIMITS.tier),
    },
  ];
  const byId = new Map(sections.map((section) => [section.id, section]));
  const ordered = SECTION_ORDER.map((key) => byId.get(key)).filter(Boolean);
  const vars = { name: meta.name || '', userName: userName || meta.defaultUserName || '너' };
  const text = ordered.map((section) => section.text).filter(Boolean).join('\n\n')
    .replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : ''));
  return { text, sections: ordered, limits: LIMITS };
}

function buildPrompt(id, tierId, rel, userName) {
  return assemble(id, tierId, rel, userName).text;
}

module.exports = { assemble, buildPrompt, cap, LIMITS, SECTION_ORDER };
