# Daily Him — 端到端交互需求（交接版）

> 产品：Daily Him（线上 https://dailyhim.cn）  
> 仓库：`ruiimma330-lab/idol-chat`（GitHub 显示名可能为 `daily-him`）  
> 文档用途：交给 Neon / Antigravity 继续开发前的**完整交互说明书**  
> 时区：Asia/Shanghai  
> 主分支 tip（写文档时）：`5d67cb2`（含 #64 聊天入口重做）

---

## 0. 产品一句话

像 KakaoTalk 的 **AI 爱豆分身聊天**：注册账号 → 选人 → 开始聊天后成为好友 → 在「聊天」列表进房间续聊；另有朋友圈（近况/活动）、星光消耗与兑换。

**不是真人**；禁止克隆公开语音、禁止真人爱豆照片作头像。

---

## 1. 用户旅程总览

```
封面 cover
  ├─ 未登录 → 登录/注册 → 选人 pick → 新人 onboard → 聊天室
  └─ 已登录
        ├─ 已有好友 → 直接进首页「聊天」列表（应看到每一行好友）
        └─ 无好友 → 选人 pick → onboard → 聊天室
首页 /
  ├─ Tab「聊天」：好友行列表（核心入口）→ 点行进房间
  ├─ Tab「朋友圈」：近况 / 活动预告
  ├─ Tab「我」：资料、星光补给、清空记录等
  └─ 顶栏星光 → starlight 页（领取 / 兑换码 / 套餐展示）
```

---

## 2. 必须满足的交互（按屏幕）

### 2.1 封面 `/shell/cover.html`

| 步骤 | 期望 |
| --- | --- |
| 打开站点 / PWA 冷启动 | 看到品牌 Daily Him +「开始」 |
| 未登录点开始 | 去 `/login` |
| 已登录且有好友 | **进首页聊天列表**，不要再逼去选人页 |
| 已登录无好友 | 去 `/shell/pick.html` |
| 「添加到桌面」 | 去 install 引导 |

### 2.2 登录 / 注册 `/login`

| 规则 | 说明 |
| --- | --- |
| **注册**用户名 | **必须** `^\d{8,12}$`（8–12 位纯数字，如 `2315042798`）+ `age14: true` |
| **登录**用户名 | `[A-Za-z0-9_]{3,32}`（兼容旧号） |
| 密码 | ≥ 8 位；bcrypt 存储 |
| 会话 | Cookie `sid`，约 30 天 |
| 可选门禁 | 若设 `APP_PASSWORD`，先站点解锁再注册登录 |
| 注册后无好友 | 进选人页 |

### 2.3 选人 `/shell/pick.html`

- 团体 Tab → 横向滑动肖像 →「开始聊天」。
- **点「开始聊天」= 已成为好友**（立刻 `PUT /api/profile { onboarded: true }`），之后必须出现在「聊天」列表，即使还没发过消息。
- 若尚未设称呼 → `/shell/onboard.html?c=`（自己填 / 让他来问）→ `/?c=&welcome=1`。
- 从聊天页「+」进入（`?from=chat`）→ 保存后**直接回列表**，可跳过 onboard。

### 2.4 首页「聊天」列表（**当前最关键验收点**）

| 需求 | 说明 |
| --- | --- |
| 入口可见 | 底部 Tab「聊天」；主区 `#friends-section` 列出好友行 |
| 一行 = 一个好友 | 头像、名称（昵称优先）、预览、时间 |
| 何时算好友 | ① 点过「开始聊天」（`onboardedAt`）**或** ② 有历史消息 |
| 多好友 | 可同时有多个；按最近活跃排序 |
| 点行 | 进入该角色聊天室：`/?c=<id>&open=1` |
| 空态 | 文案「还没有聊天，点右上角 + 添加」；**不要**误跳选人页把已有好友藏掉 |
| 添加 | 右上角 + → 选人；加完回列表应立刻看到新行 |

**生产诊断（仍未解决 UI 空列表）与已针对过的根因：**

| 根因 | 表现 | 修复落点 |
| --- | --- | --- |
| PM2 多 worker 内存漂移 | Turso 有数据、某进程内存无 → 列表空 | `exportUserDocs` 直读；部署 **`pm2 … -i 1`** |
| 未写 `onboardedAt` | 点开始聊天后仍空 | picker/onboard 立刻 `onboarded:true` |
| API 失败当空数组 | 500 → 客户端当「没好友」 | 应用 `friends_failed`；listing 不因 backfill 抛错 |
| SW 旧缓存 | 旧脚本 / 空态 | `dh-pwa-22` + `sw-heal.js` |
| 误 redirect 到 pick | 有聊天也被藏 | soft-gate，禁止 `replace` 到 pick |

- 账号用户名 `2315042798`，Turso 曾确认约 **5** 个好友文档，页面仍常无入口。
- 已合 #58–#64（含整段重做）；**Neon 首要任务：在 #64 架构上查清 API 有无数据 vs 前端不渲染，修到可见 5 行。**

### 2.5 聊天室（同页 `/`，`open=1` 打开房间）

| 能力 | 期望 |
| --- | --- |
| 进房 | 列表点行或 `open=1` → `openRoom()` |
| `welcome=1` | 种欢迎语后**留在列表**（不要强行进房藏列表） |
| 发文字 | `POST /api/chat`；扣星光（约 3 / 长文 4）；402 → 星光条 |
| 历史 | 服务端按 userId+角色持久；打开时拉取 |
| 语音气泡 | 点喇叭 `POST /api/tts`（聊天发送默认 `voice:false`） |
| 主动 check-in | 默认闲置约 **8h**（`CHECKIN_IDLE_MS`）且当日未 proactive → `/api/checkin` 写一行（不扣星光、不调 LLM）；需已 onboarded + 有历史 |
| 亲密度 | `GET /api/relationship`；火花 streak |
| 记忆 | 「他记得的你」可查看/编辑；清空聊天**保留**记忆与亲密度 |
| 星光不足 | 提示去领取 / 补给站 |
| 朋友圈入口 | 菜单或资料里进该角色朋友圈 |

### 2.6 朋友圈

- 内容：艺人**近况 + 活动预告**（通稿/官宣口径），不是闲聊流水账。
- 互动：点赞、评论（按现有 API）。
- Tab「朋友圈」与聊天内入口一致体验。

### 2.7 星光

| 项 | 规则 |
| --- | --- |
| 注册赠送 | 100 |
| 每日领取 | 50；连续签到额外（3 天 +5，7 天 +15 等，见 `config/starlight.json`） |
| 扣费 | 普通文本 3；长文本 4；语音 15 |
| 兑换码 | 如 `DH-STAR-100` 等；**管理员也不再无限星光**，一律用兑换码 |
| 充值套餐 | UI 展示 6/30/68/128 元档；支付「即将开放」 |
| 返回 | 星光页返回用 Shell 回首页，不要坏掉的 `history.back` |

### 2.8 导航与可读性

- 底栏：聊天 / 朋友圈 / 我。
- 对比度：幽灵按钮、浅色底上的字必须可读（曾修过 `btn-ghost` 等）。
- 移动端 PWA：`dh-pwa-22`；改前端后需 bump SW 并强刷。

---

## 3. 明确产品决策（已确认）

| 决策 | 状态 |
| --- | --- |
| 点「开始聊天」= 好友 | 是 |
| 有历史无 onboarded 也算好友 | 是（并尽量回填 onboarded） |
| ADMINS 无限星光 | **已取消** → 用兑换码 |
| 用户名纯数字 | 允许 |
| 空列表自动跳选人 | **禁止**（会掩盖真实好友） |
| 聊天入口再打补丁 | 用户要求 **整段重做**（#64 已合；UI 仍可能空 → 继续查根因） |
| 学语言 / 实时通话 / 瞬间相册 | 不做（见 roadmap） |

---

## 4. 技术锚点（实现对照）

| 区域 | 路径 |
| --- | --- |
| 好友列表 API | `GET /api/friends`（`Cache-Control: no-store`）→ `lib/friends.js` → `store.exportUserDocs` |
| 列表 UI | `public/friends-list.js` + `index.html` `#friends-section` / `#screen-list` |
| 聊天主逻辑 | `public/app.js`、`POST /api/chat`、`public/playback.js` |
| 封面分流 | `public/shell/cover.html`；未登录 `/` → gate → cover |
| 选人 | `public/shell/picker.js`、`pick.html`、`picker-groups.js` |
| 新人 | `public/shell/onboard.html`、`lib/call-name.js` |
| 我的 | `public/me/me.js`（资料、改密、清空全部、注销等） |
| 星光 | `lib/starlight.js`、`config/starlight.json`、`public/shell/starlight.html` |
| 朋友圈 | `lib/moments*.js`、`public/moments.js`；kind：`news` / `preview` / `event` |
| 签到 | `lib/checkins.js`、`config/checkins.json` |
| 角色 | 开放约 10 人；roster 见 `config/public-roster.json` + `characters/<id>/` |
| 存储 | Turso（`TURSO_*`）；否则 `data/`；`/api/health` → `storage` |
| 部署 | `/opt/dailyhim`，`deploy/hk/update.sh`，PM2 **`dailyhim -i 1`**（勿 `--exec-mode`） |
| 环境 | `/etc/dailyhim.env`；用户 `dailyhim` |

---

## 5. 验收清单（交给 Neon 优先跑）

1. 用 `2315042798` 登录生产或连同一 Turso：`GET /api/friends` 是否返回 5 条。
2. 若 API 有数据、UI 无行：查 SW 缓存、脚本加载、`FriendsList.load`、DOM 显隐、是否被别的脚本清空。
3. 若 API 也空：查 `exportUserDocs`、hydrate、PM2 多实例、Turso 凭证、userId 是否一致。
4. 新用户：选人 → 开始聊天 → **立即**在列表见一行 → 点进可聊。
5. 加第二人：列表两行，互不覆盖。
6. 强刷 / 重装 PWA 后列表仍在。

---

## 6. 相关 PR（近期）

| PR | 内容 |
| --- | --- |
| #58–#62 | 好友列表显示、Turso 同步、禁止误清空等补丁 |
| #63 | PM2 `-i 1` 启动说明 |
| #64 | **重做**聊天入口：`lib/friends.js` + `friends-list.js` |

线上若仍无入口，不要再小补丁堆叠；在 #64 架构上查数据路径与前端渲染根因。
