# Idol chat

Personal-use KakaoTalk-style demo. The chat partner is an **AI character**, not a real person. No voice cloning and no recordings are used.

## Run

Node.js 18 or newer.

```bash
npm install
export DEEPSEEK_CHAT_API_KEY=your_key_here
export ELEVENLABS_API_KEY=your_key_here
# optional: an ElevenLabs voice id you already have
export VOICE_ID=your_voice_id
# recommended locally so sessions survive restart
export SESSION_SECRET=dev-secret-change-me
npm start
```

Open http://localhost:3000. The server reads keys only from the environment. It exits on startup if either API key is missing, and it never prints the key values.

`PORT` defaults to 3000.

### Accounts (phase 0)

Chat requires a **username + password** account:

- Register / login on `/login`
- Username: 3–32 chars, letters / digits / underscore
- Password: at least 8 characters (stored with bcrypt; never plaintext)
- Session cookie `sid` binds to `userId` for 30 days

Optional **site gate**: if `APP_PASSWORD` is set, visitors must unlock the site first (`/api/site-login`), then register or log in. Leave `APP_PASSWORD` unset locally to skip that step. Site gate does **not** replace per-user accounts.

When `NODE_ENV` is `production`, `SESSION_SECRET` is required (process exits if missing). `APP_PASSWORD` is optional.

### Chat history

History is stored **on the server per user** under `data/history/<userId>.json` (also mirrored in browser `localStorage` as a cache). Opening the app loads from the server. 「대화 기록 삭제」 clears both server and device.

**Storage:** with `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` set, all data (users, history, relationship, memory, session secret) is stored in Turso (libSQL); otherwise it falls back to local JSON files in `data/` (wiped on Render free redeploys). `/api/health` shows `storage: turso|file`. Do not commit `data/`.

## Config

`config.json` holds non-secret defaults. Environment variables override it. If a value is missing from both, the server falls back to `deepseek-v4-pro`, `eleven_flash_v2_5`, and a 90 second model timeout.

| Env | Default |
| --- | --- |
| `LLM_MODEL` | `llmModel` in `config.json` |
| `TTS_MODEL` | `ttsModel` in `config.json` |
| `VOICE_ID` | `voiceId` in `config.json` |
| `LLM_TIMEOUT_MS` | `90000` |
| `SESSION_SECRET` | required in production |
| `APP_PASSWORD` | optional site gate |

### Which chat model to run

Leave `config.json` as it is and override with `LLM_MODEL` when you start the app.

Off-peak (higher quality):

```bash
LLM_MODEL=deepseek-v4-pro npm start
```

Peak hours — Beijing time, weekdays 09:00–12:00 and 14:00–18:00 — use the faster model:

```bash
LLM_MODEL=deepseek-flash npm start
```

`LLM_TIMEOUT_MS` is the model request timeout in milliseconds. A timed-out model call returns HTTP 504 `{ "error": "timeout" }`. Other model failures return HTTP 502.

Text chat still works when `voiceId` is `PLACEHOLDER`. Speech is skipped until a real voice id is set, and the reply includes `audioError`. Sending `{ "voice": false }` skips TTS entirely (no ElevenLabs call) and returns `audioUrl: null`.

The system prompt is read from `persona/system_prompt.md` on each chat request. A short Korean fallback is used if that file is missing.

Generated mp3 files are cached in `cache/audio/` and served at `/audio/<sha256>.mp3`.

## API

- `GET /api/health` → `{ ok, model, voiceId, ttsModel }` (requires login unless you hit it after unlocking)
- `GET /api/auth-config` → `{ siteGate, siteUnlocked, loggedIn }`
- `POST /api/site-login` `{ password }` → optional site gate unlock
- `POST /api/register` `{ username, password }` → set session
- `POST /api/login` `{ username, password }` → set session
- `POST /api/logout` → clear session
- `GET /api/me` → current user
- `GET /api/history` → `{ messages }`
- `PUT /api/history` `{ messages }` → replace saved history
- `DELETE /api/history` → clear server history
- `POST /api/chat` with `{ messages: [{ role, content }], voice?: boolean }` → `{ bubbles, audioUrl, audioError? }`
- Model timeout → `504` `{ "error": "timeout" }`. Other model failures → `502`.

Register / login are rate-limited (per IP + global failure window).

## 数据存储（Turso）

只有 **两个变量都填了** 才会用 Turso，否则自动用本地文件（Render 免费盘重部署会丢）：

| 变量 | 填什么 |
|---|---|
| `TURSO_DATABASE_URL` | Turso 数据库地址，形如 `libsql://<库名>-<用户名>.turso.io` |
| `TURSO_AUTH_TOKEN` | 这个库的访问令牌（Turso 后台 → 数据库 → Generate Token，或 `turso db tokens create <库名>`） |

- 在 Render → 服务 → **Environment** 里添加这两个变量，点 **Save, rebuild, and deploy**。
- 首次启动会自动建表；如果库是空的而服务器本地 `data/` 里有数据，会一次性导入。
- 部署后打开 `/api/health`，看到 `"storage":"turso"` 就成功了。连不上时日志只显示错误名（如 `Database connection failed (SERVER_ERROR)`），服务会退出，Render 会保留上一个版本。
- 以后换腾讯云等数据库：仿照 `lib/storage/libsql.js` 写一个同样接口的 backend（init / loadAll / putUser / putDoc / delDoc / putSetting），在 `lib/store.js` 的 `selectBackend()` 里接上即可。

## Render 部署步骤

1. 把这个仓库推送到 GitHub。
2. 打开 [Render](https://render.com)，选 **New > Blueprint**（按仓库里的 `render.yaml` 创建），或者 **New > Web Service** 手动建一个 Node 网站服务。
3. 配好环境变量，只填在 Render 的后台里，不要写进代码或提交到 Git：
   - `DEEPSEEK_CHAT_API_KEY`（必填）
   - `ELEVENLABS_API_KEY`（必填）
   - `SESSION_SECRET`（必填；自己生成的一长串随机字符）
   - `APP_PASSWORD`（可选；站点总闸，开启后要先输入它再注册/登录账号）
4. `render.yaml` 里已经把 `NODE_ENV` 设成 `production`。生产环境没设 `SESSION_SECRET` 时，服务会报错退出。
5. 免费套餐闲置一段时间后会休眠，下次打开网址要等它醒来。`data/` 与 `cache/audio/` 都在实例本地盘上，**休眠 / 重启 / 重新部署后可能被清空**；账号与聊天记录下一步应迁到 Turso 等云库。
6. 部署完成后打开 Render 给的网址：如开启了 `APP_PASSWORD` 先解锁站点，再 **注册** 用户名密码进入聊天。
7. 用手机浏览器打开同一个网址，选「添加到主屏幕」，之后可以像独立 App 一样从主屏幕进入。
