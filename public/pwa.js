/* Install, updates, and the offline bar. Does not cache API calls itself. */
(function () {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
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
  iosLead.textContent = '用 Safari 打开 Daily Him，然后：';
  const steps = el('ol');
  ['点底部的分享按钮', '选择「添加到主屏幕」', '点右上角「添加」'].forEach((text) => {
    const li = el('li');
    li.textContent = text;
    steps.append(li);
  });
  const iosOk = el('button');
  iosOk.type = 'button';
  iosOk.textContent = '知道了';
  iosForm.append(iosTitle, iosLead, steps, iosOk);
  iosGuide.append(iosForm);

  document.body.append(offline, update, install, iosGuide);

  function paintOnline() {
    offline.hidden = navigator.onLine !== false;
  }
  window.addEventListener('online', paintOnline);
  window.addEventListener('offline', paintOnline);

  function showIos() {
    iosGuide.hidden = false;
  }
  iosOk.addEventListener('click', () => {
    iosGuide.hidden = true;
    try { localStorage.setItem('dh_ios_guide', '1'); } catch (_) { /* ignore */ }
  });

  function maybeIosGuide() {
    if (standalone || !ios) return;
    let seen = false;
    try { seen = localStorage.getItem('dh_ios_guide') === '1'; } catch (_) { seen = false; }
    if (!seen) showIos();
  }

  installHide.addEventListener('click', () => {
    install.hidden = true;
    try { localStorage.setItem('dh_install_banner', '1'); } catch (_) { /* ignore */ }
  });

  async function promptInstall() {
    if (standalone) return;
    if (deferred) {
      deferred.prompt();
      const choice = await deferred.userChoice.catch(() => null);
      deferred = null;
      install.hidden = true;
      if (choice && choice.outcome === 'accepted') {
        try { localStorage.setItem('dh_install_banner', '1'); } catch (_) { /* ignore */ }
      }
      return;
    }
    if (ios) showIos();
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

  let reloading = false;
  function applyUpdate() {
    if (!waitingWorker) return;
    reloading = true;
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }
  updateBtn.addEventListener('click', applyUpdate);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) location.reload();
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
        }
        reg.addEventListener('updatefound', () => watch(reg.installing));
      }).catch(() => { /* private mode or insecure origin */ });
    });
  }

  maybeIosGuide();

  window.DailyPwa = {
    isStandalone: () => standalone,
    install: promptInstall,
    showIos: showIos,
    showUpdate: () => { update.hidden = false; },
    showOffline: () => { offline.hidden = false; },
  };
})();
