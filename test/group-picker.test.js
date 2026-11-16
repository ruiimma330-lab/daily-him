'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-group-picker-'));
process.env.STORE_DATA_DIR = data;
process.env.SESSION_SECRET = 'group-picker-test-session-secret-123456';
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.APP_PASSWORD;
const chars = require('../lib/characters');
const voice = require('../lib/voice-pack');
const store = require('../lib/store');
const G = require('../public/shell/picker-groups');
const { LAUNCH } = require('./helpers/launch10');
const baseline = require('./fixtures/batch10-voice2-baseline.json');
const ROOT = path.join(__dirname, '..');

const roster = () => chars.list().map((c) => chars.publicInfo(c.id));
const summary = (model) => Object.fromEntries(model.groups.map((g) => [g.name, {
  open: g.members.filter(G.isOpen).map((c) => c.id).sort(),
  soon: g.members.filter((c) => !G.isOpen(c)).map((c) => c.id).sort(),
}]));

test('exactly the 10 launch characters are open in the public roster', () => {
  assert.deepEqual(roster().filter((c) => c.available).map((c) => c.id).sort(), [...LAUNCH].sort());
  const baekhyun = chars.publicInfo('baekhyun');
  assert.equal(baekhyun.fallbacks.offline.length, 3);
  assert.equal(baekhyun.fallbacks.voice.length, 3);
  assert.equal(chars.loadMeta('baekhyun').available, true);
  for (const id of ['giselle', 'jennie']) {
    assert.equal(chars.isAvailable(id), false, id);
    assert.equal(chars.publicInfo(id).availabilityLabel, '暂未开放', id);
  }
  // keonho stays off the public roster and in strict mode.
  assert.equal(chars.isPublic('keonho'), false);
  assert.equal(require('../lib/age-policy').policy('keonho').strict, true);
});

test('picker shows only groups with an open member; closed members stay as 待开放', () => {
  const model = G.build(roster());
  assert.deepEqual(summary(model), {
    EXO: { open: ['baekhyun'], soon: ['kai', 'sehun'] },
    TWS: { open: ['dohoon'], soon: ['shinyu'] },
    aespa: { open: ['karina'], soon: ['giselle', 'ningning', 'winter'] },
    BTS: { open: ['jimin', 'jungkook', 'taehyung'], soon: [] },
    BOYNEXTDOOR: { open: ['myungjaehyun'], soon: [] },
    AND2BLE: { open: ['zhanghao'], soon: ['ricky'] },
    RIIZE: { open: ['wonbin'], soon: [] },
    IVE: { open: ['wonyoung'], soon: ['yujin'] },
  });
  const names = model.groups.map((g) => g.name);
  for (const hidden of ['BLACKPINK', '个人', 'SEVENTEEN', 'TXT', 'EXO／个人', 'GOT7／个人']) assert.equal(names.includes(hidden), false, hidden);
  // The pool still lists every member of a visible group (including 待开放) for group tabs.
  // 「全部」 and a search on it only show people you can chat with. Hidden groups stay out.
  const pool = model.pool.map((c) => c.id);
  assert.equal(pool.length, 18);
  const openIds = model.pool.filter(G.isOpen).map((c) => c.id);
  assert.deepEqual(G.view(model, '全部', '').map((c) => c.id), openIds);
  assert.deepEqual([...openIds].sort(), [...LAUNCH].sort());
  assert.ok(G.view(model, '全部', '').every(G.isOpen));
  assert.ok(G.view(model, '全部', 'a').every(G.isOpen));
  for (const id of ['jennie', 'iu', 'layzhang', 'jacksonwang', 'keonho']) {
    assert.equal(pool.includes(id), false, id);
    assert.equal(G.view(model, '全部', id).length, 0, id);
  }
  for (const id of ['kai', 'sehun', 'giselle', 'ningning', 'winter', 'shinyu', 'ricky', 'yujin']) {
    assert.equal(pool.includes(id), true, id);
    assert.equal(G.view(model, '全部', '').some((c) => c.id === id), false, id);
    assert.equal(G.view(model, '全部', id).some((c) => c.id === id), false, id);
  }
  const exoSearch = G.view(model, '全部', 'exo');
  assert.ok(exoSearch.every(G.isOpen));
  assert.deepEqual(exoSearch.map((c) => c.id), ['baekhyun']);
  assert.deepEqual(G.view(model, 'aespa', '').map((c) => c.id), model.groups.find((g) => g.name === 'aespa').members.map((c) => c.id));
  assert.ok(G.view(model, 'EXO', '').some((c) => c.id === 'kai'));
  assert.deepEqual(G.view(model, 'EXO', 'kai').map((c) => c.id), ['kai']);
  assert.deepEqual(G.view(model, '全部', 'karina').map((c) => c.id), ['karina']);
  assert.deepEqual(G.view(model, 'BLACKPINK', '').map((c) => c.id), openIds, 'unknown tab falls back to 全部');
});

test('solo characters (个人, GOT7／个人, EXO／个人, no group) form 个人 only once one of them is open', () => {
  assert.equal(G.isSolo({ group: '个人' }), true);
  assert.equal(G.isSolo({ group: 'EXO／个人' }), true);
  assert.equal(G.isSolo({ group: 'GOT7／个人' }), true);
  assert.equal(G.isSolo({}), true);
  assert.equal(G.isSolo({ group: 'EXO' }), false);
  const base = roster();
  const withIu = base.map((c) => (c.id === 'iu' ? { ...c, available: true } : c));
  const model = G.build(withIu);
  const solo = model.groups[model.groups.length - 1];
  assert.equal(solo.name, '个人');
  assert.deepEqual(solo.members.map((c) => c.id).sort(), ['iu', 'jacksonwang', 'layzhang']);
  assert.equal(model.groups.find((g) => g.name === 'EXO').members.some((c) => c.id === 'layzhang'), false);
  assert.equal(G.build(base).groups.some((g) => g.solo), false);
});

test('picker page has no company tabs and loads the grouping module', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/shell/pick.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public/shell/picker.js'), 'utf8');
  assert.equal(html.includes('picker-companies'), false);
  assert.ok(html.indexOf('/shell/picker-groups.js') < html.indexOf('/shell/picker.js'));
  assert.equal(/COMPANY_LABELS|picker-companies|state\.company/.test(js), false);
  assert.match(js, /PickerGroups\.build/);
  const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  assert.match(sw, /'\/shell\/picker-groups\.js'/);
});

test('availability change leaves personas and every voice pack byte-identical', () => {
  for (const [id, expected] of Object.entries(baseline.voiceHashes)) {
    const lock = JSON.parse(fs.readFileSync(voice.lockPath(id)));
    assert.equal(lock.contentHash, expected, id);
    assert.equal(voice.contentHash(id, lock), expected, id);
  }
  for (const [id, expected] of Object.entries(baseline.personaHashes || {})) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'characters', id, 'persona.md'))).digest('hex');
    assert.equal(actual, expected, id);
  }
  for (const id of LAUNCH.filter((x) => x !== 'baekhyun')) {
    const pack = voice.load(id);
    assert.equal(pack.ok, true, id);
    assert.equal(pack.lock.version, `${id}-voice-2`);
    assert.equal(pack.lock.contentHash, voice.contentHash(id, pack.lock));
  }
  assert.equal(voice.load('baekhyun').lock.version, 'baekhyun-voice-1');
});

let server, base, cookie, userId;
test.before(async () => {
  await store.init();
  server = require('../server').createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'grouppicker', password: 'password123', age14: true }) });
  cookie = r.headers.get('set-cookie').match(/sid=[^;]+/)[0];
  userId = (await (await fetch(base + '/api/me', { headers: { Cookie: cookie } })).json()).user.id;
});
test.after(async () => {
  await store.flush({ shutdown: true });
  if (server && server.listening) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(data, { recursive: true, force: true });
});

test('existing chats with closed characters stay readable, but cannot be continued', async () => {
  const get = (route) => fetch(base + route, { headers: { Cookie: cookie } });
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const messages = [{ role: 'user', text: '之前的聊天', time: Date.now() }];
  store.putHistory(userId, 'giselle', messages);
  const saved = store.getHistory(userId, 'giselle');

  const conversations = await (await get('/api/conversations')).json();
  assert.ok(conversations.conversations.some((c) => c.id === 'giselle'));
  const history = await get('/api/history?characterId=giselle');
  assert.equal(history.status, 200);
  const historyBody = await history.json();
  assert.deepEqual(historyBody.messages, saved);
  assert.equal(historyBody.readOnly, true);

  for (const route of ['/api/chat', '/api/tts']) {
    const r = await post(route, { characterId: 'giselle', text: 'hello', messages: [], voice: false });
    assert.equal(r.status, 404, route);
    assert.equal((await r.json()).error, 'character unavailable');
  }
  const put = await fetch(base + '/api/history', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId: 'giselle', messages: [] }) });
  assert.equal(put.status, 404);
  assert.deepEqual(store.getHistory(userId, 'giselle'), saved);

  store.putDoc('memory', userId, 'giselle', {
    cards: [{ id: 'abc123abc123', text: '保留的记忆', createdAt: 1, updatedAt: 1 }],
    summary: '应删除的摘要',
    pending: [{ u: '之前的聊天', a: '嗯', t: 1 }],
    pendingTurns: 1,
  });
  store.putDoc('relationship', userId, 'giselle', { totalTurns: 7, score: 12 });
  const deleted = await fetch(base + '/api/history?characterId=giselle&summary=1', {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(store.getHistory(userId, 'giselle'), []);
  assert.equal(store.getDoc('memory', userId, 'giselle').summary, '');
  assert.equal(store.getDoc('memory', userId, 'giselle').cards.length, 1);
  assert.equal(store.getDoc('relationship', userId, 'giselle').totalTurns, 7);

  // No history with a closed character: read and delete still 404. Launch characters keep existing behavior.
  assert.equal((await get('/api/history?characterId=jennie')).status, 404);
  assert.equal((await fetch(base + '/api/history?characterId=jennie&summary=1', { method: 'DELETE', headers: { Cookie: cookie } })).status, 404);
  const openHistory = await get('/api/history?characterId=karina');
  assert.equal(openHistory.status, 200);
  assert.equal((await openHistory.json()).readOnly, false);
});

test('closed-chat UI is read-only while keeping the two-step history deletion action', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const memory = fs.readFileSync(path.join(ROOT, 'public/memory.js'), 'utf8');
  assert.match(html, /该角色暂未开放，当前仅可查看。/);
  assert.match(html, /将删除聊天记录和摘要。他记得的你与亲密度会保留。/);
  assert.match(app, /composer\.hidden = blocked/);
  assert.match(app, /!writesBlocked\(\) && \/\[\\p\{L\}\\p\{N\}\]\//);
  assert.match(app, /paintClearConfirmation\(2\)/);
  assert.match(app, /\/api\/history\?summary=1/);
  assert.match(memory, /isReadOnly\(\)/);
  assert.match(memory, /idol-character-readonly/);
});
