'use strict';

// Curated Moments (朋友圈): posts from characters/<id>/moments.json;
// per-user likes/comments (and his occasional replies) in storage kind "moments".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const characters = require('./characters');

const CHAR_DIR = path.join(__dirname, '..', 'characters');
const MAX_COMMENT = 200;
const MAX_COMMENTS_PER_POST = 40;
const REPLY_COOLDOWN_MS = 90 * 1000; // don't reply to every comment from the same user

const chains = new Map();
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn).catch((err) => {
    console.error(`Moments task failed (${err && err.message ? String(err.message).slice(0, 80) : 'unknown'})`);
  });
  chains.set(key, next);
  next.then(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}

function loadPosts(characterId) {
  const id = characters.resolveId(characterId);
  if (!id) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CHAR_DIR, id, 'moments.json'), 'utf8'));
    if (!raw || !Array.isArray(raw.posts)) return [];
    return raw.posts
      .filter((p) => p && typeof p.id === 'string' && typeof p.ko === 'string' && p.publishedAt)
      .map((p) => ({
        id: String(p.id).slice(0, 40),
        publishedAt: p.publishedAt,
        ko: String(p.ko).slice(0, 2000),
        zh: typeof p.zh === 'string' ? p.zh.slice(0, 2000) : '',
        link: typeof p.link === 'string' ? p.link.slice(0, 300) : null,
      }))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read moments.json');
    return [];
  }
}

function emptyState() {
  return { liked: {}, comments: [], lastReplyAt: 0 };
}

function loadState(userId, characterId) {
  return { ...emptyState(), ...(store.getDoc('moments', userId, characterId) || {}) };
}

function saveState(userId, characterId, state) {
  store.putDoc('moments', userId, characterId, state);
}

function list(userId, characterId) {
  const posts = loadPosts(characterId);
  const state = loadState(userId, characterId);
  return posts.map((p) => {
    const comments = (state.comments || []).filter((c) => c.postId === p.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({
        id: c.id,
        text: c.text,
        createdAt: c.createdAt,
        reply: c.reply ? { text: c.reply.text, createdAt: c.reply.createdAt } : null,
      }));
    return {
      ...p,
      liked: Boolean(state.liked && state.liked[p.id]),
      likeCount: (state.liked && state.liked[p.id]) ? 1 : 0, // personal Moments: only your like shown
      comments,
      commentCount: comments.length,
    };
  });
}

function toggleLike(userId, characterId, postId) {
  const posts = loadPosts(characterId);
  if (!posts.some((p) => p.id === postId)) return null;
  const state = loadState(userId, characterId);
  if (!state.liked) state.liked = {};
  if (state.liked[postId]) delete state.liked[postId];
  else state.liked[postId] = Date.now();
  saveState(userId, characterId, state);
  return { liked: Boolean(state.liked[postId]), likeCount: state.liked[postId] ? 1 : 0 };
}

function addComment(userId, characterId, postId, text) {
  const posts = loadPosts(characterId);
  const post = posts.find((p) => p.id === postId);
  if (!post) return null;
  const cleaned = String(text || '').trim().slice(0, MAX_COMMENT);
  if (!cleaned) {
    const err = new Error('empty');
    err.code = 'EMPTY';
    throw err;
  }
  const state = loadState(userId, characterId);
  const onPost = (state.comments || []).filter((c) => c.postId === postId);
  if (onPost.length >= MAX_COMMENTS_PER_POST) {
    const err = new Error('too many');
    err.code = 'LIMIT';
    throw err;
  }
  const comment = { id: crypto.randomBytes(6).toString('hex'), postId, text: cleaned, createdAt: Date.now(), reply: null };
  state.comments = [...(state.comments || []), comment];
  saveState(userId, characterId, state);
  return comment;
}

function commentsFor(userId, characterId, postId) {
  const state = loadState(userId, characterId);
  return (state.comments || []).filter((c) => c.postId === postId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((c) => ({
      id: c.id,
      text: c.text,
      createdAt: c.createdAt,
      reply: c.reply ? { text: c.reply.text, createdAt: c.reply.createdAt } : null,
    }));
}

const REPLY_SYSTEM = `너는 {{name}} 본인이야. 친구의 「모멘트/朋友圈」 댓글에 짧게 답하는 중이야.
규칙:
- 한국어로만, 1문장(아주 길면 2문장까지). 반말, 다정하고 장난스러워도 됨.
- 자신을 AI/모델/프로그램이라고 말하지 마. 그런 단어 쓰지 마.
- 댓글이 선 넘거나 성적/혐오면 "에이~ 그런 건 안 되지~"처럼 가볍게 넘기고 끝내.
- 과장된 약속·연인 선언 하지 마. JSON만 출력: {"ko":"..."}`;

async function maybeReply({ userId, characterId, postId, comment, llm, userName }) {
  return withLock(`${userId}:${characterId}`, async () => {
    const state = loadState(userId, characterId);
    if (Date.now() - (state.lastReplyAt || 0) < REPLY_COOLDOWN_MS) return null;
    const post = loadPosts(characterId).find((p) => p.id === postId);
    if (!post) return null;
    const meta = characters.loadMeta(characterId);
    const name = meta.name || characterId;
    const sys = REPLY_SYSTEM.replace(/\{\{name\}\}/g, name);
    const user = `게시글:\n${post.ko}\n\n${userName || '친구'}의 댓글:\n${comment.text}\n\n짧게 답해 줘.`;
    let out;
    try {
      out = await llm([{ role: 'system', content: sys }, { role: 'user', content: user }], { json: true, temperature: 0.9 });
    } catch (_) {
      console.error('Moments reply LLM failed');
      return null;
    }
    let ko = '';
    try {
      const m = String(out || '').match(/\{[\s\S]*\}/);
      if (m) ko = String(JSON.parse(m[0]).ko || '').trim();
    } catch (_) { /* ignore */ }
    ko = ko.replace(/\n+/g, ' ').slice(0, 120);
    if (!ko) return null;
    const c = (state.comments || []).find((x) => x.id === comment.id);
    if (!c || c.reply) return null;
    c.reply = { text: ko, createdAt: Date.now() };
    state.lastReplyAt = Date.now();
    saveState(userId, characterId, state);
    return c.reply;
  });
}

module.exports = { list, toggleLike, addComment, commentsFor, maybeReply, loadPosts };
