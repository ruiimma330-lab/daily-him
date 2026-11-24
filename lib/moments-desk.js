'use strict';

const crypto = require('crypto');
const store = require('./store');

const SETTING = 'moments.feed';
const DAY = 24 * 60 * 60 * 1000;

function emptyFeed() {
  return { characters: {} };
}

function readFeed() {
  const raw = store.getSetting(SETTING);
  if (!raw) return emptyFeed();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.characters) return emptyFeed();
    return parsed;
  } catch (_) {
    return emptyFeed();
  }
}

function writeFeed(feed) {
  store.putSetting(SETTING, JSON.stringify(feed));
}

function bucket(feed, characterId) {
  if (!feed.characters[characterId]) {
    feed.characters[characterId] = { lastRefreshAt: 0, drafts: [], published: [] };
  }
  return feed.characters[characterId];
}

function dayKey(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

function publicPosts(characterId) {
  const box = readFeed().characters[characterId];
  if (!box || !Array.isArray(box.published)) return [];
  const moments = require('./moments');
  return box.published.map((post) => {
    const kind = moments.normalizeKind(post.kind);
    return {
      id: post.id,
      publishedAt: post.publishedAt,
      kind,
      kindLabel: moments.kindLabel(kind),
      title: typeof post.title === 'string' ? post.title.trim().slice(0, 80) : '',
      ko: post.ko,
      zh: post.zh || '',
      link: moments.publicLink(post.link),
      images: [],
    };
  });
}

function draftsFor(characterId) {
  const box = readFeed().characters[characterId];
  if (!box) return [];
  return (box.drafts || []).filter((item) => item.status === 'draft');
}

function knownKeys(characterId) {
  const box = readFeed().characters[characterId] || { drafts: [], published: [] };
  const keys = [];
  for (const item of [...(box.drafts || []), ...(box.published || [])]) {
    if (item.sourceUrl) keys.push(`u:${item.sourceUrl}`);
    if (item.sourceTitle) keys.push(`t:${item.sourceTitle}`);
  }
  return keys;
}

function draftedToday(characterId, now) {
  const box = readFeed().characters[characterId];
  if (!box) return 0;
  const day = dayKey(now);
  return (box.drafts || []).filter((item) => dayKey(item.createdAt || 0) === day).length;
}

function lastRefreshAt(characterId) {
  const box = readFeed().characters[characterId];
  return box ? box.lastRefreshAt || 0 : 0;
}

function markRefreshed(characterId, now) {
  const feed = readFeed();
  bucket(feed, characterId).lastRefreshAt = now;
  writeFeed(feed);
}

function addDraft(characterId, draft, now) {
  const moments = require('./moments');
  const feed = readFeed();
  const box = bucket(feed, characterId);
  box.drafts.push({
    id: crypto.randomBytes(6).toString('hex'),
    status: 'draft',
    kind: moments.normalizeKind(draft.kind),
    title: typeof draft.title === 'string' ? draft.title.trim().slice(0, 80) : '',
    ko: String(draft.ko || '').trim().slice(0, 2000),
    zh: String(draft.zh || '').trim().slice(0, 2000),
    link: moments.publicLink(draft.link),
    sourceUrl: draft.sourceUrl || '',
    sourceTitle: draft.sourceTitle || '',
    createdAt: now,
  });
  writeFeed(feed);
  return box.drafts[box.drafts.length - 1];
}

function findDraft(characterId, id) {
  const feed = readFeed();
  const box = feed.characters[characterId];
  if (!box) return null;
  const draft = (box.drafts || []).find((item) => item.id === id && item.status === 'draft');
  return draft ? { feed, box, draft } : null;
}

function updateDraft(characterId, id, patch) {
  const moments = require('./moments');
  const found = findDraft(characterId, id);
  if (!found) return null;
  if (typeof patch.ko === 'string') found.draft.ko = patch.ko.trim().slice(0, 2000);
  if (typeof patch.zh === 'string') found.draft.zh = patch.zh.trim().slice(0, 2000);
  if (typeof patch.kind === 'string') found.draft.kind = moments.normalizeKind(patch.kind);
  if (typeof patch.title === 'string') found.draft.title = patch.title.trim().slice(0, 80);
  if (typeof patch.link === 'string') found.draft.link = moments.publicLink(patch.link);
  writeFeed(found.feed);
  return found.draft;
}

function discardDraft(characterId, id) {
  const found = findDraft(characterId, id);
  if (!found) return null;
  found.draft.status = 'discarded';
  writeFeed(found.feed);
  return found.draft;
}

function publishDraft(characterId, id, now) {
  const found = findDraft(characterId, id);
  if (!found || !found.draft.ko) return null;
  found.draft.status = 'published';
  const moments = require('./moments');
  const kind = moments.normalizeKind(found.draft.kind);
  found.box.published.push({
    id: `p${found.draft.id}`,
    publishedAt: new Date(now).toISOString(),
    kind,
    title: typeof found.draft.title === 'string' ? found.draft.title : '',
    ko: found.draft.ko,
    zh: found.draft.zh,
    link: moments.publicLink(found.draft.link),
    sourceUrl: found.draft.sourceUrl,
    sourceTitle: found.draft.sourceTitle,
  });
  writeFeed(found.feed);
  return found.box.published[found.box.published.length - 1];
}

module.exports = {
  DAY,
  publicPosts,
  draftsFor,
  knownKeys,
  draftedToday,
  lastRefreshAt,
  markRefreshed,
  addDraft,
  updateDraft,
  discardDraft,
  publishDraft,
};
