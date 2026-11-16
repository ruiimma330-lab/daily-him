const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Duplex } = require('node:stream');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-install-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'install-test-secret-with-at-least-32-characters';
process.env.APP_PASSWORD = 'install-gate-test';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
const store = require('../lib/store');
const { createApp } = require('../server');
let app;
// Dispatch real Express requests over an in-memory HTTP socket; no listen port.
function request(url) {
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
      const body = raw.subarray(raw.indexOf('\r\n\r\n') + 4).toString();
      resolve({ status: res.statusCode, headers: res.getHeaders(), text: () => body, json: () => JSON.parse(body) });
      socket.destroy();
    });
    app(req, res);
  });
}
test.before(async () => {
  await store.init();
  app = createApp();
});
test.after(async () => {
  await store.flush({ shutdown: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});
test('install resources and assetlinks bypass site gate and account login', async () => {
  for (const url of ['/shell/install.html', '/shell/install.css', '/shell/install.js', '/api/install-qr.svg', '/api/site-config', '/mobile-lock.css', '/mobile-lock.js', '/pwa.js', '/manifest.webmanifest', '/downloads/android.json', '/.well-known/assetlinks.json']) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
  }
  const qr = await request('/api/install-qr.svg');
  assert.match(qr.headers['content-type'], /image\/svg\+xml/);
  assert.match(qr.text(), /<svg[^>]*(?:width="222"|viewBox=)/);
  const links = await request('/.well-known/assetlinks.json');
  assert.match(links.headers['content-type'], /application\/json/);
  assert.ok(Array.isArray(await links.json()));
  const metadata = (await request('/downloads/android.json')).json();
  const apk = await request('/downloads/daily-him.apk');
  assert.equal(apk.status, metadata.available ? 200 : 404);
  if (metadata.available) {
    assert.match(apk.headers['content-type'], /application\/vnd.android.package-archive/);
    assert.match(apk.headers['content-disposition'], /attachment/);
  }
  const account = await request('/api/me');
  assert.equal(account.status, 401, 'account still requires authentication');
});

test('install QR is desktop-only and mobile instructions cover iOS, Android, and WeChat', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/shell/install.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../public/shell/install.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../public/shell/install.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '../public/mobile-lock.js'), 'utf8');
  assert.match(html, /class="qr"[^>]*width="222"[^>]*height="222"/);
  assert.match(html, /src="\/api\/install-qr\.svg"/);
  assert.match(css, /\.qr-section\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(min-width:\s*760px\)[\s\S]*\.qr-section\s*\{\s*display:\s*block/);
  assert.doesNotMatch(css, /\.qr[^}]*height:\s*auto/);
  assert.match(html, /Safari[\s\S]*分享[\s\S]*添加到主屏幕[\s\S]*添加/);
  assert.match(html, /ios-step-icon[\s\S]*ios-browser-warning[\s\S]*copy-site-link/);
  assert.match(html, /Chrome[\s\S]*安装应用[\s\S]*添加到主屏幕/);
  assert.match(js, /dataset\.installOs = ios \? 'ios' : 'android'/);
  assert.match(js, /\/api\/site-config/);
  assert.match(mobile, /MicroMessenger/);
  assert.match(mobile, /在浏览器打开/);
  assert.match(mobile, /Safari/);
  assert.match(mobile, /Chrome/);
});

test('cover, me page, and chat menu keep a reusable install entry', () => {
  const cover = fs.readFileSync(path.join(__dirname, '../public/shell/cover.html'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const me = fs.readFileSync(path.join(__dirname, '../public/me/me.js'), 'utf8');
  const pwa = fs.readFileSync(path.join(__dirname, '../public/pwa.js'), 'utf8');
  assert.match(cover, /data-pwa-install[^>]*>添加到桌面/);
  assert.match(chat, /id="install-open"[^>]*data-pwa-install[^>]*>[\s\S]*?添加到桌面/);
  assert.match(me, /canShowInstallEntry[\s\S]*添加到桌面[\s\S]*DailyPwa\.install/);
  assert.match(pwa, /standalone \|\| wechat/);
  assert.match(pwa, /beforeinstallprompt[\s\S]*deferred = event/);
  assert.match(pwa, /CriOS\|FxiOS\|EdgiOS\|OPiOS\|MicroMessenger/);
  assert.match(pwa, /navigator\.clipboard\.writeText/);
});

test('site URL is configurable without exposing secrets', async () => {
  const previous = process.env.PUBLIC_SITE_URL;
  process.env.PUBLIC_SITE_URL = 'https://preview.dailyhim.cn/';
  try {
    const response = await request('/api/site-config');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), {
      siteUrl: 'https://preview.dailyhim.cn',
      installUrl: 'https://preview.dailyhim.cn/shell/install.html',
      shareUrl: 'https://preview.dailyhim.cn',
    });
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_SITE_URL;
    else process.env.PUBLIC_SITE_URL = previous;
  }
});

test('move mode replaces pages but leaves health available', async () => {
  const previous = process.env.MOVED_TO_URL;
  process.env.MOVED_TO_URL = 'https://dailyhim.cn';
  try {
    const page = await request('/shell/cover.html');
    assert.equal(page.status, 200);
    assert.match(page.text(), /Daily Him 已搬家到 dailyhim\.cn/);
    assert.match(page.text(), /href="https:\/\/dailyhim\.cn"/);
    const health = await request('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json().ok, true);
  } finally {
    if (previous === undefined) delete process.env.MOVED_TO_URL;
    else process.env.MOVED_TO_URL = previous;
  }
});
