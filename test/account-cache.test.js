const test = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../public/account-cache');

function memoryStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(key); },
    key(index) { return [...map.keys()][index] || null; },
    get length() { return map.size; },
    dump() { return map; },
  };
}

const userA = 'a'.repeat(32);
const userB = 'b'.repeat(32);

test('legacy keys migrate onto the signed-in account and the old keys are deleted', () => {
  const storage = memoryStorage({
    idolchat_history_v1: JSON.stringify([{ role: 'user', text: 'baek-secret', time: 1 }]),
    'idolchat_history_v1:zztest': JSON.stringify([{ role: 'user', text: 'zz-secret', time: 2 }]),
    idol_prefs_v1: JSON.stringify({ nickname: 'mina' }),
    idol_selected_character: 'zztest',
    dh_install_banner: '1',
  });
  cache.adopt(storage, userA, 'baekhyun');
  assert.equal(storage.getItem('idolchat_history_v1'), null);
  assert.equal(storage.getItem('idolchat_history_v1:zztest'), null);
  assert.equal(storage.getItem('idol_prefs_v1'), null);
  assert.equal(storage.getItem('idol_selected_character'), null);
  assert.equal(storage.getItem(cache.historyKey(userA, 'baekhyun')), JSON.stringify([{ role: 'user', text: 'baek-secret', time: 1 }]));
  assert.equal(storage.getItem(cache.historyKey(userA, 'zztest')), JSON.stringify([{ role: 'user', text: 'zz-secret', time: 2 }]));
  assert.match(storage.getItem(cache.prefsKey(userA)), /mina/);
  assert.equal(cache.getSelected(storage, userA), 'zztest');
  assert.equal(storage.getItem('dh_install_banner'), '1');
});

test('switching accounts drops the previous account cache and a failed fetch stays blank', () => {
  const storage = memoryStorage();
  storage.setItem(cache.historyKey(userA, 'baekhyun'), JSON.stringify([{ role: 'user', text: 'A-secret', time: 1 }]));
  storage.setItem(cache.prefsKey(userA), JSON.stringify({ nickname: 'only-A' }));
  storage.setItem('idol_account_id', userA);

  cache.adopt(storage, userB, 'baekhyun');

  assert.equal(storage.getItem(cache.historyKey(userA, 'baekhyun')), null);
  assert.equal(storage.getItem(cache.prefsKey(userA)), null);
  assert.equal(storage.getItem('idol_account_id'), userB);
  assert.equal(storage.getItem(cache.historyKey(userB, 'baekhyun')), null);

  const shown = cache.viewAfterFetch(false, [{ role: 'user', text: 'A-secret', time: 1 }]);
  assert.deepEqual(shown, []);
  assert.equal(JSON.stringify([...storage.dump().values()]).includes('A-secret'), false);
});
