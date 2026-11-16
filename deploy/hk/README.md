# Daily Him 香港服务器部署

目标环境：腾讯云香港轻量服务器，Ubuntu 22.04，域名 `dailyhim.cn` 与
`www.dailyhim.cn`。`setup.sh` 必须用 root 运行，可重复执行；它会安装 Node.js 22 LTS、
Git、Nginx、Certbot、PM2，同步代码到 `/opt/dailyhim`，配置 HTTPS 与开机自启，最后请求
`https://dailyhim.cn/api/health`。

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
然后记录 GitHub 主机指纹并执行一行部署命令：

```bash
sudo ssh-keyscan -H github.com | sudo tee -a /root/.ssh/known_hosts >/dev/null
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
- `ADMINS`
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

脚本只接受 main 的 fast-forward 更新，随后运行 `npm ci --omit=dev`、带新环境变量平滑 reload
PM2，并检查本机健康接口。

## 修改环境变量

```bash
sudoedit /etc/dailyhim.env
sudo bash -c 'set -a; source /etc/dailyhim.env; set +a; pm2 reload dailyhim --update-env; pm2 save --force >/dev/null'
```

不要把该文件复制到仓库，不要把密钥粘贴到命令参数、Issue、PR 或日志中。

## 查看状态与日志

```bash
sudo pm2 status
sudo pm2 logs dailyhim
sudo journalctl -u nginx -n 100 --no-pager
sudo certbot certificates
curl -fsS https://dailyhim.cn/api/health
```

## 回退

先从日志中选定已知正常的提交 SHA：

```bash
sudo git -C /opt/dailyhim log --oneline -20
sudo git -C /opt/dailyhim checkout --detach <提交SHA>
sudo npm --prefix /opt/dailyhim ci --omit=dev --no-audit --no-fund
sudo bash -c 'set -a; source /etc/dailyhim.env; set +a; pm2 reload dailyhim --update-env; pm2 save --force >/dev/null'
curl -fsS https://dailyhim.cn/api/health
```

需要回到最新 main 时，再执行 `sudo bash /opt/dailyhim/deploy/hk/update.sh`。
