/* Idol picker. Reads /api/characters only. Does not import the chat app. */
(function () {
  const groupsEl = document.getElementById('picker-groups');
  const pager = document.getElementById('picker-pager');
  const pagesEl = document.getElementById('picker-pages');
  const metaEl = document.getElementById('picker-meta');
  const goBtn = document.getElementById('picker-go');
  const emptyEl = document.getElementById('picker-empty');
  const searchForm = document.getElementById('picker-search');
  const queryInput = document.getElementById('picker-query');
  const menu = document.getElementById('picker-menu');

  const state = { all: [], model: { groups: [], pool: [] }, group: '全部', query: '', index: 0 };

  function filtered() {
    return PickerGroups.view(state.model, state.group, state.query);
  }

  function tabRow(el, values, current, onPick) {
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

  // Group tabs only: a group shows when at least one member can chat; 个人 comes last.
  function paintTabs() {
    const groups = ['全部', ...state.model.groups.map((g) => g.name)];
    if (!groups.includes(state.group)) state.group = '全部';
    tabRow(groupsEl, groups, state.group, (value) => {
      state.group = value;
      state.index = 0;
      paint();
    });
  }

  function paintMeta(list) {
    const current = list[state.index];
    metaEl.innerHTML = '';
    if (!current) {
      goBtn.disabled = true;
      return;
    }
    const open = current.available !== false;
    goBtn.disabled = !open;
    goBtn.textContent = open ? '开始聊天' : (current.availabilityLabel || '待开放');
    goBtn.classList.toggle('is-soon', !open);
    paintDots(list.length);
    const name = document.createElement('b');
    const ko = current.name || current.displayName || current.id;
    const zh = current.nameZh ? `  ${current.nameZh}` : '';
    name.textContent = `${ko}${zh}`;
    const sub = document.createElement('span');
    sub.textContent = current.group || current.company || '';
    metaEl.append(name, sub);
    const notice = document.createElement('p');
    notice.textContent = current.disclaimer + (current.voiceAvailable ? '' : ' 语音暂不可用');
    metaEl.append(notice);
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
      page.dataset.portraitSrc = ch.portrait || ch.avatar || '';
      const img = document.createElement('img');
      img.alt = ch.nameZh || ch.name || ch.id;
      page.append(img);
      pager.append(page);
    });
    buildDots(list.length);
    paintMeta(list);
    autoplay.setCount(list.length);
    requestAnimationFrame(() => jump(state.index));
  }

  // Instagram-style dots: the current photo's dot stays centered; at most 4 visible each side.
  function buildDots(count) {
    pagesEl.innerHTML = '';
    pagesEl.hidden = count <= 1;
    const track = document.createElement('div');
    track.className = 'picker-dots-track';
    for (let i = 0; i < count; i += 1) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker-dot';
      btn.setAttribute('aria-label', `第 ${i + 1} 张，共 ${count} 张`);
      btn.addEventListener('click', () => {
        autoplay.poke();
        jump(i, true);
      });
      track.append(btn);
    }
    pagesEl.append(track);
  }

  function paintDots(count) {
    const track = pagesEl.firstElementChild;
    if (!track || track.children.length !== count) return;
    const view = CarouselDots.layout(count, state.index);
    pagesEl.dataset.mode = view.mode;
    pagesEl.style.setProperty('--dot-slots', String(view.slots));
    track.style.setProperty('--dot-offset', String(view.offset));
    view.dots.forEach((dot, i) => {
      const btn = track.children[i];
      btn.style.setProperty('--dot-scale', String(dot.scale));
      btn.style.setProperty('--dot-opacity', String(dot.opacity));
      btn.classList.toggle('is-hidden', dot.hidden);
      btn.tabIndex = dot.hidden ? -1 : 0;
      if (dot.hidden) btn.setAttribute('aria-hidden', 'true');
      else btn.removeAttribute('aria-hidden');
      if (dot.active) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    });
  }

  function jump(index, smooth) {
    const list = filtered();
    const last = Math.max(0, list.length - 1);
    const next = Math.max(0, Math.min(last, index));
    const width = pager.clientWidth || 1;
    state.index = next;
    pager.scrollTo({ left: next * width, behavior: smooth && !reducedMotion.matches ? 'smooth' : 'auto' });
    loadPortraitNeighbors(next);
    paintMeta(list);
  }

  // Keep network/decode work bounded: current cover plus at most two on either side.
  function loadPortraitNeighbors(center) {
    const start = Math.max(0, center - 2);
    const end = Math.min(pager.children.length - 1, center + 2);
    for (let index = start; index <= end; index += 1) {
      const page = pager.children[index];
      if (!page || page.dataset.portraitLoading === '1') continue;
      const img = page.querySelector('img');
      if (!img) continue;
      page.dataset.portraitLoading = '1';
      PortraitLoader.attach(page, img, page.dataset.portraitSrc || '');
    }
  }

  function step(direction) {
    const list = filtered();
    if (list.length < 2) return;
    jump(state.index + direction, true);
  }

  // Autoplay: ~3.5s per photo, loops; pauses while touched, resumes 5s after; off-screen/hidden tab/reduced motion stop it.
  const reducedMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const autoplay = CarouselDots.createAutoplay({
    interval: 3500,
    resumeDelay: 5000,
    advance() {
      const list = filtered();
      if (list.length > 1) jump(CarouselDots.nextIndex(list.length, state.index), true);
    },
  });
  autoplay.setReducedMotion(reducedMotion.matches);
  if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', (e) => autoplay.setReducedMotion(e.matches));
  autoplay.setPageVisible(document.visibilityState !== 'hidden');
  document.addEventListener('visibilitychange', () => autoplay.setPageVisible(document.visibilityState !== 'hidden'));
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      entries.forEach((entry) => autoplay.setOnScreen(entry.isIntersecting));
    }, { threshold: 0.3 }).observe(pager);
  }
  let touchStart = null;
  pager.addEventListener('touchstart', (event) => {
    const point = event.touches[0];
    touchStart = point ? { x: point.clientX, y: point.clientY } : null;
    autoplay.interactStart();
  }, { passive: true });
  pager.addEventListener('touchend', (event) => {
    const point = event.changedTouches[0];
    if (touchStart && point) {
      const dx = touchStart.x - point.clientX;
      const dy = touchStart.y - point.clientY;
      if (Math.abs(dx) >= 36 && Math.abs(dx) > Math.abs(dy)) {
        event.preventDefault();
        step(dx > 0 ? 1 : -1);
      }
    }
    touchStart = null;
    autoplay.interactEnd();
  }, { passive: false });
  pager.addEventListener('touchcancel', () => {
    touchStart = null;
    autoplay.interactEnd();
  }, { passive: true });

  let wheelLocked = false;
  let wheelUnlock = 0;
  pager.addEventListener('wheel', (event) => {
    autoplay.poke();
    clearTimeout(wheelUnlock);
    wheelUnlock = setTimeout(() => { wheelLocked = false; }, 180);
    if (wheelLocked) return;
    const amount = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (Math.abs(amount) < 8) return;
    event.preventDefault();
    wheelLocked = true;
    step(amount > 0 ? 1 : -1);
  }, { passive: false });

  pager.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    autoplay.poke();
    step(event.key === 'ArrowRight' ? 1 : -1);
  });

  function syncFromScroll() {
    const list = filtered();
    const width = pager.clientWidth || 1;
    const index = Math.max(0, Math.min(list.length - 1, Math.round(pager.scrollLeft / width)));
    if (index === state.index) return;
    state.index = index;
    loadPortraitNeighbors(index);
    paintMeta(list);
  }

  async function start() {
    const current = filtered()[state.index];
    if (!current || current.available === false || goBtn.disabled) return;
    Shell.setSelectedCharacter(current.id);
    goBtn.disabled = true;
    try {
      // Product rule: tapping 开始聊天 immediately makes this idol a friend,
      // even if the user later backs out of the naming screen.
      let profile = null;
      try {
        const saved = await Shell.api('/api/profile?characterId=' + encodeURIComponent(current.id), {
          method: 'PUT',
          body: JSON.stringify({ onboarded: true }),
        });
        profile = saved && saved.profile;
      } catch (_) {
        Shell.toast('保存失败，请重试');
        goBtn.disabled = current.available === false;
        return;
      }
      // From 好友「添加」: go straight back to the list so the new row is visible.
      if (Shell.qs('from') === 'chat') {
        Shell.go('/', { c: current.id, welcome: '1' });
        return;
      }
      const named = Boolean(
        profile
        && (profile.callNameStatus === 'done' || profile.callNameStatus === 'pending')
      );
      if (named) {
        Shell.go('/', { c: current.id, welcome: '1' });
        return;
      }
      Shell.go('/shell/onboard.html', { c: current.id });
    } catch (_) {
      Shell.toast('暂时进不去，请重试');
      goBtn.disabled = current.available === false;
    }
  }

  let hasFriendsState = false;
  function leave() {
    if (Shell.qs('from') === 'chat' || hasFriendsState) Shell.go('/', { c: Shell.selectedCharacter() });
    else Shell.go('/shell/cover.html');
  }

  pager.addEventListener('scroll', syncFromScroll, { passive: true });
  goBtn.addEventListener('click', start);
  const searchBtn = document.getElementById('picker-search-btn');
  searchForm.addEventListener('submit', (event) => event.preventDefault());
  searchBtn.addEventListener('click', () => {
    const open = searchForm.hidden;
    searchForm.hidden = !open;
    searchBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      queryInput.focus();
    } else if (state.query || queryInput.value) {
      state.query = '';
      queryInput.value = '';
      state.index = 0;
      paint();
    }
  });
  queryInput.addEventListener('input', () => {
    state.query = queryInput.value;
    state.index = 0;
    paint();
  });

  const menuBtn = document.getElementById('picker-menu-btn');
  function closeMenu() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
  }
  if (menuBtn && menu) {
    menuBtn.hidden = menu.children.length === 0;
    menuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!menu.children.length) return;
      const open = menu.hidden;
      menu.hidden = !open;
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (event) => {
      if (!menu.hidden && !menu.contains(event.target) && !menuBtn.contains(event.target)) {
        closeMenu();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });
  }

  const backBtn = document.getElementById('picker-back');
  if (backBtn) {
    backBtn.hidden = Shell.qs('from') !== 'chat';
    backBtn.addEventListener('click', leave);
  }

  Promise.all([
    Shell.api('/api/characters'),
    Shell.api('/api/friends').catch(() => ({ friends: [], hasFriends: false })),
  ]).then(([data, friends]) => {
    const added = new Set((friends.friends || []).map((item) => item.id));
    hasFriendsState = Boolean(friends && (friends.hasFriends || added.size > 0));
    if (backBtn) backBtn.hidden = !(hasFriendsState || Shell.qs('from') === 'chat');
    let roster = data.characters || [];
    // From chat "添加": only show idols not yet opened as friends.
    if (Shell.qs('from') === 'chat') {
      roster = roster.filter((ch) => !added.has(ch.id));
    }
    state.all = roster;
    state.model = PickerGroups.build(state.all);
    const preset = Shell.qs('c') || data.defaultId;
    paint();
    const list = filtered();
    const found = list.findIndex((ch) => ch.id === preset);
    if (found > 0) jump(found);
  }).catch((err) => {
    // Load/paint failure is not "no match": say so, hide the dead button, offer a retry.
    if (window.console) console.error('picker failed', err);
    pager.innerHTML = '';
    goBtn.hidden = true;
    emptyEl.hidden = false;
    emptyEl.textContent = '加载失败，点这里重试';
    emptyEl.setAttribute('role', 'button');
    emptyEl.tabIndex = 0;
    emptyEl.addEventListener('click', () => location.reload(), { once: true });
  });
})();
