#!/usr/bin/env bash
# Build, verify, then stage ONLY public artifacts. Never generate a signing key.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
for command_name in java gradle node; do
  command -v "$command_name" >/dev/null || { echo "缺少构建工具：$command_name（需要 JDK 17、Gradle 8.11.1 和 Android SDK 36）" >&2; exit 1; }
done
: "${ANDROID_HOME:?请设置 Android SDK 路径 ANDROID_HOME}"
: "${ANDROID_KEYSTORE_PATH:?请设置仓库外的签名 keystore 绝对路径}"
: "${ANDROID_KEYSTORE_PASSWORD:?请设置 keystore 密码}"
: "${ANDROID_KEY_ALIAS:?请设置签名别名}"
: "${ANDROID_KEY_PASSWORD:?请设置密钥密码}"
[[ "$ANDROID_KEYSTORE_PATH" = /* && -f "$ANDROID_KEYSTORE_PATH" ]] || { echo '签名文件必须是存在的绝对路径' >&2; exit 1; }
keystore_realpath="$(realpath "$ANDROID_KEYSTORE_PATH")"
case "$keystore_realpath" in "$repo_dir"/*) echo '签名材料必须放在仓库外' >&2; exit 1;; esac
signer="$ANDROID_HOME/build-tools/35.0.0/apksigner"
[[ -x "$signer" && -f "$ANDROID_HOME/platforms/android-36/android.jar" ]] || { echo '缺少 platforms;android-36 或 build-tools;35.0.0' >&2; exit 1; }
gradle_version="$(gradle --version)"
[[ "$gradle_version" == *'Gradle 8.11.1'* ]] || { echo '请使用固定版本 Gradle 8.11.1' >&2; exit 1; }
gradle --no-daemon --console=plain -p "$repo_dir/android" :app:assembleRelease
apk="$repo_dir/android/app/build/outputs/apk/release/app-release.apk"
# Verify signatures before making the APK available; only print public cert data.
verification_file="$(mktemp)"
trap 'rm -f "$verification_file"' EXIT
"$signer" verify --verbose --print-certs "$apk" > "$verification_file"
cat "$verification_file"
node "$repo_dir/scripts/stage-android.cjs" "$apk" "$verification_file"
