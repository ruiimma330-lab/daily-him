'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHAR_DIR = path.join(__dirname, '..', 'characters');

function lockPath(characterId, rootDir = CHAR_DIR) {
  return path.join(rootDir, characterId, 'voice', 'voice.lock.json');
}

function preparePath(characterId, rootDir = CHAR_DIR) {
  return path.join(rootDir, characterId, 'voice', 'prepare.js');
}

function listPacks(rootDir = CHAR_DIR) {
  try {
    return fs.readdirSync(rootDir).filter((id) => fs.existsSync(lockPath(id, rootDir))).sort();
  } catch (_) {
    return [];
  }
}

function canonicalLock(lock) {
  const copy = { ...lock };
  delete copy.contentHash;
  return JSON.stringify(copy);
}

function repoRoot(rootDir) {
  return path.resolve(rootDir, '..');
}

function pinBuffers(lock, rootDir) {
  if (!Array.isArray(lock.pins)) {
    const err = new Error('voice lock is missing pins');
    err.code = 'PINS';
    throw err;
  }
  const root = repoRoot(rootDir);
  const chunks = [];
  for (const pin of lock.pins) {
    if (!pin || typeof pin.file !== 'string' || typeof pin.sha256 !== 'string' || !pin.sha256) {
      const err = new Error('voice lock pin is incomplete');
      err.code = 'PINS';
      throw err;
    }
    if (path.isAbsolute(pin.file) || pin.file.split(/[\\/]/).includes('..')) {
      const err = new Error('voice lock pin path is not allowed');
      err.code = 'PINS';
      throw err;
    }
    const abs = path.resolve(root, pin.file);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      const err = new Error('voice lock pin path is not allowed');
      err.code = 'PINS';
      throw err;
    }
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (_) {
      const err = new Error('pinned file is missing');
      err.code = 'PINS';
      throw err;
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (hash !== pin.sha256) {
      const err = new Error('pinned file does not match the voice lock');
      err.code = 'PINS';
      throw err;
    }
    chunks.push(buf);
  }
  return chunks;
}

function contentHash(characterId, lock, rootDir = CHAR_DIR) {
  const prepare = fs.readFileSync(preparePath(characterId, rootDir));
  const hash = crypto.createHash('sha256');
  hash.update(canonicalLock(lock));
  hash.update('\n');
  hash.update(prepare);
  for (const buf of pinBuffers(lock, rootDir)) {
    hash.update('\n');
    hash.update(buf);
  }
  return hash.digest('hex');
}

function lockError(lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return 'voice lock is incomplete';
  if (lock.tags !== 'keep') return 'voice lock must keep tags';
  if (typeof lock.version !== 'string' || !lock.version) return 'voice lock is missing version';
  if (typeof lock.model !== 'string' || !lock.model) return 'voice lock is missing model';
  if (typeof lock.outputFormat !== 'string' || !lock.outputFormat) return 'voice lock is missing outputFormat';
  if (!(['male', 'female'].includes(lock.placeholderVoice) && lock.voiceId === '') && (typeof lock.voiceId !== 'string' || !lock.voiceId.trim() || lock.voiceId.trim() === 'PLACEHOLDER')) {
    return 'voice lock is missing voiceId';
  }
  if (!lock.voiceSettings || typeof lock.voiceSettings !== 'object' || Array.isArray(lock.voiceSettings)) {
    return 'voice lock is missing voiceSettings';
  }
  if (typeof lock.speechPrefix !== 'string') return 'voice lock is missing speechPrefix';
  if (typeof lock.defaultMood !== 'string') return 'voice lock is missing defaultMood';
  if (!lock.moodTags || typeof lock.moodTags !== 'object' || Array.isArray(lock.moodTags)) {
    return 'voice lock is missing moodTags';
  }
  if (!Array.isArray(lock.samples) || lock.samples.length === 0) return 'voice lock is missing samples';
  for (const sample of lock.samples) {
    if (!sample || typeof sample.text !== 'string' || !sample.text) return 'voice lock sample is incomplete';
    if (sample.mood != null && typeof sample.mood !== 'string') return 'voice lock sample is incomplete';
  }
  if (!Array.isArray(lock.pins)) return 'voice lock is missing pins';
  if (typeof lock.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(lock.contentHash)) {
    return 'voice lock is missing contentHash';
  }
  return '';
}

function load(characterId, rootDir = CHAR_DIR) {
  const file = lockPath(characterId, rootDir);
  if (!fs.existsSync(file)) return null;
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return { ok: false, characterId, error: 'voice.lock.json is not valid JSON' };
  }
  const problem = lockError(lock);
  if (problem) return { ok: false, characterId, error: problem };
  const prepFile = preparePath(characterId, rootDir);
  if (!fs.existsSync(prepFile)) return { ok: false, characterId, error: 'prepare.js is missing' };
  let mod;
  try {
    const resolved = require.resolve(prepFile);
    delete require.cache[resolved];
    mod = require(resolved);
  } catch (_) {
    return { ok: false, characterId, error: 'prepare.js could not load' };
  }
  if (!mod || typeof mod.prepare !== 'function' || typeof mod.canSpeak !== 'function') {
    return { ok: false, characterId, error: 'prepare.js is missing prepare or canSpeak' };
  }
  let hash = '';
  try {
    hash = contentHash(characterId, lock, rootDir);
  } catch (err) {
    const pin = err && err.code === 'PINS';
    return { ok: false, characterId, error: pin ? err.message : 'voice package could not be hashed' };
  }
  if (hash !== lock.contentHash) {
    return { ok: false, characterId, error: 'voice package hash does not match contentHash' };
  }
  let configuredVoiceId = lock.voiceId;
  if (lock.placeholderVoice) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
      configuredVoiceId = String((config.placeholderVoices || {})[lock.placeholderVoice] || '').trim();
    } catch (_) { configuredVoiceId = ''; }
  }
  return { ok: true, enabled: Boolean(configuredVoiceId), configuredVoiceId, characterId, lock, prepare: mod.prepare, canSpeak: mod.canSpeak };
}

function warnIfEnvDiffers(pack) {
  const voice = typeof process.env.VOICE_ID === 'string' ? process.env.VOICE_ID.trim() : '';
  const model = typeof process.env.TTS_MODEL === 'string' ? process.env.TTS_MODEL.trim() : '';
  if (voice && voice !== pack.lock.voiceId) {
    console.error(`VOICE_ID is set and differs from the locked voice for ${pack.characterId}; the lock is used`);
  }
  if (model && model !== pack.lock.model) {
    console.error(`TTS_MODEL is set and differs from the locked model for ${pack.characterId}; the lock is used`);
  }
}

function buildRequest(pack, text, mood) {
  const spoken = pack.prepare(text, mood, pack.lock);
  const voiceId = pack.lock.placeholderVoice ? pack.configuredVoiceId : pack.lock.voiceId;
  if (!voiceId) throw new Error('Voice is not configured');
  const outputFormat = pack.lock.outputFormat;
  return {
    characterId: pack.characterId,
    version: pack.lock.version,
    endpoint: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
    body: {
      text: spoken,
      model_id: pack.lock.model,
      voice_settings: pack.lock.voiceSettings,
    },
    cacheKey: crypto.createHash('sha256').update([
      pack.characterId,
      pack.lock.version,
      outputFormat,
      voiceId,
      pack.lock.model,
      JSON.stringify(pack.lock.voiceSettings),
      spoken,
    ].join('\n')).digest('hex'),
  };
}

module.exports = {
  listPacks,
  load,
  contentHash,
  buildRequest,
  warnIfEnvDiffers,
  lockPath,
  preparePath,
  canonicalLock,
};
