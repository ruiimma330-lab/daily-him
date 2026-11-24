'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { digitUsername } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-front-performance-'));
process.env.STORE_DATA_DIR = dataDir;
process.env.SESSION_SECRET = 'front-performance-test-session-secret-1234';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;

const characters = require('../lib/characters');
const store = require('../lib/store');
const { createApp } = require('../server');

let server;
let base;
let cookie;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:html|css|js)$/.test(entry.name) ? [file] : [];
  });
}

test.before(async () => {
  await store.init();
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const registered = await fetch(base + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: digitUsername(), password: 'password123', age14: true }),
  });
  cookie = (registered.headers.get('set-cookie') || '').match(/sid=[^;]+/)[0];
});

test.after(async () => {
  await store.flush({ shutdown: true });
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('public UI has no Google Fonts and uses the Chinese/Korean system stack', () => {
  const files = sourceFiles(path.join(ROOT, 'public'));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /fonts\.(?:googleapis|gstatic)\.com/, file);
    assert.doesNotMatch(source, /Noto Sans (?:KR|SC)/, file);
  }
  const styles = [
    'public/style.css',
    'public/shell/shell.css',
    'public/shell/picker.css',
    'public/shell/install.css',
  ].map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  for (const family of ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK']) {
    assert.match(styles, new RegExp(family));
  }
});

test('public JPEG picker covers have smaller WebP derivatives', () => {
  const withJpeg = characters.list().filter((character) => fs.existsSync(path.join(ROOT, 'characters', character.id, 'portrait.jpg')));
  assert.ok(withJpeg.length > 0);
  for (const character of withJpeg) {
    const jpeg = path.join(ROOT, 'characters', character.id, 'portrait.jpg');
    const webp = path.join(ROOT, 'characters', character.id, 'portrait.webp');
    assert.equal(fs.existsSync(webp), true, character.id);
    assert.ok(fs.statSync(webp).size < fs.statSync(jpeg).size, character.id);
    assert.equal(fs.readFileSync(webp, { encoding: 'ascii', flag: 'r' }).slice(0, 4), 'RIFF', character.id);
  }
});

test('HTML and code revalidate while versioned portraits are immutable WebP', async () => {
  const html = await fetch(base + '/shell/install.html');
  assert.equal(html.headers.get('cache-control'), 'public, max-age=0, must-revalidate');

  const css = await fetch(base + '/shell/picker.css');
  assert.equal(css.headers.get('cache-control'), 'public, max-age=0, must-revalidate');

  const portrait = await fetch(base + '/characters/baekhyun/portrait.jpg?v=dh-pwa-16', {
    headers: { Cookie: cookie, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
  });
  assert.equal(portrait.status, 200);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /req\.query\.v === characters\.ASSET_VERSION/g);
  assert.match(portrait.headers.get('content-type') || '', /image\/webp/);
  assert.equal(portrait.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(portrait.headers.get('vary') || '', /Accept/);
});

test('text responses use compression when the client accepts it', async () => {
  const response = await fetch(base + '/shell/install.html', {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(response.headers.get('content-encoding'), 'gzip');
});
