const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { digitUsername } = require('./helpers');
const sources = require('../lib/moments-sources');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-moments-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
delete process.env.DEEPSEEK_CHAT_API_KEY;
delete process.env.MOMENTS_REFRESH_SECRET;
delete process.env.MOMENTS_ADMINS;

const store = require('../lib/store');
const desk = require('../lib/moments-desk');
const moments = require('../lib/moments');
const refresh = require('../lib/moments-refresh');
const { createApp } = require('../server');

const NOW = Date.parse('2026-11-02T04:00:00Z');
const HOUR = 60 * 60 * 1000;

function rss(items) {
  const body = items.map((item) => `<item><title>${item.title}</title><link>${item.url}</link><pubDate>${item.date}</pubDate><description>${item.summary || ''}</description></item>`).join('');
  return `<?xml version="1.0"?><rss><channel>${body}</channel></rss>`;
}

function html(items) {
  return items.map((item) => `<a href="${item.url}"><span>${item.title}</span></a><li class="time" title="${item.day}">${item.day}</li>`).join('');
}

const recentRssDate = new Date(NOW - 2 * HOUR).toUTCString();
const oldRssDate = new Date(NOW - 10 * 24 * HOUR).toUTCString();

test('fetch filters, dedupes, and keeps only the last 72 hours', () => {
  const parsed = sources.parseRss(rss([
    { title: 'EXO 서울 공연 안내', url: 'https://www.smentertainment.com/newsroom/exo/?utm_source=x', date: recentRssDate, summary: 'EXO 공연' },
    { title: 'EXO 서울 공연 안내', url: 'https://www.smentertainment.com/newsroom/exo/', date: recentRssDate, summary: 'EXO 공연' },
    { title: '라이즈 신곡', url: 'https://www.smentertainment.com/newsroom/riize/', date: recentRssDate, summary: 'RIIZE' },
    { title: 'EXO 오래된 소식', url: 'https://www.smentertainment.com/newsroom/old/', date: oldRssDate, summary: 'EXO' },
  ]), 'https://www.smentertainment.com/newsroom/feed/');
  const picked = sources.selectItems(parsed, { keywords: ['EXO', '엑소'], now: NOW, existingKeys: [] });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].title, 'EXO 서울 공연 안내');
  assert.equal(sources.normalizeUrl(picked[0].url).includes('utm_source'), false);

  const page = sources.parseHtml(html([
    { title: '백현 팬미팅 안내입니다', url: '/notice/?idx=1', day: '2026-11-02' },
    { title: '백현 예전 안내입니다', url: '/notice/?idx=2', day: '2026-01-01' },
  ]), 'http://inb100.com/notice');
  const pagePicked = sources.selectItems(page, { keywords: ['백현'], now: NOW, existingKeys: [] });
  assert.equal(pagePicked.length, 1);
  assert.match(pagePicked[0].url, /^http:\/\/inb100.com\/notice/);
});

let base;
let server;
let fan;
let admin;

function cookieFrom(response, previous) {
  const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const sid = list.map((item) => item.split(';')[0]).find((item) => item.startsWith('sid='));
  if (sid) return sid;
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/sid=[^;]+/);
  return match ? match[0] : (previous || '');
}

async function request(pathname, { method = 'GET', body, cookie, headers } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
  return { status: response.status, json, cookie: cookieFrom(response, cookie) };
}

test.before(async () => {
  await store.init();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  fan = await request('/api/register', { method: 'POST', body: { username: digitUsername(), password: 'password1', age14: true } });
  const adminName = digitUsername();
  admin = await request('/api/register', { method: 'POST', body: { username: adminName, password: 'password1', age14: true } });
  process.env.MOMENTS_ADMINS = adminName;
});

test.after(async () => {
  delete process.env.MOMENTS_REFRESH_SECRET;
  delete process.env.MOMENTS_ADMINS;
  await store.flush();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('drafts stay hidden, admins can review them, and an unset secret turns refresh off', async () => {
  const off = await request('/api/moments/refresh', { method: 'POST', body: {} });
  assert.equal(off.status, 200);
  assert.equal(off.json.enabled, false);

  process.env.MOMENTS_REFRESH_SECRET = 'moments-test-secret';
  const denied = await request('/api/moments/refresh', {
    method: 'POST',
    body: { characterId: 'baekhyun' },
    headers: { Authorization: 'Bearer wrong' },
  });
  assert.equal(denied.status, 401);

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/api/')) return originalFetch(url);
    if (href.includes('newsroom')) {
      return { ok: true, status: 200, text: async () => rss([
        { title: 'EXO 새 공연 안내', url: 'https://www.smentertainment.com/newsroom/exo-new/', date: recentRssDate, summary: 'EXO가 서울에서 공연한다.' },
        { title: '라이즈 소식', url: 'https://www.smentertainment.com/newsroom/riize-new/', date: recentRssDate, summary: 'RIIZE' },
      ]) };
    }
    return { ok: true, status: 200, text: async () => html([
      { title: '백현 팬미팅 안내입니다', url: '/notice/?idx=9', day: '2026-11-02' },
    ]) };
  };
  try {
    const result = await refresh.refreshCharacter('baekhyun', {
      fetchImpl: global.fetch,
      now: NOW,
      llm: async () => JSON.stringify({
        kind: 'preview', title: '새 일정', ko: '오늘 소식 하나 있어.', zh: '今天有一条消息。',
      }),
    });
    assert.equal(result.enabled, true);
    assert.equal(result.drafted, 2);
    assert.equal(desk.draftsFor('baekhyun')[0].kind, 'preview');
    assert.equal(desk.draftsFor('baekhyun')[0].title, '새 일정');
    const again = await refresh.refreshCharacter('baekhyun', {
      fetchImpl: global.fetch,
      now: NOW,
      llm: async () => JSON.stringify({ ko: '또 다른 초안', zh: '另一条草稿' }),
    });
    assert.equal(again.drafted, 0);
  } finally {
    global.fetch = originalFetch;
  }

  const visible = moments.list(fan.json.user.id, 'baekhyun');
  assert.equal(visible.some((post) => post.ko === '오늘 소식 하나 있어.'), false);
  const fanView = await request('/api/admin/moments?characterId=baekhyun', { cookie: fan.cookie });
  assert.equal(fanView.status, 403);
  const adminView = await request('/api/admin/moments?characterId=baekhyun', { cookie: admin.cookie });
  assert.equal(adminView.status, 200);
  assert.equal(adminView.json.drafts.length, 2);
  assert.ok(adminView.json.drafts[0].sourceUrl);

  const edited = await request(`/api/admin/moments/${adminView.json.drafts[0].id}?characterId=baekhyun`, {
    method: 'PUT',
    cookie: admin.cookie,
    body: { ko: '수정한 초안', zh: '改过的草稿' },
  });
  assert.equal(edited.status, 200);
  const published = await request(`/api/admin/moments/${adminView.json.drafts[0].id}/publish?characterId=baekhyun`, {
    method: 'POST',
    cookie: admin.cookie,
  });
  assert.equal(published.status, 200);
  const feed = await request('/api/moments?characterId=baekhyun', { cookie: fan.cookie });
  assert.equal(feed.json.posts.some((post) => post.ko === '수정한 초안'), true);
  assert.equal(feed.json.posts.some((post) => post.sourceUrl), false);
  assert.equal(desk.draftsFor('baekhyun').some((item) => item.id === adminView.json.drafts[0].id), false);

  delete process.env.MOMENTS_ADMINS;
  const closed = await request('/api/admin/moments?characterId=baekhyun', { cookie: admin.cookie });
  assert.equal(closed.status, 404);
});

test('concurrent toggleLike during maybeReply preserves the like and saves the reply', async () => {
  const userId = fan.json.user.id;
  const postId = moments.loadPosts('baekhyun')[0].id;
  const comment = await moments.addComment(userId, 'baekhyun', postId, '오빠 오늘 멋있다');
  let markStarted;
  let releaseLlm;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseLlm = resolve; });
  const task = moments.maybeReply({
    userId,
    characterId: 'baekhyun',
    postId,
    comment,
    userName: '에리',
    llm: async () => {
      markStarted();
      await gate;
      return JSON.stringify({ ko: '고마워, 오늘 기분 좋네!' });
    },
  });
  await started;
  const liked = await moments.toggleLike(userId, 'baekhyun', postId);
  assert.equal(liked.liked, true);
  releaseLlm();
  const reply = await task;
  assert.ok(reply);
  assert.equal(reply.text, '고마워, 오늘 기분 좋네!');
  const item = moments.list(userId, 'baekhyun').find((p) => p.id === postId);
  assert.equal(item.liked, true);
  const savedComment = item.comments.find((c) => c.id === comment.id);
  assert.equal(savedComment.reply.text, '고마워, 오늘 기분 좋네!');
});
