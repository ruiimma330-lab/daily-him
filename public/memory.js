/* 他记得的事: view and delete long-term memory cards. Uses withChar() from app.js. */
(function () {
  const panel = document.getElementById('mem-panel');
  if (!panel) return;
  const list = document.getElementById('mem-list');
  const empty = document.getElementById('mem-empty');
  const sumBox = document.getElementById('mem-summary');
  const sumText = document.getElementById('mem-summary-text');
  const clearBtn = document.getElementById('mem-clear');
  let currentData = null;
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
  const fmtDay = (s) => { const [y, m, d] = s.split('-'); return `${y}年${Number(m)}月${Number(d)}日`; };
  const isReadOnly = () => Boolean(window.IdolChat && window.IdolChat.isReadOnly && window.IdolChat.isReadOnly());

  // Two taps to confirm: first tap arms the button for 3 seconds.
  function armed(btn, label, armedLabel) {
    if (btn.classList.contains('armed')) return true;
    btn.classList.add('armed'); btn.textContent = armedLabel;
    setTimeout(() => { btn.classList.remove('armed'); btn.textContent = label; }, 3000);
    return false;
  }

  function render(data) {
    currentData = data;
    list.innerHTML = '';
    const cards = (data && data.cards) || [];
    for (const c of cards) {
      const li = document.createElement('li');
      li.className = 'mem-item';
      const main = document.createElement('div');
      main.className = 'mem-item-main';
      const p = document.createElement('p'); p.className = 'mem-text'; p.textContent = c.text;
      const meta = document.createElement('p'); meta.className = 'mem-date mem-kind';
      const kind = [c.categoryLabel, c.statusLabel].filter(Boolean).join(' · ');
      meta.textContent = (kind ? `${kind} · ` : '') + (c.date ? `📅 ${fmtDay(c.date)} · ` : '') + `记于 ${fmt(c.updatedAt || c.createdAt)}`;
      main.append(p, meta);
      if (isReadOnly()) {
        li.append(main);
      } else {
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'mem-del'; del.textContent = '删除';
        del.addEventListener('click', async () => {
          if (!armed(del, '删除', '确认删除')) return;
          del.disabled = true;
          try {
            const r = await fetch(withChar(`/api/memory/${encodeURIComponent(c.id)}`), { method: 'DELETE' });
            if (!r.ok) throw new Error();
            render(await r.json()); toast('已删除，他不会再记起这件事');
          } catch (_) { del.disabled = false; toast('删除失败，请重试'); }
        });
        li.append(main, del);
      }
      list.appendChild(li);
    }
    empty.hidden = cards.length > 0 || Boolean(data && data.summary);
    clearBtn.hidden = isReadOnly() || (cards.length === 0 && !(data && data.summary));
    sumBox.hidden = !(data && data.summary);
    sumText.textContent = (data && data.summary) || '';
  }

  async function open() {
    document.getElementById('menu').hidden = true;
    const ps = document.getElementById('profile-sheet'); if (ps) ps.hidden = true;
    panel.hidden = false;
    list.innerHTML = ''; empty.hidden = true;
    try {
      const r = await fetch(withChar('/api/memory'));
      if (r.status === 401) { location.href = '/login'; return; }
      render(await r.json());
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
  clearBtn.addEventListener('click', async () => {
    if (!armed(clearBtn, '清空全部记忆', '再点一次确认清空')) return;
    try {
      const r = await fetch(withChar('/api/memory'), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'CLEAR' }) });
      if (!r.ok) throw new Error();
      render(await r.json()); toast('记忆已清空');
    } catch (_) { toast('清空失败'); }
  });
})();
