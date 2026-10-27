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

  const HISTORY_KEY = 'idolchat_history_v1';
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

  let messages = loadHistory();
  let settings = loadSettings();
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
  let voiceNote = '';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function loadHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string' && !item.ephemeral)
        .map((item) => ({
          role: item.role,
          text: item.text,
          time: typeof item.time === 'number' ? item.time : Date.now(),
          audioUrl: safeAudioUrl(item.audioUrl),
        }));
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

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.map((item) => ({
        role: item.role,
        text: item.text,
        time: item.time,
        audioUrl: item.audioUrl,
      }))));
    } catch (err) {
      showToast('이 브라우저에 대화를 저장하지 못했어요');
    }
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
      const bubble = message.audioUrl && !message.text ? buildVoiceBubble(message) : buildTextBubble(message);
      if (messageIndex === 0) bubble.classList.add('sharp');
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
    bubble.setAttribute('aria-label', '입력 중...');
    for (let i = 0; i < 3; i += 1) bubble.append(el('span', 'dot'));
    const label = el('span', 'typing-label');
    label.textContent = '입력 중...';
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
    if (message.audioUrl && !message.text) return '음성메시지';
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

  function openRoom() {
    roomOpen = true;
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

  function clearHistory() {
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
    saveHistory();
    saveSettings();
    closeModal();
    setMenu(false);
    render();
  }

  function historyPayload() {
    return messages
      .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string' && item.text.trim() && !item.ephemeral)
      .slice(-20)
      .map((item) => ({ role: item.role, content: item.text }));
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
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: historyPayload(), voice: settings.voice }),
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
      const bubbles = Array.isArray(data.bubbles)
        ? data.bubbles.map((bubble) => String(bubble).trim()).filter(Boolean).slice(0, 4)
        : [];
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
        if (settings.autoplay && roomOpen) {
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
  document.getElementById('modal-confirm').addEventListener('click', clearHistory);
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
})();
