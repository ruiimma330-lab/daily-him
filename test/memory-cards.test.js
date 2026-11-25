const test = require('node:test');
const assert = require('node:assert/strict');
const cards = require('../lib/memory-cards');
const memory = require('../lib/memory');

const NOW = Date.parse('2026-11-02T04:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function memCard(partial) {
  return { createdAt: 1, updatedAt: 1, raisedAt: null, askedAt: null, ...partial };
}

test('old cards stay readable and gain a category without being deleted', () => {
  const raw = { id: 'old', text: '用户喜欢草莓', createdAt: 1, updatedAt: 2 };
  const view = memory.publicView({ cards: [raw], summary: '' }, NOW);
  assert.equal(view.cards.length, 1);
  assert.equal(view.cards[0].id, 'old');
  assert.equal(view.cards[0].text, '用户喜欢草莓');
  assert.equal(view.cards[0].category, 'preference');
  assert.equal(view.cards[0].categoryLabel, '喜好');
  assert.equal(raw.category, undefined);
});

test('cooldown is three days and only one card is offered per turn', () => {
  const recent = memCard({ id: 'recent', text: '用户喜欢咖啡', category: 'preference', tags: ['咖啡', '커피'], raisedAt: NOW - DAY, updatedAt: 2 });
  const older = memCard({ id: 'older', text: '用户在学画画', category: 'recent', tags: ['画画'], raisedAt: NOW - 4 * DAY, updatedAt: 1 });
  const cooled = cards.selectForPrompt([recent], { now: NOW, turnsSinceProactive: 10 });
  assert.equal(cooled.proactive, null);
  const ready = cards.selectForPrompt([older], { now: NOW, turnsSinceProactive: 10 });
  assert.equal(ready.proactive.id, 'older');
  const many = cards.selectForPrompt([
    memCard({ id: 'a', text: '用户近况甲', category: 'recent', updatedAt: 1 }),
    memCard({ id: 'b', text: '用户近况乙', category: 'recent', updatedAt: 9 }),
    memCard({ id: 'c', text: '用户近况丙', category: 'recent', updatedAt: 3 }),
  ], { now: NOW, turnsSinceProactive: 4 });
  assert.equal(many.proactive.id, 'b');
  assert.equal(cards.selectForPrompt([older], { now: NOW, turnsSinceProactive: 3 }).proactive, null);
});

test('a nearby promise jumps the queue', () => {
  const soon = memCard({ id: 'exam', text: '用户明天考试', category: 'promise', date: '2026-11-03', tags: ['考试', '시험'], updatedAt: 1 });
  const other = memCard({ id: 'other', text: '用户喜欢咖啡', category: 'preference', tags: ['咖啡'], updatedAt: 9 });
  const jumped = cards.selectForPrompt([other, soon], { now: NOW, turnsSinceProactive: 0 });
  assert.equal(jumped.proactive.id, 'exam');
});

test('Korean wording matches a Chinese card, and a similar new card updates the old one', () => {
  const picked = cards.selectForPrompt([
    memCard({ id: 's', text: '用户喜欢草莓', category: 'preference', tags: ['草莓'] }),
  ], { now: NOW, userText: '오늘 딸기 먹었어', turnsSinceProactive: 0 });
  assert.equal(picked.mentioned[0].id, 's');
  assert.equal(picked.proactive, null);

  const mem = {
    cards: [memCard({ id: 's', text: '用户喜欢草莓', category: 'preference', tags: ['草莓', '딸기'] })],
    deleted: [],
  };
  const added = memory.applyOps(mem, [{ op: 'add', text: '用户很喜欢吃草莓', category: 'preference', tags: ['草莓', '딸기'] }], NOW);
  assert.equal(added, 1);
  assert.equal(mem.cards.length, 1);
  assert.match(mem.cards[0].text, /很喜欢/);
  assert.equal(mem.cards[0].id, 's');
  assert.equal(memory.applyOps(mem, [], NOW), 0);
  assert.equal(mem.cards.length, 1);
  assert.equal(cards.similar(
    memCard({ id: '1', text: '用户喜欢草莓', category: 'preference', tags: ['草莓'] }),
    memCard({ id: '2', text: '用户喜欢咖啡', category: 'preference', tags: ['咖啡'] }),
  ), false);
});

test('memory stays inside one account and one character, and summaries do not keep pack facts', async () => {
  const docs = new Map();
  memory.setBackend({
    load: (userId, characterId) => {
      const found = docs.get(`${userId}|${characterId}`);
      return found ? JSON.parse(JSON.stringify(found)) : null;
    },
    save: (userId, characterId, data) => docs.set(`${userId}|${characterId}`, JSON.parse(JSON.stringify(data))),
  });
  try {
  docs.set('A|baekhyun', {
    cards: [memCard({ id: 'p', text: '用户周三考试', date: '2026-11-01', category: 'promise', tags: ['考试', '시험'] })],
    deleted: [],
    summary: '',
    turnsSinceProactive: 0,
    openings: [],
  });
  const first = memory.promptBlock('A', 'baekhyun', '안녕', '에리', { now: NOW });
  assert.match(first, /먼저 꺼내도 되는 기억 1개/);
  assert.ok(docs.get('A|baekhyun').cards[0].askedAt);
  const second = memory.promptBlock('A', 'baekhyun', '안녕', '에리', { now: NOW });
  assert.equal(second.includes('먼저 꺼내도 되는 기억'), false);
  const archived = memory.publicView(docs.get('A|baekhyun'), NOW);
  assert.equal(archived.cards.length, 1);
  assert.equal(archived.cards[0].status, 'archived');
  assert.equal(archived.cards[0].id, 'p');

  docs.set('A|baekhyun', { cards: [memCard({ id: '1', text: '用户喜欢草莓', category: 'preference', tags: ['草莓', '딸기'] })], deleted: [], summary: '', openings: [] });
  docs.set('A|zzlayer', { cards: [memCard({ id: '2', text: '用户在学画画', category: 'recent', tags: ['画画'] })], deleted: [], summary: '', openings: [] });
  docs.set('B|baekhyun', { cards: [memCard({ id: '3', text: '用户讨厌咖啡', category: 'preference', tags: ['咖啡', '커피'] })], deleted: [], summary: '', openings: [] });
  const mine = memory.promptBlock('A', 'baekhyun', '딸기', '에리', { now: NOW });
  assert.match(mine, /草莓/);
  assert.equal(mine.includes('画画'), false);
  assert.equal(mine.includes('咖啡'), false);

  await memory.noteOpening('A', 'baekhyun', '왔구나');
  await memory.noteOpening('A', 'zzlayer', '뭐해');
  await memory.noteOpening('B', 'baekhyun', '안녕');
  assert.deepEqual(memory.recentOpenings('A', 'baekhyun'), ['왔구나']);
  assert.deepEqual(memory.recentOpenings('A', 'zzlayer'), ['뭐해']);
  assert.equal(memory.promptBlock('A', 'zzlayer', '안녕', 'you', { now: NOW }).includes('왔구나'), false);

  const mem = { summary: '' };
  await memory.summarize(
    mem,
    [{ role: 'user', text: '下周考试' }],
    async () => '用户下周考试。1992년 5월 6일 경기도 부천시 출생。',
    '1. 1992년 5월 6일 경기도 부천시 출생, 본명 변백현.',
  );
  assert.match(mem.summary, /考试/);
  assert.equal(mem.summary.includes('1992'), false);
  } finally {
    memory.setBackend(memory.storeBackend);
  }
});

test('memory.load survives null cards/deleted and concurrent promptBlock preserves afterTurn extraction', async () => {
  const docs = new Map();
  memory.setBackend({
    load: (userId, characterId) => {
      const found = docs.get(`${userId}|${characterId}`);
      return found ? JSON.parse(JSON.stringify(found)) : null;
    },
    save: (userId, characterId, data) => docs.set(`${userId}|${characterId}`, JSON.parse(JSON.stringify(data))),
  });
  try {
    docs.set('N|baekhyun', { cards: null, deleted: null, pending: null, openings: null, summary: '' });
    const loaded = memory.load('N', 'baekhyun');
    assert.deepEqual(loaded.cards, []);
    assert.deepEqual(loaded.deleted, []);
    assert.deepEqual(loaded.pending, []);
    assert.deepEqual(loaded.openings, []);
    assert.equal(memory.promptBlock('N', 'baekhyun', '안녕', '에리', { now: NOW }), '');

    docs.set('C|baekhyun', {
      cards: [memCard({ id: 'old1', text: '用户周三考试', date: '2026-11-01', category: 'promise', tags: ['考试', '시험'] })],
      deleted: [],
      summary: '',
      turnsSinceProactive: 0,
      openings: [],
    });
    const turnPromise = memory.afterTurn({
      userId: 'C',
      characterId: 'baekhyun',
      userText: '我喜欢草莓',
      replyText: '좋아',
      llm: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return JSON.stringify({
          ops: [{ op: 'add', text: '用户喜欢草莓', category: 'preference', date: null, tags: ['草莓', '딸기'] }],
        });
      },
      userName: '에리',
    });
    const block = memory.promptBlock('C', 'baekhyun', '안녕', '에리', { now: NOW });
    assert.match(block, /먼저 꺼내도 되는 기억 1개/);
    await turnPromise;
    await memory.idle('C', 'baekhyun');
    const finalDoc = docs.get('C|baekhyun');
    assert.ok(finalDoc.cards.some((c) => c.text === '用户喜欢草莓'), 'afterTurn card should be kept');
    assert.ok(finalDoc.cards.find((c) => c.id === 'old1').askedAt, 'promptBlock askedAt should be kept');
  } finally {
    memory.setBackend(memory.storeBackend);
  }
});

test('cleanSummary preserves 600-char summaries and caps at 800 chars', () => {
  assert.equal(cards.SUMMARY_MAX_CHARS, 800);
  const s600 = '她每周五都会去上韩语课，并且和白贤约定好年底一起去看雪。'.repeat(24).slice(0, 600);
  assert.equal(s600.length, 600);
  const kept600 = cards.cleanSummary(s600, '');
  assert.equal(kept600.length, 600);
  const s950 = '用户分享了重要的人生里程碑和约定。'.repeat(60);
  assert.ok(s950.length > 800);
  const capped = cards.cleanSummary(s950, '');
  assert.equal(capped.length, 800);
});
