#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/dailyhim}"
ENV_FILE="${ENV_FILE:-/etc/dailyhim.env}"
BRANCH="${BRANCH:-main}"
APP_NAME="${APP_NAME:-dailyhim}"
APP_USER="${APP_USER:-dailyhim}"
APP_HOME="${APP_HOME:-/var/lib/dailyhim}"

run_as_app() {
  runuser --preserve-environment -u "$APP_USER" -- env HOME="$APP_HOME" PATH="$PATH" "$@"
}

wait_for_health() {
  local url="$1"
  local expected_commit="$2"
  local body=""
  for ((i = 1; i <= 30; i += 1)); do
    if body="$(curl -fsS "$url" 2>/dev/null)" && [[ "$body" == *'"ok":true'* ]] && [[ "$body" == *"\"commit\":\"${expected_commit}\""* ]]; then
      printf '%s\n' "$body"
      return 0
    fi
    sleep 2
  done
  echo "健康检查超时或版本不匹配：$url（期望 commit=$expected_commit，最后响应：${body:-无}）" >&2
  echo "请检查端口占用与残留进程：ss -ltnp | grep :3000 / ps aux | grep server.js" >&2
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
EXPECTED_COMMIT="$(git -C "$APP_DIR" rev-parse --short=7 HEAD)"
rm -rf "$APP_DIR/node_modules"
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR/node_modules"
run_as_app npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_DIR/cache" "$APP_DIR/cache/audio"

if [[ -S /root/.pm2/rpc.sock ]] && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 delete "$APP_NAME" >/dev/null
  pm2 save --force >/dev/null
fi
systemctl disable --now pm2-root >/dev/null 2>&1 || true
if systemctl list-unit-files dailyhim.service >/dev/null 2>&1 || systemctl is-active --quiet dailyhim.service 2>/dev/null; then
  systemctl disable --now dailyhim.service >/dev/null 2>&1 || true
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
run_as_app pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
run_as_app pm2 start "$APP_DIR/server.js" --name "$APP_NAME" --cwd "$APP_DIR" -i 1 --time
run_as_app pm2 save --force >/dev/null

wait_for_health "http://127.0.0.1:${PORT:-3000}/api/health" "$EXPECTED_COMMIT"

asset_url="http://127.0.0.1:${PORT:-3000}/friends-list.js"
asset_code="$(curl -sS -o /dev/null -w '%{http_code}' "$asset_url")"
if [[ "$asset_code" != "200" ]]; then
  echo "静态脚本检查失败：$asset_url 返回 HTTP $asset_code（期望 200）" >&2
  exit 1
fi
