/* 朋友圈 Moments panel. Uses withChar() from app.js. */
(function () {
  const panel = document.getElementById('mom-panel');
  if (!panel) return;
  const feed = document.getElementById('mom-feed');
  const empty = document.getElementById('mom-empty');
  const toast = (msg) => {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
  };
  const fmt = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = Date.now();
    const diff = Math.max(0, now - d.getTime());
    if (diff < 3600e3) return `${Math.max(1, Math.floor(diff / 60e3))}分钟前`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}小时前`;
    if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)}天前`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  };
  const avatarNode = () => {
    const a = document.createElement('span');
    a.className = 'avatar sm';
    a.setAttribute('aria-hidden', 'true');
    const tpl = document.getElementById('puppy-svg');
    if (tpl && tpl.content) a.append(tpl.content.cloneNode(true));
    return a;
  };

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
      row.append(who, document.createTextNode('：' + c.text));
      frag.appendChild(row);
      if (c.reply && c.reply.text) {
        const r = document.createElement('div');
        r.className = 'mom-reply';
        const w2 = document.createElement('span');
        w2.className = 'who';
        w2.textContent = window.IdolChat && window.IdolChat.shownName ? window.IdolChat.shownName() : '백현';
        w2.setAttribute('data-char-label', 'name');
        r.append(w2, document.createTextNode('：' + c.reply.text));
        frag.appendChild(r);
      }
    }
    box.insertBefore(frag, compose || null);
  }

  function safeSrc(src) {
    if (typeof src !== 'string') return '';
    const s = src.trim();
    if (s.length < 2 || s.length > 200) return '';
    if (!s.startsWith('/') || s.startsWith('//')) return '';
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

  function photosBlock(images) {
    const srcs = (Array.isArray(images) ? images : []).map(safeSrc).filter(Boolean).slice(0, 9);
    if (!srcs.length) return null;
    const n = srcs.length;
    const block = document.createElement('div');
    block.className = 'mom-photos ' + (n === 1 ? 'single' : (n === 2 || n === 4 ? 'cols-2' : 'cols-3'));
    for (const src of srcs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mom-photo';
      btn.setAttribute('aria-label', '查看图片');
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      btn.append(img);
      btn.addEventListener('click', () => openLightbox(src));
      block.append(btn);
    }
    return block;
  }

  function card(post) {
    const el = document.createElement('article');
    el.className = 'mom-card';
    el.dataset.id = post.id;

    const top = document.createElement('div');
    top.className = 'mom-card-top';
    top.appendChild(avatarNode());
    const body = document.createElement('div');
    body.className = 'mom-card-body';
    const name = document.createElement('p');
    name.className = 'mom-name';
    name.textContent = window.IdolChat && window.IdolChat.shownName ? window.IdolChat.shownName() : '백현';
    name.setAttribute('data-char-label', 'name');
    const text = document.createElement('p');
    text.className = 'mom-text';
    text.textContent = post.ko;
    body.append(name, text);
    if (post.zh) {
      const zh = document.createElement('p');
      zh.className = 'mom-zh';
      zh.textContent = post.zh;
      body.append(zh);
    }
    const photos = photosBlock(post.images);
    if (photos) body.append(photos);
    const time = document.createElement('p');
    time.className = 'mom-time';
    time.textContent = fmt(post.publishedAt);
    body.append(time);
    top.append(body);

    const actions = document.createElement('div');
    actions.className = 'mom-actions';
    const likeBtn = document.createElement('button');
    likeBtn.type = 'button';
    likeBtn.className = 'mom-btn' + (post.liked ? ' liked' : '');
    likeBtn.textContent = post.liked ? '♥ 已赞' : '♡ 赞';
    likeBtn.addEventListener('click', async () => {
      likeBtn.disabled = true;
      try {
        const r = await fetch(withChar(`/api/moments/${encodeURIComponent(post.id)}/like`), { method: 'POST' });
        if (!r.ok) throw new Error();
        const d = await r.json();
        post.liked = d.liked;
        likeBtn.className = 'mom-btn' + (d.liked ? ' liked' : '');
        likeBtn.textContent = d.liked ? '♥ 已赞' : '♡ 赞';
      } catch (_) { toast('点赞失败'); }
      likeBtn.disabled = false;
    });
    const cmtBtn = document.createElement('button');
    cmtBtn.type = 'button';
    cmtBtn.className = 'mom-btn';
    cmtBtn.textContent = `💬 评论${post.commentCount ? ' ' + post.commentCount : ''}`;
    const cbox = document.createElement('div');
    cbox.className = 'mom-comments';
    cbox.hidden = true;
    const compose = document.createElement('div');
    compose.className = 'mom-compose';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = '写评论…';
    const send = document.createElement('button');
    send.type = 'button';
    send.textContent = '发送';
    cbox.append(compose);
    compose.append(input, send);
    renderComments(cbox, post.comments);
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
        cmtBtn.textContent = `💬 评论 ${post.commentCount}`;
        renderComments(cbox, post.comments);
        input.value = '';
        cbox.hidden = false;
        if (!d.comment.reply) {
          setTimeout(async () => {
            try {
              const rr = await fetch(withChar(`/api/moments/${encodeURIComponent(post.id)}/comments`));
              if (!rr.ok) return;
              const dd = await rr.json();
              post.comments = dd.comments || [];
              renderComments(cbox, post.comments);
            } catch (_) { /* ignore */ }
          }, 2500);
        }
      } catch (_) { toast('评论失败'); }
      send.disabled = false;
    });
    cmtBtn.addEventListener('click', () => { cbox.hidden = !cbox.hidden; });
    actions.append(likeBtn, cmtBtn);
    el.append(top, actions, cbox);
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
      const r = await fetch(withChar('/api/moments'));
      if (r.status === 401) { location.href = '/login'; return; }
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
    if (lb && !lb.hidden) {
      lb.hidden = true;
      return;
    }
    if (panel.classList.contains('tab-mode')) document.dispatchEvent(new CustomEvent('idol-tab', { detail: { tab: 'chat' } }));
    else close();
  });
})();
