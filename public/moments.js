/* Moments feed. Self-contained: own stylesheet, own character lookup.
   Host contract: #mom-panel, #mom-feed, #mom-empty, #toast, and window.Moments. */
(function () {
  const panel = document.getElementById('mom-panel');
  if (!panel) return;
  const feed = document.getElementById('mom-feed');
  const empty = document.getElementById('mom-empty');
  const characterId = () => {
    const fromUrl = new URLSearchParams(location.search).get('c');
    if (fromUrl) return fromUrl.toLowerCase();
    try {
      const account = localStorage.getItem('idol_account_id');
      if (account && window.AccountCache) {
        const saved = window.AccountCache.getSelected(localStorage, account);
        if (saved) return saved;
      }
    } catch (_) { /* ignore */ }
    return 'baekhyun';
  };
  const withChar = (u) => `${u}${u.includes('?') ? '&' : '?'}characterId=${encodeURIComponent(characterId())}`;
  const identity = { name: '', avatar: '' };

  const toast = (msg) => {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
  };
  const fmt = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  };
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  const ICO = {
    heart: svg('M12 19s-6.5-4.2-6.5-8.2A3.4 3.4 0 0 1 12 8.2 3.4 3.4 0 0 1 18.5 10.8C18.5 14.8 12 19 12 19z'),
    comment: svg('M6.2 16.2 5 18.2c-.2.3-.7.1-.7-.3V8.2A2 2 0 0 1 6.3 6.2h11.4A2 2 0 0 1 19.7 8.2v5.8a2 2 0 0 1-2 2H6.2z'),
    share: svg('M12 16V5.5M8.2 9 12 5.2 15.8 9M6 18.5h12'),
    bookmark: svg('M7 4.8h10V19l-5-3.2L7 19z'),
  };
  const iconBtn = (name, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mom-ico';
    b.setAttribute('aria-label', label);
    b.innerHTML = ICO[name];
    return b;
  };

  async function loadIdentity() {
    const id = characterId();
    identity.avatar = `/characters/${id}/avatar`;
    identity.name = id;
    try {
      const [chars, prof] = await Promise.all([
        fetch('/api/characters').then((r) => r.json()),
        fetch('/api/profile?characterId=' + encodeURIComponent(id)).then((r) => r.json()),
      ]);
      const ch = (chars.characters || []).find((item) => item.id === id && item.available !== false);
      const nick = prof.profile && typeof prof.profile.characterNickname === 'string'
        ? prof.profile.characterNickname.trim() : '';
      if (ch) {
        identity.name = nick || ch.displayName || ch.name || id;
        identity.avatar = ch.avatar || identity.avatar;
      }
    } catch (_) { /* keep the path fallback */ }
  }

  const avatarNode = () => {
    const a = document.createElement('span');
    a.className = 'mom-avatar';
    const img = document.createElement('img');
    img.alt = '';
    img.src = identity.avatar;
    a.append(img);
    return a;
  };

  function safeSrc(src) {
    if (typeof src !== 'string') return '';
    const s = src.trim();
    if (s.length < 2 || s.length > 200 || !s.startsWith('/') || s.startsWith('//')) return '';
    if (s.includes('..') || s.includes('\\') || s.includes('://') || /[\s?#]/.test(s)) return '';
    return s;
  }

  function hideLightbox() {
    const lb = document.getElementById('mom-lightbox');
    if (lb) lb.hidden = true;
  }

  function openLightbox(src) {
    let lb = document.getElementById('mom-lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'mom-lightbox';
      lb.className = 'mom-lightbox';
      lb.hidden = true;
      lb.setAttribute('role', 'dialog');
      lb.setAttribute('aria-modal', 'true');
      lb.setAttribute('aria-label', '查看图片');
      const img = document.createElement('img');
      img.alt = '';
      lb.append(img);
      lb.addEventListener('click', () => { lb.hidden = true; });
      (document.querySelector('.phone') || panel).append(lb);
    }
    lb.querySelector('img').src = src;
    lb.hidden = false;
  }

  function carousel(images) {
    const srcs = (Array.isArray(images) ? images : []).map(safeSrc).filter(Boolean).slice(0, 9);
    if (!srcs.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'mom-carousel';
    const track = document.createElement('div');
    track.className = 'mom-track';
    srcs.forEach((src) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mom-slide';
      btn.setAttribute('aria-label', '查看图片');
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      btn.append(img);
      btn.addEventListener('click', () => openLightbox(src));
      track.append(btn);
    });
    wrap.append(track);
    if (srcs.length > 1) {
      const dots = document.createElement('div');
      dots.className = 'mom-dots';
      srcs.forEach((_, i) => {
        const dot = document.createElement('i');
        if (i === 0) dot.className = 'on';
        dots.append(dot);
      });
      track.addEventListener('scroll', () => {
        const w = track.clientWidth || 1;
        const i = Math.round(track.scrollLeft / w);
        [...dots.children].forEach((dot, n) => dot.classList.toggle('on', n === i));
      }, { passive: true });
      wrap.append(dots);
    }
    return wrap;
  }

  function renderComments(box, comments) {
    const compose = box.querySelector('.mom-compose');
    box.querySelectorAll('.mom-citem, .mom-reply').forEach((n) => n.remove());
    const frag = document.createDocumentFragment();
    for (const c of comments || []) {
      const row = document.createElement('p');
      row.className = 'mom-citem';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = '我';
      row.append(who, document.createTextNode(c.text));
      frag.appendChild(row);
      if (c.reply && c.reply.text) {
        const r = document.createElement('p');
        r.className = 'mom-reply';
        const w2 = document.createElement('span');
        w2.className = 'who';
        w2.textContent = identity.name || '';
        r.append(w2, document.createTextNode(c.reply.text));
        frag.appendChild(r);
      }
    }
    box.insertBefore(frag, compose || null);
  }

  function card(post) {
    const el = document.createElement('article');
    el.className = 'mom-card';
    el.dataset.id = post.id;

    const top = document.createElement('div');
    top.className = 'mom-card-top';
    top.append(avatarNode());
    const who = document.createElement('div');
    who.className = 'mom-who';
    const name = document.createElement('p');
    name.className = 'mom-name';
    name.textContent = identity.name;
    const date = document.createElement('p');
    date.className = 'mom-date';
    date.textContent = fmt(post.publishedAt);
    who.append(name, date);
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'mom-more-btn';
    moreBtn.setAttribute('aria-label', '更多');
    moreBtn.textContent = '···';
    top.append(who, moreBtn);

    const photos = carousel(post.images);

    const icons = document.createElement('div');
    icons.className = 'mom-icons';
    const likeBtn = iconBtn('heart', '赞');
    if (post.liked) likeBtn.classList.add('on');
    const cmtBtn = iconBtn('comment', '评论');
    const shareBtn = iconBtn('share', '分享');
    const saveBtn = iconBtn('bookmark', '收藏');
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    icons.append(likeBtn, cmtBtn, shareBtn, spacer, saveBtn);

    const likes = document.createElement('p');
    likes.className = 'mom-likes';
    const paintLikes = () => {
      likes.hidden = !post.likeCount;
      likes.textContent = post.likeCount ? `${post.likeCount} 次赞` : '';
    };
    paintLikes();

    const caption = document.createElement('p');
    caption.className = 'mom-caption';
    const capName = document.createElement('b');
    capName.textContent = identity.name;
    caption.append(capName, document.createTextNode(post.ko || ''));

    const thread = document.createElement('div');
    thread.className = 'mom-thread';
    thread.hidden = true;
    const compose = document.createElement('div');
    compose.className = 'mom-compose';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = '添加评论…';
    const send = document.createElement('button');
    send.type = 'button';
    send.textContent = '发布';
    compose.append(input, send);
    thread.append(compose);
    renderComments(thread, post.comments);

    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'mom-view';
    const paintView = () => {
      const n = post.commentCount || 0;
      view.hidden = !n || !thread.hidden;
      view.textContent = `查看全部 ${n} 条评论`;
    };
    paintView();

    function showThread() {
      thread.hidden = false;
      view.hidden = true;
      input.focus();
    }
    view.addEventListener('click', showThread);
    cmtBtn.addEventListener('click', showThread);
    moreBtn.addEventListener('click', showThread);

    likeBtn.addEventListener('click', async () => {
      likeBtn.disabled = true;
      try {
        const r = await fetch(withChar(`/api/moments/${encodeURIComponent(post.id)}/like`), { method: 'POST' });
        if (!r.ok) throw new Error();
        const d = await r.json();
        post.liked = d.liked;
        post.likeCount = d.likeCount;
        likeBtn.classList.toggle('on', d.liked);
        paintLikes();
      } catch (_) { toast('点赞失败'); }
      likeBtn.disabled = false;
    });
    shareBtn.addEventListener('click', async () => {
      const url = location.href;
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(url);
        toast('链接已复制');
      } catch (_) { toast('没能复制'); }
    });
    saveBtn.addEventListener('click', () => {
      const on = saveBtn.classList.toggle('on');
      saveBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    send.addEventListener('click', async () => {
      const v = input.value.trim();
      if (!v) return;
      send.disabled = true;
      try {
        const r = await fetch(withChar(`/api/moments/${encodeURIComponent(post.id)}/comments`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: v }),
        });
        if (!r.ok) throw new Error();
        const d = await r.json();
        post.comments = [...(post.comments || []), d.comment];
        post.commentCount = post.comments.length;
        renderComments(thread, post.comments);
        input.value = '';
        showThread();
        paintView();
        if (!d.comment.reply) {
          setTimeout(async () => {
            try {
              const rr = await fetch(withChar(`/api/moments/${encodeURIComponent(post.id)}/comments`));
              if (!rr.ok) return;
              const dd = await rr.json();
              post.comments = dd.comments || [];
              renderComments(thread, post.comments);
            } catch (_) { /* ignore */ }
          }, 2500);
        }
      } catch (_) { toast('评论失败'); }
      send.disabled = false;
    });

    el.append(top);
    if (photos) el.append(photos);
    el.append(icons, likes, caption);
    if (post.zh) {
      const zh = document.createElement('p');
      zh.className = 'mom-zh';
      zh.textContent = post.zh;
      el.append(zh);
    }
    el.append(view, thread);
    return el;
  }

  function render(posts) {
    feed.innerHTML = '';
    empty.hidden = posts.length > 0;
    for (const p of posts) feed.appendChild(card(p));
  }

  async function open(opts) {
    const asTab = Boolean(opts && opts.asTab);
    panel.classList.toggle('tab-mode', asTab);
    const menu = document.getElementById('menu');
    if (menu) menu.hidden = true;
    const ps = document.getElementById('profile-sheet');
    if (ps) ps.hidden = true;
    panel.hidden = false;
    feed.innerHTML = '';
    try {
      await loadIdentity();
      const r = await fetch(withChar('/api/moments'));
      if (r.status === 401) { location.href = '/login'; return; }
      if (r.status === 404) { empty.hidden = false; return; }
      const d = await r.json();
      render(d.posts || []);
    } catch (_) { toast('加载失败'); }
  }
  function close() {
    hideLightbox();
    panel.hidden = true;
    panel.classList.remove('tab-mode');
  }
  window.Moments = { open, close, isOpen: () => !panel.hidden };

  ['moments-open-menu', 'moments-open-profile'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', open);
  });
  document.getElementById('mom-back').addEventListener('click', () => {
    if (panel.classList.contains('tab-mode')) {
      document.dispatchEvent(new CustomEvent('idol-tab', { detail: { tab: 'chat' } }));
    } else close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    const lb = document.getElementById('mom-lightbox');
    if (lb && !lb.hidden) { lb.hidden = true; return; }
    if (panel.classList.contains('tab-mode')) document.dispatchEvent(new CustomEvent('idol-tab', { detail: { tab: 'chat' } }));
    else close();
  });
})();
