#!/usr/bin/env node
'use strict';

// Zero-dep CLI to convert a dry vocal melody (mp3/wav) into a character's locked voice
// via ElevenLabs Speech-to-Speech (eleven_multilingual_sts_v2) and register it in config/singing.json.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHAR_DIR = path.join(ROOT, 'characters');
const SINGING_CONFIG_PATH = path.join(ROOT, 'config', 'singing.json');
const APP_CONFIG_PATH = path.join(ROOT, 'config.json');

const VALID_OCCASIONS = new Set(['lullaby', 'birthday', 'cheer', 'any']);
const CHAR_ID_RE = /^[a-z0-9_-]{1,32}$/;
const CLIP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,56}$/i;

function printUsage() {
  console.log([
    'Usage:',
    '  node scripts/make-singing-clip.js \\',
    '    --character <id> \\',
    '    --input <dry-vocal.mp3|wav> \\',
    '    --id <clipId> \\',
    '    --occasion <lullaby|birthday|cheer|any> \\',
    '    --ko "<korean text>" \\',
    '    --zh "<chinese translation>" \\',
    '    [--mood <soft|sweet|playful|...>] \\',
    '    [--dry-run]',
    '',
    'Environment:',
    '  ELEVENLABS_API_KEY  Required unless --dry-run is passed.',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = { occasion: 'any', mood: 'soft', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const key = eq >= 0 ? token.slice(2, eq) : token.slice(2);
      const val = eq >= 0 ? token.slice(eq + 1) : argv[++i];
      if (val === undefined) throw new Error(`Missing value for --${key}`);
      if (key === 'character') args.character = val;
      else if (key === 'input') args.input = val;
      else if (key === 'id') args.id = val;
      else if (key === 'occasion') args.occasion = val;
      else if (key === 'ko') args.ko = val;
      else if (key === 'zh') args.zh = val;
      else if (key === 'mood') args.mood = val;
      else throw new Error(`Unknown option: --${key}`);
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }
  return args;
}

function readCharacterVoiceId(characterId) {
  const lockPath = path.join(CHAR_DIR, characterId, 'voice', 'voice.lock.json');
  if (!fs.existsSync(lockPath)) {
    throw new Error(`Missing voice.lock.json for character "${characterId}" at ${lockPath}`);
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  let voiceId = typeof lock.voiceId === 'string' ? lock.voiceId.trim() : '';
  if (!voiceId && lock.placeholderVoice && fs.existsSync(APP_CONFIG_PATH)) {
    try {
      const appCfg = JSON.parse(fs.readFileSync(APP_CONFIG_PATH, 'utf8'));
      voiceId = String((appCfg.placeholderVoices || {})[lock.placeholderVoice] || '').trim();
    } catch (_) { /* ignore */ }
  }
  if (!voiceId || voiceId === 'PLACEHOLDER') {
    throw new Error(`No usable voiceId found in ${lockPath}`);
  }
  return { voiceId, lock };
}

function upsertSingingConfig(characterId, entry, configPath = SINGING_CONFIG_PATH) {
  let cfg = {
    _note: 'Pre-recorded pitch-accurate a cappella clips (Scheme B). Run `node scripts/make-singing-clip.js --help` or drop .mp3 files into characters/<id>/singing/ and register them here.',
    characters: {},
  };
  if (fs.existsSync(configPath)) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object') cfg = parsed;
  }
  if (!cfg.characters || typeof cfg.characters !== 'object') cfg.characters = {};
  const list = Array.isArray(cfg.characters[characterId]) ? cfg.characters[characterId].slice() : [];
  const idx = list.findIndex((item) => item && item.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  cfg.characters[characterId] = list;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return cfg;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return { ok: true, help: true };
  }

  const characterId = String(args.character || '').trim().toLowerCase();
  if (!CHAR_ID_RE.test(characterId)) {
    throw new Error('Invalid or missing --character <id>');
  }
  const clipId = String(args.id || '').trim();
  if (!CLIP_ID_RE.test(clipId)) {
    throw new Error('Invalid or missing --id <clipId> (letters, digits, _ or -)');
  }
  if (!VALID_OCCASIONS.has(args.occasion)) {
    throw new Error(`Invalid --occasion "${args.occasion}" (expected lullaby|birthday|cheer|any)`);
  }
  const ko = String(args.ko || '').trim();
  const zh = String(args.zh || '').trim();
  if (!ko) throw new Error('Missing --ko "<korean>"');
  if (!zh) throw new Error('Missing --zh "<chinese>"');
  if (!args.input) throw new Error('Missing --input <dry-vocal.mp3|wav>');

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new Error(`Input audio file not found: ${inputPath}`);
  }
  const ext = path.extname(inputPath).toLowerCase();
  if (ext !== '.mp3' && ext !== '.wav') {
    throw new Error(`Unsupported input extension "${ext}" (expected .mp3 or .wav)`);
  }

  const { voiceId, lock } = readCharacterVoiceId(characterId);
  const endpoint = `https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;
  const outFile = `${clipId}.mp3`;
  const outPath = path.join(CHAR_DIR, characterId, 'singing', outFile);
  const entry = {
    id: clipId,
    file: outFile,
    occasion: args.occasion,
    ko,
    zh,
    mood: String(args.mood || 'soft').trim() || 'soft',
  };

  if (args.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      characterId,
      voiceId,
      model_id: 'eleven_multilingual_sts_v2',
      endpoint,
      inputPath,
      inputBytes: fs.statSync(inputPath).size,
      outputPath: outPath,
      configEntry: entry,
    }, null, 2));
    return { ok: true, dryRun: true, endpoint, outPath, entry };
  }

  const apiKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY environment variable is required (or pass --dry-run)');
  }

  const inputBytes = fs.readFileSync(inputPath);
  const mime = ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
  const form = new FormData();
  form.append('audio', new Blob([inputBytes], { type: mime }), path.basename(inputPath));
  form.append('model_id', 'eleven_multilingual_sts_v2');
  if (lock && lock.voiceSettings && typeof lock.voiceSettings === 'object') {
    form.append('voice_settings', JSON.stringify(lock.voiceSettings));
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`ElevenLabs STS failed (${response.status}): ${errText.slice(0, 300)}`);
  }
  const arrayBuf = await response.arrayBuffer();
  const outBuf = Buffer.from(arrayBuf);
  if (outBuf.length <= 64) {
    throw new Error(`ElevenLabs STS returned unexpectedly small audio (${outBuf.length} bytes)`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outBuf);
  upsertSingingConfig(characterId, entry);
  console.log(`Saved ${outPath} (${outBuf.length} bytes) and updated ${SINGING_CONFIG_PATH}`);
  return { ok: true, outPath, bytes: outBuf.length, entry };
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`Error: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  readCharacterVoiceId,
  upsertSingingConfig,
  run,
};
