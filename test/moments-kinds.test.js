'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const moments = require('../lib/moments');

test('moments kinds label news, preview, and event posts', () => {
  assert.equal(moments.normalizeKind('preview'), 'preview');
  assert.equal(moments.kindLabel('event'), '活动');
  assert.equal(moments.kindLabel('weird'), '近况');
  assert.equal(moments.publicLink('https://example.com/show'), 'https://example.com/show');
  assert.equal(moments.publicLink('http://insecure.example'), null);
  assert.equal(moments.publicLink('/local/path'), null);

  const posts = moments.loadPosts('baekhyun');
  assert.ok(posts.length >= 1);
  assert.ok(posts.every((post) => post.kind && post.kindLabel));
  assert.ok(posts.some((post) => post.kind === 'news'));
  assert.ok(posts.some((post) => post.kind === 'event'));
  assert.ok(posts.some((post) => post.title));
  assert.ok(posts.some((post) => post.link && post.link.startsWith('https://')));
});

test('moments UI explains artist news and event previews', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'moments.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'moments.css'), 'utf8');
  assert.match(index, /近况资讯与活动预告/);
  assert.match(index, /暂时还没有近况或活动预告/);
  assert.match(index, /近况 · 活动预告/);
  assert.match(js, /查看活动预告/);
  assert.match(js, /mom-kind/);
  assert.match(css, /\.mom-kind-preview/);
});
