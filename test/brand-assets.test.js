'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function pngInfo(file) {
  const data = fs.readFileSync(file);
  assert.deepEqual(data.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), file);
  assert.equal(data.subarray(12, 16).toString('ascii'), 'IHDR', file);
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bitDepth: data[24],
    colorType: data[25],
  };
}

test('B2 mark is a clean navy and ivory vector without embedded raster or live text', () => {
  const mark = fs.readFileSync(path.join(PUBLIC, 'brand', 'mark.svg'), 'utf8');
  assert.match(mark, /viewBox="0 0 512 512"/);
  assert.match(mark, /rx="112" fill="#13213F"/);
  assert.match(mark, /fill="#F7F1E5"/);
  assert.equal((mark.match(/<path /g) || []).length, 3);
  assert.doesNotMatch(mark, /<(?:image|text)\b/i);
  assert.doesNotMatch(mark, /gradient|data:image/i);
});

test('all generated app icons and launch images keep their required dimensions', () => {
  const expected = {
    'apple-touch-icon.png': [180, 180, 2],
    'icon-192.png': [192, 192, 6],
    'icon-512.png': [512, 512, 6],
    'icon-maskable-512.png': [512, 512, 2],
    'splash-750x1334.png': [750, 1334, 2],
    'splash-1170x2532.png': [1170, 2532, 2],
  };
  for (const [name, [width, height, colorType]] of Object.entries(expected)) {
    const info = pngInfo(path.join(PUBLIC, 'icons', name));
    assert.deepEqual([info.width, info.height], [width, height], name);
    assert.equal(info.bitDepth, 8, name);
    assert.equal(info.colorType, colorType, name);
  }
});

test('manifest and visible logo containers use the B2 midnight blue while PWA stays on version 15', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.background_color, '#13213F');
  assert.equal(manifest.theme_color, '#13213F');
  const shell = fs.readFileSync(path.join(PUBLIC, 'shell', 'shell.css'), 'utf8');
  const login = fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8');
  const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  assert.match(shell, /\.mark \{[^}]*border-radius: 22px;[^}]*background: #13213f;/);
  assert.match(login, /\.mark \{[\s\S]*?border-radius: 20px;[\s\S]*?background: #13213f;/);
  assert.match(sw, /const VERSION = 'dh-pwa-17';/);
});
