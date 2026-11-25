'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/shell/carousel-dots');
const ROOT = path.join(__dirname, '..');

const visible = (view) => view.dots.filter((d) => !d.hidden).map((d) => d.index);

test('few photos: static centered row, every dot full size, current highlighted', () => {
  assert.deepEqual(D.layout(0, 0), { mode: 'none', slots: 0, offset: 0, dots: [] });
  const one = D.layout(1, 0);
  assert.equal(one.mode, 'static');
  assert.equal(one.slots, 1);
  const nine = D.layout(9, 8);
  assert.equal(nine.mode, 'static');
  assert.equal(nine.slots, 9);
  assert.equal(nine.offset, 0);
  assert.deepEqual(visible(nine), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(nine.dots.every((d) => d.scale === 1 && d.opacity === 1));
  assert.deepEqual(nine.dots.filter((d) => d.active).map((d) => d.index), [8]);
});

test('many photos: current dot centered, max 4 each side, edges smaller and fainter', () => {
  const n = 18;
  for (let i = 0; i < n; i += 1) {
    const view = D.layout(n, i);
    assert.equal(view.mode, 'slide');
    assert.equal(view.slots, 9);
    // Track shift puts dot i in slot 4 (the middle of 9 slots).
    assert.equal(i + view.offset, 4, `index ${i}`);
    const shown = visible(view);
    assert.ok(shown.length <= 9);
    assert.ok(shown.every((k) => Math.abs(k - i) <= 4));
    assert.deepEqual(view.dots.filter((d) => d.active).map((d) => d.index), [i]);
  }
  const mid = D.layout(n, 9).dots;
  assert.deepEqual(visible({ dots: mid }), [5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(mid[9].scale, 1);
  assert.equal(mid[11].scale, 1);
  assert.ok(mid[12].scale < 1 && mid[12].opacity < 1);
  assert.ok(mid[13].scale < mid[12].scale && mid[13].opacity < mid[12].opacity);
  assert.equal(mid[14].hidden, true);
  assert.equal(mid[14].scale, 0);
  assert.equal(mid[4].hidden, true);
  // Near the start, nothing to the left; only 4 to the right.
  assert.deepEqual(visible(D.layout(n, 0)), [0, 1, 2, 3, 4]);
  assert.deepEqual(visible(D.layout(n, 17)), [13, 14, 15, 16, 17]);
  // Out-of-range input is clamped.
  assert.equal(D.layout(n, 99).dots[17].active, true);
  assert.equal(D.layout(n, -3).dots[0].active, true);
});

test('nextIndex loops back to the first photo', () => {
  assert.equal(D.nextIndex(5, 0), 1);
  assert.equal(D.nextIndex(5, 4), 0);
  assert.equal(D.nextIndex(1, 0), 0);
  assert.equal(D.nextIndex(0, 0), 0);
});

function fakeClock() {
  let now = 0; let seq = 0; const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

test('autoplay advances every 3.5s, pauses on touch, resumes 5s after release', () => {
  const clock = fakeClock();
  let steps = 0;
  const ap = D.createAutoplay({ advance: () => { steps += 1; }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  ap.setCount(1);
  clock.tick(10000);
  assert.equal(steps, 0, 'one photo never autoplays');
  ap.setCount(4);
  clock.tick(3499);
  assert.equal(steps, 0);
  clock.tick(1);
  assert.equal(steps, 1);
  clock.tick(3500);
  assert.equal(steps, 2);
  ap.interactStart();
  clock.tick(20000);
  assert.equal(steps, 2, 'no autoplay while finger is down');
  ap.interactEnd();
  clock.tick(4999);
  assert.equal(steps, 2, 'still cooling down');
  clock.tick(1 + 3500);
  assert.equal(steps, 3, 'resumes 5s after the user stops, then waits one interval');
  ap.poke();
  clock.tick(5000 + 3499);
  assert.equal(steps, 3);
  clock.tick(1);
  assert.equal(steps, 4);
});

test('autoplay stops off-screen, in a hidden tab, and with reduced motion', () => {
  const clock = fakeClock();
  let steps = 0;
  const ap = D.createAutoplay({ advance: () => { steps += 1; }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  ap.setCount(5);
  ap.setOnScreen(false);
  clock.tick(10000);
  assert.equal(steps, 0);
  ap.setOnScreen(true);
  ap.setPageVisible(false);
  clock.tick(10000);
  assert.equal(steps, 0);
  assert.equal(ap.running(), false);
  ap.setPageVisible(true);
  ap.setReducedMotion(true);
  clock.tick(10000);
  assert.equal(steps, 0);
  ap.setReducedMotion(false);
  clock.tick(3500);
  assert.equal(steps, 1);
  ap.destroy();
  clock.tick(10000);
  assert.equal(steps, 1);
});

test('picker loads the dots module and the service worker precaches it under a new cache name', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/shell/pick.html'), 'utf8');
  assert.ok(html.indexOf('/shell/carousel-dots.js') > -1);
  assert.ok(html.indexOf('/shell/carousel-dots.js') < html.indexOf('/shell/picker.js'));
  const js = fs.readFileSync(path.join(ROOT, 'public/shell/picker.js'), 'utf8');
  assert.match(js, /CarouselDots\.layout/);
  assert.match(js, /CarouselDots\.createAutoplay/);
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /IntersectionObserver/);
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.match(sw, /const VERSION = 'dh-pwa-19';/);
  assert.match(sw, /'\/shell\/carousel-dots\.js'/);
});
