const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-layers-'));
process.env.STORE_DATA_DIR = dataDir;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const store = require('../lib/store');
const prefs = require('../lib/prefs');
const profile = require('../lib/profile');
const { assemble } = require('../lib/build-prompt');
const { FIELDS } = require('../lib/prompt-layers');
const before = require('./fixtures/baekhyun-prompt-before.json');

const userA = 'a'.repeat(32);
const userB = 'b'.repeat(32);
const otherId = 'zzlayer';
const otherDir = path.join(__dirname, '..', 'characters', otherId);

const pairs = [
  { user: userA, character: 'baekhyun', nick: '星甲', call: '에리甲', remark: '伯贤甲', habits: '习惯甲', days: 3, turns: 11 },
  { user: userA, character: otherId, nick: '星甲', call: '에리乙', remark: '假角乙', habits: '习惯乙', days: 4, turns: 22 },
  { user: userB, character: 'baekhyun', nick: '星丙', call: '에리丙', remark: '伯贤丙', habits: '习惯丙', days: 7, turns: 33 },
  { user: userB, character: otherId, nick: '星丙', call: '에리丁', remark: '假角丁', habits: '习惯丁', days: 8, turns: 44 },
];

function promptFor(pair) {
  const rel = { daysKnown: pair.days, totalTurns: pair.turns, score: pair.turns * 10 };
  return assemble(pair.character, 'stranger', rel, pair.call, {
    account: { nickname: prefs.load(pair.user).nickname },
    relation: profile.load(pair.user, pair.character),
  }).text;
}

test.before(async () => {
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'character.json'), JSON.stringify({
    id: otherId, name: '테스트', displayName: '테스트', available: true, defaultUserName: 'you',
  }));
  fs.writeFileSync(path.join(otherDir, 'persona.md'), '테스트 역할.\n');
  fs.writeFileSync(path.join(otherDir, 'manifest.json'), JSON.stringify({
    version: 1, files: ['character.json', 'persona.md'],
  }));
  require('./helpers/complete-pack')(otherDir);
  await store.init();
  prefs.save(userA, { nickname: '星甲' });
  prefs.save(userB, { nickname: '星丙' });
  for (const pair of pairs) {
    profile.save(pair.user, pair.character, {
      callName: pair.call,
      characterNickname: pair.remark,
      habits: pair.habits,
      displayName: `显示${pair.remark}`,
    });
  }
});

test.after(async () => {
  await store.flush();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(otherDir, { recursive: true, force: true });
});

test('the same Baekhyun inputs still match the snapshot', () => {
  for (const tier of ['stranger', 'friend', 'close', 'flirty']) {
    assert.equal(assemble('baekhyun', tier, before.rel, before.userName).text, before.prompts[tier]);
  }
});

test('two accounts and two characters do not share nicknames, remarks, or intimacy', () => {
  const texts = pairs.map((pair) => ({ pair, text: promptFor(pair) }));
  for (const { pair, text } of texts) {
    assert.ok(text.includes(pair.nick), pair.nick);
    assert.ok(text.includes(pair.call), pair.call);
    assert.ok(text.includes(pair.remark), pair.remark);
    assert.ok(text.includes(pair.habits), pair.habits);
    assert.ok(text.includes(`${pair.days}일째`));
    assert.ok(text.includes(`${pair.turns}번`));
    assert.equal(text.includes(`显示${pair.remark}`), false);
    for (const other of pairs) {
      if (other === pair) continue;
      if (other.nick !== pair.nick) assert.equal(text.includes(other.nick), false);
      assert.equal(text.includes(other.call), false);
      assert.equal(text.includes(other.remark), false);
      assert.equal(text.includes(other.habits), false);
      if (other.days !== pair.days) assert.equal(text.includes(`${other.days}일째`), false);
    }
    const accountAt = text.indexOf('사용자 닉네임');
    const tierAt = text.indexOf('## 현재 관계 단계');
    const extraAt = text.indexOf('## 이 사용자');
    assert.ok(accountAt > 0 && accountAt < tierAt && tierAt < extraAt);
  }
});

test('saving a profile keeps fields that were not in the patch', () => {
  const userC = 'c'.repeat(32);
  store.putDoc('profile', userC, 'baekhyun', {
    characterNickname: '伯贤甲',
    callName: '에리甲',
    displayName: '显示伯贤甲',
    habits: '习惯甲',
    onboardedAt: 5,
    legacyNote: 'keep-me',
  });
  const saved = profile.save(userC, 'baekhyun', { characterNickname: '伯贤甲2' });
  assert.equal(saved.characterNickname, '伯贤甲2');
  assert.equal(saved.callName, '에리甲');
  assert.equal(saved.displayName, '显示伯贤甲');
  assert.equal(saved.habits, '习惯甲');
  assert.equal(saved.onboardedAt, 5);
  assert.equal(saved.legacyNote, 'keep-me');
  const stored = store.getDoc('profile', userC, 'baekhyun');
  assert.equal(stored.legacyNote, 'keep-me');
  assert.equal(profile.load(userB, 'baekhyun').characterNickname, '伯贤丙');
});

test('layer fields are named and relation extras stay inside the length cap', () => {
  assert.ok(FIELDS.account.some((field) => field.key === 'nickname'));
  assert.ok(FIELDS.relation.some((field) => field.key === 'score' && field.source === 'relationship.score'));
  assert.ok(FIELDS.relation.some((field) => field.key === 'callName'));
  const built = assemble('baekhyun', 'stranger', { daysKnown: 1, totalTurns: 1 }, '에리', {
    relation: { habits: '습'.repeat(500), characterNickname: '备注' },
  });
  const extra = built.sections.find((section) => section.id === 'relation');
  assert.ok(extra.text.length <= built.limits.relation);
  assert.ok(extra.text.length <= 600);
  assert.equal(built.text.includes('备注'), true);
});
