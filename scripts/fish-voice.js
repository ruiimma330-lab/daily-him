#!/usr/bin/env node
'use strict';

// Zero-dep CLI helper for Fish Audio voice discovery, character lock assignment, and smoke testing.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ttsFish = require('../lib/tts-fish');
const voicePack = require('../lib/voice-pack');

const ROOT = path.join(__dirname, '..');
const DEFAULT_CHAR_DIR = path.join(ROOT, 'characters');
const CHAR_ID_RE = /^[a-z0-9_-]{1,32}$/;

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/fish-voice.js search [--lang ko] [--query "..."] [--tag male] [--self] [--limit 20]',
    '  node scripts/fish-voice.js set --character <id> --reference-id <refId> [--model s2-pro] [--dry-run]',
    '  node scripts/fish-voice.js test --reference-id <refId> [--text "[soft] 안녕, 잘 지냈어?"] [--model s2-pro] [--out /tmp/fish-test.mp3]',
    '',
    'Environment:',
    '  FISH_AUDIO_API_KEY   Required for search and test (or FISH_API_KEY).',
    '  FISH_AUDIO_API_BASE  Optional override (default: https://api.fish.audio).',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    subcommand: '',
    help: false,
    self: false,
    dryRun: false,
    limit: 20,
    model: ttsFish.DEFAULT_MODEL,
    text: '[soft] 안녕, 잘 지냈어?',
    out: path.join(os.tmpdir(), 'fish-test.mp3'),
  };
  const tokens = Array.isArray(argv) ? argv : [];
  let i = 0;
  if (tokens.length > 0 && !tokens[0].startsWith('-')) {
    args.subcommand = tokens[0];
    i = 1;
  }
  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--self') {
      args.self = true;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const key = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      const val = eq >= 0 ? token.slice(eq + 1) : tokens[++i];
      if (val === undefined) throw new Error(`Missing value for --${key}`);
      if (key === 'lang') args.lang = val;
      else if (key === 'query') args.query = val;
      else if (key === 'tag') args.tag = val;
      else if (key === 'limit') args.limit = Number(val);
      else if (key === 'character') args.character = val;
      else if (key === 'reference-id') args.referenceId = val;
      else if (key === 'model') args.model = val;
      else if (key === 'text') args.text = val;
      else if (key === 'out') args.out = val;
      else throw new Error(`Unknown option: --${key}`);
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }
  return args;
}

function toLfBuffer(buf) {
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function computeLfContentHash(characterId, lock, charDir = DEFAULT_CHAR_DIR) {
  const prepPath = voicePack.preparePath(characterId, charDir);
  if (!fs.existsSync(prepPath)) {
    throw new Error(`Missing prepare.js at ${prepPath}`);
  }
  const prepare = toLfBuffer(fs.readFileSync(prepPath));
  const hash = crypto.createHash('sha256');
  hash.update(voicePack.canonicalLock(lock));
  hash.update('\n');
  hash.update(prepare);
  const pins = Array.isArray(lock.pins) ? lock.pins : [];
  const root = path.resolve(charDir, '..');
  for (const pin of pins) {
    if (!pin || typeof pin.file !== 'string' || typeof pin.sha256 !== 'string' || !pin.sha256) {
      throw new Error('voice lock pin is incomplete');
    }
    if (path.isAbsolute(pin.file) || pin.file.split(/[\\/]/).includes('..')) {
      throw new Error('voice lock pin path is not allowed');
    }
    const abs = path.resolve(root, pin.file);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error('voice lock pin path is not allowed');
    }
    const raw = fs.readFileSync(abs);
    const rawHash = crypto.createHash('sha256').update(raw).digest('hex');
    if (rawHash === pin.sha256) {
      hash.update('\n');
      hash.update(raw);
    } else {
      const lf = toLfBuffer(raw);
      const lfHash = crypto.createHash('sha256').update(lf).digest('hex');
      if (lfHash !== pin.sha256) {
        throw new Error(`pinned file does not match voice lock sha256: ${pin.file}`);
      }
      hash.update('\n');
      hash.update(lf);
    }
  }
  return hash.digest('hex');
}

async function runSearch(args, fetchImpl = fetch) {
  const apiKey = ttsFish.readApiKey();
  if (!apiKey) {
    throw new Error('FISH_AUDIO_API_KEY environment variable is required');
  }
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.min(100, Math.floor(args.limit)) : 20;
  const url = new URL(`${ttsFish.resolveBaseUrl()}/model`);
  url.searchParams.set('sort_by', 'task_count');
  url.searchParams.set('page_size', String(limit));
  if (args.lang) url.searchParams.set('language', String(args.lang).trim());
  if (args.query) url.searchParams.set('title', String(args.query).trim());
  if (args.tag) url.searchParams.set('tag', String(args.tag).trim());
  if (args.self) url.searchParams.set('self', 'true');

  const response = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(ttsFish.ATTEMPT_MS),
  });
  if (!response.ok) {
    const detail = await ttsFish.readTtsErrorDetail(response, apiKey);
    const err = new Error(`Fish model search failed (${response.status}): ${detail || 'unknown error'}`);
    err.status = response.status;
    err.detail = detail;
    throw err;
  }
  const payload = await response.json();
  const items = Array.isArray(payload) ? payload : (Array.isArray(payload && payload.items) ? payload.items : []);
  for (const item of items) {
    const id = item && (item._id || item.id || item.reference_id) ? String(item._id || item.id || item.reference_id) : '';
    const title = item && (item.title || item.name) ? String(item.title || item.name) : '';
    const tags = item && Array.isArray(item.tags) ? item.tags.join(',') : String((item && item.tags) || '');
    const desc = String((item && item.description) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    console.log(`${id} | ${title} | ${tags} | ${desc}`);
  }
  return { ok: true, count: items.length, items };
}

function runSet(args, charDir = DEFAULT_CHAR_DIR) {
  const characterId = String(args.character || '').trim().toLowerCase();
  if (!CHAR_ID_RE.test(characterId)) {
    throw new Error('Invalid or missing --character <id>');
  }
  const refId = String(args.referenceId || '').trim();
  if (!refId) {
    throw new Error('Missing --reference-id <refId>');
  }
  const model = String(args.model || ttsFish.DEFAULT_MODEL).trim() || ttsFish.DEFAULT_MODEL;
  const charJsonPath = path.join(charDir, characterId, 'character.json');
  const lockFilePath = voicePack.lockPath(characterId, charDir);
  if (!fs.existsSync(charJsonPath)) {
    throw new Error(`Missing character.json at ${charJsonPath}`);
  }
  if (!fs.existsSync(lockFilePath)) {
    throw new Error(`Missing voice.lock.json at ${lockFilePath}`);
  }

  const meta = JSON.parse(fs.readFileSync(charJsonPath, 'utf8'));
  const nextMeta = {
    ...meta,
    ttsProvider: 'fish',
    ttsModel: model,
    voiceId: refId,
  };
  delete nextMeta.placeholderVoice;

  const lock = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
  const nextLock = {
    ...lock,
    provider: 'fish',
    model,
    voiceId: refId,
  };
  delete nextLock.placeholderVoice;
  nextLock.contentHash = computeLfContentHash(characterId, nextLock, charDir);

  if (args.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      characterId,
      characterJsonPath: charJsonPath,
      voiceLockPath: lockFilePath,
      characterJson: nextMeta,
      voiceLock: nextLock,
    }, null, 2));
    return {
      ok: true,
      dryRun: true,
      characterId,
      characterJson: nextMeta,
      voiceLock: nextLock,
    };
  }

  fs.writeFileSync(charJsonPath, `${JSON.stringify(nextMeta, null, 2)}\n`, 'utf8');
  fs.writeFileSync(lockFilePath, `${JSON.stringify(nextLock, null, 2)}\n`, 'utf8');
  console.log(`Updated ${charJsonPath} and ${lockFilePath} (provider=fish, model=${model}, contentHash=${nextLock.contentHash})`);
  return {
    ok: true,
    dryRun: false,
    characterId,
    characterJson: nextMeta,
    voiceLock: nextLock,
  };
}

async function runTest(args, fetchImpl = fetch) {
  const refId = String(args.referenceId || '').trim();
  if (!refId) {
    throw new Error('Missing --reference-id <refId>');
  }
  const model = String(args.model || ttsFish.DEFAULT_MODEL).trim() || ttsFish.DEFAULT_MODEL;
  const text = String(args.text || '').trim();
  if (!text) {
    throw new Error('Missing --text');
  }
  const outPath = path.resolve(args.out || path.join(os.tmpdir(), 'fish-test.mp3'));
  const request = ttsFish.buildRequest(
    { characterId: 'cli-test', lock: { version: 'cli-test-1', model } },
    text,
    refId,
  );
  const audio = await ttsFish.fetchOnce(request, ttsFish.readApiKey(), fetchImpl);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, audio);
  console.log(`Saved ${outPath} (${audio.length} bytes)`);
  return { ok: true, outPath, bytes: audio.length, model, endpoint: request.endpoint };
}

async function run(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.help || !args.subcommand) {
    printUsage();
    return { ok: true, help: true };
  }
  const fetchImpl = options.fetchImpl || fetch;
  const charDir = options.charactersDir || DEFAULT_CHAR_DIR;
  if (args.subcommand === 'search') {
    return runSearch(args, fetchImpl);
  }
  if (args.subcommand === 'set') {
    return runSet(args, charDir);
  }
  if (args.subcommand === 'test') {
    return runTest(args, fetchImpl);
  }
  throw new Error(`Unknown subcommand "${args.subcommand}" (expected search|set|test)`);
}

if (require.main === module) {
  run().catch((err) => {
    const status = err && err.status ? ` status=${err.status}` : '';
    const detail = err && err.detail ? ` detail=${err.detail}` : '';
    console.error(`Error:${status}${detail} ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });
}

module.exports = {
  printUsage,
  parseArgs,
  computeLfContentHash,
  run,
};
