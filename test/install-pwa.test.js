const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const path = require('node:path');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
function create(options = {}) {
  const nodes = {};
  const events = {};
  const entries = [];
  function element() {
    return {
      hidden: false,
      listeners: {},
      children: [],
      style: {},
      dataset: {},
      append(...items) { this.children.push(...items); },
      appendChild(item) { this.children.push(item); return item; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute(name, value) { this[name] = String(value); },
      remove() { this.removed = true; },
      select() { this.selected = true; },
      focus() { this.focused = true; },
    };
  }
  for (const id of [
    'install-pwa', 'install-status', 'apk-pending', 'apk-download', 'apk-status',
    'site-url', 'ios-browser-warning', 'copy-site-link', 'copy-site-fallback',
  ]) nodes[id] = element();
  nodes['apk-download'].hidden = true;
  nodes['copy-site-fallback'].hidden = true;
  const entry = element();
  entries.push(entry);

  const navigator = {
    userAgent: options.userAgent || 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0',
    platform: options.platform || 'Linux',
    maxTouchPoints: options.maxTouchPoints || 1,
  };
  if (options.clipboard === 'ok') navigator.clipboard = { writeText: async () => {} };
  if (options.clipboard === 'fail') navigator.clipboard = { writeText: async () => { throw new Error('denied'); } };
  const window = {
    navigator,
    location: { href: 'https://dailyhim.cn/shell/install.html' },
    matchMedia: () => ({ matches: options.standalone === true }),
    addEventListener: (key, fn) => { (events[key] || (events[key] = [])).push(fn); },
  };
  const document = {
    createElement: element,
    body: element(),
    getElementById: (id) => nodes[id],
    querySelectorAll: () => entries,
    addEventListener() {},
    execCommand: () => options.execCopy === true,
  };
  const fetch = async (url) => {
    if (url === '/api/site-config') {
      return { ok: true, json: async () => ({ installUrl: 'https://dailyhim.cn/shell/install.html' }) };
    }
    if (url.endsWith('.apk')) {
      return { ok: options.available === true, headers: { get: () => 'application/vnd.android.package-archive' } };
    }
    return { ok: true, json: async () => ({ available: options.available === true, version: '1.0.0', bytes: 1048576 }) };
  };
  const context = vm.createContext({
    window,
    navigator,
    document,
    localStorage: { getItem: () => null, setItem() {} },
    fetch,
  });
  for (const file of ['public/pwa.js', 'public/shell/install.js']) {
    vm.runInContext(fs.readFileSync(root + '/' + file, 'utf8'), context);
  }
  return { window, events, nodes, document, entry };
}

test('PWA prompt, iPad guide, and APK availability states', async () => {
  const android = create();
  let prompted = 0;
  for (const callback of android.events.beforeinstallprompt) {
    callback({ preventDefault() {}, prompt() { prompted++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  }
  await android.nodes['install-pwa'].listeners.click();
  assert.equal(prompted, 1, 'install page reuses the existing deferred PWA prompt');
  for (const callback of android.events.appinstalled) callback();
  assert.equal(android.nodes['install-pwa'].disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(android.nodes['apk-download'].hidden, true, 'missing APK is not offered');
  const ready = create({ available: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready.nodes['apk-download'].hidden, false, 'real APK is offered');
});

test('standalone and WeChat hide persistent install entries', () => {
  const standalone = create({ standalone: true });
  assert.equal(standalone.entry.hidden, true);
  const wechat = create({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0 Safari/604.1',
    platform: 'iPhone',
  });
  assert.equal(wechat.entry.hidden, true);
  assert.equal(wechat.document.body.children[3].hidden, true, 'WeChat keeps only the browser-open guide');
});

test('iOS Safari gets visual steps while embedded browsers get a durable copy fallback', async () => {
  const safari = create({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  });
  const safariForm = safari.document.body.children[3].children[0];
  assert.equal(safariForm.children[2].hidden, false, 'Safari steps are visible');
  assert.equal(safariForm.children[3].hidden, true, 'Safari does not show copy-first flow');

  const embedded = create({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1 Line/14.0',
    platform: 'iPhone',
    clipboard: 'fail',
    execCopy: false,
  });
  const form = embedded.document.body.children[3].children[0];
  assert.equal(form.children[2].hidden, true);
  assert.equal(form.children[3].hidden, false, 'embedded browser offers copy');
  await form.children[3].listeners.click();
  assert.equal(form.children[4].hidden, false);
  assert.equal(form.children[4].value, 'https://dailyhim.cn/shell/install.html');
  assert.equal(embedded.nodes['ios-browser-warning'].hidden, false);
  await embedded.nodes['copy-site-link'].listeners.click();
  assert.equal(embedded.nodes['copy-site-fallback'].hidden, false);
  assert.equal(embedded.nodes['copy-site-fallback'].value, 'https://dailyhim.cn/shell/install.html');
});
