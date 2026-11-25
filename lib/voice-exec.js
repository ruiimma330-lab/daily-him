'use strict';

const fs = require('fs');
const path = require('path');

const AUDIO_DIR = path.join(__dirname, '..', 'cache', 'audio');
const ATTEMPT_MS = 12000;

function hasClip(cacheKey) {
  const filePath = path.join(AUDIO_DIR, `${cacheKey}.mp3`);
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
}

async function readTtsErrorDetail(response) {
  try {
    const raw = response && typeof response.text === 'function' ? await response.text() : '';
    const snippet = String(raw || '').slice(0, 300).trim();
    if (!snippet) return '';
    try {
      const parsed = JSON.parse(snippet);
      if (parsed && parsed.detail) {
        if (typeof parsed.detail === 'string') return parsed.detail.trim().slice(0, 120);
        if (typeof parsed.detail === 'object') {
          const parts = [parsed.detail.status, parsed.detail.message]
            .filter((v) => typeof v === 'string' && v.trim())
            .map((v) => v.trim());
          if (parts.length) return parts.join(': ').slice(0, 120);
        }
      }
      if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim().slice(0, 120);
      }
      if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error.trim().slice(0, 120);
      }
    } catch (_) {}
    return snippet.replace(/\s+/g, ' ').slice(0, 120);
  } catch (_) {
    return '';
  }
}

function voiceIdPrefix(endpoint) {
  const match = String(endpoint || '').match(/\/text-to-speech\/([^/?]+)/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]).slice(0, 8);
  } catch (_) {
    return String(match[1]).slice(0, 8);
  }
}

async function fetchOnce(request, apiKey) {
  const response = await fetch(request.endpoint, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(ATTEMPT_MS),
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || contentType.includes('json') || contentType.startsWith('text/')) {
    const detail = await readTtsErrorDetail(response);
    const characterId = request && request.characterId ? request.characterId : 'unknown';
    const voicePrefix = voiceIdPrefix(request && request.endpoint) || 'unknown';
    console.error(`TTS request failed (status=${response.status}, detail=${detail || 'none'}, characterId=${characterId}, voiceId=${voicePrefix})`);
    const err = new Error('TTS failed');
    err.status = response.status;
    err.detail = detail;
    throw err;
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 64) {
    const err = new Error('TTS failed');
    err.status = response.status;
    err.detail = 'empty audio';
    throw err;
  }
  return audio;
}

const inflight = new Map();

async function synthesize(request, apiKey, fetchAudio, dir) {
  const root = dir || AUDIO_DIR;
  const filename = `${request.cacheKey}.mp3`;
  const filePath = path.join(root, filename);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return `/audio/${filename}`;
  const pending = inflight.get(filePath);
  if (pending) return pending;
  const job = writeClip(request, apiKey, fetchAudio, root, filePath, filename)
    .finally(() => { inflight.delete(filePath); });
  inflight.set(filePath, job);
  return job;
}

async function writeClip(request, apiKey, fetchAudio, root, filePath, filename) {
  const once = fetchAudio || ((req) => fetchOnce(req, apiKey));
  let audio;
  try {
    audio = await once(request);
  } catch (err) {
    console.error(`TTS request failed (${err && err.status ? err.status : 'retry'}, detail=${err && err.detail ? err.detail : 'none'})`);
    audio = await once(request);
  }
  fs.mkdirSync(root, { recursive: true });
  const tempPath = path.join(root, `.${request.cacheKey}.${process.pid}.tmp`);
  fs.writeFileSync(tempPath, audio);
  fs.renameSync(tempPath, filePath);
  return `/audio/${filename}`;
}

module.exports = { synthesize, hasClip, readTtsErrorDetail, ATTEMPT_MS };
