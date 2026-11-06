(function () {
  const pwa = window.DailyPwa;
  const button = document.getElementById('install-pwa');
  const status = document.getElementById('install-status');
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function installed() {
    button.disabled = true;
    button.textContent = '已添加到主屏幕';
    status.textContent = '你正在使用主屏幕应用，可直接返回 Daily Him。';
  }
  if (pwa && pwa.isStandalone()) installed();
  window.addEventListener('appinstalled', installed);
  window.addEventListener('beforeinstallprompt', () => {
    status.textContent = '已准备好，点击「添加到主屏幕」即可安装。';
  });
  button.addEventListener('click', async () => {
    if (!pwa) return;
    try {
      await pwa.install();
      if (!ios && !button.disabled) status.textContent = '若没有弹出提示，请在 Chrome 菜单中选择「安装应用」或「添加到主屏幕」。';
    } catch (_) {
      status.textContent = '请重试，或在 Chrome 菜单中选择「添加到主屏幕」。';
    }
  });

  // A signed APK is only offered once it really exists. The build script writes
  // both the APK and its metadata; never present a login page/404 as a download.
  fetch('/downloads/android.json', { cache: 'no-store' }).then(async (response) => {
    if (!response.ok) throw new Error('metadata unavailable');
    const info = await response.json();
    if (!info.available) throw new Error('not built');
    const apk = await fetch('/downloads/daily-him.apk', { method: 'HEAD', cache: 'no-store' });
    if (!apk.ok || !/application\/(vnd.android.package-archive|octet-stream)/i.test(apk.headers.get('content-type') || '')) throw new Error('APK unavailable');
    document.getElementById('apk-pending').hidden = true;
    document.getElementById('apk-download').hidden = false;
    document.getElementById('apk-status').textContent = 'APK · ' + info.version + ' · ' + (info.bytes / 1048576).toFixed(1) + ' MB';
  }).catch(() => {
    document.getElementById('apk-status').textContent = '安卓安装包尚未生成，请先使用「添加到主屏幕」。';
  });
})();
