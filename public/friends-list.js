/* Chat-entry list (好友 / 聊天). Owns #friends-section only. */
(function (global) {
  const section = () => document.getElementById('friends-section');
  let loadSeq = 0;
  let lastFriends = null;

  function label(friend) {
    return (friend && (friend.characterNickname || friend.nameZh || friend.displayName || friend.name || friend.id)) || '';
  }

  function safeDate(ts) {
    if (ts == null || ts === '' || ts === 0) return null;
    if (typeof ts !== 'number' && typeof ts !== 'string' && !(ts instanceof Date)) return null;
    if (typeof ts === 'number' && !Number.isFinite(ts)) return null;
    const d = ts instanceof Date ? ts : new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatTime(ts) {
    const d = safeDate(ts);
    if (!d) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function render(friends, opts = {}) {
    const root = section();
    if (!root) return;
    const { onOpen } = opts || {};
    root.replaceChildren();
    const list = Array.isArray(friends) ? friends : [];
    lastFriends = list.slice();
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'friends-empty';
      empty.textContent = '还没有聊天，点右上角 + 添加';
      root.append(empty);
      return;
    }
    list.forEach((friend) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'chat-row';
      row.dataset.friendId = friend.id;

      const avatar = document.createElement('span');
      avatar.className = 'avatar squircle';
      avatar.setAttribute('aria-hidden', 'true');
      if (friend.avatar) {
        avatar.style.backgroundImage = 'url("' + friend.avatar + '")';
        avatar.style.backgroundSize = 'cover';
        avatar.style.backgroundPosition = 'center';
      }

      const main = document.createElement('span');
      main.className = 'row-main';
      const top = document.createElement('span');
      top.className = 'row-top';
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = label(friend);
      const time = document.createElement('time');
      time.className = 'row-time';
      const d = safeDate(friend.lastAt);
      if (d) {
        time.dateTime = d.toISOString();
        time.textContent = formatTime(d);
      }
      top.append(name, time);

      const bot = document.createElement('span');
      bot.className = 'row-bot';
      const preview = document.createElement('span');
      preview.className = 'row-preview';
      preview.textContent = friend.preview || '点击进入聊天';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.hidden = true;
      bot.append(preview, badge);
      main.append(top, bot);
      row.append(avatar, main);
      row.addEventListener('click', () => {
        if (typeof onOpen === 'function') onOpen(friend);
        else location.href = '/?c=' + encodeURIComponent(friend.id) + '&open=1';
      });
      root.append(row);
    });
  }

  function renderError(opts = {}) {
    const root = section();
    if (!root) return;
    if (Array.isArray(lastFriends) && lastFriends.length > 0) return;
    root.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'friends-error';
    const msg = document.createElement('p');
    msg.className = 'friends-empty';
    msg.textContent = '没能加载聊天列表';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'friends-retry';
    btn.textContent = '重试';
    btn.addEventListener('click', () => { load(opts); });
    wrap.append(msg, btn);
    root.append(wrap);
  }

  function resolveAccountId(opts) {
    if (opts && opts.accountId) return String(opts.accountId);
    try {
      if (typeof localStorage !== 'undefined') return localStorage.getItem('idol_account_id') || '';
    } catch (_) { /* ignore */ }
    return '';
  }

  function hydrateFromCache(userId, opts = {}) {
    if (!userId || !global.AccountCache || typeof localStorage === 'undefined') return false;
    const cached = global.AccountCache.getFriends(localStorage, userId);
    if (!Array.isArray(cached)) return false;
    render(cached, opts);
    return true;
  }

  async function fetchFriendsOnce() {
    const response = await fetch('/api/friends', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) return { status: 401 };
    if (!response.ok) return { status: response.status };
    const data = await response.json();
    if (!data || data.ok === false || !Array.isArray(data.friends)) return { status: response.status };
    return { status: response.status, friends: data.friends };
  }

  async function load(opts = {}) {
    const root = section();
    if (!root) return [];
    const seq = ++loadSeq;
    const accountId = resolveAccountId(opts);
    let result = null;
    try {
      result = await fetchFriendsOnce();
    } catch (_) {
      result = null;
    }
    if (seq !== loadSeq) return lastFriends || [];
    if (result && result.status === 401) return lastFriends || [];
    if ((!result || !Array.isArray(result.friends)) && opts.retry !== false) {
      const delayMs = opts.retryDelayMs ?? 400;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (seq !== loadSeq) return lastFriends || [];
      try {
        result = await fetchFriendsOnce();
      } catch (_) {
        result = null;
      }
      if (seq !== loadSeq) return lastFriends || [];
      if (result && result.status === 401) return lastFriends || [];
    }
    if (result && Array.isArray(result.friends)) {
      if (accountId && global.AccountCache && typeof localStorage !== 'undefined') {
        global.AccountCache.setFriends(localStorage, accountId, result.friends);
      }
      render(result.friends, opts);
      return result.friends;
    }
    renderError(opts);
    return lastFriends || [];
  }

  function updateCurrent(characterId, { preview, time, unread } = {}) {
    if (Array.isArray(lastFriends) && characterId) {
      const idx = lastFriends.findIndex((f) => f && f.id === characterId);
      if (idx !== -1) {
        const nextItem = { ...lastFriends[idx] };
        if (preview != null) nextItem.preview = preview;
        if (time) {
          const d = safeDate(time);
          if (d) nextItem.lastAt = d.getTime();
        }
        lastFriends = lastFriends.slice();
        lastFriends[idx] = nextItem;
        const activeId = resolveAccountId();
        if (activeId && global.AccountCache && typeof localStorage !== 'undefined') {
          global.AccountCache.setFriends(localStorage, activeId, lastFriends);
        }
      }
    }
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(characterId)
      : String(characterId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const row = document.querySelector(
      '#friends-section .chat-row[data-friend-id="' + escaped + '"]'
    );
    if (!row) return;
    const previewEl = row.querySelector('.row-preview');
    const timeEl = row.querySelector('.row-time');
    const badge = row.querySelector('.badge');
    if (previewEl && preview != null) previewEl.textContent = preview;
    if (timeEl && time) {
      const d = safeDate(time);
      if (d) {
        timeEl.dateTime = d.toISOString();
        timeEl.textContent = formatTime(d);
      }
    }
    if (badge && unread != null) {
      if (unread > 0) {
        badge.hidden = false;
        badge.textContent = unread > 99 ? '99+' : String(unread);
      } else {
        badge.hidden = true;
      }
    }
  }

  function resetState() {
    loadSeq += 1;
    lastFriends = null;
  }

  const api = { load, render, renderError, updateCurrent, label, hydrateFromCache, resetState };
  if (typeof window !== 'undefined') global.FriendsList = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
