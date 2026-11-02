const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-scope-'));
process.env.STORE_DATA_DIR = dataDir;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

const store = require('../lib/store');
const prefs = require('../lib/prefs');
const wallet = require('../lib/wallet');
const { ACCOUNT_SCOPE } = require('../lib/account-scope');

const userId = 'c'.repeat(32);

test.before(async () => {
  await store.init();
});

test.after(async () => {
  await store.flush();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('account docs read the old user key and the new account key, and writes do not delete the old row', () => {
  assert.equal(ACCOUNT_SCOPE, 'account');
  store.putDoc('prefs', userId, 'user', {
    playback: 'auto',
    translation: 'collapsed',
    nickname: 'old',
    aiNoticeSeen: true,
  });
  assert.equal(prefs.load(userId).nickname, 'old');
  assert.equal(prefs.load(userId).playback, 'auto');

  const saved = prefs.save(userId, { nickname: 'new' });
  assert.equal(saved.nickname, 'new');
  assert.equal(store.getDoc('prefs', userId, 'account').nickname, 'new');
  assert.equal(store.getDoc('prefs', userId, 'user').nickname, 'old');
  assert.equal(prefs.load(userId).nickname, 'new');

  store.putDoc('wallet', userId, 'user', { balance: 3, purchases: [] });
  assert.equal(wallet.load(userId).balance, 3);
  store.putDoc('wallet', userId, 'account', { balance: 9, purchases: [] });
  assert.equal(wallet.load(userId).balance, 9);
  assert.equal(store.getDoc('wallet', userId, 'user').balance, 3);
});
