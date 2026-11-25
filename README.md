# Daily Him

Multi-character KakaoTalk-style AI idol chat PWA. Chat partners are **AI fictional characters**, not real people; no voice cloning and no recordings are used.

- **Characters & Discovery:** 49 characters in the public discovery roster (`config/public-roster.json`), with 10 open characters currently enabled for live chat (`available !== false` and complete character packs).
- **Core Features:** Friends list & onboarding (`public/friends-list.js`, `lib/friends.js`), multi-character chat & proactive check-ins, on-demand/inline voice synthesis, Moments feed & admin review desk, Starlight balance & redeem codes, long-term memory cards/summaries, and relationship/spark progression.

## Run Locally

Node.js 18 or newer (Node.js 22 LTS in production).

```bash
npm install
export DEEPSEEK_CHAT_API_KEY=your_key_here
export ELEVENLABS_API_KEY=your_key_here
# recommended locally so sessions survive restart
export SESSION_SECRET=dev-secret-change-me
npm start
```

Open `http://localhost:3000`. The server reads API keys only from the environment, exits on startup if `DEEPSEEK_CHAT_API_KEY` or `ELEVENLABS_API_KEY` is missing, and never logs secret values. `PORT` defaults to `3000`.

### Accounts & Auth

Chat requires a registered account on `/login`:

- **Registration (`POST /api/register`):** `username` must be **8–12 digits** (`^\d{8,12}$`), `password` 8–128 characters (hashed with bcrypt), and `age14: true` is required.
- **Login (`POST /api/login`):** accepts new 8–12 digit accounts as well as legacy `[A-Za-z0-9_]{3,32}` usernames.
- **Session:** `sid` cookie binds to `userId` for 30 days.
- **Optional site gate:** if `APP_PASSWORD` is set, visitors unlock the site first via `POST /api/site-login`. When `NODE_ENV=production`, `SESSION_SECRET` is required.

### Storage (Turso or Local File)

- **Turso / libSQL:** when both `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set, users, account docs, settings, and the starlight ledger are stored in Turso.
- **Local file fallback:** otherwise data is stored under `STORE_DATA_DIR` (defaults to `data/`), with per-character documents at `data/<kind>/<characterId>/<userId>.json` (`users.json` and `settings.json` at the root of `data/`). Do not commit `data/`.
- `GET /api/health` returns `{ ok, storage, commit, assetVersion }` (`storage` is `"turso"` or `"file"`).

### Config, Prompts & Voice Packs

`config.json` holds global defaults (such as `llmModel: "deepseek-flash"` and relationship tier rules), while environment variables override them (`LLM_MODEL`, `TTS_MODEL`, `VOICE_ID`, `LLM_TIMEOUT_MS` defaulting to `90000`).

- **Prompts:** assembled by `lib/build-prompt.js` from `persona/common.md` and `characters/<id>/`.
- **Voice packs:** locked characters resolve voice configuration and preprocessing from `characters/<id>/voice/voice.lock.json` (plus `prepare.js` and SHA-256 pinned files), rather than a single global `VOICE_ID`.
- **Audio cache:** synthesized MP3 clips are cached in `cache/audio/` and served at `/audio/<sha256>.mp3`; optional pre-stored greeting clips live under `characters/<id>/greetings/`.

## Key API Endpoints

- **Health & Auth:** `GET /api/health`, `GET /api/site-config`, `GET /api/auth-config`, `POST /api/site-login`, `POST /api/register`, `POST /api/login`, `POST /api/logout`, `GET /api/me`
- **Friends & Roster:** `GET /api/friends`, `GET /api/characters`, `GET /api/conversations`
- **Chat, Check-in & Voice:** `POST /api/chat`, `POST /api/tts`, `GET|PUT|DELETE /api/history`, `POST /api/checkin`
- **Relationship & Memory:** `GET|DELETE /api/relationship`, `GET /api/memory`, `PUT /api/memory/personal`, `DELETE /api/memory/summary`, `DELETE /api/memory/:id`, `DELETE /api/memory`
- **Moments:** `GET /api/moments`, `POST /api/moments/:id/like`, `GET|POST /api/moments/:id/comments`, `POST /api/moments/refresh`, `GET|PUT|POST /api/admin/moments...`
- **Starlight:** `GET /api/starlight`, `POST /api/starlight/claim`, `POST /api/starlight/redeem`, `POST /api/admin/starlight/grant`, `POST /api/admin/starlight/codes`

## Production Deployment

Production runs on Tencent Cloud Hong Kong (Ubuntu 22.04, Nginx, Certbot HTTPS, PM2 `-i 1`, Turso). See [`deploy/hk/README.md`](deploy/hk/README.md) for setup, update, environment variables, moments refresh, and rollback instructions.
