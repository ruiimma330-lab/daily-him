'use strict';

const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://api.fish.audio';
const DEFAULT_MODEL = 's2-pro';
const ATTEMPT_MS = 15000;

const TAG_MAP = {
  chuckles: 'chuckling',
  whispers: 'whispering',
  sighs: 'sighing',
  laughs: 'laughing',
  'laughs softly': 'laughing softly',
  'sings softly': 'singing softly',
  hums: 'humming',
};

function readApiKey() {
  return (process.env.FISH_AUDIO_API_KEY || process.env.FISH_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(readApiKey());
}

function resolveBaseUrl() {
  const raw = (process.env.FISH_AUDIO_API_BASE || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(raw)) return DEFAULT_BASE_URL;
  return raw;
}

function adaptTagsForFish(text, model = DEFAULT_MODEL) {
  let out = String(text || '').replace(/\[([^\[\]]+)\]/g, (full, inner) => {
    const mapped = TAG_MAP[inner.trim().toLowerCase()];
    return mapped ? `[${mapped}]` : full;
  });
  if (String(model || '').trim().toLowerCase() === 's1') {
    out = out.replace(/\[([^\[\]]+)\]/g, '($1)');
  }
  return out;
}

function pickFishSettings(voiceSettings) {
  const out = {};
  if (!voiceSettings || typeof voiceSettings !== 'object' || Array.isArray(voiceSettings)) {
    return out;
  }
  if (typeof voiceSettings.mp3_bitrate === 'number' && [64, 128, 192].includes(voiceSettings.mp3_bitrate)) {
    out.mp3_bitrate = voiceSettings.mp3_bitrate;
  }
  if (typeof voiceSettings.temperature === 'number' && Number.isFinite(voiceSettings.temperature)
    && voiceSettings.temperature >= 0 && voiceSettings.temperature <= 1) {
    out.temperature = voiceSettings.temperature;
  }
  if (typeof voiceSettings.top_p === 'number' && Number.isFinite(voiceSettings.top_p)
    && voiceSettings.top_p >= 0 && voiceSettings.top_p <= 1) {
    out.top_p = voiceSettings.top_p;
  }
  if (voiceSettings.latency === 'normal' || voiceSettings.latency === 'balanced') {
    out.latency = voiceSettings.latency;
  }
  if (typeof voiceSettings.chunk_length === 'number' && Number.isFinite(voiceSettings.chunk_length)
    && voiceSettings.chunk_length >= 100 && voiceSettings.chunk_length <= 300) {
    out.chunk_length = voiceSettings.chunk_length;
  }
  if (typeof voiceSettings.normalize === 'boolean') {
    out.normalize = voiceSettings.normalize;
  }
  if (voiceSettings.prosody && typeof voiceSettings.prosody === 'object' && !Array.isArray(voiceSettings.prosody)) {
    const prosody = {};
    if (typeof voiceSettings.prosody.speed === 'number' && Number.isFinite(voiceSettings.prosody.speed)) {
      prosody.speed = voiceSettings.prosody.speed;
    }
    if (typeof voiceSettings.prosody.volume === 'number' && Number.isFinite(voiceSettings.prosody.volume)) {
      prosody.volume = voiceSettings.prosody.volume;
    }
    if (Object.keys(prosody).length > 0) {
      out.prosody = prosody;
    }
  }
  return out;
}

function buildRequest(pack, spoken, voiceId) {
  const model = String((pack && pack.lock && pack.lock.model) || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const adaptedText = adaptTagsForFish(spoken, model);
  const endpoint = `${resolveBaseUrl()}/v1/tts`;
  const settings = pickFishSettings(pack && pack.lock ? pack.lock.voiceSettings : null);
  const body = {
    text: adaptedText,
    reference_id: voiceId,
    format: 'mp3',
    ...settings,
  };
  const characterId = pack && pack.characterId ? pack.characterId : '';
  const version = pack && pack.lock && pack.lock.version ? pack.lock.version : '';
  const cacheKey = crypto.createHash('sha256').update([
    'fish',
    characterId,
    version,
    model,
    voiceId,
    JSON.stringify(body),
  ].join('\n')).digest('hex');
  return {
    provider: 'fish',
    characterId,
    version,
    model,
    endpoint,
    body,
    cacheKey,
  };
}

async function readTtsErrorDetail(response, secretKey = '') {
  try {
    const raw = response && typeof response.text === 'function' ? await response.text() : '';
    const snippet = String(raw || '').slice(0, 300).trim();
    if (!snippet) return '';
    let detail = '';
    try {
      const parsed = JSON.parse(snippet);
      if (parsed && parsed.detail) {
        if (typeof parsed.detail === 'string') detail = parsed.detail.trim().slice(0, 120);
        else if (typeof parsed.detail === 'object') {
          const parts = [parsed.detail.status, parsed.detail.message]
            .filter((v) => typeof v === 'string' && v.trim())
            .map((v) => v.trim());
          if (parts.length) detail = parts.join(': ').slice(0, 120);
        }
      }
      if (!detail && parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
        detail = parsed.message.trim().slice(0, 120);
      }
      if (!detail && parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
        detail = parsed.error.trim().slice(0, 120);
      }
    } catch (_) {}
    if (!detail) detail = snippet.replace(/\s+/g, ' ').slice(0, 120);
    if (secretKey) detail = detail.split(secretKey).join('[redacted]');
    return detail;
  } catch (_) {
    return '';
  }
}

async function fetchOnce(request, apiKey, fetchImpl = fetch) {
  const key = String(apiKey || readApiKey()).trim();
  if (!key) {
    const err = new Error('Fish TTS failed');
    err.status = 503;
    err.detail = 'FISH_AUDIO_API_KEY missing';
    throw err;
  }
  const model = (request && request.model) || DEFAULT_MODEL;
  const response = await fetchImpl(request.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
      model,
    },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(ATTEMPT_MS),
  });
  const contentType = String(
    (response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') : '') || '',
  ).toLowerCase();
  if (!response.ok || contentType.includes('json') || contentType.startsWith('text/')) {
    const detail = await readTtsErrorDetail(response, key);
    const characterId = request && request.characterId ? request.characterId : 'unknown';
    const referenceId = String((request && request.body && request.body.reference_id) || '').slice(0, 8) || 'unknown';
    console.error(`Fish TTS request failed (status=${response.status}, detail=${detail || 'none'}, characterId=${characterId}, referenceId=${referenceId})`);
    const err = new Error('Fish TTS failed');
    err.status = response.status;
    err.detail = detail;
    throw err;
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 64) {
    const err = new Error('Fish TTS failed');
    err.status = response.status;
    err.detail = 'empty audio';
    throw err;
  }
  return audio;
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  ATTEMPT_MS,
  readApiKey,
  isConfigured,
  resolveBaseUrl,
  adaptTagsForFish,
  buildRequest,
  fetchOnce,
  readTtsErrorDetail,
};
