'use strict';

// Blind listening prep. These copies stay frozen so the live /api/tts path is not reused
// or edited from here.
// baselineSpeech matches commit d13456d: the chat path sent item.raw through toSpeechText,
// so bracket tags such as [chuckles] stayed in the audio text.
// currentSpeech matches today's /api/tts: strip those tags, then the same toSpeechText, then slice 1000.

const LINES = [
  { id: 'playful', mood: 'playful', text: '에리 뭐야 [chuckles] 그렇게 말하면 나 웃기잖아' },
  { id: 'soft', mood: 'soft', text: '오늘 수고했어 [laughs softly] 이제 좀 쉬어' },
  { id: 'shy', mood: 'shy', text: '아 진짜 [sighs] 그런 말 하면 부끄럽단 말이야' },
];

function stripAudioTags(line) {
  return String(line || '')
    .replace(/\[\s*[A-Za-z][A-Za-z ,'-]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toSpeechText(bubbles) {
  const joined = bubbles.join(' ');
  return joined
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\p{Emoji_Modifier}/gu, '')
    .replace(/[\u200D\uFE0F\u20E3]/g, '')
    .replace(/[ㅋㅎ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function baselineSpeech(raw) {
  return toSpeechText([raw]);
}

function currentSpeech(raw) {
  return toSpeechText([stripAudioTags(raw)]).slice(0, 1000);
}

function withPrefix(prefix, speech) {
  return `${prefix} ${speech}`.trim();
}

function assignVersions(random) {
  const swap = random() < 0.5;
  return swap
    ? { A: 'current', B: 'baseline' }
    : { A: 'baseline', B: 'current' };
}

function envFlag(name, fileValue) {
  const raw = process.env[name];
  const set = typeof raw === 'string' && raw.trim().length > 0;
  return {
    set,
    matchesCharacter: set ? raw.trim() === String(fileValue || '').trim() : null,
  };
}

module.exports = {
  LINES,
  baselineSpeech,
  currentSpeech,
  withPrefix,
  assignVersions,
  envFlag,
};
