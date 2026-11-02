/* Account-scoped browser cache. History, settings, prefs, and the selected
   character are keyed by user id (and character id when the data is per idol).
   Device install flags stay global. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AccountCache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const USER_RE = /^[a-f0-9]{32}$/;

  function keysOf(storage) {
    const out = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key) out.push(key);
    }
    return out;
  }

  function historyKey(userId, characterId) {
    return `idolchat_history_v1:${userId}:${characterId}`;
  }

  function settingsKey(userId, characterId) {
    return `idolchat_settings_v1:${userId}:${characterId}`;
  }

  function prefsKey(userId) {
    return `idol_prefs_v1:${userId}`;
  }

  function selectedKey(userId) {
    return `idol_selected_character:${userId}`;
  }

  function getSelected(storage, userId) {
    try {
      const value = storage.getItem(selectedKey(userId));
      return value ? String(value).toLowerCase() : '';
    } catch (_) {
      return '';
    }
  }

  function setSelected(storage, userId, characterId) {
    if (!userId || !characterId) return;
    try { storage.setItem(selectedKey(userId), String(characterId).toLowerCase()); } catch (_) { /* ignore */ }
  }

  function migrate(storage, userId, characterId) {
    const char = String(characterId || 'baekhyun').toLowerCase();
    const legacyHistory = storage.getItem('idolchat_history_v1');
    if (legacyHistory && !storage.getItem(historyKey(userId, 'baekhyun'))) {
      storage.setItem(historyKey(userId, 'baekhyun'), legacyHistory);
    }
    storage.removeItem('idolchat_history_v1');

    keysOf(storage).forEach((key) => {
      const match = key.match(/^idolchat_history_v1:([a-z0-9_-]{1,32})$/);
      if (!match || USER_RE.test(match[1])) return;
      const dest = historyKey(userId, match[1]);
      if (!storage.getItem(dest)) storage.setItem(dest, storage.getItem(key));
      storage.removeItem(key);
    });

    const legacySettings = storage.getItem('idolchat_settings_v1');
    if (legacySettings && !storage.getItem(settingsKey(userId, char))) {
      storage.setItem(settingsKey(userId, char), legacySettings);
    }
    storage.removeItem('idolchat_settings_v1');

    const legacyPrefs = storage.getItem('idol_prefs_v1');
    if (legacyPrefs && !storage.getItem(prefsKey(userId))) {
      storage.setItem(prefsKey(userId), legacyPrefs);
    }
    storage.removeItem('idol_prefs_v1');

    const legacySelected = storage.getItem('idol_selected_character');
    if (legacySelected && !storage.getItem(selectedKey(userId))) {
      storage.setItem(selectedKey(userId), legacySelected);
    }
    storage.removeItem('idol_selected_character');
  }

  function belongsToUser(key, userId) {
    return key === prefsKey(userId)
      || key === selectedKey(userId)
      || key === `idol_cache_migrated:${userId}`
      || key.indexOf(`idolchat_history_v1:${userId}:`) === 0
      || key.indexOf(`idolchat_settings_v1:${userId}:`) === 0;
  }

  function isAccountKey(key) {
    return key === 'idol_account_id'
      || key === 'idol_prefs_v1'
      || key === 'idol_selected_character'
      || key === 'idolchat_history_v1'
      || key === 'idolchat_settings_v1'
      || key.indexOf('idol_prefs_v1:') === 0
      || key.indexOf('idol_selected_character:') === 0
      || key.indexOf('idolchat_history_v1') === 0
      || key.indexOf('idolchat_settings_v1') === 0
      || key.indexOf('idol_cache_migrated:') === 0;
  }

  function purgeForeign(storage, userId) {
    keysOf(storage).forEach((key) => {
      if (!isAccountKey(key) || key === 'idol_account_id') return;
      if (belongsToUser(key, userId)) return;
      storage.removeItem(key);
    });
  }

  function adopt(storage, userId, characterId) {
    if (!userId) return;
    migrate(storage, userId, characterId || 'baekhyun');
    purgeForeign(storage, userId);
    try {
      storage.setItem('idol_account_id', userId);
      storage.setItem(`idol_cache_migrated:${userId}`, '1');
    } catch (_) { /* ignore */ }
  }

  // A failed pull must not fall back to whatever the browser still has.
  function viewAfterFetch(fetchOk, remote) {
    if (!fetchOk || !Array.isArray(remote)) return [];
    return remote;
  }

  return {
    historyKey,
    settingsKey,
    prefsKey,
    selectedKey,
    getSelected,
    setSelected,
    migrate,
    adopt,
    purgeForeign,
    viewAfterFetch,
  };
});
