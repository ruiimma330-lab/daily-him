'use strict';

const HOUR = 60 * 60 * 1000;
const WINDOW_MS = 72 * HOUR;

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[\s"'“”‘’]/g, '').trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((key) => url.searchParams.delete(key));
    return url.toString();
  } catch (_) {
    return String(value || '').trim();
  }
}

function withinWindow(publishedAt, now, windowMs = WINDOW_MS) {
  const time = Date.parse(publishedAt);
  if (!Number.isFinite(time)) return false;
  return time <= now + 5 * 60 * 1000 && now - time <= windowMs;
}

function matchesKeywords(item, keywords) {
  if (!Array.isArray(keywords) || !keywords.length) return true;
  const hay = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  return keywords.some((word) => hay.includes(String(word || '').toLowerCase()));
}

function decode(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8211;/g, '–')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function parseRss(xml, pageUrl) {
  const items = [];
  const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const title = decode((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const link = decode((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '').trim();
    const pub = decode((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '').trim();
    const summary = decode((block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || !link) continue;
    const publishedAt = Number.isFinite(Date.parse(pub)) ? new Date(pub).toISOString() : null;
    items.push({ title, url: new URL(link, pageUrl || 'https://example.invalid').href, publishedAt, summary: summary.slice(0, 500) });
  }
  return items;
}

function parseHtml(html, pageUrl) {
  const items = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const title = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 8) continue;
    const around = String(html).slice(match.index, match.index + 900);
    const date = around.match(/(20\d{2})[-.](\d{2})[-.](\d{2})/);
    let url = '';
    try { url = new URL(match[1], pageUrl).href; } catch (_) { url = ''; }
    if (!url || url.startsWith('javascript:')) continue;
    items.push({
      title,
      url,
      publishedAt: date ? `${date[1]}-${date[2]}-${date[3]}T00:00:00Z` : null,
      summary: '',
    });
  }
  return items;
}

function dedupe(items, existingKeys) {
  const seen = new Set(existingKeys || []);
  const out = [];
  for (const item of items) {
    const keys = [];
    if (item.url) keys.push(`u:${normalizeUrl(item.url)}`);
    if (item.title) keys.push(`t:${normalizeTitle(item.title)}`);
    if (!keys.length || keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    out.push(item);
  }
  return out;
}

function selectItems(items, { keywords, now, existingKeys, windowMs }) {
  const fresh = items.filter((item) => withinWindow(item.publishedAt, now, windowMs) && matchesKeywords(item, keywords));
  fresh.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return dedupe(fresh, existingKeys);
}

module.exports = {
  WINDOW_MS,
  normalizeTitle,
  normalizeUrl,
  withinWindow,
  parseRss,
  parseHtml,
  dedupe,
  selectItems,
};
