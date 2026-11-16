(function () {
  const pwa = window.DailyPwa;
  const button = document.getElementById('install-pwa');
  const status = document.getElementById('install-status');
  const userAgent = navigator.userAgent || '';
  const ios = /iphone|ipad|ipod/i.test(userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = ios && /Version\/[\d.]+.*Safari\//i.test(userAgent)
    && !/(CriOS|FxiOS|EdgiOS|OPiOS|MicroMessenger|Line\/|FBAN|FBAV|Instagram|GSA\/|DuckDuckGo|YaBrowser|Twitter)/i.test(userAgent);
  if (document.body && document.body.dataset) document.body.dataset.installOs = ios ? 'ios' : 'android';
  if (document.body && document.body.dataset) document.body.dataset.installBrowser = safari ? 'safari' : 'other';

  let installUrl = window.location && window.location.href
    ? window.location.href
    : 'https://dailyhim.cn/shell/install.html';
  fetch('/api/site-config', { cache: 'no-store' }).then((response) => response.ok ? response.json() : null).then((config) => {
    if (!config || typeof config.installUrl !== 'string') return;
    installUrl = config.installUrl;
    const link = document.getElementById('site-url');
    if (link) {
      link.href = installUrl;
      link.textContent = installUrl.replace(/^https?:\/\//, '');
    }
  }).catch(() => { /* keep same-origin fallback */ });

  const warning = document.getElementById('ios-browser-warning');
  if (warning) warning.hidden = !ios || safari;
  const copyLink = document.getElementById('copy-site-link');
  const copyFallback = document.getElementById('copy-site-fallback');
  if (copyLink) {
    copyLink.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(installUrl);
        copyLink.textContent = '已复制，请到 Safari 粘贴';
      } catch (_) {
        const input = document.createElement('textarea');
        input.value = installUrl;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand && document.execCommand('copy');
        input.remove();
        if (copied) {
          copyLink.textContent = '已复制，请到 Safari 粘贴';
        } else if (copyFallback) {
          copyFallback.value = installUrl;
          copyFallback.hidden = false;
          copyFallback.focus();
          copyFallback.select();
          copyLink.textContent = '请长按下方链接复制';
        } else {
          copyLink.textContent = installUrl;
        }
      }
    });
  }

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
      const result = await pwa.install();
      if (!ios && !button.disabled && (!result || !result.prompted)) status.textContent = '若没有弹出提示，请在 Chrome 菜单中选择「安装应用」或「添加到主屏幕」。';
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
