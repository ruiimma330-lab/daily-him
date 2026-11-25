/* Install, updates, and the offline bar. Does not cache API calls itself. */
(function () {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const userAgent = navigator.userAgent || '';
  const ios = /iphone|ipad|ipod/i.test(userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const wechat = /MicroMessenger/i.test(userAgent);
  const iosSafari = ios && /Version\/[\d.]+.*Safari\//i.test(userAgent)
    && !/(CriOS|FxiOS|EdgiOS|OPiOS|MicroMessenger|Line\/|FBAN|FBAV|Instagram|GSA\/|DuckDuckGo|YaBrowser|Twitter)/i.test(userAgent);
  let deferred = null;
  let waitingWorker = null;

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  const offline = el('div', 'offline-bar');
  offline.id = 'offline-bar';
  offline.hidden = navigator.onLine !== false;
  offline.textContent = '网络断开了，连上后自动恢复';

  const update = el('div', 'pwa-update');
  update.id = 'pwa-update';
  update.hidden = true;
  const updateText = el('span');
  updateText.textContent = '有新版本，点此刷新';
  const updateBtn = el('button');
  updateBtn.type = 'button';
  updateBtn.textContent = '刷新';
  update.append(updateText, updateBtn);

  const install = el('div', 'pwa-install');
  install.id = 'pwa-install';
  install.hidden = true;
  const installText = el('span');
  installText.textContent = '添加到主屏幕';
  const installBtn = el('button');
  installBtn.type = 'button';
  installBtn.textContent = '添加';
  const installHide = el('button');
  installHide.type = 'button';
  installHide.textContent = '以后';
  install.append(installText, installBtn, installHide);

  const iosGuide = el('div', 'pwa-ios');
  iosGuide.id = 'pwa-ios';
  iosGuide.hidden = true;
  const iosForm = el('form');
  const iosTitle = el('h2');
  iosTitle.textContent = '添加到主屏幕';
  const iosLead = el('p');
  const steps = el('div', 'pwa-guide-steps');
  [
    ['⇧', '1. 点 Safari 的「分享」', '通常在屏幕底部'],
    ['＋', '2. 选择「添加到主屏幕」', '在分享菜单中向下找'],
    ['添加', '3. 点右上角「添加」', '完成后从桌面打开'],
  ].forEach(([symbol, title, detail]) => {
    const item = el('div', 'pwa-guide-step');
    const icon = el('span', 'pwa-guide-icon');
    icon.textContent = symbol;
    const copy = el('span');
    const strong = el('strong');
    strong.textContent = title;
    const small = el('small');
    small.textContent = detail;
    copy.append(strong, small);
    item.append(icon, copy);
    steps.append(item);
  });
  const copyLink = el('button', 'pwa-copy-link');
  copyLink.type = 'button';
  copyLink.textContent = '复制链接';
  copyLink.hidden = true;
  const copyFallback = el('textarea', 'pwa-copy-fallback');
  copyFallback.hidden = true;
  copyFallback.setAttribute('readonly', '');
  copyFallback.setAttribute('aria-label', 'Daily Him 安装链接');
  const iosOk = el('button');
  iosOk.type = 'button';
  iosOk.textContent = '知道了';
  iosForm.append(iosTitle, iosLead, steps, copyLink, copyFallback, iosOk);
  iosGuide.append(iosForm);

  document.body.append(offline, update, install, iosGuide);

  function paintOnline() {
    offline.hidden = navigator.onLine !== false;
  }
  window.addEventListener('online', paintOnline);
  window.addEventListener('offline', paintOnline);

  function prepareGuide() {
    copyLink.hidden = true;
    copyLink.textContent = '复制链接';
    copyFallback.hidden = true;
    steps.hidden = false;
    if (ios && iosSafari) {
      iosTitle.textContent = '用 Safari 添加到主屏幕';
      iosLead.textContent = '按下面三个位置操作：';
    } else if (ios) {
      iosTitle.textContent = '请用 Safari 打开';
      iosLead.textContent = '当前浏览器不能添加到主屏幕。复制链接，用 Safari 打开后再添加。';
      steps.hidden = true;
      copyLink.hidden = false;
    } else {
      iosTitle.textContent = '从 Chrome 菜单安装';
      iosLead.textContent = '暂时没有弹出系统安装框。请点 Chrome 右上角菜单，选择「安装应用」或「添加到主屏幕」。';
      steps.hidden = true;
    }
  }

  function showGuide() {
    prepareGuide();
    iosGuide.hidden = false;
  }

  async function configuredInstallUrl() {
    try {
      const response = await fetch('/api/site-config', { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json();
        if (data && typeof data.installUrl === 'string') return data.installUrl;
      }
    } catch (_) { /* use current page */ }
    if (window.location && window.location.href) return window.location.href;
    return 'https://dailyhim.cn/shell/install.html';
  }

  copyLink.addEventListener('click', async () => {
    const url = await configuredInstallUrl();
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      copyLink.textContent = '已复制，请到 Safari 粘贴';
    } catch (_) {
      const input = el('textarea');
      input.value = url;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      if (input.select) input.select();
      const copied = document.execCommand && document.execCommand('copy');
      if (input.remove) input.remove();
      if (copied) {
        copyLink.textContent = '已复制，请到 Safari 粘贴';
      } else {
        copyFallback.value = url;
        copyFallback.hidden = false;
        if (copyFallback.focus) copyFallback.focus();
        if (copyFallback.select) copyFallback.select();
        copyLink.textContent = '请长按下方链接复制';
      }
    }
  });

  iosOk.addEventListener('click', () => {
    iosGuide.hidden = true;
    try { localStorage.setItem('dh_ios_guide', '1'); } catch (_) { /* ignore */ }
  });

  installHide.addEventListener('click', () => {
    install.hidden = true;
    try { localStorage.setItem('dh_install_banner', '1'); } catch (_) { /* ignore */ }
  });

  async function promptInstall() {
    if (standalone || wechat) return { prompted: false, reason: standalone ? 'standalone' : 'wechat' };
    if (deferred) {
      deferred.prompt();
      const choice = await deferred.userChoice.catch(() => null);
      deferred = null;
      install.hidden = true;
      if (choice && choice.outcome === 'accepted') {
        try { localStorage.setItem('dh_install_banner', '1'); } catch (_) { /* ignore */ }
      }
      return { prompted: true, outcome: choice && choice.outcome };
    }
    showGuide();
    return { prompted: false, reason: ios ? (iosSafari ? 'ios-safari' : 'ios-browser') : 'manual' };
  }
  installBtn.addEventListener('click', promptInstall);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event;
    if (standalone) return;
    let seen = false;
    try { seen = localStorage.getItem('dh_install_banner') === '1'; } catch (_) { seen = false; }
    if (!seen) install.hidden = false;
  });

  function syncInstallEntries(installed = standalone) {
    if (!document.querySelectorAll) return;
    document.querySelectorAll('.pwa-install-entry,[data-pwa-install]').forEach((entry) => {
      entry.hidden = installed || wechat;
    });
  }
  syncInstallEntries();
  if (document.addEventListener) {
    document.addEventListener('click', (event) => {
      const entry = event.target && event.target.closest && event.target.closest('[data-pwa-install]');
      if (!entry) return;
      event.preventDefault();
      promptInstall();
    });
  }
  window.addEventListener('appinstalled', () => {
    install.hidden = true;
    iosGuide.hidden = true;
    syncInstallEntries(true);
  });

  let reloading = false;
  function isUserTyping() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return true;
    }
    if (!document.querySelectorAll) return false;
    const fields = document.querySelectorAll('textarea, input[type="text"], input[type="search"], input:not([type])');
    for (let i = 0; i < fields.length; i += 1) {
      if (fields[i].value) return true;
    }
    return false;
  }
  function applyUpdate() {
    if (!waitingWorker) return;
    reloading = true;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }
  function scheduleAutoApply() {
    setTimeout(() => {
      if (reloading || !waitingWorker) return;
      if (isUserTyping()) {
        const active = document.activeElement;
        if (active && active.addEventListener) {
          active.addEventListener('blur', () => {
            setTimeout(() => {
              if (!reloading && waitingWorker && !isUserTyping()) applyUpdate();
            }, 300);
          }, { once: true });
        }
        return;
      }
      applyUpdate();
    }, 1200);
  }
  updateBtn.addEventListener('click', applyUpdate);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading && !isUserTyping()) location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        function watch(worker) {
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state !== 'installed') return;
            if (navigator.serviceWorker.controller) {
              waitingWorker = worker;
              update.hidden = false;
              return;
            }
            worker.postMessage({ type: 'SKIP_WAITING' });
          });
        }
        if (reg.waiting && navigator.serviceWorker.controller) {
          waitingWorker = reg.waiting;
          update.hidden = false;
          // Auto-apply after a short beat when idle so deploys are not stuck behind the bar.
          scheduleAutoApply();
        }
        reg.addEventListener('updatefound', () => watch(reg.installing));
      }).catch(() => { /* private mode or insecure origin */ });
    });
  }

  prepareGuide();

  window.DailyPwa = {
    isStandalone: () => standalone,
    canShowInstallEntry: () => !standalone && !wechat,
    install: promptInstall,
    showIos: showGuide,
    showGuide,
    showUpdate: () => { update.hidden = false; },
    showOffline: () => { offline.hidden = false; },
  };
})();
