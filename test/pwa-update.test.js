'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');

function makeElement(tag = 'div', className = '') {
  return {
    tagName: String(tag).toUpperCase(),
    className,
    hidden: false,
    disabled: false,
    readOnly: false,
    value: '',
    listeners: {},
    children: [],
    style: {},
    dataset: {},
    append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); return item; },
    addEventListener(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn); },
    setAttribute(name, value) { this[name] = String(value); },
    closest(selector) {
      if (selector === '[hidden]' && this._insideHidden) return { hidden: true };
      return null;
    },
    click() {
      for (const fn of this.listeners.click || []) fn({ target: this });
    },
  };
}

function loadPwa({ fields = [], activeElement = null, reg = null, hasController = true } = {}) {
  const winListeners = {};
  const swListeners = {};
  const timers = [];
  let nextTimerId = 1;
  let reloads = 0;

  const body = makeElement('body');
  const document = {
    body,
    activeElement,
    createElement: (tag) => makeElement(tag),
    querySelectorAll: (selector) => (selector.includes('textarea') ? fields : []),
    addEventListener() {},
  };

  const serviceWorker = {
    controller: hasController ? { state: 'activated' } : null,
    addEventListener(name, fn) { (swListeners[name] || (swListeners[name] = [])).push(fn); },
    register: async () => reg || { waiting: null, installing: null, addEventListener() {} },
  };

  const navigator = {
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0',
    platform: 'Linux',
    maxTouchPoints: 1,
    onLine: true,
    serviceWorker,
  };

  const location = {
    href: 'https://dailyhim.cn/',
    reload() { reloads += 1; },
  };

  const window = {
    navigator,
    location,
    matchMedia: () => ({ matches: false }),
    addEventListener(name, fn) { (winListeners[name] || (winListeners[name] = [])).push(fn); },
  };

  const fakeSetTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.push({ id, fn, ms, cleared: false });
    return id;
  };
  const fakeClearTimeout = (id) => {
    const entry = timers.find((t) => t.id === id);
    if (entry) entry.cleared = true;
  };

  const context = vm.createContext({
    window,
    navigator,
    document,
    location,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    fetch: async () => ({ ok: false }),
  });

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/pwa.js'), 'utf8'), context);

  const updateBar = body.children.find((node) => node.id === 'pwa-update');
  const refreshBtn = updateBar.children[1];

  return {
    window,
    document,
    updateBar,
    refreshBtn,
    timers,
    get reloads() { return reloads; },
    async fireLoad() {
      for (const fn of winListeners.load || []) fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
    emitControllerChange() {
      for (const fn of swListeners.controllerchange || []) fn();
    },
    runTimers() {
      for (const t of timers.slice()) {
        if (!t.cleared) {
          t.cleared = true;
          t.fn();
        }
      }
    },
  };
}

test('clicking refresh after DailyPwa.showUpdate() with no waitingWorker reloads immediately', () => {
  const env = loadPwa();
  env.window.DailyPwa.showUpdate();
  assert.equal(env.updateBar.hidden, false);

  env.refreshBtn.click();
  assert.equal(env.updateBar.hidden, true);
  assert.equal(env.reloads, 1);
});

test('clicking refresh when waitingWorker is already activated reloads immediately', async () => {
  const posted = [];
  const waitingWorker = {
    state: 'activated',
    postMessage(msg) { posted.push(msg); },
  };
  const env = loadPwa({
    reg: { waiting: waitingWorker, installing: null, addEventListener() {} },
  });
  await env.fireLoad();
  assert.equal(env.updateBar.hidden, false);

  env.refreshBtn.click();
  assert.equal(posted.length, 0);
  assert.equal(env.reloads, 1);
});

test('clicking refresh when a hidden input has a non-empty value still reloads', () => {
  const hiddenField = makeElement('input');
  hiddenField._insideHidden = true;
  hiddenField.value = 'prefilled profile';

  const env = loadPwa({ fields: [hiddenField] });
  env.window.DailyPwa.showUpdate();
  env.refreshBtn.click();
  assert.equal(env.reloads, 1);
});

test('auto-apply blocks on visible non-empty input and ignores hidden inputs', async () => {
  const postedVisible = [];
  const visibleField = makeElement('textarea');
  visibleField.value = 'draft message';
  const waitingVisible = {
    state: 'installed',
    postMessage(msg) { postedVisible.push(msg); },
  };
  const blockedEnv = loadPwa({
    fields: [visibleField],
    reg: { waiting: waitingVisible, installing: null, addEventListener() {} },
  });
  await blockedEnv.fireLoad();
  blockedEnv.runTimers();
  assert.equal(postedVisible.length, 0, 'visible non-empty field blocks auto-apply');
  assert.equal(blockedEnv.reloads, 0);

  const postedHidden = [];
  const hiddenField = makeElement('input');
  hiddenField._insideHidden = true;
  hiddenField.value = 'hidden profile field';
  const waitingHidden = {
    state: 'installed',
    postMessage(msg) { postedHidden.push(msg); },
  };
  const hiddenEnv = loadPwa({
    fields: [hiddenField],
    reg: { waiting: waitingHidden, installing: null, addEventListener() {} },
  });
  await hiddenEnv.fireLoad();
  hiddenEnv.runTimers();
  assert.equal(postedHidden.length, 1, 'hidden input does not block auto-apply');
  assert.equal(postedHidden[0].type, 'SKIP_WAITING');
  hiddenEnv.emitControllerChange();
  assert.equal(hiddenEnv.reloads, 1);
});

test('clicking refresh on installed waitingWorker posts SKIP_WAITING and falls back to reload if controllerchange never fires', async () => {
  const posted = [];
  const waitingWorker = {
    state: 'installed',
    postMessage(msg) { posted.push(msg); },
  };
  const env = loadPwa({
    reg: { waiting: waitingWorker, installing: null, addEventListener() {} },
  });
  await env.fireLoad();

  env.refreshBtn.click();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'SKIP_WAITING');
  assert.equal(env.reloads, 0);

  const fallbackTimer = env.timers.find((t) => t.ms === 600 && !t.cleared);
  assert.ok(fallbackTimer, 'schedules 600ms reload fallback');
  fallbackTimer.fn();
  assert.equal(env.reloads, 1);
});

test('sw-heal ignores hidden inputs and pauses only on visible non-empty inputs', async () => {
  function runHeal({ fields = [], activeElement = null } = {}) {
    const swListeners = {};
    let reloads = 0;
    let shownUpdates = 0;
    const sw = {
      controller: { state: 'activated' },
      addEventListener(name, fn) { (swListeners[name] || (swListeners[name] = [])).push(fn); },
      getRegistration: async () => ({
        waiting: null,
        installing: null,
        addEventListener() {},
        update: async () => {},
      }),
    };
    const ctx = vm.createContext({
      navigator: { serviceWorker: sw },
      document: {
        activeElement,
        querySelectorAll: () => fields,
      },
      window: {
        DailyPwa: { showUpdate() { shownUpdates += 1; } },
      },
      sessionStorage: { getItem: () => '0', setItem() {} },
      location: { reload() { reloads += 1; } },
      Date,
    });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/sw-heal.js'), 'utf8'), ctx);
    for (const fn of swListeners.controllerchange || []) fn();
    return { reloads, shownUpdates };
  }

  const hiddenField = makeElement('input');
  hiddenField._insideHidden = true;
  hiddenField.value = 'prefilled profile';
  assert.deepEqual(runHeal({ fields: [hiddenField] }), { reloads: 1, shownUpdates: 0 });

  const visibleField = makeElement('textarea');
  visibleField.value = 'unsent chat draft';
  assert.deepEqual(runHeal({ fields: [visibleField] }), { reloads: 0, shownUpdates: 1 });
});
