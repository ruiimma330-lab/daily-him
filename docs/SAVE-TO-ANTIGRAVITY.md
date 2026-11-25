# 保存到本机 Antigravity 目录

目标路径（注意文件夹名含空格与拼写 `peoject`）：

`D:\antigravity peoject\daily him`

## 方式 A：Git clone（推荐，可继续 push）

在 **Windows PowerShell** 执行：

```powershell
New-Item -ItemType Directory -Force -Path "D:\antigravity peoject" | Out-Null
git clone https://github.com/ruiimma330-lab/idol-chat.git "D:\antigravity peoject\daily him"
cd "D:\antigravity peoject\daily him"
git checkout main
git pull
```

然后在 Antigravity / Neon 中 **Open Folder** → 选该目录。  
优先打开：`docs\HANDOFF-FOR-NEON.md` 与 `docs\interaction-requirements.md`。

## 方式 B：已有 zip

1. 解压到 `D:\antigravity peoject\daily him`（解压后目录内应直接看到 `package.json`、`server.js`）。
2. 若缺 `.git`，再执行方式 A 的 clone 覆盖，或在该目录 `git init` 后加 remote（一般不如直接 clone）。

## 校验

```powershell
cd "D:\antigravity peoject\daily him"
git log -1 --oneline
dir docs
```

应能看到 `HANDOFF-FOR-NEON.md`、`interaction-requirements.md`，且最近 commit 含聊天入口重做或本交接文档。
