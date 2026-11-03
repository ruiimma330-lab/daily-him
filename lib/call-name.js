'use strict';

const MAX = 12;
const REFUSE_RE = /^(不知道啊?|不想说|不用了?|随便|비밀(이야)?|pass|skip|없어|말\s*안\s*할래|모르겠어|아무거나)$/i;
const GREET_RE = /^(안녕(하세요)?|하이|hi|hello|뭐\s*해|ㅎㅎ+|ㅋㅋ+|ㅎㅇ)$/i;
const YES_RE = /^(好的?|好啊|可以|行|嗯|是|对|응|웅|좋아|그래|ㅇㅇ|ok|okay)$/i;
const NO_RE = /^(不好|不要|不行|不对|아니|싫어|no)$/i;

function chars(value) {
  return [...String(value || '')];
}

function sanitize(raw) {
  const cleaned = String(raw || '')
    .replace(/[\r\n\t]/g, '')
    .replace(/[{}<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const list = chars(cleaned);
  if (!list.length || list.length > MAX) return '';
  if (/[?？]/.test(cleaned)) return '';
  return list.join('');
}

function particle(name) {
  const last = chars(name).pop() || '';
  const code = last.codePointAt(0) || 0;
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? '야' : '아';
  return '아';
}

function confirmItem(name) {
  const safe = sanitize(name);
  return {
    ko: `${safe}${particle(safe)}~ 기억했어!`,
    zh: `${safe}～记住啦！`,
    mood: 'sweet',
  };
}

function unsureItem(name) {
  const safe = sanitize(name);
  return {
    ko: `그럼 ${safe}${particle(safe)}라고 부를게, 괜찮을까?`,
    zh: `那我就叫你${safe}，好不好？`,
    mood: 'sweet',
  };
}

function fallbackItem() {
  return {
    ko: '그럼 일단 에리라고 부를게. 바꾸고 싶으면 언제든 말해~',
    zh: '那我先叫你에리，想改随时告诉我~',
    mood: 'soft',
  };
}

function statusOf(profile) {
  const saved = profile && typeof profile.callNameStatus === 'string' ? profile.callNameStatus : '';
  if (saved) return saved;
  if (profile && profile.callName) return 'done';
  return '';
}

function extract(text) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return { kind: 'none' };
  const bare = compact.replace(/[~～.。!！]+$/g, '');
  if (REFUSE_RE.test(bare)) return { kind: 'refuse' };
  if (YES_RE.test(bare)) return { kind: 'yes' };
  if (NO_RE.test(bare)) return { kind: 'no' };
  const patterns = [
    /^(?:请)?叫我\s*(.+)$/,
    /^我叫\s*(.+)$/,
    /^就叫\s*(.+)$/,
    /^(.+?)就好$/,
    /^(.+?)이라고\s*불러(?:줘|요)?$/,
    /^(.+?)\s*라고\s*불러(?:줘|요)?$/,
    /^나는\s+(.+?)(?:야|이야)?$/,
    /^call me\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (!match) continue;
    const name = sanitize(String(match[1] || '').replace(/[吧呀啊哦哟~～.。!！]+$/g, ''));
    if (name) return { kind: 'name', name, via: 'pattern' };
  }
  if (chars(compact).length <= MAX && !/[?？]/.test(compact) && !GREET_RE.test(bare)) {
    const name = sanitize(compact);
    if (name) return { kind: 'name', name, via: 'short' };
  }
  return { kind: 'none' };
}

function fixed(patch, item) {
  return {
    mode: 'fixed',
    patch,
    ko: item.ko,
    zh: item.zh,
    mood: item.mood,
  };
}

function plan(profile, text) {
  const status = statusOf(profile);
  if (status !== 'pending' && status !== 'confirming') return { mode: 'normal' };
  const hit = extract(text);
  if (status === 'confirming') {
    if (hit.kind === 'name') {
      return fixed({
        callName: hit.name,
        callNameSource: 'asked',
        callNameStatus: 'done',
        callNameCandidate: '',
        callNameAsks: 0,
      }, confirmItem(hit.name));
    }
    if (hit.kind === 'yes' && sanitize(profile && profile.callNameCandidate)) {
      const name = sanitize(profile.callNameCandidate);
      return fixed({
        callName: name,
        callNameSource: 'asked',
        callNameStatus: 'done',
        callNameCandidate: '',
        callNameAsks: 0,
      }, confirmItem(name));
    }
    if (hit.kind === 'no' || hit.kind === 'refuse') {
      return fixed({
        callName: '에리',
        callNameSource: 'fallback',
        callNameStatus: 'done',
        callNameCandidate: '',
        callNameAsks: 0,
      }, fallbackItem());
    }
    return { mode: 'chat', unnamed: true, asks: Number(profile && profile.callNameAsks) || 0 };
  }
  if (hit.kind === 'name') {
    return fixed({
      callName: hit.name,
      callNameSource: 'asked',
      callNameStatus: 'done',
      callNameCandidate: '',
      callNameAsks: 0,
    }, confirmItem(hit.name));
  }
  if (hit.kind === 'refuse') {
    return fixed({
      callName: '에리',
      callNameSource: 'fallback',
      callNameStatus: 'done',
      callNameCandidate: '',
      callNameAsks: 0,
    }, fallbackItem());
  }
  return { mode: 'chat', unnamed: true, asks: Number(profile && profile.callNameAsks) || 0 };
}

function parseModelAddress(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[0]); } catch (_) { return null; }
  const address = data && (data.address || data.callName);
  if (!address || typeof address !== 'object' || Array.isArray(address)) return null;
  const name = sanitize(address.name || address.value || '');
  const confidence = String(address.confidence || '').toLowerCase();
  return {
    name,
    confidence: confidence === 'high' || confidence === 'low' ? confidence : 'none',
  };
}

function settle(profile, content) {
  const status = statusOf(profile);
  if (status !== 'pending' && status !== 'confirming') return null;
  const address = parseModelAddress(content);
  if (address && address.name && address.confidence === 'high') {
    return {
      patch: {
        callName: address.name,
        callNameSource: 'asked',
        callNameStatus: 'done',
        callNameCandidate: '',
        callNameAsks: 0,
      },
    };
  }
  if (address && address.name && address.confidence === 'low') {
    const item = unsureItem(address.name);
    return {
      patch: { callNameStatus: 'confirming', callNameCandidate: address.name },
      replace: true,
      ko: item.ko,
      zh: item.zh,
      mood: item.mood,
    };
  }
  const asks = Number(profile && profile.callNameAsks) || 0;
  if (asks >= 1) {
    const item = fallbackItem();
    return {
      patch: {
        callName: '에리',
        callNameSource: 'fallback',
        callNameStatus: 'done',
        callNameCandidate: '',
        callNameAsks: asks,
      },
      replace: true,
      ko: item.ko,
      zh: item.zh,
      mood: item.mood,
    };
  }
  return { patch: { callNameStatus: 'pending', callNameAsks: asks + 1 } };
}

function promptHint(asks) {
  const again = Number(asks) >= 1
    ? '이름은 다시 묻지 마.'
    : '이번 대화 끝에 이름을 한 번만 자연스럽게 물어.';
  return `对方还没告诉你称呼，先不要叫具体名字。${again} 답장 JSON에 "address":{"name":"","confidence":"high|low|none"} 를 넣어. name은 상대가 원하는 호칭만 넣고, 없으면 빈 문자열.`;
}

module.exports = {
  MAX,
  sanitize,
  particle,
  extract,
  plan,
  settle,
  parseModelAddress,
  promptHint,
  confirmItem,
  unsureItem,
  fallbackItem,
  statusOf,
};
