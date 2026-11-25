'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(full);
    return entry.name.endsWith('.html') ? [full] : [];
  });
}

test('every app page locks mobile zoom and loads the shared gesture guard', () => {
  for (const file of htmlFiles(PUBLIC)) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /maximum-scale=1/, file);
    assert.match(html, /user-scalable=no/, file);
    assert.match(html, /\/mobile-lock\.css/, file);
    assert.match(html, /\/mobile-lock\.js/, file);
  }
  const css = fs.readFileSync(path.join(PUBLIC, 'mobile-lock.css'), 'utf8');
  const js = fs.readFileSync(path.join(PUBLIC, 'mobile-lock.js'), 'utf8');
  assert.match(css, /touch-action:\s*manipulation/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /font-size:\s*16px/);
  assert.match(js, /gesturestart/);
  assert.match(js, /preventDefault/);
});

test('picker wires horizontal touch, debounced wheel, keyboard, and vertical-pan preservation', () => {
  const js = fs.readFileSync(path.join(PUBLIC, 'shell/picker.js'), 'utf8');
  const css = fs.readFileSync(path.join(PUBLIC, 'shell/picker.css'), 'utf8');
  assert.match(js, /addEventListener\('touchstart'/);
  assert.match(js, /addEventListener\('touchend'/);
  assert.match(js, /Math\.abs\(dx\) > Math\.abs\(dy\)/);
  assert.match(js, /addEventListener\('wheel'/);
  assert.match(js, /wheelLocked/);
  assert.match(js, /setTimeout\(\(\) => \{ wheelLocked = false; \}, 180\)/);
  assert.match(js, /ArrowLeft/);
  assert.match(js, /ArrowRight/);
  assert.match(css, /touch-action:\s*pan-y/);
  assert.match(js, /autoplay\.interactStart\(\)/);
  assert.match(js, /autoplay\.interactEnd\(\)/);
});

test('new mobile guard files are precached in dh-pwa-19', () => {
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  assert.match(sw, /const VERSION = 'dh-pwa-19';/);
  assert.match(sw, /'\/mobile-lock\.css'/);
  assert.match(sw, /'\/mobile-lock\.js'/);
});
