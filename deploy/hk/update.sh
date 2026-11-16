#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

APP_DIR="${APP_DIR:-/opt/dailyhim}"
ENV_FILE="${ENV_FILE:-/etc/dailyhim.env}"
BRANCH="${BRANCH:-main}"
APP_NAME="${APP_NAME:-dailyhim}"
APP_USER="${APP_USER:-dailyhim}"
APP_HOME="${APP_HOME:-/var/lib/dailyhim}"

run_as_app() {
  runuser --preserve-environment -u "$APP_USER" -- env HOME="$APP_HOME" PATH="$PATH" "$@"
}

# git 由 root 执行，继承的 umask 可能让 pull 出来的新文件是 600，
# 导致 dailyhim 读不到 package-lock.json、npm ci 误报缺少 lockfile。
# 只放宽到“其他人可读可进入”（目录 755、文件 644，保留可执行位），不加写权限；
# .git、node_modules、cache、data 与 .env/证书私钥跳过，保持原有归属与严格权限。
fix_app_tree() {
  local dir="$1"
  local prune=(
    -mindepth 1
    \( -name .git -o -name node_modules -o -name cache -o -name data
    -o -name '.env' -o -name '.env.*'
    -o -name '*.pem' -o -name '*.key' -o -name '*.jks'
    -o -name '*.keystore' -o -name '*.p12' \)
    -prune -o
  )
  [[ -d "$dir" ]] || return 0
  chmod 755 "$dir"
  find "$dir" "${prune[@]}" -type d -exec chmod 755 {} +
  find "$dir" "${prune[@]}" -type f -perm -u+x -exec chmod 755 {} +
  find "$dir" "${prune[@]}" -type f ! -perm -u+x -exec chmod 644 {} +
}

# setup.sh 用 umask 022 安装全局 Node/PM2，但历史机器上 /usr/lib/node_modules
# 或 /usr/bin/pm2 可能已被锁成 700，dailyhim 执行时同样报
# “env: 'pm2': Permission denied”。update.sh 也要在调用 pm2 之前补一次 a+rX。
# 只加读/执行位，限定在 npm 全局包树与具体可执行文件。
GLOBAL_NODE_MODULES_DIRS=("/usr/lib/node_modules" "/usr/local/lib/node_modules")
GLOBAL_BIN_DIRS=("/usr/bin" "/usr/local/bin" "/usr/sbin")
GLOBAL_EXECUTABLES=("node" "npm" "npx" "pm2")

relax_global_paths() {
  local dir name path failed=0

  for dir in "${GLOBAL_NODE_MODULES_DIRS[@]}" "$(npm root -g 2>/dev/null)"; do
    [[ -n "$dir" && -d "$dir" ]] || continue
    chmod -R a+rX "$dir" 2>/dev/null || failed=1
  done

  for dir in "${GLOBAL_BIN_DIRS[@]}" "$(npm prefix -g 2>/dev/null)/bin"; do
    [[ -n "$dir" && -d "$dir" ]] || continue
    chmod a+rX "$dir" 2>/dev/null || failed=1
    for name in "${GLOBAL_EXECUTABLES[@]}"; do
      path="$dir/$name"
      [[ -e "$path" ]] || continue
      chmod a+rX "$path" 2>/dev/null || failed=1
    done
  done

  if [[ "$failed" -ne 0 ]]; then
    echo "警告：部分全局路径权限未能修正，若 pm2 报 Permission denied 请手动检查。" >&2
  fi
  return 0
}

wait_for_health() {
  local url="$1"
  for ((i = 1; i <= 30; i += 1)); do
    if curl -fsS "$url"; then
      printf '\n'
      return 0
    fi
    sleep 2
  done
  echo "健康检查超时：$url" >&2
  return 1
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行：sudo bash update.sh" >&2
  exit 1
fi
if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "$APP_DIR 不是 Git 仓库，请先运行 setup.sh。" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "缺少 $ENV_FILE，请先运行 setup.sh。" >&2
  exit 1
fi
if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "缺少低权限用户 $APP_USER，请重新运行 setup.sh。" >&2
  exit 1
fi

git -C "$APP_DIR" fetch origin "$BRANCH"
git -C "$APP_DIR" checkout "$BRANCH"
git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
fix_app_tree "$APP_DIR"
relax_global_paths
rm -rf "$APP_DIR/node_modules"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR/node_modules"
run_as_app npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_DIR/cache" "$APP_DIR/cache/audio"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
run_as_app pm2 reload "$APP_NAME" --update-env
run_as_app pm2 save --force >/dev/null

wait_for_health "http://127.0.0.1:${PORT:-3000}/api/health"
