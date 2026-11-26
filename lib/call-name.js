'use strict';

const replyParser = require('./reply-parser');

const MAX = 12;
const SHORT_MAX = 6;
const REFUSE_RE = /^(不知道啊?|不想说|不用了?|随便|비밀(이야)?|pass|skip|없어|말\s*안\s*할래|모르겠어|아무거나)$/i;
const GREET_RE = /^(안녕(하세요)?|하이|hi|hello|뭐\s*해|ㅎㅎ+|ㅋㅋ+|ㅎㅇ)$/i;
const YES_RE = /^(好的?|好啊|可以|行|嗯|是|对|응|웅|좋아|그래|ㅇㅇ|ok|okay)$/i;
const NO_RE = /^(不好|不要|不行|不对|아니|싫어|no)$/i;
const IDOL_ADDRESS_RE = /^(?:哥哥|哥|欧巴|오빠|형|형아|姐姐|姐|누나|언니|弟弟|妹妹|老公|老婆|宝宝|宝贝|亲爱的|男神|女神|爱豆|前辈|선배|자기|여보|小狗|小猫)(?:呀|啊|啦|呐|嘛|哦|喔|哟|야|아)?$/i;
const CHATTER_RE = /^(?:你好|您好|哈喽|嗨|在吗|在干嘛呢?|干嘛呢?|吃了吗|睡了吗|(?:好|太)?想你(?:了)?|(?:好|超)?喜欢你|(?:好|超)?爱你|晚安|早安|午安|哈哈+|嘿嘿+|呵呵+|呜呜+|哭了|救命|(?:今天|现在)?(?:好|太)?(?:累|饿|困|无聊|难过|开心)(?:了)?|饿了|累了|困了|睡了|无聊|(?:非常)?谢谢(?:你)?|抱歉|对不起|没事|没关系|(?:好|太|超)?可爱(?:了)?|(?:好|太|超)?帅(?:了)?|보고\s*싶어(?:요)?|사랑해(?:요)?|좋아해(?:요)?|잘\s*자(?:요)?|잘\s*잤어(?:요)?|고마워(?:요)?|미안해?(?:요)?|괜찮아(?:요)?|뭐\s*해|어디야|피곤해(?:요)?|배고파(?:요)?|졸려(?:요)?|힘들어(?:요)?|귀여워(?:요)?|멋있어(?:요)?|잘생겼어(?:요)?)(?:呀|啊|啦|呐|嘛|哦|喔|哟|呢|吧|야|아|요)?$/i;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const SENTENCE_PUNCT_RE = /[!！,，.。;；…~～]/;

function stripPatternNoise(raw) {
  return String(raw || '')
    .replace(/[\p{Extended_Pictographic}\p{Symbol}\uFE0F\u200D\u20E3]/gu, '')
    .replace(/^[~～.。!！,，;；…\s]+|[吧呀啊哦哟~～.。!！,，;；…\s]+$/g, '');
}

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
    const name = sanitize(stripPatternNoise(match[1]));
    if (name) return { kind: 'name', name, via: 'pattern' };
  }
  const words = compact.split(/\s+/).filter(Boolean);
  if (
    chars(compact).length <= SHORT_MAX
    && words.length <= 2
    && !/[?？]/.test(compact)
    && !EMOJI_RE.test(compact)
    && !SENTENCE_PUNCT_RE.test(compact)
    && !GREET_RE.test(bare)
    && !IDOL_ADDRESS_RE.test(bare)
    && !CHATTER_RE.test(bare)
  ) {
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
  const data = replyParser.parseJsonLoose(text);
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
  return `对方还没告诉你称呼，先不要叫具体名字。注意分辨对方是在说【自己的名字/希望你叫他的称呼】，还是在叫你（如“哥哥/欧巴/오빠/宝宝/爱豆”等对你的称呼）或答非所问。如果对方是在叫你或答非所问，绝不要把那句话当成用户名字，必须把 "address":{"name":"","confidence":"none"} 设为 none，先自然接住或温和澄清对方刚才的话再确认称呼。${again} 답장 JSON에 "address":{"name":"","confidence":"high|low|none"} 를 넣어. name은 상대가 원하는 본인 호칭만 넣고, 없으면 빈 문자열.`;
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
