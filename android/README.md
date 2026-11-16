# Daily Him 安卓安装包

这是 TWA 外壳，包名 `com.dailyhim.app`，显示名 **Daily Him**，打开
`${PUBLIC_SITE_URL}/shell/cover.html`（未设置时为 `https://dailyhim.cn`）。网页和账号仍使用现有站点。
需要 Android 6.0+、网络和支持 TWA 的浏览器（推荐 Chrome）；域名验证未完成时会显示浏览器工具栏。

## 构建

固定工具：JDK 17、Gradle 8.11.1、Android SDK Platform 36、Build Tools 35.0.0；
AGP 8.10.1、android-browser-helper 2.6.2（其依赖要求 compileSdk 36；targetSdk 保持 35）。在能访问 Google Maven / Maven Central 的机器上：

```bash
sdkmanager 'platforms;android-36' 'build-tools;35.0.0'
# ANDROID_HOME 指向 SDK，Gradle 8.11.1 / JDK 17 在 PATH 中。
# 首次由维护者在仓库外创建并安全备份长期签名密钥（交互输入密码）：
keytool -genkeypair -keystore /secure/location/daily-him-release.jks \
  -alias daily-him -keyalg RSA -keysize 3072 -validity 10000
export ANDROID_KEYSTORE_PATH=/secure/location/daily-him-release.jks
export ANDROID_KEY_ALIAS=daily-him
export PUBLIC_SITE_URL=https://dailyhim.cn
# 用本地安全输入提供 ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_PASSWORD，切勿写进仓库。
bash scripts/build-android.sh
```

脚本先构建 release，再用 `apksigner verify --verbose --print-certs` 验证，最后生成：

- `public/downloads/daily-him.apk`：已签名可侧载 APK。
- `public/downloads/android.json`：版本、大小、APK 文件 SHA-256 和签名证书 SHA-256。
- `public/.well-known/assetlinks.json`：匹配该 APK 签名证书的域名声明。

将这三个公开文件作为同一组提交、部署后，安装页自动显示「下载安卓安装包」。
下载路径为 `/downloads/daily-him.apk`，免登录；安装页 `/shell/install.html`。
后续升级必须保留相同签名密钥并提高 `android/app/build.gradle` 的 `versionCode`。

## 签名和域名验证

**必须匹配的是签名证书 SHA-256，不能使用 APK 文件的 SHA-256 代替。**
脚本自动从最终 APK 提取，写入 `sha256_cert_fingerprints` 并打印在构建日志中。
域名声明必须从 `${PUBLIC_SITE_URL}/.well-known/assetlinks.json`
以 HTTP 200、JSON 内容直接返回，不能要求登录。

当前环境无 JDK/Android SDK，且无法解析 `dl.google.com`，代理连接也不可用，
因此尚未生成 APK 或任何签名材料。`assetlinks.json` 暂为 `[]`，没有伪造指纹；
`android.json` 为 `available: false`，下载按钮显示尚未提供，PWA 安装可照常使用。

## 可选手动 CI

`.github/workflows/android-apk.yml` 仅通过 `workflow_dispatch` 手动触发，不部署、不提交产物。
配置 GitHub Secrets（仅名称占位，仓库无实际密钥）：
`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。
BASE64 仅编码，不加密，必须存 Secrets。CI 在 runner 临时目录解码并始终清理。
下载 `daily-him-android-public` artifact，将三个公开文件恢复到上述路径并进行人工审核。
不要上传 keystore、密码或私钥作为 artifact；密钥需要在 CI 外安全备份以支持升级。

## 手动验收（构建后）

1. `apksigner verify --verbose --print-certs public/downloads/daily-him.apk`。
2. `adb install -r public/downloads/daily-him.apk`，从桌面点 Daily Him，确认进入线上封面。
3. 部署匹配的 assetlinks 后重启应用，确认 TWA 隐藏地址栏。
4. 验证登录、音频播放、返回行为；APK 不新增网页业务逻辑。

实现参考：[Google TWA 示例](https://github.com/GoogleChrome/android-browser-helper/tree/main/demos/twa-basic)、
[Android 命令行构建](https://developer.android.com/build/building-cmdline)、
[apksigner](https://developer.android.com/tools/apksigner)。
