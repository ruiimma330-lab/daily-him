/* 我的. Own files and tokens. Host: #screen-me #me-root #ai-notice #toast, window.IdolChat. */
(function () {
  const screen = document.getElementById('screen-me');
  const root = document.getElementById('me-root');
  if (!screen || !root) return;

  const state = {
    me: null,
    starlight: null,
    settings: blankSettings(),
    characters: [],
    profiles: {},
    rel: {},
    about: { version: '' },
  };
  const stack = [];
  let viewGen = 0;

  const main = document.createElement('div');
  main.className = 'me-page';
  const sub = document.createElement('div');
  sub.className = 'me-page me-sub';
  sub.hidden = true;
  const dialog = document.createElement('div');
  dialog.className = 'me-dialog';
  dialog.hidden = true;
  root.append(main, sub, dialog);

  function blankSettings() {
    return { playback: 'tap', translation: 'collapsed', nickname: '', aiNoticeSeen: false };
  }

  function writeLocal(next) {
    state.settings = { ...state.settings, ...next };
    const id = state.me && state.me.user && state.me.user.id;
    if (id && window.AccountCache) {
      try { localStorage.setItem(window.AccountCache.prefsKey(id), JSON.stringify(state.settings)); } catch (_) { /* ignore */ }
    }
    if (window.IdolChat && window.IdolChat.applyPrefs) window.IdolChat.applyPrefs(state.settings);
    syncNotice();
  }

  function toast(msg) {
    const node = document.getElementById('toast');
    if (!node) return;
    node.textContent = msg;
    node.classList.add('show');
    setTimeout(() => node.classList.remove('show'), 1800);
  }

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
      paintMain();
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
        input.autocomplete = 'off';
        input.placeholder = opts.placeholder || '';
        input.setAttribute('aria-label', opts.placeholder || opts.title || '');
        form.append(input);
      }
      const actions = document.createElement('div');
      actions.className = 'me-dialog-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '取消';
      const confirm = document.createElement('button');
      confirm.type = 'submit';
      confirm.textContent = opts.confirm || '确定';
      if (opts.danger) confirm.className = 'is-danger';
      actions.append(cancel, confirm);
      form.append(actions);
      const finish = (value) => {
        dialog.hidden = true;
        dialog.replaceChildren();
        resolve(value);
      };
      cancel.addEventListener('click', () => finish(null));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = input ? input.value.trim() : true;
        if (opts.match != null && value !== opts.match) return;
        finish(value);
      });
      if (input && opts.match != null) {
        confirm.disabled = true;
        input.addEventListener('input', () => { confirm.disabled = input.value.trim() !== opts.match; });
      }
      dialog.append(form);
      (input || confirm).focus();
    });
  }

  async function twoStep(opts) {
    const first = await ask({ title: opts.title, body: opts.body, confirm: '继续' });
    if (!first) return false;
    const second = await ask({
      title: '再次确认',
      body: opts.again,
      confirm: opts.confirm || '确认',
      danger: true,
      input: opts.input,
      placeholder: opts.placeholder,
      match: opts.match,
    });
    return Boolean(second);
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

  function line(label, value, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'me-line';
    const span = document.createElement('span');
    span.textContent = label;
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
    if (onClick) button.addEventListener('click', onClick);
    else { button.style.cursor = 'default'; chev.remove(); }
    return button;
  }

  function kicker(text) {
    const node = document.createElement('p');
    node.className = 'me-kicker';
    node.textContent = text;
    return node;
  }

  function group(nodes) {
    const box = document.createElement('div');
    box.className = 'me-group';
    nodes.forEach((node) => box.append(node));
    return box;
  }

  function seg(options, current, onPick) {
    const box = document.createElement('div');
    box.className = 'me-seg';
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

  function face() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<rect width="64" height="64" fill="#efece8"/><circle cx="32" cy="26" r="10" fill="none" stroke="#1c1c1c" stroke-width="1.4"/><path d="M16 50c2.4-8 8-12 16-12s13.6 4 16 12" fill="none" stroke="#1c1c1c" stroke-width="1.4" stroke-linecap="round"/>';
    return svg;
  }

  function jpegBytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  async function fileToAvatarJpeg(file) {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) throw new Error('encode failed');
    return jpegBytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }

  function publish(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

  async function saveSettings(patch) {
    writeLocal(patch);
    try {
      const saved = await api('/api/me/settings', { method: 'PUT', body: JSON.stringify(patch) });
      writeLocal(saved.settings || patch);
    } catch (_) { toast('已记在这台设备上'); }
  }

  function nameOf(ch) {
    const nick = (state.profiles[ch.id] && state.profiles[ch.id].characterNickname || '').trim();
    return nick || ch.nameZh || ch.displayName || ch.name;
  }

  function starlightCard() {
    const card = document.createElement('section');
    card.className = 'me-group me-starlight';
    card.setAttribute('aria-label', '星光');
    const data = state.starlight;
    const balance = data ? `${data.balance ?? 0} 星光` : '余额暂不可用';
    const status = data
      ? (data.claimedToday ? `今日已领取 · 连续 ${data.streak || 0} 天` : '今日可领取')
      : '领取状态暂不可用';
    const row = line(balance, status, () => { location.href = '/shell/starlight.html#claim'; });
    row.querySelector('b').className = 'me-label';
    const icon = document.createElement('img');
    icon.src = '/icons/starlight.svg';
    icon.width = 18;
    icon.height = 18;
    icon.alt = '';
    row.querySelector('span').prepend(icon);
    const actions = document.createElement('div');
    actions.className = 'me-line me-card-actions me-starlight-actions';
    [['领取', 'claim'], ['充值', 'recharge'], ['明细', 'ledger']].forEach(([label, anchor]) => {
      const link = document.createElement('a');
      link.href = `/shell/starlight.html#${anchor}`;
      link.textContent = label;
      actions.append(link);
    });
    card.append(row, actions);
    return card;
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
    const avatar = document.createElement('button');
    avatar.type = 'button';
    avatar.className = 'me-avatar';
    avatar.setAttribute('data-user-avatar', '');
    avatar.setAttribute('aria-label', '更换头像');
    avatar.append(face());
    const edit = document.createElement('em');
    edit.textContent = '更换';
    avatar.append(edit);
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;
    avatar.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const picked = file.files && file.files[0];
      file.value = '';
      if (!picked) return;
      try {
        const image = await fileToAvatarJpeg(picked);
        await api('/api/me/avatar', { method: 'PUT', body: JSON.stringify({ image }) });
        if (state.me) state.me.hasAvatar = true;
        publish('idol-avatar', { hasAvatar: true });
        toast('头像已更新');
      } catch (_) { toast('头像没换上'); }
    });
    const ident = document.createElement('div');
    const nick = document.createElement('button');
    nick.type = 'button';
    nick.className = 'me-nick';
    const username = state.me && state.me.user ? state.me.user.username : '';
    nick.textContent = (state.settings.nickname || '').trim() || username || '设置昵称';
    nick.addEventListener('click', () => editNick(nick));
    const handle = document.createElement('p');
    handle.className = 'me-handle';
    handle.textContent = username ? `@${username}` : '';
    ident.append(nick, handle);
    profile.append(avatar, ident, file);

    const idols = document.createElement('div');
    state.characters.forEach((ch) => idols.append(idolCard(ch)));
    if (!state.characters.length) idols.append(group([line('还没有可聊天的爱豆')]));

    const voice = seg([
      { id: 'tap', label: '点了才播' },
      { id: 'auto', label: '自动播放' },
    ], state.settings.playback, (id) => saveSettings({ playback: id }).then(paintMain));
    const translation = seg([
      { id: 'collapsed', label: '默认收起' },
      { id: 'expanded', label: '默认展开' },
    ], state.settings.translation, (id) => saveSettings({ translation: id }).then(paintMain));

    main.append(
      top,
      kicker('个人资料'),
      profile,
      kicker('我的爱豆'),
      idols,
      kicker('星光'),
      starlightCard(),
      kicker('聊天'),
      group([
        labeled('语音', voice),
        labeled('翻译', translation),
      ]),
      kicker('隐私与安全'),
      group([
        line('改密码', '', () => push(renderPassword)),
        line('清空全部聊天记录', '', clearAll),
      ]),
      kicker('账号'),
      group([
        line('退出登录', '', () => { if (window.IdolChat && window.IdolChat.logout) window.IdolChat.logout(); }),
        line('注销账号', '', () => push(renderDelete)),
      ]),
      kicker('关于与合规'),
      group([
        ...(window.DailyPwa && !window.DailyPwa.canShowInstallEntry() ? [] : [line('添加到桌面', '', () => {
          if (window.DailyPwa) window.DailyPwa.install();
          else location.href = '/shell/install.html';
        })]),
        line('隐私政策', '', () => { location.href = '/legal/privacy.html'; }),
        line('用户协议', '', () => { location.href = '/legal/terms.html'; }),
        line('意见反馈 / 举报', '', () => push(renderFeedback)),
      ]),
    );
    const version = document.createElement('p');
    version.className = 'me-version';
    version.textContent = state.about.version ? `版本 ${state.about.version}` : '';
    main.append(version);
    if (window.IdolChat && window.IdolChat.applyUserAvatar) window.IdolChat.applyUserAvatar();
  }

  function labeled(label, control) {
    const wrap = document.createElement('div');
    wrap.className = 'me-block';
    const span = document.createElement('span');
    span.className = 'me-label';
    span.textContent = label;
    wrap.append(span, control);
    return wrap;
  }

  function editNick(nick) {
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
      await saveSettings({ nickname: input.value.trim().slice(0, 20) });
      paintMain();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') { done = true; paintMain(); }
    });
    input.addEventListener('blur', commit);
  }

  function idolCard(ch) {
    const card = document.createElement('article');
    card.className = 'me-idol';
    const head = document.createElement('div');
    head.className = 'me-idol-head';
    const img = document.createElement('img');
    img.alt = '';
    img.src = ch.avatar;
    const text = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = nameOf(ch);
    const small = document.createElement('small');
    small.textContent = ch.group || ch.name || '';
    text.append(strong, small);
    head.append(img, text);

    const remark = document.createElement('input');
    remark.maxLength = 20;
    remark.value = (state.profiles[ch.id] && state.profiles[ch.id].characterNickname) || '';
    remark.placeholder = ch.displayName || ch.name || '备注名';
    remark.setAttribute('aria-label', '备注名');
    remark.addEventListener('change', async () => {
      const characterNickname = remark.value.trim();
      try {
        const saved = await api(`/api/profile?characterId=${encodeURIComponent(ch.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ characterNickname }),
        });
        state.profiles[ch.id] = (saved && saved.profile) || state.profiles[ch.id];
        publish('idol-profile', { characterId: ch.id, characterNickname });
        strong.textContent = nameOf(ch);
        toast('备注已更新');
      } catch (_) { toast('备注没保存上'); }
    });
    const call = document.createElement('input');
    call.maxLength = 12;
    call.value = (state.profiles[ch.id] && state.profiles[ch.id].callName) || '';
    call.placeholder = '他怎么叫你';
    call.setAttribute('aria-label', '他怎么叫你');
    call.addEventListener('change', async () => {
      const nextName = call.value.trim();
      if (!nextName) { toast('称呼不能是空的'); call.value = (state.profiles[ch.id] && state.profiles[ch.id].callName) || ''; return; }
      try {
        const saved = await api(`/api/profile?characterId=${encodeURIComponent(ch.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ callName: nextName, callNameStatus: 'done', callNameSource: 'user' }),
        });
        state.profiles[ch.id] = (saved && saved.profile) || state.profiles[ch.id];
        toast('称呼已更新');
      } catch (_) { toast('称呼没保存上'); }
    });

    const rel = state.rel[ch.id] || {};
    const stats = document.createElement('div');
    stats.className = 'me-stats';
    [['亲密度', rel.score != null ? String(rel.score) : '0'], ['关系阶段', rel.tier && rel.tier.name ? rel.tier.name : '—'], ['相识天数', rel.daysKnown != null ? `${rel.daysKnown} 天` : '0 天']].forEach(([label, value]) => {
      const cell = document.createElement('div');
      const span = document.createElement('span');
      span.className = 'me-label';
      span.textContent = label;
      const b = document.createElement('b');
      b.textContent = value;
      cell.append(span, b);
      stats.append(cell);
    });

    const memory = document.createElement('button');
    memory.type = 'button';
    memory.className = 'me-link';
    memory.textContent = '他记得的你';
    memory.addEventListener('click', () => push((host, gen) => renderMemory(host, ch, gen)));
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'me-textbtn';
    clear.textContent = '清空和他的聊天记录';
    clear.addEventListener('click', () => clearOne(ch));

    const field = document.createElement('label');
    field.className = 'me-field';
    const fieldLabel = document.createElement('span');
    fieldLabel.textContent = '备注名';
    field.append(fieldLabel, remark);
    const callField = document.createElement('label');
    callField.className = 'me-field';
    const callLabel = document.createElement('span');
    callLabel.textContent = '他怎么叫你';
    callField.append(callLabel, call);
    const chat = document.createElement('a');
    chat.className = 'me-link';
    chat.textContent = '进入聊天';
    chat.href = '/?c=' + encodeURIComponent(ch.id);
    card.append(head, chat, field, callField, stats, memory, clear);
    return card;
  }

  async function clearOne(ch) {
    const ok = await twoStep({
      title: '清空聊天记录',
      body: `将删除你和${nameOf(ch)}的聊天记录，以及这段聊天的摘要。他记得的你与亲密度会保留。`,
      again: '再确认一次。这一步之后才会删除。',
      confirm: '确认清空',
    });
    if (!ok) return;
    try {
      await api(`/api/history?characterId=${encodeURIComponent(ch.id)}&summary=1`, { method: 'DELETE' });
      publish('idol-history-cleared', { characterId: ch.id });
      toast('聊天记录已清空');
    } catch (_) { toast('没有清空'); }
  }

  async function clearAll() {
    const ok = await twoStep({
      title: '清空全部聊天记录',
      body: '将删除你和所有爱豆的聊天记录，以及这些聊天的摘要。记忆卡片会保留。',
      again: '再确认一次。这一步之后才会删除。',
      confirm: '确认清空',
    });
    if (!ok) return;
    try {
      await api('/api/histories', { method: 'DELETE', body: JSON.stringify({ confirm: 'CLEAR' }) });
      publish('idol-history-cleared', { all: true });
      toast('全部聊天记录已清空');
    } catch (_) { toast('没有清空'); }
  }

  function fmt(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  // 他记得的你 — the single per-character page. Same three sections as the chat menu:
  // personal fields, memory cards (view/edit/delete), and the summary (view/clear only).
  async function renderMemory(host, ch, gen) {
    host.replaceChildren();
    host.append(bar('他记得的你'));
    let data = null;
    try {
      data = await api(`/api/memory?characterId=${encodeURIComponent(ch.id)}`);
    } catch (_) {
      if (gen !== viewGen) return;
      const tip = document.createElement('p');
      tip.className = 'me-note';
      tip.textContent = '没有加载出来';
      host.append(block(tip));
      return;
    }
    if (gen !== viewGen) return;
    const reload = () => renderMemory(host, ch, viewGen);

    // 1. 关于你 — editable, applied to the next chat turn.
    const personal = data.personal || {};
    const callInput = document.createElement('input');
    callInput.maxLength = 12;
    callInput.value = personal.callName || '';
    callInput.placeholder = '还没定';
    callInput.setAttribute('aria-label', '他怎么叫你');
    const nickInput = document.createElement('input');
    nickInput.maxLength = 20;
    nickInput.value = personal.characterNickname || '';
    nickInput.placeholder = ch.displayName || ch.name || '备注名';
    nickInput.setAttribute('aria-label', '备注名');
    const habitsInput = document.createElement('textarea');
    habitsInput.maxLength = 200;
    habitsInput.rows = 3;
    habitsInput.value = personal.habits || '';
    habitsInput.placeholder = '例如：晚上容易失眠，喜欢先说累';
    habitsInput.setAttribute('aria-label', '他记得的习惯');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'me-submit';
    save.textContent = '保存，下一句就生效';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const saved = await api(`/api/memory/personal?characterId=${encodeURIComponent(ch.id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            callName: callInput.value.trim(),
            characterNickname: nickInput.value.trim(),
            habits: habitsInput.value.trim(),
          }),
        });
        state.profiles[ch.id] = { ...(state.profiles[ch.id] || {}), ...(saved.personal || {}) };
        publish('idol-profile', {
          characterId: ch.id,
          characterNickname: (saved.personal && saved.personal.characterNickname) || '',
        });
        toast('保存好了，下一句就用上');
      } catch (_) {
        toast('没保存上，请重试');
      } finally { save.disabled = false; }
    });
    const about = document.createElement('div');
    about.className = 'me-block';
    about.append(
      kicker('关于你'),
      field('他怎么叫你', callInput),
      field('你怎么叫他（备注名）', nickInput),
      field('他记得的习惯', habitsInput),
      save,
    );
    host.append(about);

    // 2. 他记得的事 — grouped by category; every card can be viewed, edited, deleted.
    const cards = data.cards || [];
    const cardsBlock = document.createElement('div');
    cardsBlock.className = 'me-block';
    cardsBlock.append(kicker('他记得的事'));
    if (!cards.length) {
      const empty = document.createElement('p');
      empty.className = 'me-note';
      empty.textContent = '还没有记住什么。';
      cardsBlock.append(empty);
    } else {
      const buckets = new Map();
      for (const card of cards) {
        const key = card.category || 'recent';
        if (!buckets.has(key)) buckets.set(key, { label: card.categoryLabel || '', cards: [] });
        buckets.get(key).cards.push(card);
      }
      ['preference', 'recent', 'promise', 'address'].forEach((key) => {
        const bucket = buckets.get(key);
        if (!bucket) return;
        const heading = document.createElement('p');
        heading.className = 'me-kicker';
        heading.textContent = `${bucket.label} · ${bucket.cards.length}`;
        cardsBlock.append(heading);
        bucket.cards.forEach((card) => cardsBlock.append(memoryCardNode(card, ch, reload)));
      });
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'me-textbtn';
    clear.textContent = '清空全部记忆';
    clear.addEventListener('click', async () => {
      const ok = await twoStep({
        title: '清空全部记忆',
        body: '记忆卡片会被清空，聊天记录和亲密度都不动。',
        again: '再确认一次。清空后他会重新开始记。',
        confirm: '确认清空',
      });
      if (!ok) return;
      try {
        await api(`/api/memory?characterId=${encodeURIComponent(ch.id)}`, {
          method: 'DELETE',
          body: JSON.stringify({ confirm: 'CLEAR' }),
        });
        toast('记忆已清空');
        reload();
      } catch (_) { toast('清空失败'); }
    });
    if (cards.length) cardsBlock.append(clear);
    host.append(cardsBlock);

    // 3. 之前聊过的 — summary is view/clear only and never touches cards or intimacy.
    const summaryBlock = document.createElement('div');
    summaryBlock.className = 'me-block';
    summaryBlock.append(kicker('之前聊过的（摘要）'));
    const summaryText = document.createElement('p');
    summaryText.className = 'me-note';
    summaryText.textContent = data.summary || '还没有摘要。';
    summaryBlock.append(summaryText);
    if (data.summary) {
      const clearSummary = document.createElement('button');
      clearSummary.type = 'button';
      clearSummary.className = 'me-textbtn';
      clearSummary.textContent = '清空摘要';
      clearSummary.addEventListener('click', async () => {
        const ok = await twoStep({
          title: '清空摘要',
          body: '只清空这段聊天的摘要，记忆卡片和亲密度都保留。',
          again: '再确认一次。',
          confirm: '确认清空',
        });
        if (!ok) return;
        try {
          await api(`/api/memory/summary?characterId=${encodeURIComponent(ch.id)}`, { method: 'DELETE' });
          toast('摘要已清空');
          reload();
        } catch (_) { toast('清空失败'); }
      });
      summaryBlock.append(clearSummary);
    }
    host.append(summaryBlock);
  }

  function field(label, control) {
    const wrap = document.createElement('label');
    wrap.className = 'me-field';
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(span, control);
    return wrap;
  }

  function block(node) {
    const box = document.createElement('div');
    box.className = 'me-block';
    box.append(node);
    return box;
  }

  function memoryCardNode(card, ch, reload) {
    const item = document.createElement('article');
    item.className = 'me-card';
    const text = document.createElement('p');
    text.textContent = card.text;
    const kind = document.createElement('p');
    kind.className = 'me-note';
    const bits = [card.categoryLabel, card.statusLabel, card.date].filter(Boolean);
    kind.textContent = bits.join(' · ') + (card.edited ? ' · 你改过' : '');
    const time = document.createElement('time');
    time.textContent = fmt(card.updatedAt || card.createdAt);
    const actions = document.createElement('div');
    actions.className = 'me-card-actions';
    const view = document.createElement('button');
    view.type = 'button';
    view.textContent = '查看';
    view.addEventListener('click', () => ask({ title: '他记得的事', body: card.text, confirm: '关闭' }));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '修改';
    edit.addEventListener('click', () => {
      ask({ title: '修改这条记忆', body: '改过的内容会直接作为他记住的事。', input: true, placeholder: '一句话就好', confirm: '保存' })
        .then(async (next) => {
          // ask() resolves true when no input; only a non-empty string is a real edit.
          if (typeof next !== 'string' || !next.trim()) return;
          try {
            await api(`/api/memory/${encodeURIComponent(card.id)}?characterId=${encodeURIComponent(ch.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ text: next.trim() }),
            });
            toast('改好了');
            reload();
          } catch (_) { toast('没保存上'); }
        });
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'is-delete';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      const ok = await twoStep({
        title: '删除这条记忆',
        body: card.text,
        again: '删除后，他不会再记起这件事。',
        confirm: '确认删除',
      });
      if (!ok) return;
      try {
        await api(`/api/memory/${encodeURIComponent(card.id)}?characterId=${encodeURIComponent(ch.id)}`, { method: 'DELETE' });
        toast('已删除');
        reload();
      } catch (_) { toast('删除失败'); }
    });
    actions.append(view, edit, del);
    item.append(text, kind, time, actions);
    return item;
  }

  function renderPassword(host) {
    host.replaceChildren();
    host.append(bar('改密码'));
    const block = document.createElement('div');
    block.className = 'me-block';
    const oldPassword = document.createElement('input');
    oldPassword.type = 'password';
    oldPassword.autocomplete = 'current-password';
    const newPassword = document.createElement('input');
    newPassword.type = 'password';
    newPassword.autocomplete = 'new-password';
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
        toast(err.status === 401 ? '原密码不正确' : '新密码至少 8 位');
      } finally { save.disabled = false; }
    });
    const oldField = document.createElement('label');
    oldField.className = 'me-field';
    const oldLabel = document.createElement('span');
    oldLabel.textContent = '原密码';
    oldField.append(oldLabel, oldPassword);
    const newField = document.createElement('label');
    newField.className = 'me-field';
    const newLabel = document.createElement('span');
    newLabel.textContent = '新密码';
    newField.append(newLabel, newPassword);
    block.append(oldField, newField, save);
    host.append(block);
  }

  function renderDelete(host) {
    host.replaceChildren();
    host.append(bar('注销账号'));
    const block = document.createElement('div');
    block.className = 'me-block';
    const note = document.createElement('p');
    note.className = 'me-note';
    note.textContent = '注销会删除账号、聊天、记忆、偏好，以及朋友圈里的赞和评论。付费不会因注销自动取消。请输入「注销」确认。';
    const input = document.createElement('input');
    input.autocomplete = 'off';
    input.placeholder = '注销';
    input.setAttribute('aria-label', '输入注销');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'me-submit';
    button.textContent = '继续';
    button.disabled = true;
    input.addEventListener('input', () => { button.disabled = input.value.trim() !== '注销'; });
    button.addEventListener('click', async () => {
      const ok = await ask({
        title: '再次确认',
        body: '这一步之后，账号和相关数据会被删除。付费不会因注销自动取消。',
        confirm: '确认注销',
        danger: true,
      });
      if (!ok) return;
      button.disabled = true;
      try {
        await api('/api/me', { method: 'DELETE', body: JSON.stringify({ confirm: '注销' }) });
        if (window.IdolChat && window.IdolChat.logout) window.IdolChat.logout();
        else location.href = '/login';
      } catch (_) {
        toast('没有注销');
        button.disabled = false;
      }
    });
    const field = document.createElement('label');
    field.className = 'me-field';
    const span = document.createElement('span');
    span.textContent = '确认词';
    field.append(span, input);
    block.append(note, field, button);
    host.append(block);
  }

  function renderFeedback(host) {
    host.replaceChildren();
    host.append(bar('意见反馈 / 举报'));
    const block = document.createElement('div');
    block.className = 'me-block';
    const kind = document.createElement('select');
    [['feedback', '意见反馈'], ['report', '举报']].forEach(([id, label]) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      kind.append(option);
    });
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
        await api('/api/feedback', { method: 'POST', body: JSON.stringify({ kind: kind.value, text }) });
        area.value = '';
        toast('已收到');
      } catch (_) { toast('没送出去'); }
      finally { save.disabled = false; }
    });
    const kindField = document.createElement('label');
    kindField.className = 'me-field';
    const kindLabel = document.createElement('span');
    kindLabel.textContent = '类型';
    kindField.append(kindLabel, kind);
    const textField = document.createElement('label');
    textField.className = 'me-field';
    const textLabel = document.createElement('span');
    textLabel.textContent = '内容';
    textField.append(textLabel, area);
    block.append(kindField, textField, save);
    host.append(block);
  }

  function syncNotice() {
    const notice = document.getElementById('ai-notice');
    if (!notice) return;
    notice.hidden = state.settings.aiNoticeSeen === true;
  }

  async function refresh() {
    try {
      const [me, settings, chars, about, starlight, history] = await Promise.all([
        api('/api/me'),
        api('/api/me/settings'),
        api('/api/characters'),
        api('/api/about'),
        api('/api/starlight').catch(() => null),
        api('/api/conversations'),
      ]);
      state.me = me;
      state.starlight = starlight;
      if (window.AccountCache && me.user && me.user.id) {
        const characterId = new URLSearchParams(location.search).get('c') || 'baekhyun';
        window.AccountCache.adopt(localStorage, me.user.id, characterId);
      }
      writeLocal(settings.settings || {});
      state.characters = [...new Map([
        ...(chars.characters || []).filter((ch) => ch.available !== false),
        ...(history.conversations || []),
      ].map((ch) => [ch.id, ch])).values()];
      state.about = about || state.about;
      const details = await Promise.all(state.characters.map(async (ch) => {
        const [prof, rel] = await Promise.all([
          api(`/api/profile?characterId=${encodeURIComponent(ch.id)}`),
          api(`/api/relationship?characterId=${encodeURIComponent(ch.id)}`),
        ]);
        return [ch.id, (prof && prof.profile) || {}, (rel && rel.relationship) || {}];
      }));
      state.profiles = {};
      state.rel = {};
      details.forEach(([id, prof, rel]) => {
        state.profiles[id] = prof;
        state.rel[id] = rel;
      });
    } catch (_) { /* login redirect handles auth */ }
    paintMain();
    if (stack.length) showSub();
    else syncBar();
    syncNotice();
  }

  const noticeOk = document.getElementById('ai-notice-ok');
  if (noticeOk) {
    noticeOk.addEventListener('click', () => saveSettings({ aiNoticeSeen: true }));
  }
  syncNotice();
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || screen.hidden) return;
    if (!dialog.hidden) {
      dialog.hidden = true;
      dialog.replaceChildren();
    } else if (stack.length) pop();
  });

  window.Me = { open: refresh };
  refresh();
})();
