/* 他记得的你: personal info, memory cards, and the conversation summary for one character.
   Uses withChar() from app.js. Nothing here changes chat history or intimacy. */
(function () {
  const panel = document.getElementById('mem-panel');
  if (!panel) return;
  const groups = document.getElementById('mem-groups');
  const list = document.getElementById('mem-list');
  const empty = document.getElementById('mem-empty');
  const sumBox = document.getElementById('mem-summary');
  const sumText = document.getElementById('mem-summary-text');
  const sumClear = document.getElementById('mem-summary-clear');
  const clearBtn = document.getElementById('mem-clear');
  const forgotBox = document.getElementById('mem-forgot');
  const forgotList = document.getElementById('mem-forgot-list');
  const callInput = document.getElementById('mem-call-name');
  const nickInput = document.getElementById('mem-nickname');
  const habitsInput = document.getElementById('mem-habits');
  const personalSave = document.getElementById('mem-personal-save');
  let currentData = null;
  let dirtyPersonal = false;

  const toast = (msg) => {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
  };
  const fmt = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  };
  const fmtDay = (s) => { const [y, m, d] = String(s).split('-'); return `${y}年${Number(m)}月${Number(d)}日`; };
  const isReadOnly = () => Boolean(window.IdolChat && window.IdolChat.isReadOnly && window.IdolChat.isReadOnly());

  // Two taps to confirm: first tap arms the button for 3 seconds.
  function armed(btn, label, armedLabel) {
    if (btn.classList.contains('armed')) return true;
    btn.classList.add('armed'); btn.textContent = armedLabel;
    setTimeout(() => { btn.classList.remove('armed'); btn.textContent = label; }, 3000);
    return false;
  }

  function paintPersonal(data) {
    const personal = (data && data.personal) || {};
    if (document.activeElement !== callInput) callInput.value = personal.callName || '';
    if (document.activeElement !== nickInput) nickInput.value = personal.characterNickname || '';
    if (document.activeElement !== habitsInput) habitsInput.value = personal.habits || '';
    callInput.placeholder = personal.defaultCallName || '还没定';
    // Read-only is only known after the first history fetch, so decide here (not at load).
    const locked = isReadOnly();
    [callInput, nickInput, habitsInput].forEach((input) => { input.disabled = locked; });
    personalSave.hidden = locked;
  }

  // The summary is always on the page (view or clear only); an empty one says so.
  function paintSummary(data) {
    const summary = (data && data.summary) || '';
    sumBox.hidden = false;
    sumText.textContent = summary || '还没有摘要。多聊几句就会有了。';
    sumText.classList.toggle('is-empty', !summary);
    sumClear.hidden = isReadOnly() || !summary;
  }

  function paintForgotten(data) {
    const forgotten = (data && data.forgotten) || [];
    forgotBox.hidden = forgotten.length === 0;
    forgotList.innerHTML = '';
    forgotten.slice(-30).reverse().forEach((item) => {
      const li = document.createElement('li');
      li.className = 'mem-forgot-item';
      const text = document.createElement('p');
      text.className = 'mem-text';
      text.textContent = item.text;
      const meta = document.createElement('p');
      meta.className = 'mem-date';
      meta.textContent = item.at ? `忘记于 ${fmt(item.at)}` : '已忘记';
      li.append(text, meta);
      forgotList.appendChild(li);
    });
  }

  function cardNode(card) {
    const li = document.createElement('li');
    li.className = 'mem-item';
    const main = document.createElement('div');
    main.className = 'mem-item-main';
    const p = document.createElement('p'); p.className = 'mem-text'; p.textContent = card.text;
    const meta = document.createElement('p'); meta.className = 'mem-date mem-kind';
    const kind = [card.categoryLabel, card.statusLabel].filter(Boolean).join(' · ');
    const edited = card.edited ? ' · 你改过' : '';
    meta.textContent = (kind ? `${kind} · ` : '') + (card.date ? `📅 ${fmtDay(card.date)} · ` : '') + `记于 ${fmt(card.updatedAt || card.createdAt)}${edited}`;
    main.append(p, meta);
    li.append(main);
    if (isReadOnly()) return li;
    const actions = document.createElement('div');
    actions.className = 'mem-actions';
    const edit = document.createElement('button');
    edit.type = 'button'; edit.className = 'mem-del mem-edit'; edit.textContent = '修改';
    edit.addEventListener('click', () => startEdit(li, card));
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'mem-del'; del.textContent = '删除';
    del.addEventListener('click', async () => {
      if (!armed(del, '删除', '确认删除')) return;
      del.disabled = true;
      await removeCard(card);
      del.disabled = false;
    });
    actions.append(edit, del);
    li.append(actions);
    return li;
  }

  // Editing is inline so the card stays in its category group while it changes.
  function startEdit(li, card) {
    li.innerHTML = '';
    const form = document.createElement('form');
    form.className = 'mem-edit-form';
    const input = document.createElement('textarea');
    input.className = 'mem-edit-input';
    input.rows = 2;
    input.maxLength = 120;
    input.value = card.text;
    input.setAttribute('aria-label', '修改这条记忆');
    const row = document.createElement('div');
    row.className = 'mem-actions';
    const save = document.createElement('button');
    save.type = 'submit'; save.className = 'mem-del mem-save-one'; save.textContent = '保存';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'mem-del'; cancel.textContent = '取消';
    cancel.addEventListener('click', () => render(currentData));
    row.append(save, cancel);
    form.append(input, row);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) { toast('写点什么再保存'); input.focus(); return; }
      save.disabled = true;
      try {
        const r = await fetch(withChar(`/api/memory/${encodeURIComponent(card.id)}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!r.ok) throw new Error('save failed');
        render(await r.json());
        toast('改好了，他下次就按你写的记');
      } catch (_) {
        save.disabled = false;
        toast('没保存上，请重试');
      }
    });
    li.append(form);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  async function removeCard(card) {
    try {
      const r = await fetch(withChar(`/api/memory/${encodeURIComponent(card.id)}`), { method: 'DELETE' });
      if (!r.ok) throw new Error('delete failed');
      render(await r.json());
      toast('已删除，他不会再记起这件事');
    } catch (_) {
      toast('删除失败，请重试');
    }
  }

  function render(data) {
    currentData = data;
    const cards = (data && data.cards) || [];
    groups.innerHTML = '';
    list.innerHTML = '';
    paintPersonal(data);
    paintSummary(data);
    paintForgotten(data);

    // Cards are grouped by category; the flat list stays empty so each card renders once.
    const buckets = new Map();
    for (const card of cards) {
      const key = card.category || 'recent';
      if (!buckets.has(key)) buckets.set(key, { label: card.categoryLabel || '', cards: [] });
      buckets.get(key).cards.push(card);
    }
    const order = ['preference', 'recent', 'promise', 'address'];
    [...buckets.entries()]
      .sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99))
      .forEach(([, bucket]) => {
        const title = document.createElement('h4');
        title.className = 'mem-group-title';
        title.textContent = `${bucket.label || '记忆'} · ${bucket.cards.length}`;
        const ul = document.createElement('ul');
        ul.className = 'mem-list';
        ul.dataset.category = bucket.label || '';
        bucket.cards.forEach((card) => ul.appendChild(cardNode(card)));
        groups.append(title, ul);
      });

    empty.hidden = cards.length > 0 || Boolean(data && data.summary);
    clearBtn.hidden = isReadOnly() || (cards.length === 0 && !(data && data.summary));
  }

  async function refresh() {
    const r = await fetch(withChar('/api/memory'));
    if (r.status === 401) { location.href = '/login'; return null; }
    if (!r.ok) throw new Error('load failed');
    const data = await r.json();
    render(data);
    return data;
  }

  async function open() {
    document.getElementById('menu').hidden = true;
    const ps = document.getElementById('profile-sheet'); if (ps) ps.hidden = true;
    panel.hidden = false;
    const scroller = panel.querySelector('.mem-body');
    if (scroller) scroller.scrollTop = 0;
    groups.innerHTML = ''; list.innerHTML = ''; empty.hidden = true;
    dirtyPersonal = false;
    try {
      await refresh();
    } catch (_) { toast('加载失败'); }
  }
  function close() { panel.hidden = true; }

  ['memory-open-menu', 'memory-open-profile'].forEach((id) => {
    const b = document.getElementById(id); if (b) b.addEventListener('click', open);
  });
  document.getElementById('mem-back').addEventListener('click', close);
  document.addEventListener('idol-character-readonly', () => {
    if (!panel.hidden && currentData) render(currentData);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });

  [callInput, nickInput, habitsInput].forEach((input) => {
    input.addEventListener('input', () => { dirtyPersonal = true; });
  });

  // Personal fields are saved explicitly and apply to the very next chat turn.
  personalSave.addEventListener('click', async () => {
    if (isReadOnly()) return;
    personalSave.disabled = true;
    callInput.blur();
    nickInput.blur();
    habitsInput.blur();
    try {
      const r = await fetch(withChar('/api/memory/personal'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callName: callInput.value.trim(),
          characterNickname: nickInput.value.trim(),
          habits: habitsInput.value.trim(),
        }),
      });
      if (!r.ok) throw new Error('save failed');
      const data = await r.json();
      if (currentData) currentData.personal = data.personal;
      paintPersonal({ personal: data.personal });
      dirtyPersonal = false;
      const savedNick = (data.personal && data.personal.characterNickname) || '';
      const charId = (typeof CHARACTER_ID === 'string' && CHARACTER_ID)
        || (new URLSearchParams(location.search).get('c') || 'baekhyun').toLowerCase();
      document.dispatchEvent(new CustomEvent('idol-profile', {
        detail: { characterId: charId, characterNickname: savedNick },
      }));
      toast('保存好了，下一句就用上');
      personalSave.textContent = '已保存 ✓';
      setTimeout(() => { personalSave.textContent = '保存，下一句就生效'; }, 1600);
    } catch (_) {
      toast('没保存上，请重试');
    } finally {
      personalSave.disabled = false;
    }
  });

  sumClear.addEventListener('click', async () => {
    if (!armed(sumClear, '清空摘要', '再点一次确认')) return;
    try {
      const r = await fetch(withChar('/api/memory/summary'), { method: 'DELETE' });
      if (!r.ok) throw new Error('clear failed');
      render(await r.json());
      toast('摘要已清空，记忆卡片还在');
    } catch (_) {
      toast('清空失败');
    } finally {
      sumClear.classList.remove('armed');
      sumClear.textContent = '清空摘要';
    }
  });

  clearBtn.addEventListener('click', async () => {
    if (!armed(clearBtn, '清空全部记忆', '再点一次确认清空')) return;
    try {
      const r = await fetch(withChar('/api/memory'), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'CLEAR' }) });
      if (!r.ok) throw new Error('clear failed');
      render(await r.json()); toast('记忆已清空');
    } catch (_) { toast('清空失败'); }
  });
})();
