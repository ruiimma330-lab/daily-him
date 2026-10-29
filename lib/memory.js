'use strict';

// Long-term memory: cards + rolling summary, per userId + characterId.
// Storage goes through `backend` (file JSON now) so it can be swapped for a DB later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

const MAX_CARDS = 150;
const MAX_DELETED = 200;
const WINDOW = 20; // messages sent to the chat LLM
const SUMMARY_BATCH = 10; // summarize once this many messages have scrolled out
const SUMMARY_MAX_CHARS = 400;
const INJECT_MAX_CARDS = 12;
const SUBSTANCE_RE = /\d|좋아|싫어|시험|생일|약속|내일|모레|다음 ?주|이번 ?주|주말|월요일|화요일|수요일|목요일|금요일|토요일|일요일|불러|이름|공부|회사|학교|아파|여행|喜欢|讨厌|爱吃|考试|生日|约定|明天|后天|下周|这周|周末|星期|周[一二三四五六日天]|叫我|名字|学|上班|生病|旅行|改到|其实|不是/;

const fileBackend = {
  load(userId, characterId) {
    try {
      return JSON.parse(fs.readFileSync(store.scopedPath('memory', userId, characterId), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  },
  save(userId, characterId, data) {
    const file = store.scopedPath('memory', userId, characterId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, file);
  },
};
let backend = fileBackend;
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

function publicView(mem) {
  return {
    cards: [...mem.cards].sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, text: c.text, date: c.date || null, createdAt: c.createdAt, updatedAt: c.updatedAt })),
    summary: mem.summary || '',
    summaryUpdatedAt: mem.summaryUpdatedAt,
  };
}

function deleteCard(userId, characterId, id) {
  return withLock(`${userId}:${characterId}`, async () => {
    const mem = load(userId, characterId);
    const card = mem.cards.find((c) => c.id === id);
    if (!card) return false;
    mem.cards = mem.cards.filter((c) => c.id !== id);
    mem.deleted = [...mem.deleted, { text: card.text, at: Date.now() }].slice(-MAX_DELETED);
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

function bigrams(s) {
  const t = String(s || '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

// Cards relevant to the latest user message first, then most recent; capped.
function promptBlock(userId, characterId, lastUserText, userName) {
  const mem = load(userId, characterId);
  const forgotten = (mem.deleted || []).slice(-10).map((d) => d.text);
  if (!mem.cards.length && !mem.summary && !forgotten.length) return '';
  const q = bigrams(lastUserText);
  const scored = mem.cards.map((c) => {
    let hit = 0;
    for (const g of bigrams(c.text)) if (q.has(g)) hit += 1;
    return { c, hit };
  });
  scored.sort((a, b) => (b.hit - a.hit) || (b.c.updatedAt - a.c.updatedAt));
  const lines = scored.slice(0, INJECT_MAX_CARDS).map(({ c }) => `- ${c.date ? `[${c.date} ${weekdayOf(c.date)}] ` : ''}${c.text}`);
  const parts = [`## 네가 기억하는 것 (${userName || '상대'}가 전에 직접 말해 준 것, 중국어 메모)`];
  if (lines.length) parts.push(lines.join('\n'));
  if (mem.summary) parts.push(`지난 대화 요약: ${mem.summary}`);
  if (forgotten.length) parts.push(`잊어 달라고 한 것 (요약이나 대화 기록에 남아 있어도 절대 먼저 꺼내지 말고, 물어보면 잘 기억이 안 난다고 하고 다시 물어봐): ${forgotten.join(' / ')}`);
  parts.push([
    '이 기억은 친구가 자연스럽게 기억하는 것처럼만 써. 목록을 읊거나 한꺼번에 여러 개 꺼내지 마(한 턴에 최대 1개).',
    '가끔(몇 턴에 한 번) 날짜가 다가오거나 지난 일의 근황을 먼저 물어봐도 좋아. 오늘 날짜와 메모의 날짜를 비교해서 말해.',
    '일정이 바뀌었다는 말에 "이번 주/다음 주"가 없으면 원래 일정이 있던 그 주 기준으로 생각해(다음 주 수요일 시험이 금요일로 → 다음 주 금요일). 확실하지 않으면 "다음 주 금요일 말하는 거지?"처럼 확인해.',
    '기억에 없거나 헷갈리는 건 지어내지 말고 솔직하게 물어봐. 메모가 중국어여도 대답은 한국어로.',
  ].join('\n'));
  return parts.join('\n');
}

const EXTRACT_SYSTEM = `你是聊天应用的记忆整理员。根据「新对话」更新关于用户的记忆卡片。
规则：
- 只记录用户本人亲口说过的、以后聊天值得记住的事：喜好/讨厌、近况与事件（考试、旅行、生病等，带日期）、约定、希望被怎么称呼、身份背景（学习、工作）等。
- 绝对不要记录角色（助手）说的话或编的内容；不记录寒暄、无信息的话、对角色本身的提问。
- 卡片用简短中文，一句话，以“用户”开头，如“用户喜欢草莓”。
- 相对日期（明天、下周三）要根据今天换算成具体日期 YYYY-MM-DD 填入 date；没有日期则 date 为 null。
- 同一件事已有卡片时用 update 修改那张（例如考试改期），不要新增重复卡；新信息与旧卡矛盾时以新信息为准更新旧卡；用户说某事不再成立时 delete。
- 改期/更正时，如果用户没说“这周/下周”，新日期按原卡日期所在的那一周（周一到周日）计算：原卡是下周三(2026-11-04)，“改到周五”就是同一周的周五(2026-11-06)，不是今天之后最近的周五。用户明确说了“这周/明天”等才按字面算。
- 「已删除」列表里的内容是用户主动删除的，不要再新增相同或相似的卡片。
- 没有值得记的就返回空 ops。
只输出 JSON：{"ops":[{"op":"add","text":"...","date":null},{"op":"update","id":"...","text":"...","date":"YYYY-MM-DD"},{"op":"delete","id":"..."}]}`;

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

function applyOps(mem, ops, now = Date.now()) {
  if (!Array.isArray(ops)) return 0;
  let n = 0;
  const deletedTexts = new Set(mem.deleted.map((d) => d.text));
  for (const op of ops.slice(0, 10)) {
    if (!op || typeof op !== 'object') continue;
    const text = typeof op.text === 'string' ? op.text.trim().slice(0, 120) : '';
    const date = typeof op.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(op.date) ? op.date : null;
    if (op.op === 'add' && text) {
      if (deletedTexts.has(text) || mem.cards.some((c) => c.text === text)) continue;
      mem.cards.push({ id: crypto.randomBytes(6).toString('hex'), text, date, createdAt: now, updatedAt: now });
      n += 1;
    } else if (op.op === 'update' && text) {
      const c = mem.cards.find((x) => x.id === op.id);
      if (!c) continue;
      c.text = text; c.date = date; c.updatedAt = now; n += 1;
    } else if (op.op === 'delete') {
      const before = mem.cards.length;
      mem.cards = mem.cards.filter((x) => x.id !== op.id);
      if (mem.cards.length !== before) n += 1;
    }
  }
  if (mem.cards.length > MAX_CARDS) {
    mem.cards.sort((a, b) => b.updatedAt - a.updatedAt);
    mem.cards = mem.cards.slice(0, MAX_CARDS);
  }
  return n;
}

async function extract(mem, llm, userName) {
  const cards = mem.cards.map((c) => ({ id: c.id, text: c.text, date: c.date || null, weekday: c.date ? weekdayOf(c.date) : null }));
  const deleted = mem.deleted.slice(-30).map((d) => d.text);
  const convo = mem.pending.map((p) => `用户：${p.u}\n角色：${p.a}`).join('\n');
  const user = `今天：${todayStr()}（${weekday()}）\n用户昵称：${userName || ''}\n现有卡片：${JSON.stringify(cards)}\n已删除：${JSON.stringify(deleted)}\n新对话：\n${convo}`;
  const out = await llm([{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content: user }], { json: true, temperature: 0.2 });
  const parsed = parseJson(out);
  return applyOps(mem, parsed && parsed.ops);
}

async function summarize(mem, messages, llm) {
  const lines = messages.map((m) => `${m.role === 'user' ? '用户' : '角色'}：${String(m.text).slice(0, 300)}`).join('\n');
  const sys = `把聊天记录合并进已有的滚动摘要。用中文，第三人称，只保留以后聊天有用的脉络（聊过的话题、用户的情绪和近况、双方的小约定），不写角色编造的事实。总长度不超过${SUMMARY_MAX_CHARS}字，旧内容可压缩。只输出摘要正文。`;
  const out = await llm([{ role: 'system', content: sys }, { role: 'user', content: `已有摘要：${mem.summary || '（无）'}\n新增聊天：\n${lines}` }], { temperature: 0.3 });
  const text = String(out || '').trim().slice(0, SUMMARY_MAX_CHARS + 50);
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
    const old = history.slice(0, Math.max(0, history.length - WINDOW)).filter((m) => m.time > mem.summarizedUntil);
    if (old.length >= SUMMARY_BATCH) {
      try { await summarize(mem, old, llm); calls += 1; mem.summarizedUntil = old[old.length - 1].time; } catch (err) { console.error('Memory summary failed'); }
    }
    save(userId, characterId, mem);
    return calls;
  });
}

module.exports = { noteOpening, recentOpenings, load, publicView, deleteCard, clearAll, promptBlock, afterTurn, applyOps, idle, setBackend, fileBackend, WINDOW };
