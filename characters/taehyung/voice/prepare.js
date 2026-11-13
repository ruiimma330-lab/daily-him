'use strict';

// taehyung voice-2 text prep: same mood-prefix logic as the baekhyun pack.
// the chat path sent the raw line through toSpeechText, so [chuckles] and
// similar tags stayed in the text sent to ElevenLabs. This file does not
// call the bubble-display stripper.

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

function speechOf(text) {
  return toSpeechText([String(text || '')]);
}

// Same lookup as d13456d moodDelivery: exact mood key, then defaultMood, then speechPrefix.
function prefixFor(pack, mood) {
  const tags = pack && pack.moodTags && typeof pack.moodTags === 'object' ? pack.moodTags : {};
  const parsedMood = typeof mood === 'string' ? mood : '';
  const defaultMood = pack && typeof pack.defaultMood === 'string' ? pack.defaultMood : '';
  if (parsedMood && typeof tags[parsedMood] === 'string') return tags[parsedMood];
  if (defaultMood && typeof tags[defaultMood] === 'string') return tags[defaultMood];
  return pack && typeof pack.speechPrefix === 'string' ? pack.speechPrefix : '';
}

function prepare(text, mood, pack) {
  return `${prefixFor(pack, mood)} ${speechOf(text)}`.trim();
}

function canSpeak(text) {
  return /[\p{L}\p{N}]/u.test(speechOf(text));
}

module.exports = { prepare, canSpeak };
