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
        w2.textContent = '백현';
        r.append(w2, document.createTextNode('：' + c.reply.text));
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
    top.appendChild(avatarNode());
    const body = document.createElement('div');
    body.className = 'mom-card-body';
    const name = document.createElement('p');
    name.className = 'mom-name';
    name.textContent = '백현';
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

  async function open() {
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
  function close() { panel.hidden = true; }

  ['moments-open-menu', 'moments-open-profile'].forEach((id) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', open);
  });
  document.getElementById('mom-back').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });
})();
