/* One play controller per message.
   Rules this module owns (and the tests pin):
   - at most one clip sounds at a time; starting one stops and rewinds every other node,
     including nodes that a re-render detached from the document;
   - a second tap on the playing clip stops it and rewinds to 0;
   - a tap while the clip is loading never starts a second request: it marks "play once";
   - stopAll() silences every node in the registry, not just the ones still in the DOM. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DailyPlayback = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function rewind(audio) {
    try { audio.currentTime = 0; } catch (_) { /* not seekable yet */ }
  }

  function createPlayback(options) {
    const opts = options || {};
    const createAudio = typeof opts.createAudio === 'function' ? opts.createAudio : null;
    const requestSource = typeof opts.requestSource === 'function' ? opts.requestSource : null;
    const cachedSource = typeof opts.cachedSource === 'function' ? opts.cachedSource : () => null;
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
    const onAudioError = typeof opts.onAudioError === 'function' ? opts.onAudioError : () => {};
    const players = new Map();
    let active = null;

    function playerFor(message) {
      const existing = players.get(message);
      if (existing) return existing;
      const audio = createAudio ? createAudio() : null;
      const player = {
        message,
        audio,
        loading: 0,
        want: false,
        promise: null,
        button: null,
        bubble: null,
      };
      if (audio) {
        audio.addEventListener('play', () => onChange(player));
        audio.addEventListener('pause', () => onChange(player));
        audio.addEventListener('ended', () => {
          if (active === player) active = null;
          rewind(audio);
          onChange(player);
        });
        audio.addEventListener('error', () => {
          if (!audio.getAttribute('src')) return;
          if (active === player) active = null;
          onChange(player);
          onAudioError(player.message, player);
        });
      }
      players.set(message, player);
      return player;
    }

    function isPlaying(player) {
      const audio = player && player.audio;
      return Boolean(audio && audio.getAttribute('src') && !audio.paused && !audio.ended);
    }

    function isLoading(player) {
      return Boolean(player && player.loading > 0);
    }

    function isReady(player) {
      const audio = player && player.audio;
      if (audio && audio.getAttribute('src')) return true;
      return Boolean(cachedSource(player.message));
    }

    function attachSource(player, url) {
      if (!player || !player.audio || !url) return;
      if (player.audio.getAttribute('src') === url) return;
      player.audio.src = url;
    }

    // Silences every clip ever created, detached ones included.
    function stopAll() {
      players.forEach((player) => {
        const audio = player.audio;
        if (!audio) return;
        try { if (!audio.paused) audio.pause(); } catch (_) { /* ignore */ }
        rewind(audio);
        player.want = false;
      });
      active = null;
      players.forEach((player) => onChange(player));
    }

    function stopPlayer(player) {
      if (!player || !player.audio) return;
      const audio = player.audio;
      try { if (!audio.paused) audio.pause(); } catch (_) { /* ignore */ }
      rewind(audio);
      player.want = false;
      if (active === player) active = null;
      onChange(player);
    }

    function start(player) {
      const audio = player && player.audio;
      if (!audio || !audio.getAttribute('src')) return false;
      // Never overlap: every other node stops and rewinds first.
      players.forEach((other) => {
        const node = other.audio;
        if (!node || node === audio) return;
        try { if (!node.paused) node.pause(); } catch (_) { /* ignore */ }
        rewind(node);
      });
      active = player;
      rewind(audio);
      const played = audio.play();
      if (played && played.catch) played.catch(() => {
        if (active === player) active = null;
        onChange(player);
      });
      onChange(player);
      return true;
    }

    function load(player) {
      if (!requestSource) return Promise.resolve(null);
      if (player.promise) return player.promise;
      player.loading += 1;
      onChange(player);
      player.promise = Promise.resolve()
        .then(() => requestSource(player.message))
        .then((url) => {
          if (url) attachSource(player, url);
          return url || null;
        })
        .catch(() => null)
        .then((url) => {
          player.loading = 0;
          player.promise = null;
          onChange(player);
          return url;
        });
      return player.promise;
    }

    // One tap. Returns { action } where action is stopped | queued | played | blocked.
    async function toggle(message) {
      const player = playerFor(message);
      if (isPlaying(player)) {
        stopPlayer(player);
        return { action: 'stopped' };
      }
      const cached = cachedSource(message);
      if (cached) {
        attachSource(player, cached);
        start(player);
        return { action: 'played' };
      }
      // Loading already: remember the intent, never start a second request.
      if (player.want || isLoading(player)) {
        player.want = true;
        onChange(player);
        return { action: 'queued' };
      }
      player.want = true;
      onChange(player);
      const url = await load(player);
      if (!url) {
        player.want = false;
        onChange(player);
        return { action: 'blocked' };
      }
      if (!player.want) {
        onChange(player);
        return { action: 'queued' };
      }
      player.want = false;
      attachSource(player, url);
      start(player);
      return { action: 'played' };
    }

    // A clip that arrives late (chat response, background request) is stored by the app
    // in message.audioUrl; this attaches it without starting playback.
    function refresh(message) {
      const player = players.get(message);
      if (!player) return null;
      const url = cachedSource(message);
      if (url) attachSource(player, url);
      onChange(player);
      return player;
    }

    function release(message) {
      const player = players.get(message);
      if (!player) return;
      stopPlayer(player);
      players.delete(message);
    }

    function list() {
      return [...players.values()];
    }

    return {
      playerFor,
      isPlaying,
      isLoading,
      isReady,
      stopAll,
      stopPlayer,
      start,
      toggle,
      refresh,
      release,
      list,
      active: () => active,
    };
  }

  return { createPlayback, rewind };
});
