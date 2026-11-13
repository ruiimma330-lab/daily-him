'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const PortraitLoader = require('../public/shell/portrait-loader');

const ROOT = path.join(__dirname, '..');

function classListFor(node) {
  const set = new Set();
  return {
    add(...names) { names.forEach((name) => name && set.add(name)); },
    remove(...names) { names.forEach((name) => set.delete(name)); },
    contains(name) { return set.has(name); },
  };
}

function hasClass(node, name) {
  return String(node.className || '').split(/\s+/).includes(name);
}

function createDoc() {
  function make(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      style: {},
      hidden: false,
      children: [],
      parentNode: null,
      attributes: {},
      ownerDocument: null,
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
      appendChild(child) {
        child.parentNode = node;
        node.children.push(child);
        return child;
      },
      removeChild(child) {
        node.children = node.children.filter((item) => item !== child);
        child.parentNode = null;
        return child;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const out = [];
        const walk = (parent) => {
          parent.children.forEach((child) => {
            if (sel === '.dots' && hasClass(child, 'dots')) out.push(child);
            if (sel === 'i' && child.tagName === 'I') out.push(child);
            if (sel === '.dots i' && child.tagName === 'I' && hasClass(parent, 'dots')) out.push(child);
            walk(child);
          });
        };
        walk(node);
        return out;
      },
    };
    node.classList = classListFor(node);
    return node;
  }
  const doc = {
    createElement(tag) {
      const node = make(tag);
      node.ownerDocument = doc;
      return node;
    },
  };
  return doc;
}

function pair(opts = {}) {
  const doc = opts.doc || createDoc();
  const page = doc.createElement('article');
  page.className = 'picker-page';
  const img = doc.createElement('img');
  page.appendChild(img);
  const listeners = new Map();
  img.complete = false;
  img.naturalWidth = 0;
  img.addEventListener = (type, fn) => {
    const list = listeners.get(type) || [];
    list.push(fn);
    listeners.set(type, list);
  };
  img.dispatch = (type) => {
    (listeners.get(type) || []).slice().forEach((fn) => fn());
  };
  let src = '';
  Object.defineProperty(img, 'src', {
    configurable: true,
    get() { return src; },
    set(value) {
      src = String(value);
      if (opts.cached) {
        img.complete = true;
        img.naturalWidth = opts.naturalWidth || 0;
      }
    },
  });
  if (opts.decode) img.decode = opts.decode;
  return { doc, page, img };
}

test('cover stays hidden until decode, and the three dots leave when it is ready', async () => {
  let release;
  const decode = () => new Promise((resolve) => { release = resolve; });
  const { page, img } = pair({ decode });
  const pending = PortraitLoader.attach(page, img, '/characters/karina/portrait.jpg');
  assert.equal(img.style.opacity, '0');
  assert.equal(img.classList.contains('is-ready'), false);
  assert.equal(img.classList.contains('is-pending'), true);
  const dots = page.querySelector('.dots');
  assert.ok(dots);
  assert.equal(dots.getAttribute('aria-hidden'), 'true');
  assert.equal(dots.querySelectorAll('i').length, 3);
  assert.equal(page.querySelectorAll('.dots i').length, 3);
  img.naturalWidth = 1000;
  img.complete = true;
  release();
  assert.equal(await pending, true);
  assert.equal(img.style.opacity, '1');
  assert.equal(img.classList.contains('is-ready'), true);
  assert.equal(img.classList.contains('is-pending'), false);
  assert.equal(page.querySelector('.dots'), null);
});

test('already-cached images do not leave a stuck loader when load will not fire', async () => {
  const { page, img } = pair({ cached: true, naturalWidth: 1000 });
  let loaded = false;
  img.addEventListener('load', () => { loaded = true; });
  const pending = PortraitLoader.attach(page, img, '/characters/karina/portrait.jpg');
  assert.equal(loaded, false);
  assert.equal(img.complete, true);
  assert.equal(img.style.opacity, '1');
  assert.equal(img.classList.contains('is-ready'), true);
  assert.equal(page.querySelector('.dots'), null);
  assert.equal(await pending, true);
});

test('cached images with decode() stay hidden until decode resolves, then the loader is gone', async () => {
  let release;
  const decode = () => new Promise((resolve) => { release = resolve; });
  const { page, img } = pair({ cached: true, naturalWidth: 800, decode });
  const pending = PortraitLoader.attach(page, img, '/cached.jpg');
  assert.equal(img.style.opacity, '0');
  assert.equal(page.querySelectorAll('.dots i').length, 3);
  release();
  assert.equal(await pending, true);
  assert.equal(img.style.opacity, '1');
  assert.equal(page.querySelector('.dots'), null);
});

test('a cached image still reveals if decode() rejects after the file is already complete', async () => {
  const { page, img } = pair({
    cached: true,
    naturalWidth: 800,
    decode: () => Promise.reject(new Error('decode')),
  });
  assert.equal(await PortraitLoader.attach(page, img, '/cached.jpg'), true);
  assert.equal(img.style.opacity, '1');
  assert.equal(page.querySelector('.dots'), null);
});

test('each page keeps its own loader until that photo is ready', async () => {
  let release;
  const ready = pair({ cached: true, naturalWidth: 400 });
  const waiting = pair({ decode: () => new Promise((resolve) => { release = resolve; }) });
  const shown = PortraitLoader.attach(ready.page, ready.img, '/a.jpg');
  const hidden = PortraitLoader.attach(waiting.page, waiting.img, '/b.jpg');
  assert.equal(await shown, true);
  assert.equal(ready.page.querySelector('.dots'), null);
  assert.equal(waiting.img.style.opacity, '0');
  assert.equal(waiting.page.querySelectorAll('.dots i').length, 3);
  waiting.img.naturalWidth = 400;
  waiting.img.complete = true;
  release();
  assert.equal(await hidden, true);
  assert.equal(waiting.img.style.opacity, '1');
  assert.equal(waiting.page.querySelector('.dots'), null);
});

test('a cover that has not fired load stays hidden with the dots', async () => {
  const { page, img } = pair({});
  let settled = false;
  const pending = PortraitLoader.attach(page, img, '/slow.jpg').then((ok) => { settled = true; return ok; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(img.style.opacity, '0');
  assert.equal(page.querySelectorAll('.dots i').length, 3);
  img.naturalWidth = 10;
  img.complete = true;
  img.dispatch('load');
  assert.equal(await pending, true);
  assert.equal(img.style.opacity, '1');
  assert.equal(page.querySelector('.dots'), null);
});

test('load failure removes the dots, keeps the photo hidden, and leaves the page in place', async () => {
  const { page, img } = pair({});
  const pending = PortraitLoader.attach(page, img, '/missing.jpg');
  assert.equal(page.querySelectorAll('.dots i').length, 3);
  img.complete = true;
  img.naturalWidth = 0;
  img.dispatch('error');
  assert.equal(await pending, false);
  assert.equal(img.style.opacity, '0');
  assert.equal(img.classList.contains('is-ready'), false);
  assert.equal(page.classList.contains('is-portrait-failed'), true);
  assert.equal(page.querySelector('.dots'), null);
  assert.equal(img.parentNode, page);
});

test('a broken decode does not spin forever', async () => {
  const { page, img } = pair({
    cached: true,
    naturalWidth: 0,
    decode: () => Promise.reject(new Error('broken')),
  });
  assert.equal(await PortraitLoader.attach(page, img, '/broken.jpg'), false);
  assert.equal(img.style.opacity, '0');
  assert.equal(page.classList.contains('is-portrait-failed'), true);
  assert.equal(page.querySelector('.dots'), null);
});

test('a missing portrait does not spin', async () => {
  const { page, img } = pair({});
  assert.equal(await PortraitLoader.attach(page, img, ''), false);
  assert.equal(img.style.opacity, '0');
  assert.equal(page.querySelector('.dots'), null);
  assert.equal(img.parentNode, page);
});

test('picker wires the loader, keeps the photo crop, and reuses the shell dots', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/shell/pick.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public/shell/picker.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/shell/picker.css'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.ok(html.indexOf('/shell/portrait-loader.js') < html.indexOf('/shell/picker.js'));
  assert.match(js, /PortraitLoader\.attach\(page, img, ch\.portrait \|\| ch\.avatar/);
  assert.equal(/img\.src\s*=/.test(js), false);
  assert.match(css, /object-fit:\s*cover/);
  assert.match(css, /object-position:\s*center 18%/);
  assert.match(css, /background:\s*#f4f4f4/);
  assert.match(css, /background:\s*#fee500/);
  assert.match(css, /width:\s*8px/);
  assert.match(css, /height:\s*8px/);
  assert.match(css, /translateY\(-8px\)/);
  assert.match(css, /opacity:\s*\.4/);
  assert.match(css, /animation-delay:\s*\.15s/);
  assert.match(css, /animation-delay:\s*\.3s/);
  assert.match(css, /@keyframes bounce/);
  assert.match(sw, /const VERSION = 'dh-pwa-10';/);
  assert.match(sw, /'\/shell\/portrait-loader\.js'/);
});
