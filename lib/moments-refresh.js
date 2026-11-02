'use strict';

const fs = require('fs');
const path = require('path');
const characters = require('./characters');
const sources = require('./moments-sources');
const desk = require('./moments-desk');
const { requestChatCompletion } = require('./llm-chat');

const running = new Set();
const MAX_PER_DAY = 2;

function defaultLlm() {
  const key = String(process.env.DEEPSEEK_CHAT_API_KEY || '').trim();
  if (!key) return null;
  const model = String(process.env.LLM_MODEL || 'deepseek-v4-pro').trim();
  return async (messages) => {
    const result = await requestChatCompletion({
      fetchImpl: fetch,
      url: 'https://api.deepseek.com/chat/completions',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: { model, temperature: 0.7, messages, response_format: { type: 'json_object' } },
    });
    if (!result.ok) {
      console.error(`Moments LLM failed (${result.reason})`);
      return '';
    }
    return result.content;
  };
}

function enabled() {
  return Boolean(String(process.env.MOMENTS_REFRESH_SECRET || '').trim());
}

function loadSources(characterId) {
  const id = characters.resolveId(characterId);
  if (!id) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(characters.CHAR_DIR, id, 'sources.json'), 'utf8'));
    return Array.isArray(raw.sources) ? raw.sources : [];
  } catch (_) {
    return [];
  }
}

function curatedKeys(characterId) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(characters.CHAR_DIR, characterId, 'moments.json'), 'utf8'));
    const keys = [];
    for (const post of (raw && raw.posts) || []) {
      if (post && post.sourceUrl) keys.push(`u:${sources.normalizeUrl(post.sourceUrl)}`);
    }
    return keys;
  } catch (_) {
    return [];
  }
}

async function readSource(source, fetchImpl) {
  if (!source || source.enabled === false || source.kind === 'x') return [];
  const response = await fetchImpl(source.url, {
    headers: { 'User-Agent': 'DailyHimMoments/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const text = await response.text();
  if (source.kind === 'rss' || /<rss\b|<feed\b/i.test(text)) return sources.parseRss(text, source.url);
  return sources.parseHtml(text, source.url);
}

async function draftFromItem(item, llm) {
  const result = await llm([{
    role: 'system',
    content: '너는 아이돌 본인의 친구圈 초안을 쓴다. 주어진 공지에 있는 사실만 쓰고, 없는 일정·감정·장소는 만들지 마. 한국어 반말 1~3문장과 자연스러운 중국어 번역만. JSON만: {"ko":"...","zh":"..."}',
  }, {
    role: 'user',
    content: `제목: ${item.title}\n본문: ${item.summary || ''}\n링크: ${item.url}`,
  }]);
  const match = String(result || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const ko = String(parsed.ko || '').trim();
    const zh = String(parsed.zh || '').trim();
    if (!ko) return null;
    return { ko, zh };
  } catch (_) {
    return null;
  }
}

async function refreshCharacter(characterId, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const llm = options.llm;
  const now = options.now || Date.now();
  if (!enabled()) return { enabled: false, drafted: 0 };
  const id = characters.resolveId(characterId);
  if (!id) return { enabled: true, drafted: 0 };
  const list = loadSources(id);
  const fetched = [];
  let anyOk = false;
  for (const source of list) {
    if (source.enabled === false || source.kind === 'x') continue;
    try {
      const items = await readSource(source, fetchImpl);
      anyOk = true;
      fetched.push({ items, keywords: source.keywords });
    } catch (err) {
      console.error(`Moments source failed (${source.id || 'source'})`);
    }
  }
  const existing = [...curatedKeys(id), ...desk.knownKeys(id)];
  const unique = sources.dedupe(fetched.flatMap((batch) => sources.selectItems(batch.items, {
    keywords: batch.keywords,
    now,
    existingKeys: existing,
  })), existing);
  const room = Math.max(0, MAX_PER_DAY - desk.draftedToday(id, now));
  let drafted = 0;
  const writer = llm || defaultLlm();
  if (writer) {
    for (const item of unique.slice(0, room)) {
      try {
        const text = await draftFromItem(item, writer);
        if (!text) continue;
        desk.addDraft(id, {
          ko: text.ko,
          zh: text.zh,
          sourceUrl: sources.normalizeUrl(item.url),
          sourceTitle: sources.normalizeTitle(item.title),
        }, now);
        drafted += 1;
      } catch (err) {
        console.error('Moments draft failed');
      }
    }
  }
  if (anyOk || !list.some((source) => source.enabled !== false && source.kind !== 'x')) desk.markRefreshed(id, now);
  return { enabled: true, drafted };
}

function maybeRefresh(characterId, deps) {
  if (!enabled()) return;
  const id = characters.resolveId(characterId);
  if (!id || running.has(id)) return;
  const now = deps && deps.now ? deps.now() : Date.now();
  if (now - desk.lastRefreshAt(id) < desk.DAY) return;
  running.add(id);
  refreshCharacter(id, deps).catch((err) => {
    console.error('Moments refresh failed');
  }).finally(() => running.delete(id));
}

module.exports = { enabled, loadSources, refreshCharacter, maybeRefresh, MAX_PER_DAY };
