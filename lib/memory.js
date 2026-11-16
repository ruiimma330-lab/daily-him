'use strict';

// Long-term memory: cards + rolling summary, per userId + characterId.
// Storage goes through `backend` (file JSON now) so it can be swapped for a DB later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const cardsLib = require('./memory-cards');

const MAX_CARDS = 150;
const MAX_DELETED = 200;
const MAX_NEW_PER_TURN = 1; // extraction may add at most one new card per turn
const WINDOW = 20; // messages sent to the chat LLM
const SUMMARY_BATCH = 10; // summarize once this many messages have scrolled out
const SUMMARY_MAX_CHARS = 400;
const SUBSTANCE_RE = /\d|좋아|싫어|시험|생일|약속|내일|모레|다음 ?주|이번 ?주|주말|월요일|화요일|수요일|목요일|금요일|토요일|일요일|불러|이름|공부|회사|학교|아파|여행|喜欢|讨厌|爱吃|考试|生日|约定|明天|后天|下周|这周|周末|星期|周[一二三四五六日天]|叫我|名字|学|上班|生病|旅行|改到|其实|不是/;

const storeBackend = {
  load: (userId, characterId) => store.getDoc('memory', userId, characterId),
  save: (userId, characterId, data) => store.putDoc('memory', userId, characterId, data),
};
let backend = storeBackend;
function setBackend(b) { backend = b; }

function empty() {
  return { cards: [], deleted: [], summary: '', summaryUpdatedAt: null, summarizedUntil: 0, pending: [], pendingTurns: 0, openings: [] };
}
function load(userId, characterId) {
  return { ...empty(), ...(backend.load(userId, characterId) || {}) };
}
function save(userId, characterId, data) { backend.save(userId, characterId, data); }

// Serialize work per user+character so writes never interleave.
const chains = new Map();
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).catch((err) => {
    console.error(`Memory task failed (${err && err.message ? String(err.message).slice(0, 80) : 'unknown'})`);
  });
  chains.set(key, next);
  next.then(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}
// Remember how the last few replies started (persisted, so it also works across new sessions).
function noteOpening(userId, characterId, text) {
  const o = String(text || '').trim().slice(0, 12);
  if (!o) return Promise.resolve();
  return withLock(`${userId}:${characterId}`, async () => {
    const mem = load(userId, characterId);
    mem.openings = [...(mem.openings || []), o].slice(-6);
    save(userId, characterId, mem);
  });
}
function recentOpenings(userId, characterId) { return load(userId, characterId).openings || []; }

function idle(userId, characterId) { return chains.get(`${userId}:${characterId}`) || Promise.resolve(); }

function todayStr(tz = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function weekday(tz = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, weekday: 'long' }).format(new Date());
}
function weekdayOf(ymd) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${ymd}T00:00:00Z`));
}

function publicView(mem, now = Date.now()) {
  const cards = [...mem.cards].map((card) => cardsLib.normalizeCard(card, now)).sort((a, b) => b.updatedAt - a.updatedAt)
    .map((card) => ({
      id: card.id,
      text: card.text,
      date: card.date || null,
      category: card.category,
      categoryLabel: cardsLib.categoryLabel(card.category),
      status: card.status,
      statusLabel: cardsLib.statusLabel(card.status),
      edited: card.edited === true,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    }));
  const groups = cardsLib.CATEGORIES.map((category) => ({
    category,
    label: cardsLib.categoryLabel(category),
    cards: cards.filter((card) => card.category === category),
  })).filter((group) => group.cards.length);
  return {
    cards,
    groups,
    categories: cardsLib.CATEGORIES.map((category) => ({ id: category, label: cardsLib.categoryLabel(category) })),
    summary: mem.summary || '',
    summaryUpdatedAt: mem.summaryUpdatedAt,
    forgotten: (mem.deleted || []).slice(-MAX_DELETED).reverse().map((item) => ({
      text: item.text,
      at: item.at || null,
    })),
  };
}

function deleteCard(userId, characterId, id) {
  return withLock(`${userId}:${characterId}`, async () => {
    const mem = load(userId, characterId);
    const card = mem.cards.find((c) => c.id === id);
    if (!card) return false;
    mem.cards = mem.cards.filter((c) => c.id !== id);
    mem.deleted = [...mem.deleted, { text: card.text, tags: card.tags, category: card.category, at: Date.now() }].slice(-MAX_DELETED);
    save(userId, characterId, mem);
    return true;
  });
}

// A user edit is authoritative: later extraction may not overwrite or re-add it.
// Returns the updated card, or null when the id is unknown or the text is empty.
function editCard(userId, characterId, id, patch, now = Date.now()) {
  return withLock(`${userId}:${characterId}`, async () => {
    const mem = load(userId, characterId);
    const card = mem.cards.find((c) => c.id === id);
    if (!card) return null;
    const raw = patch && typeof patch.text === 'string' ? patch.text.trim().slice(0, 120) : '';
    if (!raw) return null;
    const before = cardsLib.normalizeCard(card, now);
    const next = cardsLib.normalizeCard({
      ...card,
      text: raw,
      category: patch && typeof patch.category === 'string' ? patch.category : card.category,
      date: patch && patch.date !== undefined ? patch.date : card.date,
      edited: true,
    }, now);
    card.text = next.text;
    card.category = next.category;
    card.date = next.date;
    card.tags = next.tags;
    card.status = next.status;
    card.edited = true;
    card.updatedAt = now;
    if (before.text !== card.text) card.raisedAt = null;
    save(userId, characterId, mem);
    return cardsLib.normalizeCard(card, now);
  });
}

// Remember a text as "forgotten" without touching chat history or intimacy.
function forgetText(userId, characterId, text, now = Date.now()) {
  return withLock(`${userId}:${characterId}`, async () => {
    const mem = load(userId, characterId);
    const value = String(text || '').trim().slice(0, 120);
    if (!value) return false;
    mem.deleted = [...(mem.deleted || []), { text: value, at: now }].slice(-MAX_DELETED);
    save(userId, characterId, mem);
    return true;
  });
}

function clearSummary(userId, characterId) {
  return withLock(`${userId}:${characterId}`, async () => {
    const mem = load(userId, characterId);
    mem.summary = '';
    mem.summaryUpdatedAt = null;
    mem.summarizedUntil = 0;
    mem.pending = [];
    mem.pendingTurns = 0;
    save(userId, characterId, mem);
    return true;
  });
}

function clearAll(userId, characterId) {
  return withLock(`${userId}:${characterId}`, async () => {
    const mem = load(userId, characterId);
    const deleted = [...mem.deleted, ...mem.cards.map((c) => ({ text: c.text, at: Date.now() }))].slice(-MAX_DELETED);
    save(userId, characterId, { ...empty(), deleted, summarizedUntil: mem.summarizedUntil });
    return true;
  });
}

function lineFor(card) {
  const when = card.date ? `[${card.date} ${weekdayOf(card.date)}] ` : '';
  const kind = cardsLib.categoryLabel(card.category);
  const state = cardsLib.statusLabel(card.status);
  const badge = [kind, state].filter(Boolean).join('/');
  const edited = card.edited === true ? '(사용자가 직접 고친 문장, 이 문장 그대로 기억해) ' : '';
  return `- ${badge ? `(${badge}) ` : ''}${edited}${when}${card.text}`;
}

// Injected after the four prompt layers. At most one card is marked for the model to bring up.
function promptBlock(userId, characterId, lastUserText, userName, opts = {}) {
  const now = opts.now || Date.now();
  const mem = load(userId, characterId);
  const forgotten = (mem.deleted || []).slice(-10).map((d) => d.text);
  const picked = cardsLib.selectForPrompt(mem.cards, {
    userText: lastUserText,
    now,
    turnsSinceProactive: mem.turnsSinceProactive || 0,
  });
  mem.cards = picked.cards;
  mem.turnsSinceProactive = (mem.turnsSinceProactive || 0) + 1;
  if (picked.proactive) {
    const card = mem.cards.find((item) => item.id === picked.proactive.id);
    if (card) {
      card.raisedAt = now;
      if (card.status === 'ask') card.askedAt = now;
    }
    mem.turnsSinceProactive = 0;
  }
  for (const mentioned of picked.mentioned) {
    const card = mem.cards.find((item) => item.id === mentioned.id);
    if (card && card.status === 'ask' && !card.askedAt) card.askedAt = now;
  }
  if (mem.cards.length || mem.summary || forgotten.length || mem.turnsSinceProactive) save(userId, characterId, mem);
  if (!picked.mentioned.length && !picked.proactive && !mem.summary && !forgotten.length) return '';
  const parts = [`## 네가 기억하는 것 (${userName || '상대'}가 전에 직접 말해 준 것, 중국어 메모)`];
  if (picked.mentioned.length) parts.push(`상대가 방금 말한 기억:\n${picked.mentioned.map(lineFor).join('\n')}`);
  if (picked.proactive) {
    const ask = picked.proactive.status === 'ask' ? ' 날짜가 지났으니 결과만 한 번 물어봐. 다음부터는 먼저 꺼내지 마.' : '';
    parts.push(`먼저 꺼내도 되는 기억 1개:${ask}\n${lineFor(picked.proactive)}`);
  }
  if (mem.summary) parts.push(`지난 대화 요약: ${mem.summary}`);
  if (forgotten.length) parts.push(`잊어 달라고 한 것 (요약이나 대화 기록에 남아 있어도 절대 먼저 꺼내지 말고, 물어보면 잘 기억이 안 난다고 하고 다시 물어봐): ${forgotten.join(' / ')}`);
  parts.push([
    '이 기억은 친구가 자연스럽게 기억하는 것처럼만 써. 목록을 읊지 마.',
    '먼저 꺼내는 기억은 위 표시가 있을 때 그 1개뿐이야. 상대가 방금 말한 기억은 그 이야기에 답할 때만 써.',
    '일정이 바뀌었다는 말에 "이번 주/다음 주"가 없으면 원래 일정이 있던 그 주 기준으로 생각해. 확실하지 않으면 확인해.',
    '기억에 없거나 헷갈리는 건 지어내지 말고 솔직하게 물어봐. 메모가 중국어여도 대답은 한국어로. 역할의 공개 이력은 기억 카드가 아니야.',
  ].join('\n'));
  return parts.join('\n');
}

const EXTRACT_SYSTEM = `你是聊天应用的记忆整理员。根据「新对话」更新关于用户的记忆卡片。同一次回复里给出中文卡片和双语标签，不要调用别的服务。
规则：
- 只记录用户本人亲口说过的事。不记录角色说的话，不编造用户没说过的事，不把角色的公开履历、人设、喜好写进卡片。
- 对方只是在提问、开玩笑、复述角色的话时，不算用户说过这件事，不要记。
- category 只能是 preference（喜好）、recent（近况）、promise（约定，必须有 date）、address（称呼）。
- tags 是这件事的关键词，同时给中文和韩文说法（例如草莓和딸기）。没有把握的韩文可以不写，不要编一个假词。
- 卡片用简短中文，一句话，以“用户”开头，如“用户喜欢草莓”。
- 相对日期按今天换算成 YYYY-MM-DD；没有日期则 date 为 null。约定没有日期就不要记成 promise。
- 意思相近的旧卡用 update 合并，不要再 add 一张；同一件事换个说法也只更新旧卡。
- 已标记「用户已编辑」的旧卡是最终版本，不要再 update，也不要再 add 相似卡片。
- 「已删除」里的内容不要再新增相同或相似的卡片。
- 每次最多 add 一张新卡。没有把握、或只是闲聊没有新事实时，返回空 ops。
只输出 JSON：{"ops":[{"op":"add","text":"用户喜欢草莓","category":"preference","date":null,"tags":["草莓","딸기"]},{"op":"update","id":"...","text":"...","category":"promise","date":"YYYY-MM-DD","tags":["考试","시험"]},{"op":"delete","id":"..."}]}`;

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function draftFrom(op, now) {
  return cardsLib.normalizeCard({
    text: op.text,
    date: op.date,
    category: op.category,
    tags: op.tags,
    createdAt: now,
    updatedAt: now,
  }, now);
}

function applyOps(mem, ops, now = Date.now(), options = {}) {
  if (!Array.isArray(ops)) return 0;
  const maxNew = Number.isInteger(options.maxNew) ? Math.max(0, options.maxNew) : MAX_NEW_PER_TURN;
  let n = 0;
  let added = 0;
  for (const op of ops.slice(0, 10)) {
    if (!op || typeof op !== 'object') continue;
    const text = typeof op.text === 'string' ? op.text.trim().slice(0, 120) : '';
    if (op.op === 'add' && text) {
      if (added >= maxNew) continue;
      const draft = draftFrom(op, now);
      if (!draft.text) continue;
      if ((mem.deleted || []).some((item) => item.text === draft.text || cardsLib.similar(item, draft))) continue;
      const twin = mem.cards.find((card) => cardsLib.similar(cardsLib.normalizeCard(card, now), draft));
      if (twin) {
        // A card the user edited is authoritative; extraction never overwrites it.
        if (twin.edited === true) continue;
        twin.text = draft.text;
        twin.date = draft.date;
        twin.category = draft.category;
        twin.tags = draft.tags;
        twin.updatedAt = now;
        n += 1;
        continue;
      }
      mem.cards.push({
        id: crypto.randomBytes(6).toString('hex'),
        text: draft.text,
        date: draft.date,
        category: draft.category,
        tags: draft.tags,
        status: draft.status,
        createdAt: now,
        updatedAt: now,
        raisedAt: null,
        askedAt: null,
      });
      added += 1;
      n += 1;
    } else if (op.op === 'update' && text) {
      const card = mem.cards.find((item) => item.id === op.id);
      if (!card) continue;
      if (card.edited === true) continue;
      const draft = draftFrom(op, now);
      card.text = draft.text;
      card.date = draft.date;
      card.category = draft.category;
      card.tags = draft.tags;
      card.updatedAt = now;
      n += 1;
    } else if (op.op === 'delete') {
      const card = mem.cards.find((item) => item.id === op.id);
      if (!card) continue;
      mem.cards = mem.cards.filter((item) => item.id !== op.id);
      mem.deleted = [...(mem.deleted || []), { text: card.text, tags: card.tags, category: card.category, at: now }].slice(-MAX_DELETED);
      n += 1;
    }
  }
  if (mem.cards.length > MAX_CARDS) {
    mem.cards.sort((a, b) => b.updatedAt - a.updatedAt);
    mem.cards = mem.cards.slice(0, MAX_CARDS);
  }
  return n;
}

async function extract(mem, llm, userName) {
  const cards = mem.cards.map((c) => ({
    id: c.id,
    text: c.text,
    date: c.date || null,
    category: c.category || null,
    tags: c.tags || [],
    weekday: c.date ? weekdayOf(c.date) : null,
    edited: c.edited === true,
  }));
  const deleted = mem.deleted.slice(-30).map((d) => d.text);
  const convo = mem.pending.map((p) => `用户：${p.u}\n角色：${p.a}`).join('\n');
  const user = `今天：${todayStr()}（${weekday()}）\n用户昵称：${userName || ''}\n现有卡片：${JSON.stringify(cards)}\n已删除：${JSON.stringify(deleted)}\n新对话：\n${convo}`;
  const out = await llm([{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content: user }], { json: true, temperature: 0.2 });
  const parsed = parseJson(out);
  return applyOps(mem, parsed && parsed.ops);
}

function packFacts(characterId) {
  try { return fs.readFileSync(path.join(__dirname, '..', 'characters', characterId, 'facts.md'), 'utf8'); } catch (_) { return ''; }
}

async function summarize(mem, messages, llm, factText) {
  const lines = messages.map((m) => `${m.role === 'user' ? '用户' : '角色'}：${String(m.text).slice(0, 300)}`).join('\n');
  const sys = `把聊天记录合并进已有的滚动摘要。用中文，第三人称，只保留用户说过的脉络（聊过的话题、用户的情绪和近况、双方的小约定）。不要写入角色的公开履历、出道、专辑或人设事实，也不要编造用户没说过的事。总长度不超过${SUMMARY_MAX_CHARS}字。只输出摘要正文。`;
  const out = await llm([{ role: 'system', content: sys }, { role: 'user', content: `已有摘要：${mem.summary || '（无）'}\n新增聊天：\n${lines}` }], { temperature: 0.3 });
  const text = cardsLib.cleanSummary(String(out || '').trim(), factText);
  if (text) { mem.summary = text; mem.summaryUpdatedAt = Date.now(); }
}

// Called after each reply without awaiting. Resolves to the number of extra LLM calls made.
function afterTurn({ userId, characterId, userText, replyText, llm, userName, getHistory }) {
  return withLock(`${userId}:${characterId}`, async () => {
    const mem = load(userId, characterId);
    mem.pending = [...mem.pending, { u: String(userText).slice(0, 600), a: String(replyText).slice(0, 400), t: Date.now() }].slice(-6);
    mem.pendingTurns += 1;
    let calls = 0;
    if (mem.pendingTurns >= 2 || SUBSTANCE_RE.test(userText)) {
      try { await extract(mem, llm, userName); calls += 1; mem.pending = []; mem.pendingTurns = 0; } catch (err) { console.error('Memory extract failed'); }
    }
    const history = getHistory ? getHistory() : [];
    const old = history.slice(0, Math.max(0, history.length - WINDOW)).filter((m) => m.time > mem.summarizedUntil && m.fallback !== true);
    if (old.length >= SUMMARY_BATCH) {
      try { await summarize(mem, old, llm, packFacts(characterId)); calls += 1; mem.summarizedUntil = old[old.length - 1].time; } catch (err) { console.error('Memory summary failed'); }
    }
    save(userId, characterId, mem);
    return calls;
  });
}

module.exports = {
  noteOpening, recentOpenings, load, publicView, deleteCard, editCard, forgetText, clearSummary, clearAll,
  promptBlock, afterTurn, applyOps, idle, setBackend, storeBackend, WINDOW, MAX_NEW_PER_TURN,
  summarize, cleanSummary: cardsLib.cleanSummary, selectForPrompt: cardsLib.selectForPrompt,
};
