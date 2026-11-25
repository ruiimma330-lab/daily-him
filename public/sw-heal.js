/* Service-worker self-heal. Loaded first on every page.
   A phone that installed an older worker keeps it until every window closes; meanwhile it serves
   old cached scripts next to freshly fetched pages (e.g. the old picker.js on the new pick.html,
   which showed "没有匹配的爱豆"). This asks the browser for the newest worker, lets a waiting one take
   over, and reloads the page once when the controlling worker changes. Not cached by old workers
   because no old precache list contains this file, so it always arrives from the network. */
(function () {
  if (!('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  const hadController = Boolean(sw.controller);
  const KEY = 'dh_sw_heal_at';
  let done = false;

  function typing() {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return true;
    }
    const fields = document.querySelectorAll('textarea, input[type="text"], input[type="search"], input:not([type])');
    for (let i = 0; i < fields.length; i += 1) if (fields[i].value) return true;
    return false;
  }

  function reloadOnce() {
    if (done || !hadController) return;
    done = true;
    try {
      const last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 10000) return; // never loop
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch (_) { /* private mode: still reload once per page load */ }
    if (typing()) {
      if (window.DailyPwa && window.DailyPwa.showUpdate) window.DailyPwa.showUpdate();
      return;
    }
    location.reload();
  }

  function skip(worker) {
    if (worker) worker.postMessage({ type: 'SKIP_WAITING' });
  }

  sw.addEventListener('controllerchange', reloadOnce);
  sw.getRegistration().then((reg) => {
    if (!reg) return;
    skip(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => { if (worker.state === 'installed') skip(worker); });
    });
    return reg.update();
  }).catch(() => { /* offline or unsupported */ });
})();
