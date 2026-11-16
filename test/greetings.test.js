'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const greetings = require('../lib/greetings');
const { LAUNCH } = require('./helpers/launch10');

const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'greetings.json'), 'utf8'));
const MAX_KO = 160;

function at(hour) {
  // 2026-11-16 is a Monday; Asia/Shanghai is UTC+8, so hour-8 UTC lands on that hour.
  return Date.parse(`2026-11-16T${String((hour + 24 - 8) % 24).padStart(2, '0')}:00:00Z`)
    + (hour < 8 ? 24 * 60 * 60 * 1000 : 0);
}

test('all ten launch characters ship three time-of-day greetings plus an ask-name line', () => {
  const ids = Object.keys(DATA.characters).sort();
  assert.deepEqual(ids, [...LAUNCH].sort());
  const seen = new Set();
  for (const id of LAUNCH) {
    const entry = greetings.loadGreetings(id);
    assert.ok(entry, `${id} greetings should validate`);
    for (const slot of greetings.SLOTS) {
      assert.ok(entry.slots[slot].length, `${id} ${slot} plain`);
      assert.ok(entry.withName[slot].length, `${id} ${slot} named`);
      for (const line of entry.withName[slot]) {
        assert.ok(line.ko.includes('{callName}'), `${id} ${slot} ko slot`);
        assert.ok(line.zh.includes('{callName}'), `${id} ${slot} zh slot`);
      }
      for (const line of entry.slots[slot]) {
        // Plain lines are used once a name exists too; the slot stays optional there.
        assert.equal(/\{callName\}/.test(line.ko), false, `${id} ${slot} plain ko`);
        assert.ok(line.ko.length <= MAX_KO, `${id} ${slot} length`);
      }
    }
    assert.ok(entry.askName.ko.length > 4, `${id} askName`);
    // Every line is unique across the whole file, so characters never share a greeting.
    for (const slot of greetings.SLOTS) {
      for (const line of [...entry.slots[slot], ...entry.withName[slot]]) {
        assert.equal(seen.has(line.ko), false, `${id} duplicates another greeting: ${line.ko}`);
        seen.add(line.ko);
      }
    }
    assert.equal(seen.has(entry.askName.ko) && id !== 'baekhyun', false, `${id} askName reused`);
    seen.add(entry.askName.ko);
  }
});

test('greetings carry Korean text with a Chinese translation and no AI wording', () => {
  for (const id of LAUNCH) {
    const entry = greetings.loadGreetings(id);
    const lines = [...greetings.SLOTS.flatMap((slot) => [...entry.slots[slot], ...entry.withName[slot]]), entry.askName];
    for (const line of lines) {
      assert.match(line.ko, /[\uac00-\ud7a3]/, `${id} korean`);
      assert.match(line.zh, /[\u4e00-\u9fff]/, `${id} chinese`);
      assert.equal(/AI|인공지능|人工智能|모델|模型/i.test(line.ko + line.zh), false, `${id} must not mention AI`);
      assert.equal(/\{callName\}/.test(line.zh) && !line.ko.includes('{callName}'), false, id);
    }
  }
});

test('the greetings file has no audio yet, so nothing is committed as an mp3', () => {
  for (const id of LAUNCH) {
    const dir = path.join(ROOT, 'characters', id, 'greetings');
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    assert.equal(files.some((name) => name.endsWith('.mp3')), false, `${id} must not ship audio in this change`);
  }
  for (const id of LAUNCH) {
    const entry = greetings.loadGreetings(id);
    const lines = [...greetings.SLOTS.flatMap((slot) => [...entry.slots[slot], ...entry.withName[slot]]), entry.askName];
    for (const line of lines) assert.equal(line.audio, undefined, `${id} audio reference without a file`);
  }
});

test('time of day picks morning, afternoon, or evening in Asia/Shanghai', () => {
  assert.equal(greetings.slotFor(new Date(at(6))), 'morning');
  assert.equal(greetings.slotFor(new Date(at(10))), 'morning');
  assert.equal(greetings.slotFor(new Date(at(11))), 'afternoon');
  assert.equal(greetings.slotFor(new Date(at(17))), 'afternoon');
  assert.equal(greetings.slotFor(new Date(at(18))), 'evening');
  assert.equal(greetings.slotFor(new Date(at(23))), 'evening');
  assert.equal(greetings.slotFor(new Date(at(2))), 'evening');
  assert.equal(greetings.slotFor(new Date(at(4))), 'evening');
  assert.equal(greetings.slotFor(new Date(at(5))), 'morning');
});

test('a known callName fills the slot while an unknown one keeps the plain line', () => {
  const morning = at(9);
  const named = greetings.pick('baekhyun', { callName: '小星', now: morning });
  assert.equal(named.source, 'named');
  assert.match(named.ko, /小星/);
  assert.match(named.zh, /小星/);
  assert.equal(named.ko.includes('{callName}'), false);
  assert.equal(named.slot, 'morning');

  const plain = greetings.pick('baekhyun', { callName: '', now: morning });
  assert.equal(plain.source, 'plain');
  assert.equal(plain.ko.includes('{callName}'), false);
  assert.notEqual(plain.ko, named.ko);

  const ask = greetings.pick('baekhyun', { mode: 'ask', now: morning });
  assert.equal(ask.source, 'ask');
  assert.match(ask.zh, /[？?]/);
});

test('each character answers differently at the same hour', () => {
  const evening = at(20);
  const lines = new Set();
  for (const id of LAUNCH) {
    const picked = greetings.pick(id, { now: evening });
    assert.equal(picked.slot, 'evening');
    lines.add(picked.ko);
  }
  assert.equal(lines.size, LAUNCH.length);
});

test('a character without a greetings file falls back instead of inventing a line', () => {
  assert.equal(greetings.loadGreetings('kai'), null);
  assert.equal(greetings.pick('kai', { callName: '小星' }), null);
  assert.equal(greetings.loadGreetings('../../etc/passwd'), null);
});

test('a half-written entry is rejected so a nameless greeting never ships', () => {
  const good = JSON.parse(JSON.stringify(DATA.characters.baekhyun));
  assert.ok(greetings.validateEntry(good));
  const missingSlot = JSON.parse(JSON.stringify(good));
  delete missingSlot.slots.evening;
  assert.equal(greetings.validateEntry(missingSlot), null);
  const missingName = JSON.parse(JSON.stringify(good));
  delete missingName.withName.morning;
  assert.equal(greetings.validateEntry(missingName), null);
  const wrongName = JSON.parse(JSON.stringify(good));
  wrongName.withName.afternoon = { ko: '이름 없이 인사', zh: '没有称呼的问候' };
  assert.equal(greetings.validateEntry(wrongName), null);
  const noAsk = JSON.parse(JSON.stringify(good));
  delete noAsk.askName;
  assert.equal(greetings.validateEntry(noAsk), null);
  const noChinese = JSON.parse(JSON.stringify(good));
  noChinese.slots.morning = { ko: '좋은 아침', zh: 'good morning' };
  assert.equal(greetings.validateEntry(noChinese), null);
});

test('an optional audio file is used only when it exists on disk', () => {
  const id = 'zzgreettest';
  const dir = path.join(ROOT, 'characters', id);
  const audioDir = path.join(dir, 'greetings');
  fs.mkdirSync(audioDir, { recursive: true });
  try {
    const entry = JSON.parse(JSON.stringify(DATA.characters.baekhyun));
    entry.slots.morning = { ko: '아침이야', zh: '早上了', audio: 'morning-01.mp3' };
    // loadGreetings reads config/greetings.json, so exercise the helper directly.
    assert.equal(greetings.greetingUrl(id, entry.slots.morning), null, 'missing file is not offered');
    fs.writeFileSync(path.join(audioDir, 'morning-01.mp3'), Buffer.from('ID3 fake clip'));
    assert.equal(greetings.greetingUrl(id, entry.slots.morning), `/characters/${id}/greetings/morning-01.mp3`);
    assert.equal(greetings.greetingUrl(id, { ko: 'x', zh: 'y', audio: '../../secret.mp3' }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
