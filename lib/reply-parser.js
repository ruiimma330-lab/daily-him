'use strict';

const JSON_REPLY_RE = /^\s*\{|\{\s*"?messages"?\s*:/;
const MESSAGES_PREFIX_RE = /^\s*\{\s*"?messages"?\s*:/;

function looksLikeJsonReply(text) {
  return JSON_REPLY_RE.test(String(text || ''));
}

function isMessagesPayload(text) {
  return MESSAGES_PREFIX_RE.test(String(text || ''));
}

const JSON_KEYS = [
  'messages', 'mood', 'ko', 'zh',
  'kind', 'title',
  'address', 'callName', 'name', 'value', 'confidence',
  'cards', 'text', 'category', 'date', 'summary',
  'keep', 'drop', 'add', 'update', 'delete', 'id', 'reason',
  'ops', 'op', 'tags',
].join('|');
const MISSING_OPEN_QUOTE_RE = new RegExp(`([,{]\\s*)(${JSON_KEYS})"\\s*:`, 'g');
const MISSING_CLOSE_QUOTE_RE = new RegExp(`([,{]\\s*)"(${JSON_KEYS})\\s*:`, 'g');
const UNQUOTED_KEY_RE = new RegExp(`([,{]\\s*)(${JSON_KEYS})\\s*:`, 'g');

function repairJsonReply(raw) {
  return String(raw || '')
    .replace(MISSING_OPEN_QUOTE_RE, '$1"$2":')
    .replace(MISSING_CLOSE_QUOTE_RE, '$1"$2":')
    .replace(UNQUOTED_KEY_RE, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
}

function parseJsonLoose(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    try {
      return JSON.parse(repairJsonReply(m[0]));
    } catch (_2) {
      return null;
    }
  }
}

function parseReplyJson(text) {
  return parseJsonLoose(text);
}

function extractPreviewKo(text) {
  const raw = String(text || '');
  if (!isMessagesPayload(raw)) return raw;
  const data = parseReplyJson(raw);
  if (data && Array.isArray(data.messages)) {
    for (const item of data.messages) {
      const ko = item && typeof item.ko === 'string'
        ? item.ko.replace(/\[\[[\s\S]*?\]\]/g, '').replace(/\[\s*[A-Za-z][A-Za-z ,'-]*\]/g, '').replace(/\s+/g, ' ').trim()
        : '';
      if (ko) return ko;
    }
  }
  const match = raw.match(/"?ko"?\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (match) {
    let extracted = match[1];
    try { extracted = JSON.parse(`"${match[1]}"`); } catch (_) {}
    return extracted.replace(/\[\[[\s\S]*?\]\]/g, '').replace(/\[\s*[A-Za-z][A-Za-z ,'-]*\]/g, '').replace(/\s+/g, ' ').trim();
  }
  return '';
}

module.exports = {
  looksLikeJsonReply,
  isMessagesPayload,
  repairJsonReply,
  parseJsonLoose,
  parseReplyJson,
  extractPreviewKo,
};
