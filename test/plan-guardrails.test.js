'use strict';

// Guard rails for this change set: it must not touch any character voice pack, persona,
// facts, photos, or the intimacy rules. The greeting copy is data only — no audio.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const CHAR_DIR = path.join(ROOT, 'characters');
const { LAUNCH } = require('./helpers/launch10');

const VOICE_APPROVED = {
  baekhyun: {
    version: 'baekhyun-voice-1',
    contentHash: '4af3b1144db61cc3a7e3964a7c523d8ef8700cc4a70eb2322bada78b57fdbff3',
  },
};

test('the locked baekhyun voice package still matches its approved version and hash', () => {
  const voicePack = require('../lib/voice-pack');
  for (const [id, approved] of Object.entries(VOICE_APPROVED)) {
    const pack = voicePack.load(id);
    assert.equal(pack.ok, true, pack.error);
    assert.equal(pack.lock.version, approved.version);
    assert.equal(pack.lock.contentHash, approved.contentHash);
    assert.equal(voicePack.contentHash(id, pack.lock), approved.contentHash);
    // Settings and model are part of the lock and must be unchanged.
    assert.equal(pack.lock.model, 'eleven_v3');
    assert.deepEqual(pack.lock.voiceSettings, { stability: 0, similarity_boost: 0.85 });
    assert.equal(pack.lock.voiceId, 'zG6oPYFpVjyTj1zUmVTY');
    assert.equal(pack.lock.tags, 'keep');
  }
});

test('every launch character still has persona, facts, and its original photos', () => {
  for (const id of LAUNCH) {
    const dir = path.join(CHAR_DIR, id);
    assert.ok(fs.existsSync(path.join(dir, 'persona.md')), `${id} persona`);
    assert.ok(fs.existsSync(path.join(dir, 'facts.md')), `${id} facts`);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'character.json'), 'utf8'));
    assert.equal(meta.id, id);
    assert.ok(meta.welcomeKo && meta.askNameKo, `${id} keeps its fallback greeting fields`);
    const avatar = path.join(dir, String(meta.avatar || 'avatar.jpg'));
    assert.ok(fs.existsSync(avatar), `${id} avatar`);
  }
});

test('the greeting data file lives outside characters/ and ships no audio', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'config', 'greetings.json')), true);
  for (const id of LAUNCH) {
    assert.equal(fs.existsSync(path.join(CHAR_DIR, id, 'greetings.json')), false, `${id} must not gain a per-pack file`);
    const audioDir = path.join(CHAR_DIR, id, 'greetings');
    if (fs.existsSync(audioDir)) {
      assert.equal(fs.readdirSync(audioDir).some((name) => name.endsWith('.mp3')), false, id);
    }
  }
});

test('the reviewable draft lists every line that config/greetings.json ships', () => {
  const draft = fs.readFileSync(path.join(ROOT, 'docs', 'greetings-draft.md'), 'utf8');
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'greetings.json'), 'utf8'));
  for (const id of LAUNCH) {
    const entry = data.characters[id];
    for (const slot of ['morning', 'afternoon', 'evening']) {
      assert.ok(draft.includes(entry.slots[slot].ko), `${id} ${slot} plain ko in draft`);
      assert.ok(draft.includes(entry.slots[slot].zh), `${id} ${slot} plain zh in draft`);
      assert.ok(draft.includes(entry.withName[slot].ko), `${id} ${slot} named ko in draft`);
      assert.ok(draft.includes(entry.withName[slot].zh), `${id} ${slot} named zh in draft`);
    }
    assert.ok(draft.includes(entry.askName.ko), `${id} askName ko in draft`);
    assert.ok(draft.includes(entry.askName.zh), `${id} askName zh in draft`);
  }
});

test('the intimacy algorithm is unchanged: same point weights and tiers', () => {
  const relationship = require('../lib/relationship');
  const src = fs.readFileSync(path.join(ROOT, 'lib/relationship.js'), 'utf8');
  assert.match(src, /pointsPerActiveDay: 6/);
  assert.match(src, /pointsPerTurn: 1/);
  assert.match(src, /maxTurnPointsPerDay: 8/);
  assert.match(src, /streakGraceDays: 1/);
  // Memory never feeds the score: cards do not appear in relationship.js at all.
  assert.equal(src.includes('memory'), false);
  assert.equal(typeof relationship.recordTurn, 'function');
});

test('memory endpoints never touch history or relationship documents', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = src.indexOf("app.get('/api/memory'");
  const end = src.indexOf("app.get('/api/moments'");
  assert.ok(start > 0 && end > start);
  const routes = src.slice(start, end);
  assert.equal(routes.includes('putHistory'), false);
  assert.equal(routes.includes('deleteHistory'), false);
  assert.equal(routes.includes('relationship.'), false);
  // Clearing the summary keeps cards; clearAll keeps personal fields.
  assert.match(routes, /app\.delete\('\/api\/memory\/summary'/);
  const mem = fs.readFileSync(path.join(ROOT, 'lib/memory.js'), 'utf8');
  const clearSummary = mem.slice(mem.indexOf('function clearSummary'), mem.indexOf('function clearAll'));
  assert.equal(clearSummary.includes('mem.cards'), false, 'clearing the summary does not touch cards');
  const clearAll = mem.slice(mem.indexOf('function clearAll'), mem.indexOf('function lineFor'));
  assert.equal(clearAll.includes('mem.summary ='), false, 'clearing all memory keeps the summary field untouched');
});
