/* Chat-entry list (好友 / 聊天). Owns #friends-section only. */
(function (global) {
  const section = () => document.getElementById('friends-section');

  function label(friend) {
    return (friend && (friend.characterNickname || friend.nameZh || friend.displayName || friend.name || friend.id)) || '';
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function render(friends, { onOpen } = {}) {
    const root = section();
    if (!root) return;
    root.replaceChildren();
    const list = Array.isArray(friends) ? friends : [];
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
      if (friend.lastAt) {
        time.dateTime = new Date(friend.lastAt).toISOString();
        time.textContent = formatTime(friend.lastAt);
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

  async function load(opts) {
    const root = section();
    if (!root) return [];
    try {
      const response = await fetch('/api/friends', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        render([], opts);
        return [];
      }
      const data = await response.json();
      const friends = (data && data.friends) || [];
      render(friends, opts);
      return friends;
    } catch (_) {
      render([], opts);
      return [];
    }
  }

  function updateCurrent(characterId, { preview, time, unread } = {}) {
    const row = document.querySelector(
      '#friends-section .chat-row[data-friend-id="' + CSS.escape(characterId) + '"]'
    );
    if (!row) return;
    const previewEl = row.querySelector('.row-preview');
    const timeEl = row.querySelector('.row-time');
    const badge = row.querySelector('.badge');
    if (previewEl && preview != null) previewEl.textContent = preview;
    if (timeEl && time) {
      timeEl.dateTime = new Date(time).toISOString();
      timeEl.textContent = formatTime(time);
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

  global.FriendsList = { load, render, updateCurrent, label };
})(window);
