'use strict';

// Hybrid A+B singing & humming support:
// - Scheme B: pre-recorded pitch-accurate a cappella .mp3 clips under characters/<id>/singing/
// - Scheme A: live ElevenLabs eleven_v3 singing/humming tags ([sings softly] / [hums]) via LLM hint

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'singing.json');
const CHAR_DIR = path.join(ROOT, 'characters');

const CHAR_ID_RE = /^[a-z0-9_-]{1,32}$/;
const CLIP_FILE_RE = /^[a-z0-9][a-z0-9_-]{0,60}\.mp3$/i;

const ZH_SING_RE = /(?:清唱|哼唱|哼一?哼|哼[一两几]?[段句首曲]|唱[一两几]?[段句首曲个]|唱一下|唱[给听]|唱首歌|唱个歌|(?:给我|帮我|为我|跟我|再|能|可以|想听你)唱|唱(?:生日|晚安)歌|生日快乐歌|摇篮曲)/;
const KO_SING_RE = /(?:노래\s*(?:한\s*곡|한\s*소절|좀)?\s*(?:불러|해\s*줘|해줘)|흥얼거려|흥얼\s*거려|자장가|생일\s*축하\s*노래|생일축하노래|허밍\s*(?:해\s*줘|해줘|좀)?)/;
const QUOTED_SING_RE = /(?:唱|清唱|哼|불러)[^《「"“”》」\n]{0,12}[《「"“]([^》」"”]{1,60})[》」"”]/;
const QUOTED_ANY_RE = /[《「"“]([^》」"”]{1,60})[》」"”]/;

const LULLABY_RE = /晚安|睡|摇篮曲|자장가|잘\s*자|잠/;
const BIRTHDAY_RE = /生日|생일/;
const CHEER_RE = /加油|鼓励|安慰|难过|累了|开心一点|힘내|위로|응원/;

const GENERIC_FILLERS = new Set([
  '首歌', '一首', '一段', '一下', '个歌', '几句', '两句', '一曲', '歌', '首',
  '给我听', '给我', '听听', '吧', '呀', '啊', '呢', '嘛', '好不好', '可以吗',
  '好吗', '行吗', '晚安歌', '生日歌', '生日快乐歌', '摇篮曲', '노래', '자장가',
  '생일 축하 노래', '생일축하노래', '불러줘', '해줘', '좀',
]);

const PURPOSE_TAIL_RE = /^(?:哄我?睡(?:觉)?|哄睡|睡觉|安慰我?|鼓励我?|加油|祝.*生日.*|陪我.*|让我.*|给我听|给我|听一?听)$/;

let configCache = { mtime: -1, data: { characters: {} } };

function loadConfig(configPath = CONFIG_PATH) {
  let stat;
  try {
    stat = fs.statSync(configPath);
  } catch (_) {
    return { characters: {} };
  }
  if (configPath === CONFIG_PATH && configCache.mtime === stat.mtimeMs) {
    return configCache.data;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const data = parsed && typeof parsed === 'object' ? parsed : { characters: {} };
    if (!data.characters || typeof data.characters !== 'object') data.characters = {};
    if (configPath === CONFIG_PATH) {
      configCache = { mtime: stat.mtimeMs, data };
    }
    return data;
  } catch (_) {
    return { characters: {} };
  }
}

function detectOccasion(text) {
  const raw = String(text || '');
  if (LULLABY_RE.test(raw)) return 'lullaby';
  if (BIRTHDAY_RE.test(raw)) return 'birthday';
  if (CHEER_RE.test(raw)) return 'cheer';
  return 'any';
}

function cleanSongCandidate(candidate) {
  let s = String(candidate || '').trim();
  s = s.replace(/^[，,、\s]+/, '');
  s = s.replace(/^(?:一?[首段句曲个下]|首歌|个歌|几句|两句|一段|一首|一下|歌|首|给我听?|给我|听听)+/, '').trim();
  s = s.replace(/(?:给我听?|听一?听|吧|呀|啊|呢|嘛|好不好|可以吗|好吗|行吗|行不行|可不可以|吗|주세요|불러줘|해\s*줘|해줘|좀|[~～!！?？。.,，])+$/g, '').trim();
  return s;
}

function isGenericTail(rawTail, cleaned) {
  if (!cleaned) return true;
  if (GENERIC_FILLERS.has(cleaned)) return true;
  if (PURPOSE_TAIL_RE.test(cleaned)) return true;
  if (GENERIC_FILLERS.has(String(rawTail || '').trim())) return true;
  return false;
}

function detectIntent(text) {
  const raw = String(text || '').trim();
  if (!raw) return { sing: false, mode: null, song: '', occasion: null };

  const hasSingCue = ZH_SING_RE.test(raw) || KO_SING_RE.test(raw) || QUOTED_SING_RE.test(raw);
  if (!hasSingCue) {
    return { sing: false, mode: null, song: '', occasion: null };
  }

  const occasion = detectOccasion(raw);

  const quotedMatch = raw.match(QUOTED_ANY_RE);
  if (quotedMatch) {
    const song = String(quotedMatch[1] || '').trim();
    if (song && !GENERIC_FILLERS.has(song)) {
      return { sing: true, mode: 'specified', song, occasion };
    }
  }

  const afterMatch = raw.match(/(?:清唱|哼唱|唱|哼)\s*(.+)$/);
  if (afterMatch && afterMatch[1]) {
    const rawTail = afterMatch[1].trim();
    const cleaned = cleanSongCandidate(rawTail);
    if (!isGenericTail(rawTail, cleaned)) {
      return { sing: true, mode: 'specified', song: cleaned.slice(0, 60), occasion };
    }
  }

  return { sing: true, mode: 'general', song: '', occasion };
}

function resolveClipPath(characterId, filename, charDir = CHAR_DIR) {
  const id = String(characterId || '').trim().toLowerCase();
  if (!CHAR_ID_RE.test(id)) return null;
  if (typeof filename !== 'string' || !filename) return null;
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return null;
  const base = path.basename(filename);
  if (base !== filename || !CLIP_FILE_RE.test(base)) return null;
  const dir = path.resolve(charDir, id, 'singing');
  const full = path.resolve(dir, base);
  if (!full.startsWith(dir + path.sep)) return null;
  return full;
}

function pickPresetClip(characterId, occasion, recentAssistantTexts = [], opts = {}) {
  const id = String(characterId || '').trim().toLowerCase();
  if (!CHAR_ID_RE.test(id)) return null;

  const cfg = opts.config || loadConfig(opts.configPath || CONFIG_PATH);
  const charDir = opts.charDir || CHAR_DIR;
  const rawList = cfg && cfg.characters ? cfg.characters[id] : null;
  const entries = Array.isArray(rawList)
    ? rawList
    : (rawList && Array.isArray(rawList.clips) ? rawList.clips : []);
  if (!entries.length) return null;

  const valid = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const ko = typeof entry.ko === 'string' ? entry.ko.trim() : '';
    if (!ko) continue;
    const fileName = typeof entry.file === 'string' ? path.basename(entry.file) : '';
    if (!fileName || entry.file !== fileName) continue;
    const full = resolveClipPath(id, fileName, charDir);
    if (!full) continue;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (!stat.isFile() || stat.size <= 64) continue;
    valid.push({
      id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : path.basename(fileName, '.mp3'),
      file: fileName,
      occasion: typeof entry.occasion === 'string' && entry.occasion.trim() ? entry.occasion.trim() : 'any',
      ko,
      zh: typeof entry.zh === 'string' ? entry.zh.trim() : '',
      mood: typeof entry.mood === 'string' && entry.mood.trim() ? entry.mood.trim() : 'soft',
    });
  }
  if (!valid.length) return null;

  const want = typeof occasion === 'string' && occasion.trim() ? occasion.trim() : 'any';
  let pool = want !== 'any' ? valid.filter((c) => c.occasion === want) : [];
  if (!pool.length) pool = valid.filter((c) => c.occasion === 'any');
  if (!pool.length) pool = valid;

  const recentSet = new Set(
    (Array.isArray(recentAssistantTexts) ? recentAssistantTexts : [])
      .map((t) => String(t || '').trim())
      .filter(Boolean),
  );
  const fresh = pool.filter((c) => !recentSet.has(c.ko));
  const candidates = fresh.length ? fresh : pool;
  const rand = typeof opts.random === 'function' ? opts.random() : Math.random();
  const picked = candidates[Math.min(candidates.length - 1, Math.floor(rand * candidates.length))];

  return {
    id: picked.id,
    occasion: picked.occasion,
    ko: picked.ko,
    zh: picked.zh,
    mood: picked.mood,
    audioUrl: `/singing/${encodeURIComponent(id)}/${encodeURIComponent(picked.file)}`,
  };
}

function buildSingingHint(intent) {
  const safeIntent = intent && typeof intent === 'object' ? intent : {};
  const occasionLabels = {
    lullaby: '잘 자라는 자장가/굿나잇 멜로디 (晚安/哄睡)',
    birthday: '생일 축하 멜로디 (生日祝福)',
    cheer: '따뜻하게 응원하고 다독이는 멜로디 (加油/安慰)',
    any: '다정하고 설레는 짧은 청창/흥얼거림 (温柔清唱/哼唱)',
  };
  const occasionDesc = occasionLabels[safeIntent.occasion] || occasionLabels.any;

  const lines = [
    '## 청창/흥얼거림 요청',
    '상대가 노래나 흥얼거림을 부탁했어. 캐릭터답게 다정하게 반응하며 1~2개 버블로 답해:',
    '- 선택적으로 짧은 도입 버블 1개 + 반드시 `[sings softly]` 또는 `[hums]` 태그로 시작하는 노래/흥얼거림 버블 1개를 보내.',
    '- 노래/흥얼거림 버블의 `ko`는 `[sings softly] ...` 또는 `[hums] ...` 형식으로 시작하고, 70자 이하의 짧고 부드러운 1~2소절로 써. 구절 사이에 `~`를 넣어 eleven_v3가 자연스럽게 노래/흥얼거릴 수 있게 해.',
    '- `zh`에는 자연스러운 중국어 번역(또는 哼唱/清唱示意)을 적어 줘.',
  ];

  if (safeIntent.mode === 'specified' && safeIntent.song) {
    lines.push(`- 상대가 요청한 곡/주제: 「${safeIntent.song}」.`);
    lines.push('- 만약 상업 저작권이 있는 대중가요라면 원곡 가사를 그대로 길게 쓰지 말고, 그 곡의 분위기만 담아 가볍게 흥얼거리거나(`[hums]`) 1줄 오마주/자작 다정 멜로디로 대신해. 동요·생일축하노래·자장가 같은 퍼블릭 도메인 곡이면 1~2줄 짧게 불러도 좋아.');
  } else {
    lines.push(`- 요청 분위기: ${occasionDesc}.`);
    lines.push('- 이 분위기에 어울리는 짧고 다정한 자작 멜로디나 퍼블릭 도메인 선율 1~2줄을 `[sings softly]` 또는 `[hums]`로 불러 줘.');
  }

  return lines.join('\n');
}

module.exports = {
  CONFIG_PATH,
  CHAR_DIR,
  loadConfig,
  detectIntent,
  pickPresetClip,
  buildSingingHint,
  resolveClipPath,
};
