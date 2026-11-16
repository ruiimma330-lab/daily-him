'use strict';

// 「他记得的你」 UI contract: one page, three sections, reachable from the chat menu
// and the 我 page, with edit/delete on cards and view/clear-only on the summary.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const memory = fs.readFileSync(path.join(ROOT, 'public/memory.js'), 'utf8');
const me = fs.readFileSync(path.join(ROOT, 'public/me/me.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

test('the chat menu and the 我 page both open 「他记得的你」', () => {
  assert.match(html, /id="memory-open-menu"><span>他记得的你 💭<\/span>/);
  assert.match(html, /id="memory-open-profile">他记得的你 💭<\/button>/);
  assert.match(html, /<h2 id="mem-title">他记得的你<\/h2>/);
  assert.match(me, /memory\.textContent = '他记得的你';/);
  assert.match(me, /host\.append\(bar\('他记得的你'\)\);/);
  // No old label survives in the entry points.
  assert.equal(/他记得的事 💭/.test(html), false);
});

test('the page has the three approved sections in order', () => {
  const about = html.indexOf('id="mem-me-title">关于你');
  const cards = html.indexOf('id="mem-cards-title">他记得的事');
  const summary = html.indexOf('id="mem-summary"');
  assert.ok(about > 0 && cards > about && summary > 0, 'sections are ordered');
  assert.match(html, /id="mem-call-name"/);
  assert.match(html, /id="mem-nickname"/);
  assert.match(html, /id="mem-habits"/);
  assert.match(html, /id="mem-personal-save">保存，下一句就生效<\/button>/);
  assert.match(html, /id="mem-summary-clear">清空摘要<\/button>/);
  assert.match(html, /id="mem-groups"/);
  assert.match(html, /id="mem-forgot"/);
});

test('personal fields save through the dedicated endpoint and refresh the header name', () => {
  assert.match(memory, /fetch\(withChar\('\/api\/memory\/personal'\)/);
  assert.match(memory, /method: 'PUT'/);
  assert.match(memory, /callName: callInput\.value\.trim\(\)/);
  assert.match(memory, /characterNickname: nickInput\.value\.trim\(\)/);
  assert.match(memory, /habits: habitsInput\.value\.trim\(\)/);
  assert.match(memory, /document\.dispatchEvent\(new CustomEvent\('idol-profile'/);
  assert.match(app, /addEventListener\('idol-profile'/);
});

test('cards are grouped, editable, and deletable with a confirmation', () => {
  assert.match(memory, /const order = \['preference', 'recent', 'promise', 'address'\];/);
  assert.match(memory, /method: 'PATCH'/);
  assert.match(memory, /body: JSON\.stringify\(\{ text \}\)/);
  assert.match(memory, /if \(!armed\(del, '删除', '确认删除'\)\) return;/);
  assert.match(memory, /method: 'DELETE'/);
  // Deleting keeps the card in the forgotten list (rendered from the response).
  assert.match(memory, /function paintForgotten/);
  assert.match(html, /已忘记的事（不会再被记回来）/);
});

test('the summary can only be viewed or cleared, and clearing keeps cards', () => {
  assert.match(memory, /fetch\(withChar\('\/api\/memory\/summary'\), \{ method: 'DELETE' \}\)/);
  assert.match(memory, /摘要已清空，记忆卡片还在/);
  // The section always renders, with an explicit empty state instead of disappearing.
  assert.match(memory, /sumBox\.hidden = false;/);
  assert.match(memory, /还没有摘要。多聊几句就会有了。/);
  // No summary editor exists.
  assert.equal(/id="mem-summary-input"/.test(html), false);
  assert.equal(/summary[\s\S]{0,80}method: 'PATCH'/.test(memory), false);
});

test('read-only characters cannot edit memory from either page', () => {
  assert.match(memory, /const isReadOnly = \(\) => Boolean\(window\.IdolChat && window\.IdolChat\.isReadOnly/);
  // Read-only is decided while painting, not once at script load: access is only known
  // after the first history fetch, so a load-time disable would lock the fields forever.
  const paint = memory.slice(memory.indexOf('function paintPersonal'), memory.indexOf('function paintSummary'));
  assert.match(paint, /const locked = isReadOnly\(\);/);
  assert.match(paint, /input\.disabled = locked/);
  assert.equal(/\[callInput, nickInput, habitsInput\]\.forEach\(\(input\) => \{\n    input\.disabled/.test(memory), false);
  assert.match(memory, /if \(isReadOnly\(\)\) return;/);
  assert.match(memory, /if \(isReadOnly\(\)\) return li;/);
});

test('the 我 page memory view mirrors the three sections', () => {
  const view = me.slice(me.indexOf('async function renderMemory'), me.indexOf('function memoryCardNode'));
  assert.match(view, /kicker\('关于你'\)/);
  assert.match(view, /kicker\('他记得的事'\)/);
  assert.match(view, /kicker\('之前聊过的（摘要）'\)/);
  assert.match(view, /\/api\/memory\/personal\?characterId=/);
  // Editing a card lives in the shared card renderer, called from this view.
  assert.match(view, /memoryCardNode\(card, ch, reload\)/);
  const card = me.slice(me.indexOf('function memoryCardNode'), me.indexOf('function renderPassword'));
  assert.match(card, /method: 'PATCH'/);
  assert.match(card, /method: 'DELETE'/);
  assert.match(view, /\/api\/memory\/summary\?characterId=/);
  assert.match(view, /\['preference', 'recent', 'promise', 'address'\]\.forEach/);
  assert.equal(/kicker\('关于你'\)[\s\S]*save[\s\S]*kicker\('他记得的事'\)/.test(view), true);
});

test('clearing chat still says memory and intimacy are kept', () => {
  assert.match(app, /他记得的你与亲密度会保留/);
  assert.match(me, /他记得的你与亲密度会保留/);
  assert.match(html, /他记得的你与亲密度会保留/);
});
