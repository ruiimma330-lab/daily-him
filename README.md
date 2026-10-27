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
npm start
```

Open http://localhost:3000. The server reads keys only from the environment. It exits on startup if either key is missing, and it never prints the key values.

`PORT` defaults to 3000.

If `APP_PASSWORD` is set, opening the app asks for that password. A correct password sets an HttpOnly `sid` cookie for 30 days. Leave `APP_PASSWORD` unset locally and the gate stays off. When `NODE_ENV` is `production` and `APP_PASSWORD` is missing, the process prints an error and exits. Set `SESSION_SECRET` in production so sessions survive a restart; otherwise the server uses a random secret for that boot.

## Config

`config.json` holds non-secret defaults. Environment variables override it. If a value is missing from both, the server falls back to `deepseek-v4-pro`, `eleven_flash_v2_5`, and a 90 second model timeout.

| Env | Default |
| --- | --- |
| `LLM_MODEL` | `llmModel` in `config.json` |
| `TTS_MODEL` | `ttsModel` in `config.json` |
| `VOICE_ID` | `voiceId` in `config.json` |
| `LLM_TIMEOUT_MS` | `90000` |

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

- `GET /api/health` → `{ ok, model, voiceId, ttsModel }`
- `POST /api/chat` with `{ messages: [{ role, content }], voice?: boolean }` → `{ bubbles, audioUrl, audioError? }`
- Model timeout → `504` `{ "error": "timeout" }`. Other model failures → `502`.

Chat history stays in the browser under `localStorage` key `idolchat_history_v1`. The ⋯ menu can delete it after a confirm (`대화 기록 삭제`), turn voice messages on or off (on by default), and turn autoplay on (off by default). Those toggles persist in `idolchat_settings_v1`. If the model fails or times out, the room shows an in-character retry bubble; that bubble is not stored and is not sent back as chat history. A failed voice clip does not block the text reply.

## Render 部署步骤

1. 把这个仓库推送到 GitHub。
2. 打开 [Render](https://render.com)，选 **New > Blueprint**（按仓库里的 `render.yaml` 创建），或者 **New > Web Service** 手动建一个 Node 网站服务。
3. 配好这 4 个环境变量，只填在 Render 的后台里，不要写进代码或提交到 Git：
   - `DEEPSEEK_CHAT_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `APP_PASSWORD`（登录密码）
   - `SESSION_SECRET`（自己生成的一长串随机字符，用来给登录会话签名）
4. `render.yaml` 里已经把 `NODE_ENV` 设成 `production`。生产环境没设 `APP_PASSWORD` 时，服务会报错退出。
5. 免费套餐闲置一段时间后会休眠，下次打开网址要等它醒来。语音文件缓存在 `cache/audio/`，免费实例的磁盘是临时的，休眠、重启或重新部署后缓存会清空，下次说话会重新生成。
6. 部署完成后打开 Render 给的网址，输入 `APP_PASSWORD` 进入聊天。
7. 用手机浏览器打开同一个网址，选「添加到主屏幕」，之后可以像独立 App 一样从主屏幕进入。
