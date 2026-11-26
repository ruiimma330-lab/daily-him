function readCharacterId() {
  const fromUrl = new URLSearchParams(location.search).get('c');
  if (fromUrl) return fromUrl.toLowerCase();
  try {
    const account = localStorage.getItem('idol_account_id');
    if (account && window.AccountCache) {
      const saved = window.AccountCache.getSelected(localStorage, account);
      if (saved) return saved;
    }
    if (!account) {
      const legacy = localStorage.getItem('idol_selected_character');
      if (legacy) return String(legacy).toLowerCase();
    }
  } catch (_) { /* ignore */ }
  return 'baekhyun';
}
const CHARACTER_ID = readCharacterId();
const withChar = (u) => `${u}${u.includes('?') ? '&' : '?'}characterId=${encodeURIComponent(CHARACTER_ID)}`;
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

  let accountId = '';
  let historyReady = false;
  let historyError = false;
  let HISTORY_KEY = '';
  let SETTINGS_KEY = '';
  const CLIENT_TIMEOUT_MS = 100000;
  const RETRY_TEXT = '앗 미안 ㅠㅠ 잠깐 신호가 안 좋았나 봐… 다시 보내줄래? 🐶';

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
  const aiNotice = document.getElementById('ai-notice');
  const aiNoticeOk = document.getElementById('ai-notice-ok');
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  let friendsCache = [];

  let messages = [];
  let settings = { autoplay: false, seen: 0, playback: 'tap', translation: 'collapsed' };
  let roomOpen = false;
  let menuOpen = false;
  let typing = false;
  let busy = false;
  let animateLast = false;
  let generation = 0;
  let chatAbort = null;
  let toastTimer = 0;
  let lastCompositionEnd = 0;
  let showRetry = false;
  let retryFresh = false;
  let retryAt = 0;
  let characterVoiceUnavailable = false;
  let characterReadOnly = false;
  let characterAccessKnown = false;
  let voiceNote = '';
  let charRemark = '';
  let userNickname = '';
  let aiNoticeAccountId = '';
  let fallbackScenes = { offline: [], voice: [] };
  const FALLBACK_CACHE_KEY = `dh_fallbacks_v1:${CHARACTER_ID}`;
  const FALLBACK_RECENT_PREFIX = `dh_fallback_recent_v1:${CHARACTER_ID}:`;
  const charDefault = { name: '백현', emoji: '🐶' };

  function normalizeFallbackLines(lines) {
    if (!Array.isArray(lines)) return [];
    return lines
      .filter((line) => line && typeof line.ko === 'string' && line.ko.trim() && typeof line.zh === 'string' && line.zh.trim())
      .map((line) => ({ ko: line.ko.trim(), zh: line.zh.trim() }));
  }

  function cacheFallbackScenes(raw) {
    fallbackScenes = {
      offline: normalizeFallbackLines(raw && raw.offline),
      voice: normalizeFallbackLines(raw && raw.voice),
    };
    try { localStorage.setItem(FALLBACK_CACHE_KEY, JSON.stringify(fallbackScenes)); } catch (_) { /* optional */ }
  }

  function restoreFallbackScenes() {
    try { cacheFallbackScenes(JSON.parse(localStorage.getItem(FALLBACK_CACHE_KEY) || '{}')); } catch (_) { /* optional */ }
  }

  function pickClientFallback(scene) {
    const lines = fallbackScenes[scene] || [];
    if (!lines.length) return null;
    const key = FALLBACK_RECENT_PREFIX + scene;
    let remembered = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '[]');
      remembered = Array.isArray(parsed) ? parsed.filter((text) => typeof text === 'string') : [];
    } catch (_) { remembered = []; }
    const visible = new Set(messages.filter((item) => item && item.fallback).map((item) => item.text));
    let pool = lines.filter((line) => !remembered.includes(line.ko) && !visible.has(line.ko));
    if (!pool.length) pool = lines.filter((line) => !remembered.includes(line.ko));
    if (!pool.length) pool = lines;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    remembered = [...remembered, picked.ko].slice(-Math.max(1, lines.length - 1));
    try { localStorage.setItem(key, JSON.stringify(remembered)); } catch (_) { /* optional */ }
    return picked;
  }

  restoreFallbackScenes();

  function shownName() {
    const nick = String(charRemark || '').trim();
    return nick || charDefault.name;
  }

  function shownTitle() {
    return charDefault.emoji ? `${shownName()} ${charDefault.emoji}` : shownName();
  }

  // While a reply is on the way the NAME line itself becomes 「正在输入…」, keeping the
  // avatar and the spark. No second typing bubble is drawn in the thread.
  const TYPING_TITLE = '正在输入…';

  function paintRoomTitle() {
    const nameNode = document.getElementById('room-name');
    if (!nameNode) return;
    nameNode.textContent = typing ? TYPING_TITLE : shownTitle();
    nameNode.classList.toggle('is-typing', Boolean(typing));
  }

  function applyCharacterLabels() {
    document.querySelectorAll('[data-char-label]').forEach((node) => {
      node.textContent = node.getAttribute('data-char-label') === 'title' ? shownTitle() : shownName();
    });
    document.title = `Daily Him · ${shownName()}`;
    paintRoomTitle();
  }

  let characterAvatarUrl = `/characters/${encodeURIComponent(CHARACTER_ID)}/avatar?v=dh-pwa-29`;
  let userAvatarVersion = 0;

  function paintCharacterAvatar(node) {
    if (!node) return;
    const img = document.createElement('img');
    img.className = 'char-photo';
    img.alt = '';
    img.src = characterAvatarUrl;
    img.addEventListener('error', () => {
      img.remove();
      if (!node.querySelector('svg')) node.append(puppyIcon());
    });
    node.replaceChildren(img);
  }

  function applyUserAvatar() {
    document.querySelectorAll('[data-user-avatar]').forEach((node) => {
      let img = node.querySelector('img.user-photo');
      if (!userAvatarVersion) {
        if (img) img.remove();
        return;
      }
      if (!img) {
        img = document.createElement('img');
        img.className = 'user-photo';
        img.alt = '';
        node.append(img);
      }
      img.src = `/api/me/avatar?v=${userAvatarVersion}`;
    });
  }

  window.IdolChat = {
    shownName,
    shownTitle,
    paintAvatar: paintCharacterAvatar,
    applyUserAvatar,
    logout,
    applyPrefs: (next) => applyPrefs(next),
    isReadOnly: () => writesBlocked(),
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function syncAiNotice(me) {
    if (!aiNotice) return;
    aiNoticeAccountId = me && me.user && me.user.id ? me.user.id : '';
    // The response is authoritative. A local flag is written only as a fast-path hint.
    aiNotice.hidden = !me || !me.user || me.aiDisclaimerAcknowledged !== false;
  }

  if (aiNoticeOk) {
    aiNoticeOk.addEventListener('click', async () => {
      if (aiNoticeOk.disabled) return;
      aiNoticeOk.disabled = true;
      try {
        const response = await fetch('/api/me/ai-disclaimer', { method: 'POST' });
        if (!response.ok) throw new Error('acknowledgement failed');
        if (aiNoticeAccountId) localStorage.setItem(`idol-ai-disclaimer-${aiNoticeAccountId}`, '1');
        aiNotice.hidden = true;
      } catch (_) {
        showToast('请检查网络连接后重试');
      } finally {
        aiNoticeOk.disabled = false;
      }
    });
  }

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
        turnId: typeof item.turnId === 'string' ? item.turnId : '',
        voice: item.voice === true,
        zh: typeof item.zh === 'string' ? item.zh : '',
        mood: typeof item.mood === 'string' ? item.mood : '',
        ttsFailed: item.ttsFailed === true,
        fallback: item.fallback === true,
        failed: item.failed === true,
      }));
  }

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      let prefs = {};
      try {
        prefs = accountId ? JSON.parse(localStorage.getItem(window.AccountCache.prefsKey(accountId)) || '{}') : {};
      } catch (_) { prefs = {}; }
      const playback = prefs.playback === 'auto' || raw.playback === 'auto' ? 'auto' : 'tap';
      const translation = prefs.translation === 'expanded' || raw.translation === 'expanded' ? 'expanded' : 'collapsed';
      return {
        autoplay: playback === 'auto',
        voice: true,
        seen: Number.isFinite(raw.seen) && raw.seen > 0 ? raw.seen : 0,
        playback,
        translation,
      };
    } catch (err) {
      return { autoplay: false, voice: true, seen: 0, playback: 'tap', translation: 'collapsed' };
    }
  }

  let historySyncTimer = 0;
  let historySyncing = false;

  function historySnapshot() {
    return messages.filter((item) => !item.ephemeral).map((item) => ({
      role: item.role,
      text: item.text,
      time: item.time,
      audioUrl: item.audioUrl,
      turnId: item.turnId || undefined,
      voice: item.voice || undefined,
      zh: item.zh || undefined,
      mood: item.mood || undefined,
      ttsFailed: item.ttsFailed || undefined,
      fallback: item.fallback || undefined,
      failed: item.failed || undefined,
    }));
  }

  function saveLocalHistory() {
    if (!HISTORY_KEY || !historyReady) return;
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(historySnapshot()));
    } catch (err) {
      showToast('이 브라우저에 대화를 저장하지 못했어요');
    }
  }

  function saveHistory() {
    saveLocalHistory();
    if (writesBlocked()) return;
    clearTimeout(historySyncTimer);
    historySyncTimer = setTimeout(syncHistoryToServer, 250);
  }

  async function syncHistoryToServer() {
    if (!historyReady || writesBlocked()) return;
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
  const SPARK_FLAME = '<svg class="spark-flame" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="none" aria-hidden="true"><path d="M12 20.6c-3.4-1.6-5.3-5.1-4.7-8.7.4 1.5 1.5 2.4 2.5 2.4C9.6 9.6 11.2 6.4 14.4 3.6c.1 3.2 2.7 5.2 2.9 8.4.3 3.3-1.8 6.6-5.3 8.6z" stroke="currentColor" stroke-width="1.55" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  function renderSpark() {
    const node = document.getElementById('spark');
    if (!node || !relState) return;
    node.hidden = false;
    node.className = `spark ${relState.streakState}`;
    node.innerHTML = `${SPARK_FLAME}<span class="spark-count">${relState.streak || 0}</span>`;
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
      `连续聊天 <span class="spark spark-inline ${relState.streakState}">${SPARK_FLAME}</span> ${relState.streak || 0} 天`,
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
    if (wasUp) showToast(`和${shownName()}的关系变近了一点：${TIER_LABEL[rel.tier.id] || rel.tier.name} 💛`);
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
    setCharacterReadOnly(data && data.readOnly === true);
    return normalizeHistoryList(data && data.messages);
  }

  function saveSettings() {
    if (!SETTINGS_KEY) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) {
      /* settings are optional */
    }
  }

  function safeAudioUrl(url) {
    if (typeof url !== 'string' || url.includes('..')) return null;
    return /^\/(?:audio|singing)\/[A-Za-z0-9_./-]+$/.test(url) ? url : null;
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function writesBlocked() {
    return !characterAccessKnown || characterReadOnly;
  }

  function applyCharacterAccessUi() {
    const blocked = writesBlocked();
    document.documentElement.dataset.characterReadOnly = characterReadOnly ? 'true' : 'false';
    const banner = document.getElementById('readonly-bar');
    const composer = document.querySelector('.composer-wrap');
    const sceneBar = document.getElementById('scene-bar');
    if (banner) banner.hidden = !characterReadOnly;
    if (composer) composer.hidden = blocked;
    input.disabled = blocked;
    sendBtn.disabled = blocked;
    if (sceneBar) sceneBar.hidden = blocked || !sceneBar.children.length;
    ['voice-toggle', 'remark-open', 'moments-open-menu', 'moments-open-profile', 'sheet-moments', 'sheet-sing', 'tab-moments'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.hidden = blocked;
    });
  }

  function setCharacterReadOnly(readOnly) {
    characterReadOnly = Boolean(readOnly);
    characterAccessKnown = true;
    applyCharacterAccessUi();
    document.dispatchEvent(new CustomEvent('idol-character-readonly', { detail: { readOnly: characterReadOnly } }));
    render();
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
    paintCharacterAvatar(node);
    return node;
  }

  function mountStaticAvatars() {
    document.querySelectorAll('[data-avatar]').forEach((node) => paintCharacterAvatar(node));
  }

  function speakerIcon(playing) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', playing
      ? 'M7 5h3.2v14H7V5zm6.8 0H17v14h-3.2V5z'
      : 'M4 9.5v5h3.2L12 19V5L7.2 9.5H4zm10.15-1.55a4.3 4.3 0 0 1 0 8.1l-.85-1.35a2.7 2.7 0 0 0 0-5.4l.85-1.35z');
    svg.append(path);
    return svg;
  }

  // Ring with a gap: the "voice is still arriving" state, never a ready play icon.
  function spinnerIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '7');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2.4');
    circle.setAttribute('stroke-linecap', 'round');
    circle.setAttribute('stroke-dasharray', '30 14');
    svg.append(circle);
    return svg;
  }

  function setSpeakIcon(button, playing) {
    const want = playing ? 'pause' : 'play';
    if (button.dataset.icon === want) return;
    button.dataset.icon = want;
    button.replaceChildren(speakerIcon(playing));
    button.setAttribute('aria-pressed', playing ? 'true' : 'false');
    button.setAttribute('aria-label', playing ? '일시정지' : '음성 재생');
  }

  function setSpeakLoading(button, loading) {
    if (!button) return;
    button.classList.toggle('busy', loading);
    if (loading) {
      if (button.dataset.icon !== 'loading') {
        button.dataset.icon = 'loading';
        button.replaceChildren(spinnerIcon());
      }
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', '음성 준비 중');
      return;
    }
    button.removeAttribute('aria-busy');
    if (button.dataset.icon === 'loading') {
      button.dataset.icon = '';
      setSpeakIcon(button, false);
    }
  }

  const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';
  function unlockAudio() {
    let node = document.getElementById('audio-unlock');
    if (!node) {
      node = document.createElement('audio');
      node.id = 'audio-unlock';
      node.setAttribute('playsinline', '');
      node.setAttribute('webkit-playsinline', '');
      document.body.append(node);
    }
    if (!node.src) node.src = SILENCE;
    const played = node.play();
    if (played && played.catch) played.catch(() => {});
  }
  document.addEventListener('pointerdown', unlockAudio, { passive: true });

  function attachVoiceFallback(message) {
    if (!message.voiceFallback) message.voiceFallback = pickClientFallback('voice');
    if (message.voiceFallback) render();
  }

  function voiceFailed(message) {
    message.ttsFailed = true;
    message.ttsPending = false;
    message.voiceToken = null;
    message.voiceFallback = message.voiceFallback || pickClientFallback('voice');
    paintPlayer(playback.playerFor(message));
    saveLocalHistory();
    if (message.voiceFallback) render();
  }

  function applyStarlightDenied(data) {
    const base = (data && data.notice) || '这条语音需要 15 星光';
    const isCap = data && (data.code === 'voice-cap' || data.code === 'site-cap');
    showToast(isCap ? base : `${base} · 去领取`);
    const bar = document.getElementById('star-bar');
    if (!bar) return;
    bar.hidden = false;
    bar.textContent = '先看文字';
    bar.onclick = () => { bar.hidden = true; };
  }

  // One clip per message, one request per clip. The overlap/rewind rules live in
  // public/playback.js so they can be tested without a browser.
  const VOICE_WAIT_BUDGET_MS = 2000; // how long the chat request may hold text for voice
  const VOICE_WAIT_TIMEOUT_MS = 8000; // after this the spinner gives up and the fallback shows
  let autoplayedTick = 0;
  const playback = window.DailyPlayback.createPlayback({
    createAudio: () => {
      const audio = el('audio');
      audio.preload = 'none';
      audio.setAttribute('playsinline', '');
      audio.setAttribute('webkit-playsinline', '');
      return audio;
    },
    cachedSource: (message) => safeAudioUrl(message && message.audioUrl),
    requestSource: (message) => requestVoice(message),
    onChange: (player) => paintPlayer(player),
    onAudioError: (message, player) => {
      // A broken cached URL gets one silent retry through the normal TTS path.
      const audio = player.audio;
      if (audio.dataset.retried === '1') {
        showToast('음성을 재생하지 못했어요');
        voiceFailed(message);
        return;
      }
      audio.dataset.retried = '1';
      message.audioUrl = null;
      message.ttsFailed = false;
      try { audio.removeAttribute('src'); audio.load(); } catch (_) { /* ignore */ }
      requestVoice(message);
    },
  });

  function paintPlayer(player) {
    if (!player || !player.message) return;
    const button = player.button;
    if (!button || !button.isConnected) return;
    const playing = playback.isPlaying(player);
    const loading = !playing && (playback.isLoading(player) || player.message.ttsPending === true);
    if (loading) {
      setSpeakLoading(button, true);
      if (player.bubble) player.bubble.classList.remove('playing');
      return;
    }
    setSpeakLoading(button, false);
    setSpeakIcon(button, playing);
    if (player.bubble) player.bubble.classList.toggle('playing', playing);
  }

  function stopAllAudio() {
    if (!window.DailyPlayback) return;
    playback.stopAll();
    messages.forEach((message) => paintPlayer(playback.playerFor(message)));
  }

  // Speaker tap: second tap stops and rewinds; a tap while loading plays once when ready.
  function playMessageAudio(message) {
    unlockAudio();
    const player = playback.playerFor(message);
    if (message.starlightDenied) {
      applyStarlightDenied({ notice: message.starlightNotice, code: message.starlightCode || '' });
      return Promise.resolve();
    }
    return playback.toggle(message).then((result) => {
      if (result && result.action === 'blocked' && !message.text) {
        showToast('음성은 이번엔 못 보냈어요');
        attachVoiceFallback(message);
      }
      paintPlayer(player);
      return result;
    });
  }

  // Resolves to a playable URL for one message, or null. Shares the pending job, so a
  // tap during loading never sends a second request.
  function requestVoice(message) {
    if (message.voicePromise) return message.voicePromise;
    message.voicePromise = (async () => {
      try {
        const response = await fetch(withChar('/api/tts'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: message.text,
            mood: message.mood || '',
            // Joins the clip the chat request already started: same audio, one charge.
            voiceToken: message.voiceToken || undefined,
          }),
        });
        if (response.status === 401) {
          location.href = '/login';
          return null;
        }
        const data = await response.json().catch(() => ({}));
        const url = safeAudioUrl(data && data.audioUrl);
        if (response.status === 402 && data && data.error === 'starlight') {
          applyStarlightDenied(data);
          message.starlightDenied = true;
          message.starlightNotice = data.notice || '';
          message.starlightCode = data.code || '';
          voiceFailed(message);
          return null;
        }
        if (!response.ok || !url) {
          showToast(data && data.audioError === 'Voice is not configured'
            ? '음성은 아직 준비되지 않았어요'
            : '음성은 이번엔 못 보냈어요');
          voiceFailed(message);
          return null;
        }
        message.audioUrl = url;
        message.ttsFailed = false;
        message.ttsPending = false;
        message.voiceToken = null;
        saveHistory();
        playback.refresh(message);
        return url;
      } catch (_) {
        showToast('음성은 이번엔 못 보냈어요');
        voiceFailed(message);
        return null;
      } finally {
        message.voicePromise = null;
        paintPlayer(playback.playerFor(message));
      }
    })();
    return message.voicePromise;
  }

  // Text is already on screen: collect the clip, but never let the spinner run past ~8s.
  async function waitForVoice(message) {
    const player = playback.playerFor(message);
    paintPlayer(player);
    const timer = setTimeout(() => {
      if (safeAudioUrl(message.audioUrl) || !message.ttsPending) return;
      message.ttsPending = false;
      voiceFailed(message);
    }, VOICE_WAIT_TIMEOUT_MS);
    const url = await requestVoice(message);
    clearTimeout(timer);
    if (!url) return;
    const hadFallback = Boolean(message.voiceFallback);
    message.ttsPending = false;
    message.voiceFallback = null;
    message.ttsFailed = false;
    if (hadFallback) render();
    else paintPlayer(player);
    scheduleAutoplay();
  }

  // Character reply: Korean text, speaker (TTS on tap), Chinese collapsed underneath.
  function buildReplyBubble(message) {
    const bubble = el('div', 'bubble reply');
    if (message.fallback) {
      bubble.classList.add('is-fallback');
      bubble.dataset.fallback = 'true';
    }
    const text = typeof message.text === 'string' ? message.text : '';
    if (text) {
      const ko = el('p', 'ko-text');
      ko.textContent = text;
      bubble.append(ko);
    } else {
      bubble.classList.add('audio-only');
    }

    const zhText = typeof message.zh === 'string' ? message.zh.trim() : '';
    const canSpeak = Boolean(safeAudioUrl(message.audioUrl)) || message.ttsPending === true
      || (!writesBlocked() && /[\p{L}\p{N}]/u.test(text));
    if (canSpeak) {
      const player = playback.playerFor(message);
      const button = el('button', 'speak');
      button.type = 'button';
      setSpeakIcon(button, false);
      player.button = button;
      player.bubble = bubble;
      const audio = player.audio;
      // The audio node outlives the bubble; only the registry stops a detached clip.
      if (audio.parentNode && audio.parentNode !== bubble) audio.parentNode.removeChild(audio);
      const src = safeAudioUrl(message.audioUrl);
      if (src && audio.getAttribute('src') !== src) audio.src = src;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        playMessageAudio(message);
      });
      bubble.append(button, audio);
      paintPlayer(player);
    }

    if (zhText) {
      const expanded = settings.translation === 'expanded';
      const toggle = el('button', 'vtoggle');
      toggle.type = 'button';
      toggle.textContent = expanded ? '翻译 ▴' : '翻译 ▾';
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      const zh = el('p', 'vzh');
      zh.hidden = !expanded;
      zh.textContent = zhText;
      toggle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const open = zh.hidden;
        zh.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? '翻译 ▴' : '翻译 ▾';
      });
      bubble.append(toggle, zh);
    }
    if (message.fallback) {
      const label = el('small', 'fallback-label');
      label.textContent = message.fallbackScene === 'offline' ? '离线备用回复' : '备用回复';
      bubble.append(label);
    }
    if (message.voiceFallback) {
      const note = el('div', 'voice-fallback');
      const ko = el('span', 'ko');
      const zh = el('span', 'zh');
      ko.textContent = message.voiceFallback.ko;
      zh.textContent = message.voiceFallback.zh;
      note.append(ko, zh);
      bubble.append(note);
    }
    return bubble;
  }

  function buildTextBubble(message) {
    const bubble = el('div', 'bubble');
    bubble.textContent = message.text;
    return bubble;
  }

  function render() {
    // A rebuild tears down the bubbles, so stop anything still sounding first.
    stopAllAudio();
    messagesEl.replaceChildren();
    paintRoomTitle();
    if (historyError && !messages.length && !typing) {
      const box = el('div', 'history-miss');
      const note = el('p', 'history-miss-text');
      note.textContent = '没能加载对话';
      const retry = el('button', 'history-retry');
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', () => { loadAccountHistory(); });
      box.append(note, retry);
      messagesEl.append(box);
      updateList();
      return;
    }
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

    if (showRetry) messagesEl.append(renderRetry());
    if (characterVoiceUnavailable) voiceNote = '语音暂不可用';
    if (voiceNote && !typing) messagesEl.append(renderVoiceNote());
    animateLast = false;
    applyRoomSearch();

    if (roomOpen) {
      settings.seen = messages.length;
      saveSettings();
      requestAnimationFrame(() => {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
    updateList();
    scheduleAutoplay();
  }

  // Autoplay only starts once the speaker is genuinely ready: a real URL and no
  // request in flight. One attempt per new bubble, so a rebuild cannot fire twice.
  function scheduleAutoplay() {
    if (settings.playback !== 'auto' || !roomOpen || writesBlocked() || typing) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !String(last.text || '').trim()) return;
    if (!last.voice || autoplayedTick === last.time) return;
    if (last.ttsFailed || last.voiceFallback || last.starlightDenied) return;
    const player = playback.playerFor(last);
    if (!player || !safeAudioUrl(last.audioUrl) || playback.isLoading(player)) return;
    autoplayedTick = last.time;
    playMessageAudio(last);
  }

  function applyRoomSearch() {
    const field = document.getElementById('room-search-input');
    const q = field ? field.value.trim().toLowerCase() : '';
    document.querySelectorAll('#messages .line').forEach((line) => {
      line.hidden = Boolean(q) && !line.textContent.toLowerCase().includes(q);
    });
    document.querySelectorAll('#messages .group').forEach((group) => {
      const lines = [...group.querySelectorAll('.line')];
      if (!lines.length) return;
      group.hidden = Boolean(q) && lines.every((line) => line.hidden);
    });
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
    const wrap = el('div', `group ${incoming ? 'in named' : 'out'}${fresh ? ' fresh' : ''}`);
    if (incoming) wrap.append(makeAvatar('sm'));
    const stack = el('div', 'stack');
    if (incoming) {
      const name = el('div', 'sender');
      name.setAttribute('data-char-label', 'name');
      name.textContent = shownName();
      stack.append(name);
    }
    group.forEach((message, messageIndex) => {
      const line = el('div', 'line');
      const last = messageIndex === group.length - 1;
      const bubble = incoming ? buildReplyBubble(message) : buildTextBubble(message);
      if (messageIndex === 0) bubble.classList.add('sharp');
      const meta = el('div', 'meta');
      if (!incoming && unread && !message.failed) {
        const read = el('span', 'read');
        read.textContent = '1';
        meta.append(read);
      }
      if (!incoming && message.failed) {
        const again = el('button', 'resend');
        again.type = 'button';
        again.textContent = '重发';
        again.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          message.failed = false;
          retryLast();
        });
        meta.append(again);
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

  function renderRetry() {
    const wrap = el('div', `group in named${retryFresh ? ' fresh' : ''}`);
    retryFresh = false;
    const stack = el('div', 'stack');
    const name = el('div', 'sender');
    name.setAttribute('data-char-label', 'name');
    name.textContent = shownName();
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
    if (message.text) return message.text;
    if (message.audioUrl) return '음성';
    return '대화를 시작해 보세요';
  }

  let welcomingSameChar = false;
  async function openFriendChat(friend) {
    if (!friend || !friend.id) return;
    if (friend.id === CHARACTER_ID) {
      openRoom();
      if (historyReady && messages.length === 0 && !welcomingSameChar) {
        welcomingSameChar = true;
        try {
          const seeded = await welcomeIfNeeded([]);
          if (seeded.length && messages.length === 0 && historyReady) {
            messages = seeded;
            settings.seen = messages.length;
            saveHistory();
            saveSettings();
            render();
          }
        } finally {
          welcomingSameChar = false;
        }
      }
    } else {
      location.href = '/?c=' + encodeURIComponent(friend.id) + '&open=1';
    }
  }

  async function loadFriendsList() {
    if (!window.FriendsList) return;
    const list = await window.FriendsList.load({ onOpen: openFriendChat, accountId });
    friendsCache = Array.isArray(list) ? list.slice() : [];
    updateList();
  }

  function updateList() {
    if (!historyReady) return;
    const last = messages[messages.length - 1];
    if (!window.FriendsList) return;
    window.FriendsList.updateCurrent(CHARACTER_ID, {
      preview: showRetry ? '앗 미안 ㅠㅠ 잠깐 신호가 안 좋았나 봐…' : previewText(last),
      time: last && last.time,
      unread: Math.max(0, messages.length - settings.seen),
    });
  }

  function updateSendButton() {
    const ready = input.value.trim().length > 0;
    sendBtn.classList.toggle('ready', ready);
    sendBtn.setAttribute('aria-disabled', ready ? 'false' : 'true');
  }

  function syncToggles() {
    const auto = settings.playback === 'auto';
    settings.autoplay = auto;
    if (autoplayBtn) autoplayBtn.setAttribute('aria-checked', auto ? 'true' : 'false');
    if (voiceBtn) {
      voiceBtn.setAttribute('aria-checked', auto ? 'true' : 'false');
      const label = voiceBtn.querySelector('span');
      if (label) label.textContent = auto ? '自动播放' : '点了才播';
    }
  }

  function applyPrefs(next) {
    if (!next || typeof next !== 'object') return;
    if (next.playback === 'tap' || next.playback === 'auto') settings.playback = next.playback;
    if (next.translation === 'collapsed' || next.translation === 'expanded') settings.translation = next.translation;
    if (typeof next.nickname === 'string') userNickname = next.nickname.trim();
    document.documentElement.dataset.playback = settings.playback || 'tap';
    document.documentElement.dataset.translation = settings.translation || 'collapsed';
    try {
      if (accountId && window.AccountCache) {
        const key = window.AccountCache.prefsKey(accountId);
        const prev = JSON.parse(localStorage.getItem(key) || '{}');
        localStorage.setItem(key, JSON.stringify({
          ...prev,
          playback: settings.playback,
          translation: settings.translation,
          nickname: userNickname,
          aiNoticeSeen: typeof next.aiNoticeSeen === 'boolean' ? next.aiNoticeSeen : prev.aiNoticeSeen === true,
        }));
        if (typeof next.nickname === 'string') {
          const prevMe = window.AccountCache.getMe(localStorage, accountId) || { id: accountId };
          window.AccountCache.setMe(localStorage, accountId, {
            ...prevMe,
            id: accountId,
            nickname: userNickname,
          });
        }
      }
    } catch (_) { /* ignore */ }
    saveSettings();
    syncToggles();
    const profileName = document.getElementById('me-profile-name');
    if (profileName && (userNickname || profileName.textContent === '我' || profileName.textContent === '—')) {
      profileName.textContent = userNickname || profileName.textContent;
    }
    if (userNickname && profileName) profileName.textContent = userNickname;
    if (roomOpen) render();
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
    if (tab === 'me' && window.Me && window.Me.open) window.Me.open();
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

  function openRoom(opts = {}) {
    const wasOpen = roomOpen;
    roomOpen = true;
    if (!wasOpen && !opts.fromPopState) {
      try {
        if (!history.state || !history.state.dailyhimRoom || history.state.c !== CHARACTER_ID) {
          history.pushState({ dailyhimRoom: true, c: CHARACTER_ID }, '', location.pathname + location.search);
        }
      } catch (_) { /* ignore */ }
    }
    setTabBarVisible(false);
    if (window.Moments && window.Moments.isOpen && window.Moments.isOpen()) window.Moments.close();
    room.classList.add('open');
    room.setAttribute('aria-hidden', 'false');
    room.inert = false;
    settings.seen = messages.length;
    saveSettings();
    themeMeta.setAttribute('content', '#B2C7D9');
    render();
    if (!writesBlocked()) input.focus();
  }

  function closeRoom(opts = {}) {
    roomOpen = false;
    if (!opts.fromPopState) {
      try {
        if (history.state && history.state.dailyhimRoom) {
          history.replaceState(null, '', location.pathname + location.search);
        }
      } catch (_) { /* ignore */ }
    }
    stopAllAudio();
    setMenu(false);
    closeSheet();
    closeProfile();
    const memPanel = document.getElementById('mem-panel');
    if (memPanel && !memPanel.hidden) memPanel.hidden = true;
    if (document.activeElement && room.contains(document.activeElement)) document.activeElement.blur();
    room.classList.remove('open');
    room.setAttribute('aria-hidden', 'true');
    room.inert = true;
    themeMeta.setAttribute('content', '#ffffff');
    updateList();
    switchMainTab(mainTab === 'moments' || mainTab === 'me' ? 'chat' : mainTab);
    const focusRow = document.querySelector('#friends-section .chat-row[data-friend-id="' + CSS.escape(CHARACTER_ID) + '"]');
    if (focusRow) focusRow.focus();
  }

  window.addEventListener('popstate', (event) => {
    if (roomOpen) {
      if (!event.state || !event.state.dailyhimRoom) closeRoom({ fromPopState: true });
      return;
    }
    if (event.state && event.state.dailyhimRoom && (!event.state.c || event.state.c === CHARACTER_ID)) {
      openRoom({ fromPopState: true });
    }
  });

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

  let clearConfirmStep = 0;

  function paintClearConfirmation(step) {
    clearConfirmStep = step;
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    const confirm = document.getElementById('modal-confirm');
    title.textContent = step === 1 ? '清空聊天记录' : '再次确认';
    body.textContent = step === 1
      ? `将删除你和${shownName()}的聊天记录，以及这段聊天的摘要。他记得的你与亲密度会保留。`
      : '再确认一次。这一步之后才会删除，且无法恢复。';
    confirm.textContent = step === 1 ? '继续' : '确认清空';
  }

  function openModal() {
    setMenu(false);
    paintClearConfirmation(1);
    modal.hidden = false;
    document.getElementById('modal-cancel').focus();
  }

  function closeModal() {
    modal.hidden = true;
    clearConfirmStep = 0;
  }

  async function clearHistory() {
    generation += 1;
    if (chatAbort) chatAbort.abort('cancel');
    try {
      const response = await fetch(withChar('/api/history?summary=1'), { method: 'DELETE' });
      if (response.status === 401) {
        location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error('clear failed');
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
      showToast('聊天记录已清空');
    } catch (err) {
      showToast('没有清空');
    }
  }

  async function logout() {
    setMenu(false);
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch (err) {
      /* still leave */
    }
    messages = [];
    historyReady = false;
    historyError = false;
    if (window.FriendsList && window.FriendsList.resetState) window.FriendsList.resetState();
    try { localStorage.removeItem('idol_account_id'); } catch (err) { /* ignore */ }
    location.href = '/login';
  }

  function currentUserText() {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user' && messages[i].text && messages[i].text.trim()) return messages[i].text.trim();
    }
    return '';
  }

  function failReply() {
    typing = false;
    showRetry = false;
    retryFresh = false;
    voiceNote = '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        messages[i].failed = true;
        break;
      }
    }
    saveLocalHistory();
    render();
  }

  function clearSendFailures() {
    let changed = false;
    messages.forEach((item) => {
      if (item.failed) {
        item.failed = false;
        changed = true;
      }
    });
    if (changed) saveLocalHistory();
  }

  async function requestReply() {
    if (busy || writesBlocked()) return;
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
        body: JSON.stringify({
          text: currentUserText(),
          // Voice now rides with the reply by default. The server answers as soon as the
          // clip is ready or after this short budget, so text is never held back for long.
          voiceWaitMs: VOICE_WAIT_BUDGET_MS,
          sceneId: pendingSceneId || undefined,
          turnId: activeTurnId || undefined,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (myGen !== generation) return;
      if (response.status === 401) {
        location.href = '/login';
        return;
      }
      if (response.status === 402) {
        const denied = await response.json().catch(() => ({}));
        const bar = document.getElementById('star-bar');
        if (bar) {
          bar.hidden = false;
          bar.textContent = '星光不够啦 · 去领取';
          bar.onclick = () => { location.href = '/shell/starlight.html'; };
        }
        if (input.value.trim() === '') {
          input.value = currentUserText();
          updateSendButton();
        }
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i].role === 'user') { messages.splice(i, 1); break; }
        }
        saveLocalHistory();
        typing = false;
        busy = false;
        render();
        return;
      }
      if (!response.ok) throw new Error('chat failed');
      clearSendFailures();
      const data = await response.json();
      if (data.starlight && data.starlight.notice) {
        const bar = document.getElementById('star-bar');
        if (bar) {
          bar.hidden = false;
          bar.textContent = data.starlight.notice;
          bar.onclick = () => { location.href = '/shell/starlight.html'; };
        }
      }
      if (data.relationship) applyRelationship(data.relationship, true);
      const bubbles = Array.isArray(data.bubbles)
        ? data.bubbles.map((bubble) => String(bubble).trim()).filter(Boolean).slice(0, 4)
        : [];
      const voiceItems = Array.isArray(data.messages) ? data.messages.filter((m) => m && typeof m.ko === 'string' && m.ko.trim()).slice(0, 3) : [];
      if (voiceItems.length) {
        for (let i = 0; i < voiceItems.length; i += 1) {
          const item = voiceItems[i];
          if (myGen !== generation) return;
          typing = true;
          render();
          await sleep(i === 0 ? Math.min(900, 320 + item.ko.length * 18) : bubbleDelay(item.ko));
          if (myGen !== generation) return;
          typing = false;
          // Text is revealed now. Voice rides along when it is already ready; otherwise
          // the speaker shows a spinner and the single follow-up request below fills it in.
          const message = {
            role: 'assistant',
            text: item.ko.trim(),
            zh: String(item.zh || ''),
            mood: String(item.mood || ''),
            time: Date.now(),
            audioUrl: safeAudioUrl(item.audioUrl),
            ttsPending: item.ttsPending === true && !safeAudioUrl(item.audioUrl),
            voice: true,
            fallback: item.fallback === true,
            voiceFallback: item.ttsFailed === true ? pickClientFallback('voice') : null,
          };
          messages.push(message);
          saveHistory();
          animateLast = true;
          render();
          if (message.ttsPending) waitForVoice(message);
        }
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
        messages.push({ role: 'assistant', text: bubbles[i], time: Date.now(), audioUrl: null, voice: true });
        saveHistory();
        animateLast = true;
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
        paintRoomTitle();
      }
    }
  }

  let pendingSceneId = null;
  let activeTurnId = '';

  function newTurnId() {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function appendOfflineFallback() {
    const line = pickClientFallback('offline');
    if (!line) {
      showToast('网络断开了，连上后再发送');
      return false;
    }
    messages.push({
      role: 'assistant',
      text: line.ko,
      zh: line.zh,
      time: Date.now(),
      audioUrl: null,
      fallback: true,
      fallbackScene: 'offline',
      ephemeral: true,
    });
    animateLast = true;
    render();
    return true;
  }

  async function sendScene(scene) {
    if (!scene || !scene.messageKo || writesBlocked()) return;
    if (navigator.onLine === false) {
      appendOfflineFallback();
      return;
    }
    if (busy) {
      showToast('답장을 기다리는 중이에요');
      return;
    }
    pendingSceneId = scene.id || null;
    activeTurnId = newTurnId();
    messages.push({ role: 'user', text: scene.messageKo, time: Date.now(), audioUrl: null, turnId: activeTurnId });
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
      bar.hidden = writesBlocked();
    } catch (_) { bar.hidden = true; }
  }

  async function sendText(rawText, { clearInput = false } = {}) {
    const text = String(rawText || '').trim();
    if (!text) return;
    if (writesBlocked()) {
      showToast('该角色暂未开放，当前仅可查看');
      return;
    }
    if (navigator.onLine === false) {
      appendOfflineFallback();
      return;
    }
    if (busy) {
      showToast('답장을 기다리는 중이에요');
      return;
    }
    activeTurnId = newTurnId();
    messages.push({ role: 'user', text, time: Date.now(), audioUrl: null, turnId: activeTurnId });
    saveHistory();
    if (clearInput) {
      input.value = '';
      updateSendButton();
    }
    showRetry = false;
    voiceNote = '';
    animateLast = true;
    await requestReply();
  }

  async function send() {
    return sendText(input.value, { clearInput: true });
  }

  function retryLast() {
    if (busy || writesBlocked()) return;
    if (navigator.onLine === false) {
      appendOfflineFallback();
      return;
    }
    let lastUser = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user' && messages[i].text && messages[i].text.trim()) {
        lastUser = messages[i];
        break;
      }
    }
    if (!lastUser) return;
    activeTurnId = lastUser.turnId || newTurnId();
    lastUser.turnId = activeTurnId;
    requestReply();
  }

  applyCharacterAccessUi();
  loadScenes();
  document.getElementById('back-btn').addEventListener('click', () => closeRoom());
  document.getElementById('profile-btn').addEventListener('click', openProfile);
  menuBtn.addEventListener('click', () => setMenu(!menuOpen));
  document.getElementById('plus-btn').addEventListener('click', openSheet);
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  const sheetSing = document.getElementById('sheet-sing');
  if (sheetSing) {
    sheetSing.addEventListener('click', () => {
      closeSheet();
      sendText('给我清唱一段吧');
    });
  }
  const sheetMoments = document.getElementById('sheet-moments');
  if (sheetMoments) {
    sheetMoments.addEventListener('click', () => {
      closeSheet();
      if (window.Moments && window.Moments.open) window.Moments.open();
    });
  }
  const sheetMemory = document.getElementById('sheet-memory');
  if (sheetMemory) {
    sheetMemory.addEventListener('click', () => {
      closeSheet();
      const memBtn = document.getElementById('memory-open-menu');
      if (memBtn) memBtn.click();
    });
  }
  const sheetStarlight = document.getElementById('sheet-starlight');
  if (sheetStarlight) {
    sheetStarlight.addEventListener('click', () => {
      closeSheet();
      location.href = '/shell/starlight.html';
    });
  }
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) closeSheet();
  });
  document.getElementById('profile-close').addEventListener('click', closeProfile);
  profileSheet.addEventListener('click', (event) => {
    if (event.target === profileSheet) closeProfile();
  });
  document.getElementById('clear-btn').addEventListener('click', openModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-confirm').addEventListener('click', () => {
    if (clearConfirmStep === 1) paintClearConfirmation(2);
    else if (clearConfirmStep === 2) clearHistory();
  });
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });
  async function persistPrefs(patch) {
    applyPrefs(patch);
    try {
      const response = await fetch('/api/me/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (response.ok) {
        const data = await response.json();
        if (data && data.settings) applyPrefs(data.settings);
      }
    } catch (_) { /* local copy still applies */ }
  }
  if (autoplayBtn) {
    autoplayBtn.addEventListener('click', () => {
      persistPrefs({ playback: settings.playback === 'auto' ? 'tap' : 'auto' });
    });
  }
  if (voiceBtn) {
    voiceBtn.addEventListener('click', () => {
      persistPrefs({ playback: settings.playback === 'auto' ? 'tap' : 'auto' });
    });
  }
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

  const remarkModal = document.getElementById('remark-modal');
  const remarkInput = document.getElementById('remark-input');
  const remarkForm = document.getElementById('remark-form');

  function openRemark() {
    setMenu(false);
    if (!remarkModal || !remarkInput) return;
    remarkInput.value = charRemark;
    remarkInput.placeholder = charDefault.name;
    remarkModal.hidden = false;
    remarkInput.focus();
  }

  function closeRemark() {
    if (!remarkModal || remarkModal.hidden) return;
    remarkModal.hidden = true;
  }

  async function saveRemark(event) {
    event.preventDefault();
    const next = remarkInput.value.trim().slice(0, 20);
    const saveBtn = document.getElementById('remark-save');
    if (saveBtn) saveBtn.disabled = true;
    try {
      const response = await fetch(withChar('/api/profile'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterNickname: next }),
      });
      if (response.status === 401) {
        location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error('save failed');
      const data = await response.json();
      const saved = data && data.profile && data.profile.characterNickname;
      charRemark = typeof saved === 'string' ? saved : next;
      applyCharacterLabels();
      loadFriendsList();
      closeRemark();
      showToast('备注已更新');
    } catch (err) {
      showToast('备注没保存上');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function setMyName(profile, me) {
    const node = document.getElementById('me-profile-name');
    if (!node) return;
    const display = userNickname || (profile && profile.displayName) || (me && me.user && me.user.username) || '我';
    node.textContent = display;
  }

  async function loadAlias() {
    try {
      const [profRes, charsRes, meRes, historyRes] = await Promise.all([
        fetch(withChar('/api/profile')),
        fetch('/api/characters'),
        fetch('/api/me'),
        fetch('/api/conversations'),
      ]);
      let profile = null;
      if (charsRes.ok) {
        const chars = await charsRes.json();
        const history = historyRes.ok ? await historyRes.json() : {};
        const ch = [...(chars.characters || []), ...(history.conversations || [])].find((item) => item.id === CHARACTER_ID);
        if (ch) {
          setCharacterReadOnly(ch.available === false);
          cacheFallbackScenes(ch.fallbacks);
          characterVoiceUnavailable = !ch.voiceAvailable;
          if (characterVoiceUnavailable) { voiceNote = '语音暂不可用'; render(); }
          if (ch.displayName || ch.name) charDefault.name = ch.displayName || ch.name;
          if (typeof ch.displayEmoji === 'string') charDefault.emoji = ch.displayEmoji;
          if (typeof ch.avatar === 'string' && ch.avatar.startsWith('/characters/')) characterAvatarUrl = ch.avatar;
          const statusEl = document.getElementById('profile-status');
          if (statusEl) {
            const statusText = String(ch.status || ch.tagline || ch.bio || [ch.group, ch.company].filter(Boolean).join(' · ') || '').trim();
            statusEl.textContent = statusText;
            statusEl.hidden = !statusText;
          }
        }
      }
      if (profRes.ok) {
        const prof = await profRes.json();
        profile = prof && prof.profile;
        const nick = profile && profile.characterNickname;
        charRemark = typeof nick === 'string' ? nick : '';
      }
      const me = meRes.ok ? await meRes.json() : null;
      syncAiNotice(me);
      setMyName(profile, me);
      if (me && me.user && me.user.id && window.AccountCache) {
        const prevMe = window.AccountCache.getMe(localStorage, me.user.id);
        window.AccountCache.setMe(localStorage, me.user.id, {
          id: me.user.id,
          username: me.user.username || '',
          nickname: userNickname || (prevMe && prevMe.nickname) || '',
          hasAvatar: Boolean(me.hasAvatar),
        });
      }
      if (me && me.hasAvatar) {
        if (!userAvatarVersion) userAvatarVersion = Date.now();
      } else if (me) {
        userAvatarVersion = 0;
      }
      applyUserAvatar();
    } catch (err) { /* keep the default name */ }
    applyCharacterLabels();
  }

  const remarkOpen = document.getElementById('remark-open');
  if (remarkOpen) remarkOpen.addEventListener('click', openRemark);
  const remarkCancel = document.getElementById('remark-cancel');
  if (remarkCancel) remarkCancel.addEventListener('click', closeRemark);
  if (remarkForm) remarkForm.addEventListener('submit', saveRemark);
  if (remarkModal) {
    remarkModal.addEventListener('click', (event) => {
      if (event.target === remarkModal) closeRemark();
    });
  }

  const rechargeOpen = document.getElementById('recharge-open');
  if (rechargeOpen) rechargeOpen.addEventListener('click', () => {
    location.href = '/shell/starlight.html#recharge';
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (remarkModal && !remarkModal.hidden) closeRemark();
    else if (!modal.hidden) closeModal();
    else if (!profileSheet.hidden) closeProfile();
    else if (!sheet.hidden) closeSheet();
    else if (menuOpen) setMenu(false);
    else if (roomOpen) closeRoom();
  });

  function togglePanel(button, panel, field) {
    if (!button || !panel) return;
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && field) field.focus();
  }

  const friendSearchBtn = document.getElementById('friend-search-btn');
  const friendSearch = document.getElementById('friend-search');
  const friendSearchInput = document.getElementById('friend-search-input');
  if (friendSearchBtn) {
    friendSearchBtn.addEventListener('click', () => togglePanel(friendSearchBtn, friendSearch, friendSearchInput));
  }
  if (friendSearchInput) {
    friendSearchInput.addEventListener('input', () => {
      const q = friendSearchInput.value.trim().toLowerCase();
      document.querySelectorAll('#friends-section .chat-row').forEach((row) => {
        row.hidden = Boolean(q) && !row.innerText.toLowerCase().includes(q);
      });
    });
  }

  const friendAdd = document.getElementById('friend-add-btn');
  if (friendAdd) friendAdd.addEventListener('click', () => {
    location.href = '/shell/pick.html?from=chat&c=' + encodeURIComponent(CHARACTER_ID);
  });
  const friendSettings = document.getElementById('friend-settings-btn');
  if (friendSettings) friendSettings.addEventListener('click', () => switchMainTab('me'));
  const meProfileRow = document.getElementById('me-profile-row');
  if (meProfileRow) meProfileRow.addEventListener('click', () => switchMainTab('me'));
  const friendsToggle = document.getElementById('friends-section-toggle');
  const friendsSection = document.getElementById('friends-section');
  if (friendsToggle && friendsSection) {
    friendsToggle.addEventListener('click', () => {
      const open = friendsToggle.getAttribute('aria-expanded') !== 'false';
      friendsToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      friendsToggle.classList.toggle('collapsed', open);
      friendsSection.hidden = open;
    });
  }

  const roomSearchBtn = document.getElementById('room-search-btn');
  const roomSearch = document.getElementById('room-search');
  const roomSearchInput = document.getElementById('room-search-input');
  if (roomSearchBtn) {
    roomSearchBtn.addEventListener('click', () => togglePanel(roomSearchBtn, roomSearch, roomSearchInput));
  }
  if (roomSearchInput) roomSearchInput.addEventListener('input', applyRoomSearch);

  const emojiBtn = document.getElementById('emoji-btn');
  const emojiPop = document.getElementById('emoji-pop');
  if (emojiBtn && emojiPop) {
    emojiBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      emojiPop.hidden = !emojiPop.hidden;
      emojiBtn.setAttribute('aria-expanded', emojiPop.hidden ? 'false' : 'true');
    });
    emojiPop.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-emoji]');
      if (!button) return;
      const emoji = button.dataset.emoji;
      const start = input.selectionStart == null ? input.value.length : input.selectionStart;
      const end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
      const pos = start + emoji.length;
      input.focus();
      input.setSelectionRange(pos, pos);
      updateSendButton();
    });
    document.addEventListener('click', (event) => {
      if (emojiPop.hidden) return;
      if (emojiPop.contains(event.target) || emojiBtn.contains(event.target)) return;
      emojiPop.hidden = true;
      emojiBtn.setAttribute('aria-expanded', 'false');
    });
  }

  const bootAccountId = (() => {
    try { return localStorage.getItem('idol_account_id') || ''; } catch (_) { return ''; }
  })();
  let bootHydratedMessages = false;
  let sessionSwitched = false;

  if (bootAccountId && window.AccountCache) {
    accountId = bootAccountId;
    HISTORY_KEY = window.AccountCache.historyKey(bootAccountId, CHARACTER_ID);
    SETTINGS_KEY = window.AccountCache.settingsKey(bootAccountId, CHARACTER_ID);
    settings = loadSettings();

    const cachedMe = window.AccountCache.getMe(localStorage, bootAccountId);
    if (cachedMe) {
      if (cachedMe.nickname) userNickname = cachedMe.nickname;
      const profileName = document.getElementById('me-profile-name');
      if (profileName) {
        profileName.textContent = (userNickname || cachedMe.nickname || cachedMe.username || '我').trim() || '我';
      }
      if (cachedMe.hasAvatar) {
        userAvatarVersion = 1;
        applyUserAvatar();
      }
    }

    if (window.FriendsList && window.FriendsList.hydrateFromCache) {
      if (window.FriendsList.hydrateFromCache(bootAccountId, { onOpen: openFriendChat })) {
        const cachedFriends = window.AccountCache.getFriends(localStorage, bootAccountId);
        if (Array.isArray(cachedFriends)) friendsCache = cachedFriends.slice();
      }
    }

    const cachedHistory = window.AccountCache.getHistory(localStorage, bootAccountId, CHARACTER_ID);
    if (Array.isArray(cachedHistory) && cachedHistory.length > 0) {
      messages = normalizeHistoryList(cachedHistory);
      if (messages.length > 0) {
        bootHydratedMessages = true;
        historyReady = true;
      }
    }
  }

  mountStaticAvatars();
  syncToggles();
  updateSendButton();
  render();
  if (bootHydratedMessages && new URLSearchParams(location.search).get('open') === '1') {
    openRoom();
  }

  document.addEventListener('idol-avatar', (event) => {
    userAvatarVersion = event.detail && event.detail.hasAvatar ? Date.now() : 0;
    applyUserAvatar();
  });
  document.addEventListener('idol-profile', (event) => {
    const detail = event.detail || {};
    if (detail.characterId === CHARACTER_ID && typeof detail.characterNickname === 'string') {
      charRemark = detail.characterNickname;
      applyCharacterLabels();
    }
    loadFriendsList();
  });
  document.addEventListener('idol-history-cleared', (event) => {
    const detail = event.detail || {};
      if (detail.all) {
      const keys = [];
      const prefix = accountId ? `idolchat_history_v1:${accountId}:` : '';
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (prefix && key && key.indexOf(prefix) === 0) keys.push(key);
      }
      keys.forEach((key) => localStorage.removeItem(key));
      messages = [];
      settings.seen = 0;
      saveSettings();
      render();
      return;
    }
    if (detail.characterId !== CHARACTER_ID) return;
    messages = [];
    settings.seen = 0;
    saveLocalHistory();
    saveSettings();
    render();
  });

  applyPrefs(settings);
  loadAlias();

  // First entry with an empty history. Copy comes from the pre-stored greetings file
  // (time of day + optional callName). welcomeKo / askNameKo stay as fallbacks for
  // characters without a greetings file. Nothing here calls the LLM.
  async function welcomeIfNeeded(remote) {
    try {
      const params = new URLSearchParams(location.search);
      const wantWelcome = params.get('welcome') === '1';
      const wantOpen = params.get('open') === '1' || roomOpen;
      if ((!wantWelcome && !wantOpen) || remote.length) return remote;
      let saved = {};
      try {
        const profileResponse = await fetch(withChar('/api/profile'));
        if (profileResponse.ok) {
          const named = await profileResponse.json();
          saved = (named && named.profile) || {};
        }
      } catch (_) { saved = {}; }
      if (!wantWelcome && saved.greetedAt) return remote;
      const naming = saved.callNameStatus === 'pending' || saved.callNameStatus === 'confirming';
      const mode = naming ? 'ask' : 'welcome';
      const markGreeted = () => {
        fetch(withChar('/api/profile'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ greeted: true }),
        }).catch(() => {});
      };
      let greeting = null;
      try {
        const response = await fetch(withChar(`/api/greeting?mode=${mode}`));
        if (response.ok) {
          const data = await response.json();
          greeting = (data && data.greeting) || null;
        }
      } catch (_) { greeting = null; }
      if (greeting && greeting.ko) {
        markGreeted();
        return [{
          role: 'assistant',
          text: greeting.ko,
          time: Date.now(),
          audioUrl: safeAudioUrl(greeting.audioUrl),
          zh: greeting.zh || '',
        }];
      }
      let ch = null;
      try {
        const response = await fetch('/api/characters');
        if (response.ok) {
          const data = await response.json();
          ch = (data.characters || []).find((item) => item.id === CHARACTER_ID) || null;
        }
      } catch (_) { ch = null; }
      if (naming && ch && ch.askNameKo) {
        markGreeted();
        return [{
          role: 'assistant',
          text: ch.askNameKo,
          time: Date.now(),
          audioUrl: null,
          zh: ch.askNameZh || '',
        }];
      }
      const text = ch && typeof ch.welcomeKo === 'string' ? ch.welcomeKo.trim() : '';
      if (!text) return remote;
      markGreeted();
      return [{
        role: 'assistant',
        text,
        time: Date.now(),
        audioUrl: null,
        zh: typeof ch.welcomeZh === 'string' ? ch.welcomeZh : '',
      }];
    } catch (_) {
      return remote;
    }
  }

  async function ensureAccount() {
    let response;
    try {
      response = await fetch('/api/me');
    } catch (_) {
      return '';
    }
    if (response.status === 401) {
      try { localStorage.removeItem('idol_account_id'); } catch (_) { /* ignore */ }
      if (window.FriendsList && window.FriendsList.resetState) window.FriendsList.resetState();
      location.href = '/login';
      return 'leave';
    }
    if (!response.ok) return '';
    const data = await response.json().catch(() => null);
    const id = data && data.user && data.user.id;
    if (!id || !window.AccountCache) return '';
    const prev = bootAccountId || (() => {
      try { return localStorage.getItem('idol_account_id') || ''; } catch (_) { return ''; }
    })();
    const urlChar = new URLSearchParams(location.search).get('c');
    window.AccountCache.adopt(localStorage, id, urlChar || CHARACTER_ID);
    const switched = Boolean(prev && prev !== id);
    if (switched) {
      sessionSwitched = true;
      messages = [];
      historyReady = false;
      historyError = false;
      bootHydratedMessages = false;
      friendsCache = [];
      userNickname = '';
      userAvatarVersion = 0;
      if (window.FriendsList && window.FriendsList.resetState) window.FriendsList.resetState();
      if (!urlChar) {
        const saved = window.AccountCache.getSelected(localStorage, id) || 'baekhyun';
        const next = new URL(location.href);
        next.searchParams.set('c', saved);
        location.replace(`${next.pathname}?${next.searchParams.toString()}`);
        return 'leave';
      }
      const nextMe = window.AccountCache.getMe(localStorage, id);
      const profileName = document.getElementById('me-profile-name');
      if (profileName) {
        profileName.textContent = (nextMe && (nextMe.nickname || nextMe.username)) || (data.user && data.user.username) || '我';
      }
      userAvatarVersion = data.hasAvatar ? Date.now() : 0;
      applyUserAvatar();
      let hydrated = false;
      if (window.FriendsList && window.FriendsList.hydrateFromCache) {
        hydrated = window.FriendsList.hydrateFromCache(id, { onOpen: openFriendChat });
        if (hydrated) {
          const cachedFriends = window.AccountCache.getFriends(localStorage, id);
          if (Array.isArray(cachedFriends)) friendsCache = cachedFriends.slice();
        }
      }
      if (!hydrated) {
        const friendsRoot = document.getElementById('friends-section');
        if (friendsRoot) {
          const loading = document.createElement('p');
          loading.className = 'friends-empty';
          loading.textContent = '加载中…';
          friendsRoot.replaceChildren(loading);
        }
      }
      render();
    }
    accountId = id;
    window.AccountCache.setSelected(localStorage, id, CHARACTER_ID);
    HISTORY_KEY = window.AccountCache.historyKey(id, CHARACTER_ID);
    SETTINGS_KEY = window.AccountCache.settingsKey(id, CHARACTER_ID);
    const existingMe = window.AccountCache.getMe(localStorage, id);
    let prefNickname = '';
    try {
      const rawPrefs = JSON.parse(localStorage.getItem(window.AccountCache.prefsKey(id)) || '{}');
      if (rawPrefs && typeof rawPrefs.nickname === 'string') prefNickname = rawPrefs.nickname.trim();
    } catch (_) { /* ignore */ }
    window.AccountCache.setMe(localStorage, id, {
      id,
      username: (data.user && data.user.username) || '',
      nickname: prefNickname || (switched ? '' : userNickname) || (existingMe && existingMe.nickname) || '',
      hasAvatar: Boolean(data.hasAvatar),
    });
    return id;
  }

  async function loadAccountHistory() {
    historyError = false;
    const hasVerifiedCache = Boolean(
      !sessionSwitched
      && accountId
      && accountId === bootAccountId
      && bootHydratedMessages
      && messages.length > 0
    );
    if (!hasVerifiedCache) {
      historyReady = false;
      messages = window.AccountCache.viewAfterFetch(false, null);
      render();
    }
    let remote = null;
    try {
      remote = await pullHistoryFromServer();
    } catch (_) {
      remote = null;
    }
    if (!remote) {
      if (!hasVerifiedCache) {
        messages = window.AccountCache.viewAfterFetch(false, null);
        historyError = true;
        historyReady = false;
        render();
      }
      return;
    }
    const params = new URLSearchParams(location.search);
    // welcome=1: seed greeting, stay on list. open=1: enter the chat room.
    const fromWelcome = params.get('welcome') === '1';
    const wantOpen = params.get('open') === '1';
    const wantTab = params.get('tab');
    const seeded = await welcomeIfNeeded(remote);
    messages = window.AccountCache.viewAfterFetch(true, seeded);
    historyError = false;
    historyReady = true;
    if (seeded !== remote) saveHistory();
    else saveLocalHistory();
    let checkinAppended = false;
    if (!characterReadOnly) {
      try {
        const checkin = await fetch(withChar('/api/checkin'), { method: 'POST' });
        if (checkin.ok) {
          const payload = await checkin.json();
          if (payload && payload.appended && Array.isArray(payload.messages)) {
            messages = window.AccountCache.viewAfterFetch(true, payload.messages);
            checkinAppended = true;
            saveLocalHistory();
          }
        }
      } catch (_) { /* check-in is best-effort */ }
    }
    if (fromWelcome || wantOpen || wantTab) {
      params.delete('welcome');
      params.delete('open');
      params.delete('tab');
      const cleaned = params.toString();
      history.replaceState(
        roomOpen ? { dailyhimRoom: true, c: CHARACTER_ID } : null,
        '',
        cleaned ? `${location.pathname}?${cleaned}` : location.pathname
      );
    }
    if (roomOpen || wantOpen) settings.seen = messages.length;
    saveSettings();
    render();
    if (seeded !== remote || checkinAppended || !friendsCache.length) {
      await loadFriendsList();
    }
    updateList();
    if (wantOpen) openRoom();
    else if (wantTab === 'moments' && !characterReadOnly) switchMainTab('moments');
  }

  async function bootAccount() {
    const id = await ensureAccount();
    if (id === 'leave') return;
    if (!id) {
      historyError = true;
      messages = [];
      render();
      await loadFriendsList();
      return;
    }
    settings = loadSettings();
    applyPrefs(settings);
    const fetchSettings = async () => {
      try {
        const response = await fetch('/api/me/settings');
        if (response.ok) {
          const data = await response.json();
          if (data && data.settings) applyPrefs(data.settings);
        }
      } catch (_) { /* local prefs remain until the next visit */ }
    };
    await Promise.all([fetchSettings(), loadFriendsList(), loadAccountHistory()]);
  }
  bootAccount();
})();
