# Voice packages

Each character that can speak has its own voice package. The package is the whole TTS request for that character: model, output format, voice id, voice settings, mood tags, and the text cleanup that runs before ElevenLabs. Shared server code only loads the package and sends the request. It does not fill in model, voice, or text rules for a locked character.

Characters marked 即将开放 (`"available": false` in `character.json`) do not need a package. Chat stays available or unavailable based on the character pack alone. A missing package, a broken `voice.lock.json`, or a hash mismatch disables `/api/tts` for that character only.

## Layout

```
characters/<id>/voice/voice.lock.json
characters/<id>/voice/prepare.js
test/fixtures/voice/<id>.json
```

`voice.lock.json` fields:

- `version` — change this whenever the package or the spoken request changes
- `tags` — must be `"keep"` so bracket tags such as `[chuckles]` stay in the audio text
- `model`, `outputFormat`, `voiceId`, `voiceSettings` — sent as-is (the voice id is the public ElevenLabs id already stored for that character, not the API key)
- `speechPrefix`, `defaultMood`, `moodTags` — mood tag lookup for the spoken line
- `samples` — a few tagged lines used by the snapshot test
- `pins` — shared files this package's `prepare.js` reads, each `{ "file", "sha256" }` relative to the repo root. Use `[]` when all text rules live in this folder. A pinned file that changes on disk no longer matches, and voice for this character turns off.
- `contentHash` — sha256 of the lock JSON without `contentHash`, a newline, `prepare.js`, and each pinned file

`prepare.js` exports `prepare(text, mood, lock)` and `canSpeak(text)`. Keep it self-contained. Do not import `server.js` or the bubble-display tag stripper. Bubble text and Chinese translations still hide tags elsewhere; that code is not on this path.

`ELEVENLABS_API_KEY` stays in the environment. `VOICE_ID` and `TTS_MODEL` are ignored for a locked character. If they are set and differ from the lock, the server logs a warning and still uses the lock.

The audio cache key is a hash of the character id, package version, output format, voice id, model, voice settings, and the exact spoken text.

## Add a package

1. Create `characters/<id>/voice/prepare.js` with that character's own text rules.
2. Create `voice.lock.json` with the fields above. Set `contentHash` to `"pending"` while you fill the rest.
3. Recompute the hash and write the golden request fixture:

```
node -e "
const fs = require('fs');
const voicePack = require('./lib/voice-pack');
const id = process.argv[1];
const lock = JSON.parse(fs.readFileSync(voicePack.lockPath(id), 'utf8'));
lock.contentHash = voicePack.contentHash(id, lock);
fs.writeFileSync(voicePack.lockPath(id), JSON.stringify(lock, null, 2) + '\n');
const pack = voicePack.load(id);
if (!pack || !pack.ok) throw new Error(pack ? pack.error : 'missing package');
const requests = pack.lock.samples.map((sample) => {
  const request = voicePack.buildRequest(pack, sample.text, sample.mood);
  return { id: sample.id, endpoint: request.endpoint, body: request.body, cacheKey: request.cacheKey };
});
fs.mkdirSync('test/fixtures/voice', { recursive: true });
fs.writeFileSync('test/fixtures/voice/' + id + '.json', JSON.stringify({
  characterId: id,
  version: pack.lock.version,
  contentHash: pack.lock.contentHash,
  requests,
}, null, 2) + '\n');
" <id>
```

4. Run `npm test`. The suite loads every package, checks `contentHash` against the files, and compares `buildRequest` for each sample to `test/fixtures/voice/<id>.json`.

To change a voice that already ships, bump `version`, recompute `contentHash`, and update that character's fixture in the same change. A file edit that does not match `contentHash` fails. A request that does not match the fixture for the current version fails. Do not reuse a version string after the spoken request changes.
