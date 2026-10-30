/* Shared helpers for independent shell screens. */
(function (global) {
  const copyCache = { data: null };
  async function loadCopy() {
    if (copyCache.data) return copyCache.data;
    const r = await fetch('/shell/copy.json', { cache: 'no-store' });
    copyCache.data = await r.json();
    return copyCache.data;
  }
  function toast(msg) {
    let t = document.getElementById('shell-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'shell-toast';
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  async function api(path, opt = {}) {
    const r = await fetch(path, {
      ...opt,
      headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) },
    });
    if (r.status === 401) {
      if (opt.allow401) return null;
      location.href = '/login';
      throw new Error('auth');
    }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(body.error || 'request failed');
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return body;
  }
  function qs(k) { return new URLSearchParams(location.search).get(k); }
  function go(path, params) {
    const u = new URL(path, location.origin);
    if (params) Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') u.searchParams.set(k, v); });
    location.href = u.pathname + u.search;
  }
  function selectedCharacter() {
    return qs('c') || localStorage.getItem('idol_selected_character') || 'baekhyun';
  }
  function setSelectedCharacter(id) {
    localStorage.setItem('idol_selected_character', id);
  }
  global.Shell = { loadCopy, toast, api, qs, go, selectedCharacter, setSelectedCharacter };
})(window);
