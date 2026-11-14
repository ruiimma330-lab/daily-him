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
      resolve({ status: res.statusCode, headers: res.getHeaders(), json: () => JSON.parse(body) });
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
  for (const url of ['/shell/install.html', '/shell/install.css', '/shell/install.js', '/shell/install-qr.svg', '/mobile-lock.css', '/mobile-lock.js', '/pwa.js', '/manifest.webmanifest', '/downloads/android.json', '/.well-known/assetlinks.json']) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
  }
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
  const qr = fs.readFileSync(path.join(__dirname, '../public/shell/install-qr.svg'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '../public/mobile-lock.js'), 'utf8');
  assert.match(html, /class="qr"[^>]*width="222"[^>]*height="222"/);
  assert.match(css, /\.qr-section\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(min-width:\s*760px\)[\s\S]*\.qr-section\s*\{\s*display:\s*block/);
  assert.doesNotMatch(css, /\.qr[^}]*height:\s*auto/);
  assert.match(qr, /<svg[^>]*width="222"[^>]*height="222"[^>]*viewBox="0 0 37 37"/);
  assert.match(html, /Safari[\s\S]*分享[\s\S]*添加到主屏幕[\s\S]*添加/);
  assert.match(html, /Chrome[\s\S]*安装应用[\s\S]*添加到主屏幕/);
  assert.match(js, /dataset\.installOs = ios \? 'ios' : 'android'/);
  assert.match(mobile, /MicroMessenger/);
  assert.match(mobile, /在浏览器打开/);
  assert.match(mobile, /Safari/);
  assert.match(mobile, /Chrome/);
});
