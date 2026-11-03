'use strict';

const fs = require('fs');
const path = require('path');

const AUDIO_DIR = path.join(__dirname, '..', 'cache', 'audio');
const ATTEMPT_MS = 12000;

function hasClip(cacheKey) {
  const filePath = path.join(AUDIO_DIR, `${cacheKey}.mp3`);
  return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
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
    const err = new Error('TTS failed');
    err.status = response.status;
    throw err;
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length < 64) throw new Error('TTS failed');
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
    console.error(`TTS request failed (${err && err.status ? err.status : 'retry'})`);
    audio = await once(request);
  }
  fs.mkdirSync(root, { recursive: true });
  const tempPath = path.join(root, `.${request.cacheKey}.${process.pid}.tmp`);
  fs.writeFileSync(tempPath, audio);
  fs.renameSync(tempPath, filePath);
  return `/audio/${filename}`;
}

module.exports = { synthesize, hasClip, ATTEMPT_MS };
