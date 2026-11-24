# Daily Him 香港服务器部署

目标环境：腾讯云香港轻量服务器，Ubuntu 22.04，域名 `dailyhim.cn` 与
`www.dailyhim.cn`。`setup.sh` 必须用 root 执行系统配置，但依赖安装和应用进程使用专用的
`dailyhim` 低权限用户。脚本可重复执行；它会安装 Node.js 22 LTS、Git、Nginx、Certbot、
PM2，同步代码到 `/opt/dailyhim`，配置 HTTPS 与开机自启，最后请求健康接口。

## 部署前准备

1. 确认 `dailyhim.cn`、`www.dailyhim.cn` 的 A 记录均指向服务器，安全组开放 22/80/443。
2. 在 Turso 新建一个**空库**，准备好数据库 URL 与 Token；不要改动或复用旧库。
3. 准备 DeepSeek 与 ElevenLabs API Key。
4. 本仓库经检查为 **Private**。匿名 `raw.githubusercontent.com` 与匿名 HTTPS clone 都会
   返回 404/认证失败，不能直接使用公开仓库的 curl 命令。

## 私有仓库：推荐 SSH Deploy Key

先在服务器生成只读部署密钥：

```bash
sudo install -d -m 700 /root/.ssh
sudo ssh-keygen -t ed25519 -N '' -f /root/.ssh/id_ed25519
sudo cat /root/.ssh/id_ed25519.pub
```

把输出的公钥添加到 GitHub 仓库的 **Settings → Deploy keys → Add deploy key**，不要勾选写权限。
下面固定写入 GitHub 官方 Ed25519 主机公钥，并核验官方公布的
[`SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints)
指纹；不要用未经核验的 `ssh-keyscan` 结果代替：

```bash
printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' | sudo tee -a /root/.ssh/known_hosts >/dev/null
sudo chmod 600 /root/.ssh/known_hosts
sudo ssh-keygen -lf /root/.ssh/known_hosts -E sha256 | grep -F 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU'
sudo env REPO_URL=git@github.com:ruiimma330-lab/idol-chat.git bash -c 'rm -rf /tmp/dailyhim-deploy && git clone --depth 1 "$REPO_URL" /tmp/dailyhim-deploy && bash /tmp/dailyhim-deploy/deploy/hk/setup.sh'
```

首次运行会逐项提示输入环境变量。所有输入均不回显，自动生成的随机密钥也不会打印。

如果仓库将来改成 Public，可直接粘贴：

```bash
curl -fsSL https://raw.githubusercontent.com/ruiimma330-lab/idol-chat/main/deploy/hk/setup.sh | sudo bash
```

## 首次配置的环境变量

脚本写入 `/etc/dailyhim.env` 并设置权限为 `600`。其中 `SESSION_SECRET` 与
`MOMENTS_REFRESH_SECRET` 自动生成，`NODE_ENV`、`PORT` 和新站的空 `MOVED_TO_URL` 自动写入。

- `PUBLIC_SITE_URL`
- `DEEPSEEK_CHAT_API_KEY`
- `ELEVENLABS_API_KEY`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `APP_PASSWORD`
- `LLM_MODEL`
- `LLM_TIMEOUT_MS`
- `LLM_EFFORT`
- `VOICE_ID`
- `TTS_MODEL`
- `ADMINS`（逗号分隔用户名；列表内账号星光无限，并可发放星光 / 生成兑换码）
- `MOMENTS_ADMINS`
- `SESSION_SECRET`
- `MOMENTS_REFRESH_SECRET`
- `MOMENTS_SYNC`
- `MOVED_TO_URL`
- `STORE_DATA_DIR`
- `NODE_ENV`
- `PORT`

新服务器的 `PUBLIC_SITE_URL` 使用 `https://dailyhim.cn`，`MOVED_TO_URL` 必须留空。只有旧
Render 服务需要设置 `MOVED_TO_URL=https://dailyhim.cn`。

## 更新

```bash
sudo bash /opt/dailyhim/deploy/hk/update.sh
```

脚本只接受 main 的 fast-forward 更新，随后以 `dailyhim` 用户运行 `npm ci --omit=dev`，
通过 PM2 cluster 模式平滑 reload，并等待本机健康接口就绪。

## 朋友圈如何保证更新（开放角色）

当前聊天开放的是 `character.json` 里 `available` 不为 `false` 且包完整的角色（现为 10 位）。
朋友圈更新分两层，缺一不可：

1. **自动草稿（每日）**  
   GitHub Actions `refresh moments` 每天 UTC 01:00（北京时间 09:00）调用  
   `POST /api/moments/refresh`，`characterId=all`，只给**当前开放**角色抓公开资讯并写成草稿。  
   需要同时配好：
   - 服务器 `/etc/dailyhim.env` 的 `MOMENTS_REFRESH_SECRET`
   - GitHub 仓库 Secrets：`MOMENTS_REFRESH_SECRET`（与服务器一致）、`APP_BASE_URL=https://dailyhim.cn`
   - 服务器 `MOMENTS_ADMINS=你的用户名`（逗号分隔）

2. **人工发布（才能被粉丝看到）**  
   草稿默认不可见。用管理员账号打开  
   `https://dailyhim.cn/admin/moments.html?c=<角色id>`  
   审改后点「发布」。重大活动预告也可直接改仓库里  
   `characters/<id>/moments.json`，再跑 `update.sh` 上线。

手动补拉一次全部开放角色：

```bash
curl -fsS -X POST 'https://dailyhim.cn/api/moments/refresh' \
  -H "Authorization: Bearer $MOMENTS_REFRESH_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"characterId":"all"}'
```

## 管理员无限星光

在 `/etc/dailyhim.env` 设置：

```bash
ADMINS=你的用户名
```

多个管理员用逗号分隔。列表内账号对话 / 语音不扣星光，补给站显示「无限」，并可用补给站里的管理员表单发放星光、生成兑换码。  
朋友圈管理仍用 `MOMENTS_ADMINS`；两个列表可写成同一个用户名。

改完后按下方「修改环境变量」reload PM2。

## 修改环境变量

```bash
sudoedit /etc/dailyhim.env
sudo bash -c 'set -a; source /etc/dailyhim.env; set +a; runuser --preserve-environment -u dailyhim -- env HOME=/var/lib/dailyhim PATH=/usr/local/bin:/usr/bin:/bin pm2 reload dailyhim --update-env; runuser -u dailyhim -- env HOME=/var/lib/dailyhim PATH=/usr/local/bin:/usr/bin:/bin pm2 save --force >/dev/null'
```

不要把该文件复制到仓库，不要把密钥粘贴到命令参数、Issue、PR 或日志中。

## 查看状态与日志

```bash
sudo -u dailyhim env HOME=/var/lib/dailyhim pm2 status
sudo -u dailyhim env HOME=/var/lib/dailyhim pm2 logs dailyhim
sudo journalctl -u nginx -n 100 --no-pager
sudo certbot certificates
curl -fsS https://dailyhim.cn/api/health
```

## 回退

先从日志中选定已知正常的提交 SHA：

```bash
sudo git -C /opt/dailyhim log --oneline -20
sudo git -C /opt/dailyhim checkout --detach <提交SHA>
sudo rm -rf /opt/dailyhim/node_modules
sudo install -d -o dailyhim -g dailyhim -m 755 /opt/dailyhim/node_modules
sudo -u dailyhim env HOME=/var/lib/dailyhim npm --prefix /opt/dailyhim ci --omit=dev --no-audit --no-fund
sudo bash -c 'set -a; source /etc/dailyhim.env; set +a; runuser --preserve-environment -u dailyhim -- env HOME=/var/lib/dailyhim PATH=/usr/local/bin:/usr/bin:/bin pm2 reload dailyhim --update-env; runuser -u dailyhim -- env HOME=/var/lib/dailyhim PATH=/usr/local/bin:/usr/bin:/bin pm2 save --force >/dev/null'
curl -fsS https://dailyhim.cn/api/health
```

需要回到最新 main 时，再执行 `sudo bash /opt/dailyhim/deploy/hk/update.sh`。
