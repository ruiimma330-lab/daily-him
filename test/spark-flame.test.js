'use strict';
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const FLAME_PATH = 'M12 20.6c-3.4-1.6-5.3-5.1-4.7-8.7.4 1.5 1.5 2.4 2.5 2.4C9.6 9.6 11.2 6.4 14.4 3.6c.1 3.2 2.7 5.2 2.9 8.4.3 3.3-1.8 6.6-5.3 8.6z';

test('intimacy spark uses the monoline flame instead of the fire emoji', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const spark = app.slice(app.indexOf('function renderSpark'), app.indexOf('function renderRelPop'));
  const pop = app.slice(app.indexOf('function renderRelPop'), app.indexOf('function applyRelationship'));
  assert.equal(spark.includes('🔥'), false);
  assert.equal(pop.includes('🔥'), false);
  assert.equal(app.includes(FLAME_PATH), true);
  assert.equal((app.match(new RegExp(FLAME_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
  assert.match(spark, /SPARK_FLAME/);
  assert.match(spark, /spark-count/);
  assert.match(spark, /relState\.streak \|\| 0/);
  assert.match(pop, /连续聊天 <span class="spark spark-inline \$\{relState\.streakState\}">\$\{SPARK_FLAME\}<\/span> \$\{relState\.streak \|\| 0\} 天/);
  const svg = app.match(/<svg class="spark-flame"[\s\S]*?<\/svg>/)[0];
  assert.match(svg, /viewBox="0 0 24 24"/);
  assert.match(svg, /fill="none"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /stroke-width="1\.55"/);
  assert.match(svg, /stroke-linejoin="round"/);
  assert.match(svg, /stroke-linecap="round"/);
  assert.equal(/stroke="#/i.test(svg), false);
  assert.equal(/drop-shadow|animate|filter=/i.test(svg), false);

  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  assert.match(css, /\.spark\{[^}]*background:#fff1e6;color:#ff5a1f/);
  assert.match(css, /\.spark\.dim,\.spark\.out\{[^}]*background:#eee;color:#999/);
  assert.match(css, /\.spark svg\{[^}]*width:12px;height:12px/);
  assert.match(css, /\.rel-pop \.spark\.spark-inline\{[^}]*background:none/);

  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.match(sw, /const VERSION = 'dh-pwa-12';/);
});
