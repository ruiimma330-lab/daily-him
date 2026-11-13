/* Instagram-style photo dots + autoplay. Pure parts are shared by the browser picker and node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CarouselDots = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SIDE = 4; // at most 4 dots on each side of the current one (9 total)

  // Size/fade by distance from the current dot. The two outermost visible rings shrink and fade.
  function look(distance, side) {
    if (distance > side) return { scale: 0, opacity: 0, hidden: true };
    if (distance === side) return { scale: 0.5, opacity: 0.45, hidden: false };
    if (distance === side - 1) return { scale: 0.75, opacity: 0.75, hidden: false };
    return { scale: 1, opacity: 1, hidden: false };
  }

  /**
   * count: number of photos; index: current photo.
   * Few photos (<= 2*side+1): static row, every dot full size, row centered.
   * More photos: the row slides so the current dot sits in the middle; only side dots each way stay visible.
   * offset: how many dot steps the row is shifted (multiply by dot step in px for translateX).
   */
  function layout(count, index, side) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const s = Math.max(1, Math.floor(side == null ? SIDE : side));
    if (!n) return { mode: 'none', slots: 0, offset: 0, dots: [] };
    const current = Math.max(0, Math.min(n - 1, Math.floor(Number(index) || 0)));
    if (n <= 2 * s + 1) {
      return {
        mode: 'static',
        slots: n,
        offset: 0,
        dots: Array.from({ length: n }, (_, i) => ({ index: i, active: i === current, scale: 1, opacity: 1, hidden: false })),
      };
    }
    return {
      mode: 'slide',
      slots: 2 * s + 1,
      offset: s - current,
      dots: Array.from({ length: n }, (_, i) => ({ index: i, active: i === current, ...look(Math.abs(i - current), s) })),
    };
  }

  function nextIndex(count, index) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n <= 1) return 0;
    return (Math.floor(Number(index) || 0) + 1) % n;
  }

  /**
   * Autoplay timer. Advances only while: >1 photo, not reduced-motion, on screen, tab visible, user not interacting.
   * Timers are injectable so tests can drive it.
   */
  function createAutoplay(opts) {
    const o = Object.assign({ interval: 3500, resumeDelay: 5000 }, opts);
    // Call timers unbound: browsers throw "Illegal invocation" if setTimeout runs with a non-window `this`.
    const later = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancel = o.clearTimeout || ((id) => clearTimeout(id));
    const st = { count: 0, reduced: false, onScreen: true, pageVisible: true, touching: false, cooling: false, timer: null, resume: null };

    function canRun() {
      return st.count > 1 && !st.reduced && st.onScreen && st.pageVisible && !st.touching && !st.cooling;
    }
    function stop() {
      if (st.timer) cancel(st.timer);
      st.timer = null;
    }
    function arm() {
      stop();
      if (!canRun()) return;
      st.timer = later(() => {
        st.timer = null;
        if (!canRun()) return;
        o.advance();
        arm();
      }, o.interval);
    }
    return {
      setCount(n) { st.count = Math.max(0, Math.floor(Number(n) || 0)); arm(); },
      setReducedMotion(v) { st.reduced = Boolean(v); arm(); },
      setOnScreen(v) { st.onScreen = Boolean(v); arm(); },
      setPageVisible(v) { st.pageVisible = Boolean(v); arm(); },
      // Finger/mouse down, wheel or key: stop now; resume resumeDelay after it ends.
      interactStart() {
        st.touching = true;
        if (st.resume) cancel(st.resume);
        st.resume = null;
        stop();
      },
      interactEnd() {
        st.touching = false;
        st.cooling = true;
        if (st.resume) cancel(st.resume);
        st.resume = later(() => {
          st.resume = null;
          st.cooling = false;
          arm();
        }, o.resumeDelay);
        stop();
      },
      // Taps on a dot / wheel nudges: a start+end in one go.
      poke() { this.interactStart(); this.interactEnd(); },
      running() { return Boolean(st.timer); },
      destroy() { stop(); if (st.resume) cancel(st.resume); st.resume = null; },
    };
  }

  return { SIDE, layout, nextIndex, createAutoplay };
});
