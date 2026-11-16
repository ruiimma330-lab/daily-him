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
