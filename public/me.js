/* 我的. Own screen, own requests. Host: #screen-me #me-root #tab-bar #toast, window.IdolChat. */
(function () {
  const screen = document.getElementById('screen-me');
  const root = document.getElementById('me-root');
  if (!screen || !root) return;

  const state = {
    me: null,
    settings: { playback: 'tap', translation: 'collapsed', textSize: 'm', nickname: '' },
    characters: [],
    profiles: {},
    about: { version: '', notice: 'AI 模拟角色，非本人' },
  };
  const stack = [];
  let viewGen = 0;

  const main = document.createElement('div');
  main.className = 'me-page';
  const sub = document.createElement('div');
  sub.className = 'me-page me-page-sub';
  sub.hidden = true;
  const dialog = document.createElement('div');
  dialog.className = 'me-dialog';
  dialog.hidden = true;
  root.append(main, sub, dialog);

  const toast = (msg) => {
    const node = document.getElementById('toast');
    if (!node) return;
    node.textContent = msg;
    node.classList.add('show');
    setTimeout(() => node.classList.remove('show'), 1800);
  };

  async function api(url, opt = {}) {
    const response = await fetch(url, {
      ...opt,
      headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) },
    });
    if (response.status === 401) {
      location.href = '/login';
      throw new Error('auth');
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(body.error || 'failed');
      err.status = response.status;
      throw err;
    }
    return body;
  }

  function syncBar() {
    const bar = document.getElementById('tab-bar');
    if (!bar || screen.hidden) return;
    bar.hidden = stack.length > 0;
  }

  function showSub() {
    const gen = ++viewGen;
    sub.hidden = false;
    sub.replaceChildren();
    sub.scrollTop = 0;
    Promise.resolve(stack[stack.length - 1](sub, gen)).catch(() => toast('没有打开'));
    syncBar();
  }

  function push(render) {
    stack.push(render);
    showSub();
  }

  function pop() {
    stack.pop();
    if (!stack.length) {
      sub.hidden = true;
      sub.replaceChildren();
      syncBar();
      return;
    }
    showSub();
  }

  function ask(opts) {
    return new Promise((resolve) => {
      dialog.hidden = false;
      dialog.replaceChildren();
      const form = document.createElement('form');
      const title = document.createElement('h2');
      title.textContent = opts.title || '';
      const body = document.createElement('p');
      body.textContent = opts.body || '';
      form.append(title, body);
      let input = null;
      if (opts.input) {
        input = document.createElement('input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.placeholder = opts.placeholder || '';
        input.setAttribute('aria-label', opts.placeholder || opts.title || '');
        form.append(input);
      }
      const actions = document.createElement('div');
      actions.className = 'me-dialog-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = opts.cancel || '取消';
      const confirm = document.createElement('button');
      confirm.type = 'submit';
      confirm.textContent = opts.confirm || '确定';
      if (opts.danger) confirm.className = 'is-danger';
      if (!opts.confirm) confirm.hidden = true;
      actions.append(cancel, confirm);
      form.append(actions);
      const finish = (value) => {
        dialog.hidden = true;
        dialog.replaceChildren();
        resolve(value);
      };
      cancel.addEventListener('click', () => finish(null));
      dialog.addEventListener('click', function onBackdrop(event) {
        if (event.target !== dialog) return;
        dialog.removeEventListener('click', onBackdrop);
        finish(null);
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = input ? input.value : true;
        if (opts.match != null && value !== opts.match) return;
        finish(value);
      });
      if (input && opts.match != null) {
        confirm.disabled = true;
        input.addEventListener('input', () => { confirm.disabled = input.value !== opts.match; });
      }
      dialog.append(form);
      (input || cancel).focus();
    });
  }

  function bar(title) {
    const header = document.createElement('header');
    header.className = 'me-bar';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'me-back';
    back.setAttribute('aria-label', '返回');
    back.textContent = '‹';
    back.addEventListener('click', pop);
    const heading = document.createElement('h1');
    heading.textContent = title;
    header.append(back, heading, document.createElement('span'));
    return header;
  }

  function group(label, rows) {
    const wrap = document.createDocumentFragment();
    if (label) {
      const kicker = document.createElement('p');
      kicker.className = 'me-kicker';
      kicker.textContent = label;
      wrap.append(kicker);
    }
    const box = document.createElement('div');
    box.className = 'me-group';
    rows.forEach((row) => box.append(row));
    wrap.append(box);
    return wrap;
  }

  function line(label, value, onClick, extra) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'me-line';
    const span = document.createElement('span');
    span.textContent = label;
    if (extra) span.append(extra);
    button.append(span);
    if (value) {
      const strong = document.createElement('b');
      strong.textContent = value;
      button.append(strong);
    }
    const chev = document.createElement('i');
    chev.setAttribute('aria-hidden', 'true');
    chev.textContent = '›';
    button.append(chev);
    button.addEventListener('click', onClick);
    return button;
  }

  function face() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.innerHTML = '<rect width="64" height="64" fill="#efece8"/><circle cx="32" cy="26" r="10" fill="none" stroke="#1c1c1c" stroke-width="1.4"/><path d="M16 50c2.4-8 8-12 16-12s13.6 4 16 12" fill="none" stroke="#1c1c1c" stroke-width="1.4" stroke-linecap="round"/>';
    return svg;
  }

  function jpegBytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function fileToAvatarJpeg(file) {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = Math.floor((bitmap.width - side) / 2);
    const sy = Math.floor((bitmap.height - side) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    canvas.getContext('2d').drawImage(bitmap, sx, sy, side, side, 0, 0, 256, 256);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) throw new Error('encode failed');
    return jpegBytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }

  function publish(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function applySettings(next) {
    state.settings = { ...state.settings, ...next };
    if (window.IdolChat && window.IdolChat.applyPrefs) window.IdolChat.applyPrefs(state.settings);
  }

  async function saveSettings(patch) {
    const saved = await api('/api/me/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    applySettings(saved.settings || patch);
    return saved.settings;
  }

  function selectedCharacter() {
    return new URLSearchParams(location.search).get('c')
      || localStorage.getItem('idol_selected_character')
      || 'baekhyun';
  }

  function paintMain() {
    main.replaceChildren();
    const top = document.createElement('header');
    top.className = 'me-top';
    const title = document.createElement('h1');
    title.id = 'me-title';
    title.textContent = '我的';
    top.append(title);

    const profile = document.createElement('div');
    profile.className = 'me-profile';
    const avatarBtn = document.createElement('button');
    avatarBtn.type = 'button';
    avatarBtn.className = 'me-avatar';
    avatarBtn.setAttribute('data-user-avatar', '');
    avatarBtn.setAttribute('aria-label', '更换头像');
    avatarBtn.append(face());
    const edit = document.createElement('span');
    edit.className = 'me-avatar-edit';
    edit.textContent = '更换';
    avatarBtn.append(edit);
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/jpeg,image/png,image/webp,image/*';
    file.hidden = true;
    avatarBtn.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const picked = file.files && file.files[0];
      file.value = '';
      if (!picked) return;
      try {
        const image = await fileToAvatarJpeg(picked);
        await api('/api/me/avatar', { method: 'PUT', body: JSON.stringify({ image }) });
        publish('idol-avatar', { hasAvatar: true });
        toast('头像已更新');
      } catch (_) { toast('头像没换上'); }
    });

    const ident = document.createElement('div');
    const nick = document.createElement('button');
    nick.type = 'button';
    nick.className = 'me-nick';
    const nickname = (state.settings.nickname || '').trim();
    const username = state.me && state.me.user ? state.me.user.username : '';
    nick.textContent = nickname || username || '设置昵称';
    nick.addEventListener('click', () => editNick(ident, nick));
    const handle = document.createElement('p');
    handle.className = 'me-handle';
    handle.textContent = username ? `@${username}` : '';
    ident.append(nick, handle);
    if (state.me && state.me.hasAvatar) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'me-clear-avatar';
      clear.textContent = '恢复默认头像';
      clear.addEventListener('click', async () => {
        try {
          await api('/api/me/avatar', { method: 'DELETE' });
          state.me.hasAvatar = false;
          publish('idol-avatar', { hasAvatar: false });
          paintMain();
        } catch (_) { toast('没能恢复默认头像'); }
      });
      ident.append(clear);
    }
    profile.append(avatarBtn, ident, file);

    const idolRows = state.characters.map((ch) => {
      const prof = state.profiles[ch.id] || {};
      const remark = (prof.characterNickname || '').trim();
      const extra = document.createElement('span');
      extra.className = 'me-idol';
      const img = document.createElement('img');
      img.alt = '';
      img.src = ch.avatar;
      const text = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = remark || ch.nameZh || ch.displayName || ch.name;
      const small = document.createElement('small');
      small.textContent = ch.group || ch.name || '';
      text.append(name, small);
      extra.append(img, text);
      const row = line('', '', () => push((host, gen) => renderIdol(host, ch, gen)), extra);
      row.querySelector('span').replaceChildren(extra);
      return row;
    });

    const settingsRow = line('聊天设置', playbackLabel(), () => push(renderSettings));
    const passwordRow = line('修改密码', '', () => push(renderPassword));
    const logoutRow = line('退出登录', '', () => {
      if (window.IdolChat && window.IdolChat.logout) window.IdolChat.logout();
    });
    const deleteRow = line('删除账号', '', () => push(renderDelete));
    const rechargeRow = line('充值（演示）', '', () => {
      const c = selectedCharacter();
      location.href = `/shell/recharge.html?c=${encodeURIComponent(c)}&from=chat`;
    });
    const notice = document.createElement('p');
    notice.className = 'me-static';
    notice.textContent = state.about.notice || 'AI 模拟角色，非本人';
    const creditsRow = line('图片来源', '', () => push(renderCredits));
    const versionRow = line('版本', state.about.version || '', () => {});
    versionRow.querySelector('i').remove();
    versionRow.style.cursor = 'default';
    const feedbackRow = line('反馈', '', () => push(renderFeedback));

    main.append(
      top,
      profile,
      group('我的爱豆', idolRows.length ? idolRows : [line('还没有可聊天的爱豆', '', () => {})]),
      group('聊天', [settingsRow]),
      group('账号', [passwordRow, logoutRow, deleteRow]),
      group('会员', [rechargeRow]),
      group('关于', [notice, creditsRow, versionRow, feedbackRow]),
    );
    if (window.IdolChat && window.IdolChat.applyUserAvatar) window.IdolChat.applyUserAvatar();
  }

  function playbackLabel() {
    return state.settings.playback === 'auto' ? '自动播放' : '点击播放';
  }

  function editNick(ident, nick) {
    const input = document.createElement('input');
    input.className = 'me-nick-input';
    input.maxLength = 20;
    input.value = state.settings.nickname || '';
    input.setAttribute('aria-label', '昵称');
    nick.replaceWith(input);
    input.focus();
    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const nickname = input.value.trim().slice(0, 20);
      try {
        await saveSettings({ nickname });
        paintMain();
      } catch (_) {
        toast('昵称没保存上');
        done = false;
        input.focus();
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
      if (event.key === 'Escape') { done = true; paintMain(); }
    });
    input.addEventListener('blur', commit);
  }

  function seg(options, current, onPick) {
    const box = document.createElement('div');
    box.className = options.length === 2 ? 'me-seg two' : 'me-seg';
    box.setAttribute('role', 'radiogroup');
    options.forEach((opt) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', opt.id === current ? 'true' : 'false');
      button.textContent = opt.label;
      button.addEventListener('click', () => onPick(opt.id));
      box.append(button);
    });
    return box;
  }

  function field(label, control) {
    const wrap = document.createElement('label');
    wrap.className = 'me-field';
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(span, control);
    return wrap;
  }

  async function renderIdol(host, ch, gen) {
    host.replaceChildren();
    host.append(bar(ch.nameZh || ch.displayName || ch.name));
    const block = document.createElement('div');
    block.className = 'me-block';
    block.textContent = '加载中…';
    host.append(block);
    let prof = {};
    let rel = null;
    try {
      const [p, r] = await Promise.all([
        api(`/api/profile?characterId=${encodeURIComponent(ch.id)}`),
        api(`/api/relationship?characterId=${encodeURIComponent(ch.id)}`),
      ]);
      prof = (p && p.profile) || {};
      rel = r && r.relationship;
    } catch (_) {
      if (gen != null && gen !== viewGen) return;
      block.textContent = '没有加载出来';
      return;
    }
    if (gen != null && gen !== viewGen) return;
    block.replaceChildren();
    const remark = document.createElement('input');
    remark.maxLength = 20;
    remark.value = prof.characterNickname || '';
    remark.placeholder = ch.displayName || ch.name || '';
    const call = document.createElement('input');
    call.maxLength = 20;
    call.value = prof.callName || '';
    call.placeholder = '他怎么称呼你';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'me-submit';
    save.textContent = '保存';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const saved = await api(`/api/profile?characterId=${encodeURIComponent(ch.id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            characterNickname: remark.value.trim(),
            callName: call.value.trim(),
          }),
        });
        state.profiles[ch.id] = (saved && saved.profile) || state.profiles[ch.id];
        publish('idol-profile', {
          characterId: ch.id,
          characterNickname: remark.value.trim(),
        });
        toast('已保存');
        paintMain();
      } catch (_) { toast('没保存上'); }
      finally { save.disabled = false; }
    });
    const tier = rel && rel.tier ? rel.tier.name : '—';
    const score = rel && Number.isFinite(rel.score) ? String(rel.score) : '0';
    const days = rel && Number.isFinite(rel.daysKnown) ? `${rel.daysKnown} 天` : '0 天';
    block.append(
      field('备注名', remark),
      field('他怎么叫你', call),
      save,
      readRow('关系', tier),
      readRow('亲密度', score),
      readRow('认识天数', days),
    );
    host.append(group('', [line('他记得的事', '', () => push((page, nextGen) => renderMemory(page, ch, nextGen)))]));
  }

  function readRow(label, value) {
    const row = document.createElement('div');
    row.className = 'me-read';
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('b');
    strong.textContent = value;
    row.append(span, strong);
    return row;
  }

  function fmt(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  async function renderMemory(host, ch, gen) {
    host.replaceChildren();
    host.append(bar('他记得的事'));
    const block = document.createElement('div');
    block.className = 'me-block';
    const tip = document.createElement('p');
    tip.className = 'me-note';
    tip.textContent = '这些是他从聊天里记住的事。删掉的不会再被记回来。';
    block.append(tip);
    host.append(block);
    let data = { cards: [] };
    try {
      data = await api(`/api/memory?characterId=${encodeURIComponent(ch.id)}`);
    } catch (_) {
      if (gen != null && gen !== viewGen) return;
      const err = document.createElement('p');
      err.className = 'me-note';
      err.textContent = '没有加载出来';
      block.append(err);
      return;
    }
    if (gen != null && gen !== viewGen) return;
    const cards = data.cards || [];
    if (!cards.length) {
      const empty = document.createElement('p');
      empty.className = 'me-note';
      empty.textContent = '还没有记住什么。多聊聊之后，这里会出现。';
      block.append(empty);
      return;
    }
    cards.forEach((card) => {
      const item = document.createElement('article');
      item.className = 'me-card';
      const text = document.createElement('p');
      text.textContent = card.text;
      const time = document.createElement('time');
      time.textContent = fmt(card.updatedAt || card.createdAt);
      const actions = document.createElement('div');
      actions.className = 'me-card-actions';
      const view = document.createElement('button');
      view.type = 'button';
      view.textContent = '查看';
      view.addEventListener('click', () => {
        ask({ title: '他记得的事', body: card.text, cancel: '关闭' });
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'is-delete';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        const ok = await ask({
          title: '删除这条记忆',
          body: '删除后，他不会再记起这件事。',
          confirm: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await api(`/api/memory/${encodeURIComponent(card.id)}?characterId=${encodeURIComponent(ch.id)}`, { method: 'DELETE' });
          toast('已删除');
          renderMemory(host, ch, gen);
        } catch (_) { toast('删除失败'); }
      });
      actions.append(view, del);
      item.append(text, time, actions);
      block.append(item);
    });
  }

  function renderSettings(host) {
    host.replaceChildren();
    host.append(bar('聊天设置'));
    const block = document.createElement('div');
    block.className = 'me-block';
    const playback = seg([
      { id: 'tap', label: '点击播放' },
      { id: 'auto', label: '自动播放' },
    ], state.settings.playback, async (id) => {
      try { await saveSettings({ playback: id }); renderSettings(host); }
      catch (_) { toast('没保存上'); }
    });
    const translation = seg([
      { id: 'collapsed', label: '默认收起' },
      { id: 'expanded', label: '默认展开' },
    ], state.settings.translation, async (id) => {
      try { await saveSettings({ translation: id }); renderSettings(host); }
      catch (_) { toast('没保存上'); }
    });
    const size = seg([
      { id: 's', label: 'S' },
      { id: 'm', label: 'M' },
      { id: 'l', label: 'L' },
    ], state.settings.textSize, async (id) => {
      try { await saveSettings({ textSize: id }); renderSettings(host); }
      catch (_) { toast('没保存上'); }
    });
    block.append(
      field('语音播放', playback),
      field('翻译', translation),
      field('文字大小', size),
    );
    const note = document.createElement('p');
    note.className = 'me-note';
    note.textContent = '点击播放时，点气泡右上角的喇叭才会出声。自动播放会播刚刚那一条。文字大小和翻译的默认状态会立刻用在聊天里。';
    block.append(note);
    host.append(block);
    const rows = state.characters.map((ch) => line(
      `清除和${ch.nameZh || ch.name}的记录`,
      '',
      () => clearHistory(ch),
    ));
    host.append(group('聊天记录', rows));
  }

  async function clearHistory(ch) {
    const ok = await ask({
      title: '清除聊天记录',
      body: `只清除和${ch.nameZh || ch.name}的聊天记录。备注、关系和记忆会保留。`,
      confirm: '清除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/history?characterId=${encodeURIComponent(ch.id)}`, { method: 'DELETE' });
      publish('idol-history-cleared', { characterId: ch.id });
      toast('聊天记录已清除');
    } catch (_) { toast('没有清除'); }
  }

  function renderPassword(host) {
    host.replaceChildren();
    host.append(bar('修改密码'));
    const block = document.createElement('div');
    block.className = 'me-block';
    const oldPassword = document.createElement('input');
    oldPassword.type = 'password';
    oldPassword.autocomplete = 'current-password';
    oldPassword.minLength = 8;
    const newPassword = document.createElement('input');
    newPassword.type = 'password';
    newPassword.autocomplete = 'new-password';
    newPassword.minLength = 8;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'me-submit';
    save.textContent = '保存';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api('/api/me/password', {
          method: 'PUT',
          body: JSON.stringify({ oldPassword: oldPassword.value, newPassword: newPassword.value }),
        });
        oldPassword.value = '';
        newPassword.value = '';
        toast('密码已更新');
      } catch (err) {
        toast(err.status === 401 ? '原密码不正确' : '请检查密码，至少 8 位');
      } finally { save.disabled = false; }
    });
    block.append(field('原密码', oldPassword), field('新密码', newPassword), save);
    host.append(block);
  }

  function renderDelete(host) {
    host.replaceChildren();
    host.append(bar('删除账号'));
    const block = document.createElement('div');
    block.className = 'me-block';
    const username = state.me && state.me.user ? state.me.user.username : '';
    const note = document.createElement('p');
    note.className = 'me-note';
    note.textContent = `会删除这个账号的聊天、记忆、关系和头像。请输入 ${username} 确认。`;
    const input = document.createElement('input');
    input.autocomplete = 'off';
    input.placeholder = username;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'me-danger';
    button.textContent = '删除账号';
    button.disabled = true;
    input.addEventListener('input', () => { button.disabled = input.value !== username; });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api('/api/me', { method: 'DELETE', body: JSON.stringify({ confirm: input.value }) });
        if (window.IdolChat && window.IdolChat.logout) window.IdolChat.logout();
        else location.href = '/login';
      } catch (_) {
        toast('没有删除');
        button.disabled = input.value !== username;
      }
    });
    block.append(note, field('输入用户名', input), button);
    host.append(block);
  }

  async function renderCredits(host, gen) {
    host.replaceChildren();
    host.append(bar('图片来源'));
    const block = document.createElement('div');
    block.className = 'me-block';
    block.textContent = '加载中…';
    host.append(block);
    try {
      const data = await api('/api/credits');
      if (gen != null && gen !== viewGen) return;
      block.replaceChildren();
      (data.credits || []).forEach((entry) => {
        const item = document.createElement('article');
        item.className = 'me-credit';
        const heading = document.createElement('h2');
        heading.textContent = `${entry.name} · ${entry.file}`;
        const pre = document.createElement('pre');
        pre.textContent = entry.text;
        item.append(heading, pre);
        block.append(item);
      });
      if (!(data.credits || []).length) block.textContent = '没有署名文件';
    } catch (_) { block.textContent = '没有加载出来'; }
  }

  function renderFeedback(host) {
    host.replaceChildren();
    host.append(bar('反馈'));
    const block = document.createElement('div');
    block.className = 'me-block';
    const area = document.createElement('textarea');
    area.maxLength = 1000;
    area.placeholder = '想说的话';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'me-submit';
    save.textContent = '发送';
    save.addEventListener('click', async () => {
      const text = area.value.trim();
      if (!text) { toast('先写一点'); return; }
      save.disabled = true;
      try {
        await api('/api/feedback', { method: 'POST', body: JSON.stringify({ text }) });
        area.value = '';
        toast('已收到');
      } catch (_) { toast('没送出去'); }
      finally { save.disabled = false; }
    });
    block.append(field('内容', area), save);
    host.append(block);
  }

  async function refresh() {
    try {
      const [me, settings, chars, about] = await Promise.all([
        api('/api/me'),
        api('/api/me/settings'),
        api('/api/characters'),
        api('/api/about'),
      ]);
      state.me = me;
      state.settings = settings.settings || state.settings;
      state.characters = (chars.characters || []).filter((ch) => ch.available !== false);
      state.about = about || state.about;
      const pairs = await Promise.all(state.characters.map(async (ch) => {
        const prof = await api(`/api/profile?characterId=${encodeURIComponent(ch.id)}`);
        return [ch.id, (prof && prof.profile) || {}];
      }));
      state.profiles = Object.fromEntries(pairs);
      applySettings(state.settings);
    } catch (_) { /* login redirect or toast on next action */ }
    paintMain();
    if (stack.length) showSub();
    else syncBar();
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || screen.hidden) return;
    if (!dialog.hidden) {
      dialog.hidden = true;
      dialog.replaceChildren();
      return;
    }
    if (stack.length) pop();
  });

  window.Me = { open: refresh, syncBar };
})();
