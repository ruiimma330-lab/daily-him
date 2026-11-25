'use strict';

// The playback controller owns the "no overlapping voice" guarantees. These tests drive
// it with a fake <audio> element, so a second tap, a re-render, or a slow clip is checked
// as behaviour instead of as source text.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayback } = require('../public/playback');

const ROOT = path.join(__dirname, '..');

function fakeAudio() {
  const listeners = {};
  return {
    currentTime: 5,
    paused: true,
    ended: false,
    played: 0,
    _src: null,
    addEventListener(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); },
    emit(name) { (listeners[name] || []).forEach((fn) => fn()); },
    getAttribute(name) { return name === 'src' ? this._src : null; },
    set src(value) { this._src = value; this.currentTime = 0; this.ended = false; },
    get src() { return this._src; },
    removeAttribute(name) { if (name === 'src') this._src = null; },
    play() {
      this.played += 1;
      this.paused = false;
      this.ended = false;
      this.emit('play');
      return Promise.resolve();
    },
    pause() {
      const was = this.paused;
      this.paused = true;
      if (!was) this.emit('pause');
    },
    finish() {
      this.paused = true;
      this.ended = true;
      this.emit('ended');
    },
    load() { /* no-op in the fake */ },
  };
}

function harness(overrides = {}) {
  const nodes = [];
  const events = [];
  const playback = createPlayback({
    createAudio: () => { const node = fakeAudio(); nodes.push(node); return node; },
    cachedSource: (message) => message.audioUrl || null,
    requestSource: overrides.requestSource || (async (message) => message.audioUrl || null),
    onChange: (player) => events.push(player),
    onAudioError: (message) => events.push({ error: message }),
  });
  return { playback, nodes, events };
}

test('a second tap on a playing clip stops it and rewinds to the start', async () => {
  const { playback, nodes } = harness();
  const message = { text: '안녕', audioUrl: '/audio/aaaa.mp3' };
  const first = await playback.toggle(message);
  assert.equal(first.action, 'played');
  const audio = nodes[0];
  assert.equal(audio.played, 1);
  assert.equal(audio.paused, false);
  assert.equal(playback.isPlaying(playback.playerFor(message)), true);

  audio.currentTime = 3.5;
  const second = await playback.toggle(message);
  assert.equal(second.action, 'stopped');
  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 0, 'stop rewinds to 0');

  const third = await playback.toggle(message);
  assert.equal(third.action, 'played');
  assert.equal(audio.played, 2, 'replay starts the same node again');
  assert.equal(audio.currentTime, 0, 'replay starts from the beginning');
});

test('two different clips never overlap: starting one stops and rewinds the other', async () => {
  const { playback, nodes } = harness();
  const one = { text: '첫 번째', audioUrl: '/audio/1111.mp3' };
  const two = { text: '두 번째', audioUrl: '/audio/2222.mp3' };
  await playback.toggle(one);
  const a = nodes[0];
  await playback.toggle(two);
  const b = nodes[1];
  assert.equal(a.paused, true, 'the first clip is paused');
  assert.equal(a.currentTime, 0, 'the first clip is rewound');
  assert.equal(b.paused, false, 'the second clip plays');
  assert.equal(playback.active().message, two);
  assert.equal(playback.isPlaying(playback.playerFor(one)), false);
  assert.equal(playback.isPlaying(playback.playerFor(two)), true);
});

test('a tap while loading never starts a second request and plays once when ready', async () => {
  let calls = 0;
  let resolveRequest;
  const { playback, nodes } = harness({
    requestSource: () => {
      calls += 1;
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
  });
  const message = { text: '느린 음성', audioUrl: null };
  const first = playback.toggle(message);
  const second = await playback.toggle(message);
  const third = await playback.toggle(message);
  assert.equal(calls, 1, 'only one request is made while loading');
  assert.equal(second.action, 'queued');
  assert.equal(third.action, 'queued');
  assert.equal(playback.isLoading(playback.playerFor(message)), true);
  assert.equal(nodes.length, 1);

  resolveRequest('/audio/slow.mp3');
  const result = await first;
  assert.equal(result.action, 'played');
  assert.equal(nodes[0].played, 1, 'exactly one play when the clip is ready');
  assert.equal(nodes[0].paused, false);
});

test('a failed clip leaves the player idle, so the next tap can retry once', async () => {
  let calls = 0;
  const { playback } = harness({
    requestSource: async () => {
      calls += 1;
      return calls === 1 ? null : '/audio/retry.mp3';
    },
  });
  const message = { text: '다시', audioUrl: null };
  const failed = await playback.toggle(message);
  assert.equal(failed.action, 'blocked');
  assert.equal(playback.isLoading(playback.playerFor(message)), false);
  const retried = await playback.toggle(message);
  assert.equal(retried.action, 'played');
  assert.equal(calls, 2);
});

test('stopAll silences and rewinds every clip, including a detached one', async () => {
  const { playback, nodes } = harness();
  const one = { text: '하나', audioUrl: '/audio/aaa1.mp3' };
  const two = { text: '둘', audioUrl: '/audio/bbb2.mp3' };
  await playback.toggle(one);
  const a = nodes[0];
  await playback.toggle(two);
  const b = nodes[1];
  // "Detached" in the DOM still means the registry can stop it.
  a.currentTime = 2;
  playback.stopAll();
  assert.equal(a.paused, true);
  assert.equal(a.currentTime, 0);
  assert.equal(b.paused, true);
  assert.equal(b.currentTime, 0);
  assert.equal(playback.active(), null);
});

test('ending a clip clears the active player and rewinds it', async () => {
  const { playback, nodes } = harness();
  const message = { text: '끝', audioUrl: '/audio/end1.mp3' };
  await playback.toggle(message);
  nodes[0].finish();
  assert.equal(playback.isPlaying(playback.playerFor(message)), false);
  assert.equal(playback.active(), null);
  assert.equal(nodes[0].currentTime, 0);
});

test('a late clip can be attached without starting playback', async () => {
  const { playback, nodes } = harness();
  const message = { text: '나중', audioUrl: null };
  const player = playback.playerFor(message);
  assert.equal(playback.isReady(player), false);
  message.audioUrl = '/audio/late.mp3';
  playback.refresh(message);
  assert.equal(nodes[0].getAttribute('src'), '/audio/late.mp3');
  assert.equal(nodes[0].paused, true, 'attaching never auto-plays');
  assert.equal(playback.isReady(player), true);
});

test('the app wires the shared controller and stops audio before every rebuild', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.match(app, /window\.DailyPlayback\.createPlayback\(/);
  assert.equal(app.includes('function playExclusive'), false, 'the old exclusive helper is gone');
  // render() must stop audio before it tears the message list down.
  const render = app.slice(app.indexOf('function render() {'), app.indexOf('function render() {') + 700);
  assert.ok(render.indexOf('stopAllAudio()') > 0, 'render stops audio');
  assert.ok(render.indexOf('stopAllAudio()') < render.indexOf('messagesEl.replaceChildren()'), 'stop comes first');
  // Autoplay waits for a real URL and no in-flight request, and fires once per bubble.
  const autoplay = app.slice(app.indexOf('function scheduleAutoplay'), app.indexOf('function applyRoomSearch'));
  assert.match(autoplay, /settings\.playback !== 'auto'/);
  assert.match(autoplay, /safeAudioUrl\(last\.audioUrl\)/);
  assert.match(autoplay, /playback\.isLoading\(player\)/);
  assert.match(autoplay, /autoplayedTick === last\.time/);
  assert.equal(/maybeAutoplay\(\)/.test(app), false, 'only one autoplay entry point remains');
});

test('the chat request no longer hardcodes voice:false and asks for a short voice wait', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const chat = app.slice(app.indexOf("fetch(withChar('/api/chat')"), app.indexOf("fetch(withChar('/api/chat')") + 900);
  assert.equal(chat.includes('voice: false'), false, 'chat voice is no longer disabled by default');
  assert.match(chat, /voiceWaitMs: VOICE_WAIT_BUDGET_MS/);
  assert.match(app, /const VOICE_WAIT_BUDGET_MS = 2000;/);
  assert.match(app, /const VOICE_WAIT_TIMEOUT_MS = 8000;/);
  // The pending clip is joined with its token, so one clip is charged once.
  assert.match(app, /voiceToken: message\.voiceToken/);
});

test('the waiting speaker is a spinner, never a ready play icon', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const painter = app.slice(app.indexOf('function paintPlayer'), app.indexOf('function stopAllAudio'));
  assert.match(painter, /playback\.isLoading\(player\)/);
  assert.match(painter, /message\.ttsPending === true/);
  assert.match(painter, /setSpeakLoading\(button, true\)/);
  const loading = app.slice(app.indexOf('function setSpeakLoading'), app.indexOf('const SILENCE'));
  assert.match(loading, /spinnerIcon\(\)/);
  assert.match(loading, /음성 준비 중/);
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  assert.match(css, /\.bubble\.reply \.speak\.busy svg \{ animation: speak-spin/);
  assert.match(css, /@keyframes speak-spin/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*speak\.busy svg \{ animation: none/);
});

test('the header name shows 正在输入… and the thread has no second typing bubble', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.match(app, /const TYPING_TITLE = '正在输入…';/);
  const title = app.slice(app.indexOf('function paintRoomTitle'), app.indexOf('function applyCharacterLabels'));
  assert.match(title, /nameNode\.textContent = typing \? TYPING_TITLE : shownTitle\(\)/);
  assert.match(title, /getElementById\('room-name'\)/);
  // The in-thread typing bubble is no longer rendered; only the header indicator runs.
  assert.equal(app.includes('messagesEl.append(renderTyping())'), false);
  assert.equal(app.includes('renderTyping()'), false);
  assert.equal(app.includes("'입력 중...'"), false);
  // The avatar stays: the header still paints the character avatar, and the .name node remains.
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /id="room-name"/);
  assert.match(html, /data-avatar/);
});

test('the first-enter greeting comes from the pre-stored file, with welcomeKo as fallback', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const welcome = app.slice(app.indexOf('async function welcomeIfNeeded'), app.indexOf('async function ensureAccount'));
  assert.match(welcome, /\/api\/greeting\?mode=\$\{mode\}/);
  assert.match(welcome, /greeting\.ko/);
  assert.match(welcome, /greeting\.zh/);
  assert.match(welcome, /safeAudioUrl\(greeting\.audioUrl\)/);
  assert.match(welcome, /ch\.askNameKo/, 'askNameKo stays as a fallback');
  assert.match(welcome, /ch\.welcomeKo/, 'welcomeKo stays as a fallback');
  // No client-side invented greeting survives.
  assert.equal(welcome.includes('왔구나. 오늘 뭐 하고 있었어?'), false);
  assert.equal(welcome.includes('来了呀。今天在做什么？'), false);
  assert.match(welcome, /const mode = naming \? 'ask' : 'welcome';/);
});

test('the service worker precaches the new script under a bumped cache name', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.match(sw, /const VERSION = 'dh-pwa-20';/);
  assert.match(sw, /'\/playback\.js'/);
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(scripts[0], '/sw-heal.js');
  assert.ok(scripts.indexOf('/playback.js') > 0, 'playback loads before app.js');
  assert.ok(scripts.indexOf('/playback.js') < scripts.indexOf('/app.js'));
});
