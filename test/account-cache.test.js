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

test('switching accounts preserves per-account isolated persistence, clearUser removes only target user, and purgeForeign/viewAfterFetch still work', () => {
  const storage = memoryStorage();
  const aHistory = [{ role: 'user', text: 'A-secret', time: 1 }];
  const aFriends = [{ id: 'baekhyun', name: 'Baekhyun', displayName: '백현', preview: 'A-preview', lastAt: 100 }];
  const aMe = { id: userA, username: '10000001', nickname: 'only-A', hasAvatar: true };
  cache.setHistory(storage, userA, 'baekhyun', aHistory);
  cache.setFriends(storage, userA, aFriends);
  cache.setMe(storage, userA, aMe);
  storage.setItem(cache.prefsKey(userA), JSON.stringify({ nickname: 'only-A' }));
  storage.setItem('idol_account_id', userA);

  // Switch to Account B: Account A's keys stay isolated in storage, B cannot see A's data.
  cache.adopt(storage, userB, 'baekhyun');
  assert.equal(storage.getItem('idol_account_id'), userB);
  assert.deepEqual(cache.getHistory(storage, userA, 'baekhyun'), aHistory);
  assert.equal(cache.getFriends(storage, userA).length, 1);
  assert.equal(cache.getFriends(storage, userA)[0].preview, 'A-preview');
  assert.deepEqual(cache.getMe(storage, userA), aMe);
  assert.match(storage.getItem(cache.prefsKey(userA)), /only-A/);

  assert.equal(cache.getFriends(storage, userB), null);
  assert.equal(cache.getHistory(storage, userB, 'baekhyun'), null);
  assert.equal(cache.getMe(storage, userB), null);
  assert.equal(cache.getFriends(storage, ''), null);

  // Store Account B's own data.
  const bFriends = [{ id: 'jimin', name: 'Jimin', displayName: '지민', preview: 'B-preview', lastAt: 200 }];
  const bHistory = [{ role: 'assistant', text: 'B-secret', time: 2 }];
  const bMe = { id: userB, username: '10000002', nickname: 'only-B', hasAvatar: false };
  cache.setFriends(storage, userB, bFriends);
  cache.setHistory(storage, userB, 'jimin', bHistory);
  cache.setMe(storage, userB, bMe);

  // Switching back to Account A immediately restores Account A's own friends & history.
  cache.adopt(storage, userA, 'baekhyun');
  assert.equal(storage.getItem('idol_account_id'), userA);
  assert.equal(cache.getFriends(storage, userA)[0].id, 'baekhyun');
  assert.deepEqual(cache.getHistory(storage, userA, 'baekhyun'), aHistory);
  assert.deepEqual(cache.getMe(storage, userA), aMe);

  // clearUser removes ONLY Account A's keys while leaving Account B intact.
  cache.clearUser(storage, userA);
  assert.equal(cache.getFriends(storage, userA), null);
  assert.equal(cache.getHistory(storage, userA, 'baekhyun'), null);
  assert.equal(cache.getMe(storage, userA), null);
  assert.equal(storage.getItem(cache.prefsKey(userA)), null);
  assert.equal(storage.getItem(`idol_cache_migrated:${userA}`), null);

  assert.equal(cache.getFriends(storage, userB)[0].id, 'jimin');
  assert.deepEqual(cache.getHistory(storage, userB, 'jimin'), bHistory);
  assert.deepEqual(cache.getMe(storage, userB), bMe);

  // purgeForeign still wipes other accounts when called explicitly.
  cache.setFriends(storage, userA, aFriends);
  cache.purgeForeign(storage, userB);
  assert.equal(cache.getFriends(storage, userA), null);
  assert.equal(cache.getFriends(storage, userB)[0].id, 'jimin');

  // viewAfterFetch(false, ...) still returns [].
  const shown = cache.viewAfterFetch(false, [{ role: 'user', text: 'A-secret', time: 1 }]);
  assert.deepEqual(shown, []);
});
