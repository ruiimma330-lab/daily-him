/* Idol picker. Reads /api/characters only. Does not import the chat app. */
(function () {
  const companiesEl = document.getElementById('picker-companies');
  const groupsEl = document.getElementById('picker-groups');
  const pager = document.getElementById('picker-pager');
  const pagesEl = document.getElementById('picker-pages');
  const metaEl = document.getElementById('picker-meta');
  const goBtn = document.getElementById('picker-go');
  const emptyEl = document.getElementById('picker-empty');
  const searchForm = document.getElementById('picker-search');
  const queryInput = document.getElementById('picker-query');
  const menu = document.getElementById('picker-menu');

  const state = { all: [], company: '全部', group: '全部', query: '', index: 0 };

  const COMPANY_ORDER = ['SM', 'HYBE', 'JYP', 'YG'];
  function unique(list) {
    return [...new Set(list.filter(Boolean))].sort((a, b) => {
      const ia = COMPANY_ORDER.indexOf(a);
      const ib = COMPANY_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a).localeCompare(String(b));
    });
  }

  function filtered() {
    const q = state.query.trim().toLowerCase();
    return state.all.filter((ch) => {
      if (state.company !== '全部' && ch.company !== state.company) return false;
      if (state.group !== '全部' && ch.group !== state.group) return false;
      if (!q) return true;
      const hay = [ch.name, ch.displayName, ch.nameZh, ch.nameRoman, ch.group, ch.company, ch.id]
        .filter(Boolean).join('\n').toLowerCase();
      return hay.includes(q);
    });
  }

  function tabRow(el, label, values, current, onPick) {
    el.innerHTML = '';
    values.forEach((value) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', value === current ? 'true' : 'false');
      btn.textContent = value;
      btn.addEventListener('click', () => onPick(value));
      el.append(btn);
    });
    el.hidden = values.length <= 1;
  }

  function paintTabs() {
    const companies = ['全部', ...unique(state.all.map((ch) => ch.company))];
    if (!companies.includes(state.company)) state.company = '全部';
    const pool = state.company === '全部' ? state.all : state.all.filter((ch) => ch.company === state.company);
    const groups = ['全部', ...unique(pool.map((ch) => ch.group))];
    if (!groups.includes(state.group)) state.group = '全部';
    tabRow(companiesEl, '公司', companies, state.company, (value) => {
      state.company = value;
      state.group = '全部';
      state.index = 0;
      paint();
    });
    tabRow(groupsEl, '团体', groups, state.group, (value) => {
      state.group = value;
      state.index = 0;
      paint();
    });
  }

  function paintMeta(list) {
    const current = list[state.index];
    metaEl.innerHTML = '';
    pagesEl.innerHTML = '';
    if (!current) {
      goBtn.disabled = true;
      return;
    }
    const open = current.available !== false;
    goBtn.disabled = !open;
    goBtn.textContent = open ? '开始聊天' : '即将开放';
    goBtn.classList.toggle('is-soon', !open);
    list.forEach((_, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = String(i + 1);
      if (i === state.index) btn.setAttribute('aria-current', 'true');
      btn.addEventListener('click', () => jump(i));
      pagesEl.append(btn);
    });
    const name = document.createElement('b');
    const ko = current.name || current.displayName || current.id;
    const zh = current.nameZh ? `  ${current.nameZh}` : '';
    name.textContent = `${ko}${zh}`;
    const sub = document.createElement('span');
    sub.textContent = current.group || current.company || '';
    metaEl.append(name, sub);
  }

  function paint() {
    paintTabs();
    const list = filtered();
    if (state.index >= list.length) state.index = 0;
    pager.innerHTML = '';
    emptyEl.hidden = list.length > 0;
    goBtn.hidden = list.length === 0;
    list.forEach((ch) => {
      const page = document.createElement('article');
      page.className = 'picker-page';
      page.dataset.id = ch.id;
      const img = document.createElement('img');
      img.alt = ch.nameZh || ch.name || ch.id;
      img.src = ch.portrait || ch.avatar;
      page.append(img);
      pager.append(page);
    });
    paintMeta(list);
    requestAnimationFrame(() => jump(state.index));
  }

  function jump(index) {
    const width = pager.clientWidth || 1;
    state.index = index;
    pager.scrollTo({ left: index * width, behavior: 'auto' });
    paintMeta(filtered());
  }

  function syncFromScroll() {
    const list = filtered();
    const width = pager.clientWidth || 1;
    const index = Math.max(0, Math.min(list.length - 1, Math.round(pager.scrollLeft / width)));
    if (index === state.index) return;
    state.index = index;
    paintMeta(list);
  }

  async function start() {
    const current = filtered()[state.index];
    if (!current || current.available === false || goBtn.disabled) return;
    Shell.setSelectedCharacter(current.id);
    goBtn.disabled = true;
    try {
      let onboarded = false;
      try {
        const profile = await Shell.api('/api/profile?characterId=' + encodeURIComponent(current.id));
        onboarded = Boolean(profile.profile && profile.profile.onboardedAt);
      } catch (_) { /* treat as not set up */ }
      if (onboarded) {
        Shell.go('/', { c: current.id });
        return;
      }
      Shell.go('/shell/onboard.html', { c: current.id });
    } catch (_) {
      Shell.toast('暂时进不去，请重试');
      goBtn.disabled = current.available === false;
    }
  }

  function leave() {
    if (Shell.qs('from') === 'chat') Shell.go('/', { c: Shell.selectedCharacter() });
    else Shell.go('/shell/cover.html');
  }

  pager.addEventListener('scroll', syncFromScroll, { passive: true });
  goBtn.addEventListener('click', start);
  document.getElementById('picker-search-btn').addEventListener('click', () => {
    const open = searchForm.hidden;
    searchForm.hidden = !open;
    document.getElementById('picker-search-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) queryInput.focus();
  });
  queryInput.addEventListener('input', () => {
    state.query = queryInput.value;
    state.index = 0;
    paint();
  });
  document.getElementById('picker-menu-btn').addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    document.getElementById('picker-menu-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.getElementById('picker-back').addEventListener('click', leave);

  Shell.api('/api/characters').then((data) => {
    state.all = data.characters || [];
    const preset = Shell.qs('c') || data.defaultId;
    paint();
    const list = filtered();
    const found = list.findIndex((ch) => ch.id === preset);
    if (found > 0) jump(found);
  }).catch(() => { emptyEl.hidden = false; });
})();
