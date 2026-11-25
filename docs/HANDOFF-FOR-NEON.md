# 交接给 Neon / Antigravity

## 你要打开的项目

- **GitHub**：`https://github.com/ruiimma330-lab/idol-chat`（也可能显示为 `daily-him`）
- **默认分支**：`main`（应含 #64：`5d67cb2` 或更新）
- **本机建议路径**：`D:\antigravity peoject\daily him`
- **线上**：https://dailyhim.cn  
- **完整交互需求**：同目录 `interaction-requirements.md`（必读；已按代码全图校对：注册 8–12 位数字、`from=chat`、check-in 8h、空列表根因表等）
- **产品规划背景**：`roadmap-v2.md`

## Windows 一键落到 D 盘（PowerShell）

```powershell
New-Item -ItemType Directory -Force -Path "D:\antigravity peoject" | Out-Null
if (Test-Path "D:\antigravity peoject\daily him") {
  Set-Location "D:\antigravity peoject\daily him"
  git fetch origin
  git checkout main
  git pull origin main
} else {
  git clone https://github.com/ruiimma330-lab/idol-chat.git "D:\antigravity peoject\daily him"
  Set-Location "D:\antigravity peoject\daily him"
}
```

若用已下载的 zip：解压到同一路径，再 `git status` 确认能连远程。

## 当前阻塞（请先修这个）

**症状**：生产上账号有好友数据，首页「聊天」仍无入口行。  
**诊断账号**：用户名 `2315042798`；Turso 侧曾确认约 5 个好友相关文档。  
**已做**：多次补丁 + #64 整段重做（API Turso 直读 + `FriendsList`）。  
**仍失败**：部署后 UI 依旧空。  

**建议排查顺序**：

1. 浏览器登录后直接打开 `/api/friends`（需带 cookie）看 JSON 有没有 `friends[]`。
2. 有数据无 UI → `friends-list.js` 是否加载、SW 是否旧缓存、`#friends-section` 是否被隐藏/覆盖。
3. 无数据 → `lib/friends.js` / `store.exportUserDocs` / Turso / `userId` 是否与会话一致；PM2 是否真在跑新 commit。

### 部署（腾讯云 HK）

```bash
sudo bash /opt/dailyhim/deploy/hk/update.sh && sudo bash -c 'set -a; source /etc/dailyhim.env; set +a; runuser --preserve-environment -u dailyhim -- env HOME=/var/lib/dailyhim PATH=/usr/local/bin:/usr/bin:/bin pm2 describe dailyhim >/dev/null 2>&1 || runuser --preserve-environment -u dailyhim -- env HOME=/var/lib/dailyhim PATH=/usr/local/bin:/usr/bin:/bin pm2 start /opt/dailyhim/server.js --name dailyhim --cwd /opt/dailyhim -i 1 --time; runuser -u dailyhim -- env HOME=/var/lib/dailyhim PATH=/usr/local/bin:/usr/bin:/bin pm2 save --force' && curl -fsS https://dailyhim.cn/api/health && sudo git -C /opt/dailyhim log -1 --oneline
```

注意：PM2 用 **`-i 1`**，不要用已失效的 `--exec-mode`。  
App 目录是 **`/opt/dailyhim`**（不是 `/opt/dailyhim/app`）。

## 本地跑

需要 Node 18+。密钥只走环境变量，勿提交。

```bash
npm install
# 至少：DEEPSEEK_CHAT_API_KEY、ELEVENLABS_API_KEY、SESSION_SECRET
# 生产数据：TURSO_DATABASE_URL、TURSO_AUTH_TOKEN
npm start
```

打开 http://localhost:3000 。

## 不要改坏的约定

- 「开始聊天」= 好友；多好友并存。
- 空列表不要强制跳选人页。
- 管理员无限星光已取消 → 兑换码。
- 用户名允许纯数字。
- 前端大改后 bump `public/sw.js` VERSION 并让测试里的版本字符串一起改。

## 给 Neon 的任务包（建议顺序）

1. 读完 `interaction-requirements.md`。
2. 复现并修复「有好友无聊天入口」。
3. 写最小回归测试（API 有 friends → 客户端选择器/契约仍成立）。
4. 出 PR；合并后用上面的 HK 命令部署；用 `2315042798` 强刷验收。

## 敏感信息

密钥与 `/etc/dailyhim.env` **不要**写进仓库或交接文档明文。向用户要现有机器上的 env，或使用各自密钥库。
