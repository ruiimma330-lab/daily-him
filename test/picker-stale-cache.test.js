// Regression: empty picker ("没有匹配的爱豆") after PR #40/#41 on phones with an older service worker.
// The old worker (dh-pwa-4) stayed active (new one waited forever), served its cached pre-#40
// picker.js next to the freshly fetched new pick.html; that script looked up #picker-companies
// (gone), threw inside paint(), and the catch showed the empty message.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');

const ROOT = path.join(__dirname, '..');
process.env.STORE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-stale-'));
process.env.SESSION_SECRET = 'stale-cache-test-secret-with-at-least-32-chars';
delete process.env.APP_PASSWORD;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const ORIGIN = 'https://idol-chat.test';

// Minimal CacheStorage: caches.match searches every cache in creation order, like browsers.
function makeCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    const key = (r) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;
    return {
      async match(r) { const hit = m.get(key(r)); return hit ? hit.clone() : undefined; },
      async put(r, res) { m.set(key(r), res); },
      async keys() { return [...m.keys()]; },
    };
  };
  return {
    stores,
    open,
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(r) {
      for (const name of stores.keys()) { const hit = await (await open(name)).match(r); if (hit) return hit; }
      return undefined;
    },
  };
}

function loadWorker({ caches, fetchImpl }) {
  const listeners = {};
  let skipped = false;
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => { skipped = true; return Promise.resolve(); },
    clients: { claim: () => Promise.resolve() },
  };
  // Worker-relative URLs ('/login') resolve against the origin, as in a real worker.
  class WorkerRequest extends Request { constructor(input, init) { super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init); } }
  const ctx = vm.createContext({ self, caches, fetch: fetchImpl, Request: WorkerRequest, Response, URL, Promise, console });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8'), ctx);
  async function dispatch(type, extra) {
    const waits = [];
    let responded;
    const event = { ...extra, waitUntil: (p) => waits.push(p), respondWith: (p) => { responded = p; } };
    listeners[type](event);
    await Promise.all(waits);
    return responded ? await responded : undefined;
  }
  return { dispatch, skipped: () => skipped };
}

function jsResponse(body) {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript' } });
}

test('a stale picker.js in an old version cache is never served next to the new page', async () => {
  const caches = makeCaches();
  await (await caches.open('dh-shell-dh-pwa-4')).put('/shell/picker.js', jsResponse('/* old picker: picker-companies */'));
  const fetchImpl = async () => jsResponse('/* new picker */');
  const worker = loadWorker({ caches, fetchImpl });
  const request = new Request(ORIGIN + '/shell/picker.js');
  const res = await worker.dispatch('fetch', { request });
  assert.equal(await res.text(), '/* new picker */');
});

test('offline falls back to this version cache only, not an older version', async () => {
  const caches = makeCaches();
  await (await caches.open('dh-shell-dh-pwa-4')).put('/shell/picker.js', jsResponse('old'));
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  const version = sw.match(/const VERSION = '([^']+)'/)[1];
  await (await caches.open(`dh-shell-${version}`)).put('/shell/picker.js', jsResponse('current'));
  const worker = loadWorker({ caches, fetchImpl: async () => { throw new TypeError('offline'); } });
  const res = await worker.dispatch('fetch', { request: new Request(ORIGIN + '/shell/picker.js') });
  assert.equal(await res.text(), 'current');
  assert.doesNotMatch(sw, /caches\.match\(/, 'never search across all version caches');
});

test('new worker activates immediately and never precaches a login redirect', async () => {
  const caches = makeCaches();
  const fetchImpl = async (req) => {
    const p = new URL(req.url, ORIGIN).pathname;
    if (p === '/account-cache.js') {
      const r = new Response('<!DOCTYPE html><title>login</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      Object.defineProperty(r, 'redirected', { value: true });
      return r;
    }
    return jsResponse('ok ' + p);
  };
  const worker = loadWorker({ caches, fetchImpl });
  await worker.dispatch('install', {});
  assert.equal(worker.skipped(), true, 'install must call skipWaiting so a home-screen app is not stuck on the old worker');
  const [name] = await caches.keys();
  const cache = await caches.open(name);
  assert.equal(await cache.match('/account-cache.js'), undefined);
  assert.ok(await cache.match('/shell/picker.js'));
});

test('activate deletes every older version cache', async () => {
  const caches = makeCaches();
  await caches.open('dh-shell-dh-pwa-4');
  await caches.open('dh-media-dh-pwa-4');
  await caches.open('dh-shell-dh-pwa-6');
  const worker = loadWorker({ caches, fetchImpl: async () => jsResponse('') });
  await worker.dispatch('activate', {});
  assert.deepEqual(await caches.keys(), []);
});

test('every page with scripts loads sw-heal.js first, and the worker precaches it', () => {
  const pages = ['public/index.html', 'public/login.html', ...fs.readdirSync(path.join(ROOT, 'public/shell'))
    .filter((f) => f.endsWith('.html')).map((f) => 'public/shell/' + f)];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    if (!scripts.length) continue;
    assert.equal(scripts[0], '/sw-heal.js', page);
  }
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.match(sw, /'\/sw-heal\.js'/);
  const heal = fs.readFileSync(path.join(ROOT, 'public/sw-heal.js'), 'utf8');
  assert.match(heal, /SKIP_WAITING/);
  assert.match(heal, /controllerchange/);
  assert.match(heal, /reg\.update\(\)/);
});

test('picker load failure hides the start button instead of showing a dead "开始聊天"', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public/shell/picker.js'), 'utf8');
  const tail = js.slice(js.lastIndexOf('.catch('));
  assert.match(tail, /goBtn\.hidden = true/);
  assert.match(tail, /加载失败/);
});

function request(app, url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const req = new http.IncomingMessage(socket);
    Object.assign(req, { method: 'GET', url, headers: { host: 'localhost' }, httpVersionMajor: 1, httpVersionMinor: 0, httpVersion: '1.0' });
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks);
      resolve({ status: res.statusCode, headers: res.getHeaders(), body: raw.subarray(raw.indexOf('\r\n\r\n') + 4).toString() });
      socket.destroy();
    });
    app(req, res);
  });
}

test('logged out, account-cache.js and sw-heal.js are served as scripts (not redirected to /login)', async () => {
  const store = require('../lib/store');
  const { createApp } = require('../server');
  await store.init();
  const app = createApp();
  for (const url of ['/account-cache.js', '/sw-heal.js', '/shell/picker.js']) {
    const res = await request(app, url);
    assert.equal(res.status, 200, url);
    assert.match(String(res.headers['content-type']), /javascript/, url);
  }
  const api = await request(app, '/api/characters');
  assert.equal(api.status, 401);
});
