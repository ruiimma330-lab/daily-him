#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/dailyhim}"
ENV_FILE="${ENV_FILE:-/etc/dailyhim.env}"
BRANCH="${BRANCH:-main}"
APP_NAME="${APP_NAME:-dailyhim}"

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

git -C "$APP_DIR" fetch origin "$BRANCH"
git -C "$APP_DIR" checkout "$BRANCH"
git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
pm2 reload "$APP_NAME" --update-env
pm2 save --force >/dev/null

curl -fsS http://127.0.0.1:"${PORT:-3000}"/api/health
printf '\n'
