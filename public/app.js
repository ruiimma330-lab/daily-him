const CHARACTER_ID = (new URLSearchParams(location.search).get('c') || localStorage.getItem('idol_selected_character') || 'baekhyun').toLowerCase();
try { localStorage.setItem('idol_selected_character', CHARACTER_ID); } catch (_) {}
const withChar = (u) => `${u}${u.includes('?') ? '&' : '?'}characterId=${encodeURIComponent(CHARACTER_ID)}`;
(function () {
  // profile onboarded gate: first-time users go through shell (cover→pick→onboard)
  if (new URLSearchParams(location.search).get('forced') === '1') return;
  fetch(withChar('/api/profile')).then((r) => r.json()).then((d) => {
    if (!d || !d.profile || !d.profile.onboardedAt) {
      location.replace('/shell/cover.html');
    }
  }).catch(() => {});
})();
(function () {
  const pageFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return pageFetch(input, init).then((response) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (response.status === 401 && String(url).indexOf('/api/') !== -1) {
        location.href = '/login';
      }
      return response;
    });
  };

  const HISTORY_KEY = CHARACTER_ID === 'baekhyun' ? 'idolchat_history_v1' : `${'idolchat_history_v1'}:${CHARACTER_ID}`;
  const SETTINGS_KEY = 'idolchat_settings_v1';
  const CLIENT_TIMEOUT_MS = 100000;
  const RETRY_TEXT = '앗 미안 ㅠㅠ 잠깐 신호가 안 좋았나 봐… 다시 보내줄래? 🐶';
  const WAVE = [8, 14, 20, 11, 24, 16, 22, 10, 18, 26, 13, 21, 9, 17, 23, 12, 19, 8];

  const room = document.getElementById('screen-room');
  const messagesEl = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const menu = document.getElementById('menu');
  const menuBtn = document.getElementById('menu-btn');
  const autoplayBtn = document.getElementById('autoplay-toggle');
  const voiceBtn = document.getElementById('voice-toggle');
  const sheet = document.getElementById('sheet');
  const profileSheet = document.getElementById('profile-sheet');
  const modal = document.getElementById('modal');
  const toast = document.getElementById('toast');
  const listTime = document.getElementById('list-time');
  const listPreview = document.getElementById('list-preview');
  const listBadge = document.getElementById('list-badge');
  const roomSub = document.getElementById('room-sub');
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  let messages = loadLocalHistory();
  let settings = loadSettings();
  let roomOpen = false;
  let menuOpen = false;
  let typing = false;
  let recording = false;
  let busy = false;
  let animateLast = false;
  let generation = 0;
  let chatAbort = null;
  let toastTimer = 0;
  let lastCompositionEnd = 0;
  let showRetry = false;
  let retryFresh = false;
  let retryAt = 0;
  let voiceNote = '';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function normalizeHistoryList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string' && !item.ephemeral)
      .map((item) => ({
        role: item.role,
        text: item.text,
        time: typeof item.time === 'number' ? item.time : Date.now(),
        audioUrl: safeAudioUrl(item.audioUrl),
        voice: item.voice === true,
        zh: typeof item.zh === 'string' ? item.zh : '',
        mood: typeof item.mood === 'string' ? item.mood : '',
        ttsFailed: item.ttsFailed === true,
      }));
  }

  function loadLocalHistory() {
    try {
      return normalizeHistoryList(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'));
    } catch (err) {
      return [];
    }
  }

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        autoplay: raw.autoplay === true,
        voice: raw.voice !== false,
        seen: Number.isFinite(raw.seen) && raw.seen > 0 ? raw.seen : 0,
      };
    } catch (err) {
      return { autoplay: false, voice: true, seen: 0 };
    }
  }

  let historySyncTimer = 0;
  let historySyncing = false;

  function historySnapshot() {
    return messages.map((item) => ({
      role: item.role,
      text: item.text,
      time: item.time,
      audioUrl: item.audioUrl,
      voice: item.voice || undefined,
      zh: item.zh || undefined,
      mood: item.mood || undefined,
      ttsFailed: item.ttsFailed || undefined,
    }));
  }

  function saveLocalHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(historySnapshot()));
    } catch (err) {
      showToast('이 브라우저에 대화를 저장하지 못했어요');
    }
  }

  function saveHistory() {
    saveLocalHistory();
    clearTimeout(historySyncTimer);
    historySyncTimer = setTimeout(syncHistoryToServer, 250);
  }

  async function syncHistoryToServer() {
    if (historySyncing) {
      clearTimeout(historySyncTimer);
      historySyncTimer = setTimeout(syncHistoryToServer, 250);
      return;
    }
    historySyncing = true;
    const snapshot = historySnapshot();
    try {
      const response = await fetch(withChar('/api/history'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: snapshot }),
      });
      if (response.status === 401) {
        location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error('sync failed');
    } catch (err) {
      showToast('대화를 서버에 저장하지 못했어요');
    } finally {
      historySyncing = false;
    }
  }


  let relState = null;
  const TIER_LABEL = { stranger: '陌生 · 처음', friend: '朋友 · 친구', close: '好友 · 절친', flirty: '暧昧 · 썸' };
  function renderSpark() {
    const node = document.getElementById('spark');
    if (!node || !relState) return;
    node.hidden = false;
    node.className = `spark ${relState.streakState}`;
    node.textContent = `🔥${relState.streak || 0}`;
    node.title = '连续聊天天数';
  }
  function renderRelPop() {
    const pop = document.getElementById('rel-pop');
    if (!pop || !relState) return;
    const tip = {
      lit: '今天的火花已点亮 ✨',
      waiting: '今天还没聊，聊一句就能续上火花~',
      dim: '火花变灰了，今天聊一句就能恢复 🙂',
      out: '火花熄灭了，再聊就重新开始点亮',
      none: '聊第一句就会点亮火花',
    }[relState.streakState] || '';
    pop.innerHTML = '';
    const lines = [
      `相识第 <b>${relState.daysKnown || 0}</b> 天 · 一共聊了 ${relState.totalTurns} 次`,
      `现在的关系：<b>${TIER_LABEL[relState.tier.id] || relState.tier.name}</b>`,
      `连续聊天 🔥 ${relState.streak || 0} 天`,
      `<small>${tip}</small>`,
    ];
    pop.innerHTML = lines.join('<br>');
  }
  function applyRelationship(rel, fromChat) {
    if (!rel || !rel.tier) return;
    const wasUp = fromChat && rel.tierUp;
    relState = rel;
    renderSpark();
    renderRelPop();
    if (wasUp) showToast(`和백현的关系变近了一点：${TIER_LABEL[rel.tier.id] || rel.tier.name} 💛`);
  }
  async function loadRelationship() {
    try {
      const r = await fetch(withChar('/api/relationship'));
      if (!r.ok) return;
      const d = await r.json();
      applyRelationship(d.relationship, false);
    } catch (_) { /* ignore */ }
  }
  document.addEventListener('click', (e) => {
    const spark = e.target.closest && e.target.closest('#spark');
    const pop = document.getElementById('rel-pop');
    if (!pop) return;
    if (spark) {
      e.preventDefault();
      e.stopPropagation();
      pop.hidden = !pop.hidden;
    } else if (!e.target.closest('#rel-pop')) {
      pop.hidden = true;
    }
  }, true);
  loadRelationship();

  async function pullHistoryFromServer() {
    const response = await fetch(withChar('/api/history'));
    if (response.status === 401) {
      location.href = '/login';
      return null;
    }
    if (!response.ok) throw new Error('history failed');
    const data = await response.json();
    return normalizeHistoryList(data && data.messages);
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) {
      /* settings are optional */
    }
  }

  function safeAudioUrl(url) {
    return typeof url === 'string' && /^\/audio\/[a-f0-9]{64}\.mp3$/.test(url) ? url : null;
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function bubbleDelay(text) {
    const length = Array.from(String(text || '')).length;
    return Math.min(1200, Math.max(500, 500 + length * 16));
  }

  function formatClock(ts) {
    const date = new Date(ts);
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const period = hours < 12 ? '오전' : '오후';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return `${period} ${hours}:${minutes}`;
  }

  function formatDateLabel(ts) {
    const date = new Date(ts);
    const week = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'][date.getDay()];
    return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 ${week}`;
  }

  function formatListTime(ts) {
    const date = new Date(ts);
    const now = new Date();
    const start = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const diff = start(now) - start(date);
    if (diff === 0) return formatClock(ts);
    if (diff === 86400000) return '어제';
    return `${date.getMonth() + 1}월 ${date.getDate()}일`;
  }

  function formatDur(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    const remain = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remain).padStart(2, '0')}`;
  }

  function dayKey(ts) {
    const date = new Date(ts);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function puppyIcon() {
    const tpl = document.getElementById('puppy-svg');
    return tpl.content.firstElementChild.cloneNode(true);
  }

  function makeAvatar(sizeClass) {
    const node = el('span', sizeClass ? `avatar ${sizeClass}` : 'avatar');
    node.setAttribute('aria-hidden', 'true');
    node.append(puppyIcon());
    return node;
  }

  function mountStaticAvatars() {
    document.querySelectorAll('[data-avatar]').forEach((node) => {
      if (!node.querySelector('svg')) node.append(puppyIcon());
    });
  }

  function svgIcon(pathD, width) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(width || 16));
    svg.setAttribute('height', String(width || 16));
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', pathD);
    svg.append(path);
    return svg;
  }

  function setPlayIcon(button, playing) {
    const icon = playing
      ? svgIcon('M7 5h3.2v14H7V5zm6.8 0H17v14h-3.2V5z', 14)
      : svgIcon('M8 5.5v13l11-6.5-11-6.5z', 14);
    button.replaceChildren(icon);
    button.setAttribute('aria-label', playing ? '일시정지' : '재생');
    button.setAttribute('aria-pressed', playing ? 'true' : 'false');
  }

  function knownDuration(audio) {
    return Number.isFinite(audio.duration) && audio.duration > 0 && audio.duration !== Infinity;
  }

  function updateVoiceUI(bubble) {
    const audio = bubble.querySelector('audio');
    const button = bubble.querySelector('.play');
    const durationEl = bubble.querySelector('.dur');
    const fill = bubble.querySelector('.track-fill');
    const bars = bubble.querySelectorAll('.bars i');
    if (!audio || !durationEl) return;
    const playing = !audio.paused && !audio.ended;
    bubble.classList.toggle('playing', playing);
    if (button) setPlayIcon(button, playing);
    const known = knownDuration(audio);
    const mid = known && !audio.ended && audio.currentTime > 0.05;
    const ratio = known ? Math.min(1, Math.max(0, audio.currentTime / audio.duration)) : 0;
    const visual = (playing || mid) && !audio.ended ? ratio : 0;
    if (playing && known) durationEl.textContent = formatDur(audio.currentTime);
    else if (mid) durationEl.textContent = formatDur(audio.currentTime);
    else durationEl.textContent = known ? formatDur(audio.duration) : '00:00';
    if (fill) fill.style.width = `${Math.round(visual * 1000) / 10}%`;
    bars.forEach((bar, index) => {
      const mark = (index + 1) / bars.length;
      bar.classList.toggle('filled', visual > 0 && mark <= visual + 0.001);
    });
  }

  function syncPlayState() {
    document.querySelectorAll('.voice').forEach((bubble) => updateVoiceUI(bubble));
  }

  function stopAllAudio() {
    document.querySelectorAll('audio').forEach((audio) => audio.pause());
    syncPlayState();
  }

  function playExclusive(audio) {
    document.querySelectorAll('audio').forEach((other) => {
      if (other !== audio) other.pause();
    });
    return audio.play();
  }

  function toggleAudio(audio) {
    if (!audio.paused && !audio.ended) {
      audio.pause();
      syncPlayState();
      return;
    }
    playExclusive(audio).then(syncPlayState).catch(() => {
      showToast('음성을 재생하지 못했어요');
      syncPlayState();
    });
  }

  function buildVoiceBubble(message) {
    const bubble = el('div', 'bubble voice');
    const button = el('button', 'play');
    button.type = 'button';
    setPlayIcon(button, false);
    const col = el('div', 'voice-col');
    const bars = el('div', 'bars');
    bars.setAttribute('aria-hidden', 'true');
    WAVE.forEach((height, index) => {
      const bar = document.createElement('i');
      bar.style.setProperty('--h', `${height}px`);
      bar.style.setProperty('--d', `${(index % 6) * 0.08}s`);
      bars.append(bar);
    });
    const track = el('div', 'track');
    track.setAttribute('aria-hidden', 'true');
    const fill = el('span', 'track-fill');
    track.append(fill);
    col.append(bars, track);
    const duration = el('span', 'dur');
    duration.textContent = '00:00';
    const audio = el('audio');
    audio.preload = 'metadata';
    audio.setAttribute('playsinline', '');
    const refresh = () => updateVoiceUI(bubble);
    audio.addEventListener('loadedmetadata', refresh);
    audio.addEventListener('durationchange', refresh);
    audio.addEventListener('timeupdate', refresh);
    audio.addEventListener('play', syncPlayState);
    audio.addEventListener('pause', syncPlayState);
    audio.addEventListener('ended', syncPlayState);
    audio.addEventListener('error', () => {
      duration.textContent = '00:00';
    });
    audio.src = message.audioUrl;
    button.addEventListener('click', () => toggleAudio(audio));
    bubble.append(button, col, duration, audio);
    return bubble;
  }

  // New-format reply: one voice clip (or text fallback) with a collapsible 原文+翻译.
  function buildVoiceItem(message) {
    const wrap = el('div', 'vitem');
    const failed = !message.audioUrl;
    const bubble = failed ? buildTextBubble(message) : buildVoiceBubble(message);
    wrap.append(bubble);
    if (failed && message.ttsFailed) {
      const note = el('p', 'vnote');
      note.textContent = '语音没发出来，先看文字吧';
      wrap.append(note);
    }
    const hasText = !failed || message.zh;
    if (hasText) {
      const toggle = el('button', 'vtoggle');
      toggle.type = 'button';
      toggle.textContent = failed ? '中文翻译 ▾' : '原文 · 翻译 ▾';
      toggle.setAttribute('aria-expanded', 'false');
      const box = el('div', 'vtext');
      box.hidden = true;
      if (!failed) {
        const ko = el('p', 'vko');
        ko.textContent = message.text;
        box.append(ko);
      }
      if (message.zh) {
        const zh = el('p', 'vzh');
        zh.textContent = message.zh;
        box.append(zh);
      }
      toggle.addEventListener('click', () => {
        box.hidden = !box.hidden;
        toggle.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
        toggle.textContent = (failed ? '中文翻译 ' : '原文 · 翻译 ') + (box.hidden ? '▾' : '▴');
      });
      wrap.append(toggle, box);
    }
    return wrap;
  }

  function buildTextBubble(message) {
    const bubble = el('div', 'bubble');
    bubble.textContent = message.text;
    return bubble;
  }

  function render() {
    messagesEl.replaceChildren();
    if (roomSub) roomSub.textContent = typing ? '입력 중...' : '지금 대화할 수 있어요';
    if (!messages.length && !typing && !showRetry) {
      messagesEl.append(datePill(Date.now()));
    }

    let index = 0;
    let groupOrdinal = 0;
    const groupCount = countGroups(messages);
    while (index < messages.length) {
      const current = messages[index];
      const key = dayKey(current.time);
      const previous = index > 0 ? messages[index - 1] : null;
      if (!previous || dayKey(previous.time) !== key) {
        messagesEl.append(datePill(current.time));
      }
      let end = index + 1;
      while (end < messages.length && messages[end].role === current.role && dayKey(messages[end].time) === key) {
        end += 1;
      }
      const group = messages.slice(index, end);
      const unread = current.role === 'user' && !messages.slice(end).some((item) => item.role === 'assistant');
      groupOrdinal += 1;
      messagesEl.append(renderGroup(group, unread, animateLast && groupOrdinal === groupCount));
      index = end;
    }

    if (typing) messagesEl.append(renderTyping());
    else if (showRetry) messagesEl.append(renderRetry());
    if (voiceNote && !typing) messagesEl.append(renderVoiceNote());
    animateLast = false;

    if (roomOpen) {
      settings.seen = messages.length;
      saveSettings();
      requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
    updateList();
  }

  function countGroups(list) {
    let count = 0;
    let index = 0;
    while (index < list.length) {
      const key = dayKey(list[index].time);
      const role = list[index].role;
      let end = index + 1;
      while (end < list.length && list[end].role === role && dayKey(list[end].time) === key) end += 1;
      count += 1;
      index = end;
    }
    return count;
  }

  function datePill(ts) {
    const pill = el('div', 'date-pill');
    pill.textContent = formatDateLabel(ts);
    return pill;
  }

  function renderGroup(group, unread, fresh) {
    const incoming = group[0].role === 'assistant';
    const wrap = el('div', `group ${incoming ? 'in' : 'out'}${fresh ? ' fresh' : ''}`);
    if (incoming) wrap.append(makeAvatar('sm'));
    const stack = el('div', 'stack');
    if (incoming) {
      const name = el('div', 'sender');
      name.textContent = '백현';
      stack.append(name);
    }
    group.forEach((message, messageIndex) => {
      const line = el('div', 'line');
      const last = messageIndex === group.length - 1;
      const bubble = message.voice
        ? buildVoiceItem(message)
        : (message.audioUrl && !message.text ? buildVoiceBubble(message) : buildTextBubble(message));
      if (messageIndex === 0) (bubble.classList.contains('vitem') ? bubble.firstChild : bubble).classList.add('sharp');
      const meta = el('div', 'meta');
      if (!incoming && unread) {
        const read = el('span', 'read');
        read.textContent = '1';
        meta.append(read);
      }
      if (last) {
        const time = el('time', 'time');
        time.dateTime = new Date(message.time).toISOString();
        time.textContent = formatClock(message.time);
        meta.append(time);
      }
      if (incoming) {
        line.append(bubble);
        if (meta.childNodes.length) line.append(meta);
      } else if (meta.childNodes.length) {
        line.append(meta, bubble);
      } else {
        line.append(bubble);
      }
      stack.append(line);
    });
    wrap.append(stack);
    return wrap;
  }

  function renderTyping() {
    const wrap = el('div', 'group in');
    const stack = el('div', 'stack');
    const line = el('div', 'line');
    const bubble = el('div', 'bubble typing sharp');
    const typingText = recording ? '녹음 중...' : '입력 중...';
    bubble.setAttribute('aria-label', typingText);
    for (let i = 0; i < 3; i += 1) bubble.append(el('span', 'dot'));
    const label = el('span', 'typing-label');
    label.textContent = typingText;
    bubble.append(label);
    line.append(bubble);
    stack.append(line);
    wrap.append(makeAvatar('sm'), stack);
    return wrap;
  }

  function renderRetry() {
    const wrap = el('div', `group in${retryFresh ? ' fresh' : ''}`);
    retryFresh = false;
    const stack = el('div', 'stack');
    const name = el('div', 'sender');
    name.textContent = '백현';
    const line = el('div', 'line');
    const bubble = el('div', 'bubble sharp');
    bubble.textContent = RETRY_TEXT;
    const meta = el('div', 'meta');
    const time = el('time', 'time');
    const stamp = retryAt || Date.now();
    time.dateTime = new Date(stamp).toISOString();
    time.textContent = formatClock(stamp);
    meta.append(time);
    line.append(bubble, meta);
    const retry = el('button', 'retry-btn');
    retry.type = 'button';
    retry.textContent = '다시 보내기';
    retry.addEventListener('click', () => {
      retryLast();
    });
    stack.append(name, line, retry);
    wrap.append(makeAvatar('sm'), stack);
    return wrap;
  }

  function renderVoiceNote() {
    const note = el('p', 'muted-note');
    note.textContent = voiceNote;
    return note;
  }

  function previewText(message) {
    if (!message) return '대화를 시작해 보세요';
    if ((message.audioUrl && !message.text) || (message.voice && message.audioUrl)) return '음성메시지';
    return message.text;
  }

  function updateList() {
    const last = messages[messages.length - 1];
    if (showRetry) listPreview.textContent = '앗 미안 ㅠㅠ 잠깐 신호가 안 좋았나 봐…';
    else listPreview.textContent = previewText(last);
    if (last) {
      listTime.dateTime = new Date(last.time).toISOString();
      listTime.textContent = formatListTime(last.time);
    } else {
      listTime.textContent = '';
      listTime.removeAttribute('datetime');
    }
    const unread = Math.max(0, messages.length - settings.seen);
    if (unread > 0) {
      listBadge.hidden = false;
      listBadge.textContent = unread > 99 ? '99+' : String(unread);
    } else {
      listBadge.hidden = true;
    }
  }

  function updateSendButton() {
    const ready = input.value.trim().length > 0;
    sendBtn.classList.toggle('ready', ready);
    sendBtn.setAttribute('aria-disabled', ready ? 'false' : 'true');
  }

  function syncToggles() {
    autoplayBtn.setAttribute('aria-checked', settings.autoplay ? 'true' : 'false');
    voiceBtn.setAttribute('aria-checked', settings.voice ? 'true' : 'false');
  }

  function setMenu(open) {
    menuOpen = open;
    menu.hidden = !open;
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }


  // ---- main tabs: chat | moments | me ----
  let mainTab = 'chat';
  const tabBar = document.getElementById('tab-bar');
  const screenMe = document.getElementById('screen-me');
  const screenList = document.getElementById('screen-list');

  function setTabBarVisible(show) {
    if (!tabBar) return;
    tabBar.hidden = !show;
  }

  async function refreshMe() {
    if (!screenMe) return;
    try {
      const me = await fetch('/api/me').then((r) => r.json());
      const prof = await fetch(withChar('/api/profile')).then((r) => r.json());
      const wal = await fetch('/api/wallet').then((r) => r.json());
      const p = (prof && prof.profile) || {};
      const display = p.displayName || (me.user && me.user.username) || '—';
      const el = (id) => document.getElementById(id);
      if (el('me-display')) el('me-display').textContent = display;
      if (el('me-username')) el('me-username').textContent = me.user ? ('@' + me.user.username) : '';
      if (el('me-call')) el('me-call').textContent = p.callName || '—';
      if (el('me-charnick')) el('me-charnick').textContent = p.characterNickname || '백현';
      if (el('me-balance')) el('me-balance').textContent = String(wal.balance ?? 0);
    } catch (_) { /* ignore */ }
  }

  function switchMainTab(tab) {
    if (roomOpen) closeRoom();
    mainTab = tab;
    if (screenList) screenList.hidden = tab !== 'chat';
    if (screenMe) screenMe.hidden = tab !== 'me';
    if (window.Moments) {
      if (tab === 'moments') window.Moments.open({ asTab: true });
      else if (window.Moments.isOpen && window.Moments.isOpen()) window.Moments.close();
    }
    document.querySelectorAll('.tab-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    setTabBarVisible(true);
    if (tab === 'me') refreshMe();
  }

  if (tabBar) {
    tabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-item');
      if (!btn) return;
      switchMainTab(btn.dataset.tab);
    });
  }
  document.addEventListener('idol-tab', (e) => {
    if (e.detail && e.detail.tab) switchMainTab(e.detail.tab);
  });
  const meRecharge = document.getElementById('me-recharge');
  if (meRecharge) meRecharge.addEventListener('click', () => {
    location.href = '/shell/recharge.html?c=' + encodeURIComponent(CHARACTER_ID) + '&from=chat';
  });
  const meMemory = document.getElementById('me-memory');
  if (meMemory) meMemory.addEventListener('click', () => {
    const b = document.getElementById('memory-open-menu');
    if (b) b.click();
  });
  const meLogout = document.getElementById('me-logout');
  if (meLogout) meLogout.addEventListener('click', () => logout());
  const meReset = document.getElementById('me-reset');
  if (meReset) meReset.addEventListener('click', async () => {
    if (!confirm('重新走封面→选人→认识引导？当前聊天记录不会删。')) return;
    try {
      await fetch(withChar('/api/profile'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onboarded: false }),
      });
      location.href = '/shell/cover.html';
    } catch (_) { showToast('操作失败'); }
  });

  function openRoom() {
    roomOpen = true;
    setTabBarVisible(false);
    if (window.Moments && window.Moments.isOpen && window.Moments.isOpen()) window.Moments.close();
    room.classList.add('open');
    room.setAttribute('aria-hidden', 'false');
    room.inert = false;
    settings.seen = messages.length;
    saveSettings();
    themeMeta.setAttribute('content', '#B2C7D9');
    render();
    input.focus();
  }

  function closeRoom() {
    roomOpen = false;
    stopAllAudio();
    setMenu(false);
    closeSheet();
    closeProfile();
    room.classList.remove('open');
    room.setAttribute('aria-hidden', 'true');
    room.inert = true;
    themeMeta.setAttribute('content', '#ffffff');
    updateList();
    switchMainTab(mainTab === 'moments' || mainTab === 'me' ? 'chat' : mainTab);
    document.getElementById('open-chat').focus();
  }

  function openSheet() {
    sheet.hidden = false;
  }

  function closeSheet() {
    sheet.hidden = true;
  }

  function openProfile() {
    setMenu(false);
    profileSheet.hidden = false;
    document.getElementById('profile-close').focus();
  }

  function closeProfile() {
    if (profileSheet.hidden) return;
    profileSheet.hidden = true;
    if (roomOpen) document.getElementById('profile-btn').focus();
  }

  function openModal() {
    setMenu(false);
    modal.hidden = false;
    document.getElementById('modal-cancel').focus();
  }

  function closeModal() {
    modal.hidden = true;
  }

  async function clearHistory() {
    generation += 1;
    if (chatAbort) chatAbort.abort('cancel');
    messages = [];
    typing = false;
    busy = false;
    showRetry = false;
    retryFresh = false;
    retryAt = 0;
    voiceNote = '';
    settings.seen = 0;
    saveLocalHistory();
    saveSettings();
    closeModal();
    setMenu(false);
    render();
    try {
      const response = await fetch(withChar('/api/history'), { method: 'DELETE' });
      if (response.status === 401) {
        location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error('clear failed');
    } catch (err) {
      showToast('서버 대화 기록을 지우지 못했어요');
    }
  }

  async function logout() {
    setMenu(false);
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (err) {
      /* still leave */
    }
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch (err) {
      /* ignore */
    }
    location.href = '/login';
  }

  function historyPayload() {
    return messages
      .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string' && item.text.trim() && !item.ephemeral)
      .slice(-20)
      .map((item) => (item.role === 'assistant' && item.zh ? { role: item.role, content: item.text, zh: item.zh } : { role: item.role, content: item.text }));
  }

  function failReply() {
    typing = false;
    showRetry = true;
    retryFresh = true;
    retryAt = Date.now();
    voiceNote = '';
    render();
  }

  async function requestReply() {
    if (busy) return;
    const hasUser = messages.some((item) => item.role === 'user' && item.text && item.text.trim());
    if (!hasUser) return;

    busy = true;
    showRetry = false;
    voiceNote = '';
    const myGen = ++generation;
    if (chatAbort) chatAbort.abort('cancel');
    const controller = new AbortController();
    chatAbort = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CLIENT_TIMEOUT_MS);
    stopAllAudio();
    typing = true;
    render();

    try {
      const response = await fetch(withChar('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: historyPayload(), voice: settings.voice, sceneId: pendingSceneId || undefined }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (myGen !== generation) return;
      if (response.status === 401) {
        location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error('chat failed');
      const data = await response.json();
      if (data.relationship) applyRelationship(data.relationship, true);
      const bubbles = Array.isArray(data.bubbles)
        ? data.bubbles.map((bubble) => String(bubble).trim()).filter(Boolean).slice(0, 4)
        : [];
      const voiceItems = Array.isArray(data.messages) ? data.messages.filter((m) => m && typeof m.ko === 'string' && m.ko.trim()).slice(0, 3) : [];
      if (voiceItems.length) {
        let failedAny = false;
        for (let i = 0; i < voiceItems.length; i += 1) {
          const item = voiceItems[i];
          if (myGen !== generation) return;
          const audio = settings.voice ? safeAudioUrl(item.audioUrl) : null;
          recording = Boolean(audio);
          typing = true;
          render();
          // "Recording" gap scales with clip length; first one a bit shorter since we already waited.
          await sleep(Math.min(3200, (i === 0 ? 300 : 700) + item.ko.length * 45));
          if (myGen !== generation) return;
          typing = false;
          recording = false;
          if (item.ttsFailed) failedAny = true;
          messages.push({ role: 'assistant', text: item.ko.trim(), zh: String(item.zh || ''), mood: String(item.mood || ''), time: Date.now(), audioUrl: audio, voice: true, ttsFailed: Boolean(item.ttsFailed) });
          saveHistory();
          animateLast = true;
          render();
        }
        if (failedAny) showToast('有条语音没发出来，已改成文字');
        return;
      }
      if (!bubbles.length) throw new Error('chat failed');

      for (let i = 0; i < bubbles.length; i += 1) {
        if (myGen !== generation) return;
        typing = true;
        render();
        await sleep(bubbleDelay(bubbles[i]));
        if (myGen !== generation) return;
        typing = false;
        messages.push({ role: 'assistant', text: bubbles[i], time: Date.now(), audioUrl: null });
        saveHistory();
        animateLast = true;
        render();
      }

      const audioUrl = settings.voice ? safeAudioUrl(data.audioUrl) : null;
      if (audioUrl) {
        if (myGen !== generation) return;
        typing = true;
        render();
        await sleep(bubbleDelay(bubbles.join('\n')));
        if (myGen !== generation) return;
        typing = false;
        messages.push({ role: 'assistant', text: '', time: Date.now(), audioUrl });
        saveHistory();
        animateLast = true;
        render();
        if (false && settings.autoplay && roomOpen) {
          const audios = messagesEl.querySelectorAll('audio');
          const newest = audios[audios.length - 1];
          if (newest) {
            playExclusive(newest).then(() => {
              if (!roomOpen) {
                newest.pause();
                return;
              }
              syncPlayState();
            }).catch(() => {});
          }
        }
      } else if (settings.voice && myGen === generation && data.audioError) {
        voiceNote = data.audioError === 'Voice is not configured'
          ? '음성은 아직 준비되지 않았어요'
          : '음성은 이번엔 못 보냈어요';
        render();
      }
    } catch (err) {
      if (myGen !== generation) return;
      if (err && err.name === 'AbortError' && !timedOut) return;
      failReply();
    } finally {
      clearTimeout(timer);
      if (myGen === generation) {
        const stillTyping = typing;
        typing = false;
        busy = false;
        if (stillTyping) render();
      }
    }
  }

  let pendingSceneId = null;

  async function sendScene(scene) {
    if (!scene || !scene.messageKo) return;
    if (busy) {
      showToast('답장을 기다리는 중이에요');
      return;
    }
    pendingSceneId = scene.id || null;
    messages.push({ role: 'user', text: scene.messageKo, time: Date.now(), audioUrl: null });
    saveHistory();
    showRetry = false;
    voiceNote = '';
    animateLast = true;
    document.querySelectorAll('.scene-chip').forEach((b) => { b.disabled = true; });
    try {
      await requestReply();
    } finally {
      pendingSceneId = null;
      document.querySelectorAll('.scene-chip').forEach((b) => { b.disabled = false; });
    }
  }

  async function loadScenes() {
    const bar = document.getElementById('scene-bar');
    if (!bar) return;
    try {
      const r = await fetch(withChar('/api/scenes'));
      if (!r.ok) return;
      const d = await r.json();
      const scenes = d.scenes || [];
      bar.innerHTML = '';
      if (!scenes.length) { bar.hidden = true; return; }
      for (const sc of scenes) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'scene-chip';
        btn.textContent = sc.label;
        if (sc.hintZh) btn.title = sc.hintZh;
        btn.addEventListener('click', () => sendScene(sc));
        bar.appendChild(btn);
      }
      bar.hidden = false;
    } catch (_) { bar.hidden = true; }
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    if (busy) {
      showToast('답장을 기다리는 중이에요');
      return;
    }
    messages.push({ role: 'user', text, time: Date.now(), audioUrl: null });
    saveHistory();
    input.value = '';
    updateSendButton();
    showRetry = false;
    voiceNote = '';
    animateLast = true;
    await requestReply();
  }

  function retryLast() {
    if (busy) return;
    const lastUser = messages.some((item) => item.role === 'user' && item.text && item.text.trim());
    if (!lastUser) return;
    requestReply();
  }

  loadScenes();
  document.getElementById('open-chat').addEventListener('click', openRoom);
  document.getElementById('back-btn').addEventListener('click', closeRoom);
  document.getElementById('profile-btn').addEventListener('click', openProfile);
  menuBtn.addEventListener('click', () => setMenu(!menuOpen));
  document.getElementById('plus-btn').addEventListener('click', openSheet);
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) closeSheet();
  });
  document.getElementById('profile-close').addEventListener('click', closeProfile);
  profileSheet.addEventListener('click', (event) => {
    if (event.target === profileSheet) closeProfile();
  });
  document.getElementById('clear-btn').addEventListener('click', openModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-confirm').addEventListener('click', () => { clearHistory(); });
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });
  autoplayBtn.addEventListener('click', () => {
    settings.autoplay = !settings.autoplay;
    saveSettings();
    syncToggles();
  });
  voiceBtn.addEventListener('click', () => {
    settings.voice = !settings.voice;
    saveSettings();
    syncToggles();
  });
  input.addEventListener('input', updateSendButton);
  input.addEventListener('compositionend', () => {
    lastCompositionEnd = Date.now();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.repeat) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (Date.now() - lastCompositionEnd < 40) return;
    event.preventDefault();
    send();
  });
  sendBtn.addEventListener('click', send);
  document.getElementById('composer').addEventListener('submit', (event) => {
    event.preventDefault();
  });

  document.addEventListener('click', (event) => {
    if (!menuOpen) return;
    if (menu.contains(event.target) || menuBtn.contains(event.target)) return;
    setMenu(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!modal.hidden) closeModal();
    else if (!profileSheet.hidden) closeProfile();
    else if (!sheet.hidden) closeSheet();
    else if (menuOpen) setMenu(false);
    else if (roomOpen) closeRoom();
  });

  mountStaticAvatars();
  syncToggles();
  updateSendButton();
  render();

  pullHistoryFromServer().then((remote) => {
    if (!remote) return;
    messages = remote;
    saveLocalHistory();
    if (roomOpen) settings.seen = messages.length;
    saveSettings();
    render();
  }).catch(() => {
    showToast('서버에서 대화 기록을 불러오지 못했어요');
  });
})();
