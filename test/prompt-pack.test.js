const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const characterPack = require('../lib/character-pack');
const relationship = require('../lib/relationship');
const { assemble, cap, LIMITS } = require('../lib/build-prompt');

const before = require('./fixtures/baekhyun-prompt-before.json');
const ROOT = path.join(__dirname, '..', 'characters');

function writePack(id, files) {
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function removePack(id) {
  fs.rmSync(path.join(ROOT, id), { recursive: true, force: true });
}

test('Baekhyun prompt matches the pre-pack snapshot for every tier', () => {
  for (const tier of ['stranger', 'friend', 'close', 'flirty']) {
    const next = assemble('baekhyun', tier, before.rel, before.userName).text;
    assert.equal(next, before.prompts[tier]);
  }
});

test('facts are injected once from facts.md and catchphrases.md is read without being repeated', () => {
  const built = assemble('baekhyun', 'stranger', before.rel, before.userName);
  assert.equal(built.text.split('1992년 5월 6일').length - 1, 1);
  const catchphrases = built.sections.find((section) => section.id === 'catchphrases');
  assert.ok(catchphrases.bytesRead > 100);
  assert.equal(catchphrases.included, false);
  assert.equal(catchphrases.text, '');
  for (const section of built.sections) {
    const limit = section.id === 'persona' ? LIMITS.persona + LIMITS.facts : LIMITS[section.id];
    assert.ok(section.text.length <= limit, section.id);
  }
  assert.equal(cap('abcdef', 3), 'abc');
});

test('a new pack comes online and a broken pack only takes itself offline', () => {
  writePack('zzgood', {
    'character.json': JSON.stringify({
      id: 'zzgood',
      name: '좋은',
      displayName: '좋은',
      available: true,
      defaultUserName: 'you',
    }),
    'persona.md': '테스트 역할.\n',
    'manifest.json': JSON.stringify({
      version: 1,
      files: ['character.json', 'persona.md'],
      relationship: { tiers: [{ id: 'friend', minScore: 1, minDaysKnown: 0 }] },
    }),
  });
  writePack('zzbad', {
    'character.json': JSON.stringify({ id: 'zzbad', name: '나쁜', available: true }),
    'manifest.json': JSON.stringify({ version: 1, files: ['missing.md'] }),
  });
  try {
    const good = characterPack.inspect('zzgood');
    const bad = characterPack.inspect('zzbad');
    const baek = characterPack.inspect('baekhyun');
    assert.equal(good.online, true);
    assert.equal(bad.online, false);
    assert.match(bad.error, /missing/);
    assert.equal(baek.online, true);

    const lines = [];
    const orig = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try { characterPack.validateAll(); } finally { console.error = orig; }
    assert.ok(lines.some((line) => line.includes('zzbad')));
    assert.equal(lines.some((line) => line.includes('baekhyun')), false);
    assert.equal(lines.some((line) => line.includes('zzgood')), false);

    const now = Date.parse('2026-11-02T12:00:00+08:00');
    const rel = {
      firstMetAt: now,
      totalTurns: 1,
      score: 1,
      streak: 1,
      lastChatDay: '2026-11-02',
      todayTurns: 1,
    };
    assert.equal(relationship.view(rel, now, 'zzgood').tier.id, 'friend');
    assert.equal(relationship.view(rel, now, 'baekhyun').tier.id, 'stranger');
  } finally {
    removePack('zzgood');
    removePack('zzbad');
  }
});
