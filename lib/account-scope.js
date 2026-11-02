'use strict';

// Account-level rows share the characterId column. New writes use one scope.
// Older rows may still say "user". Reads accept both. This module does not
// migrate or delete existing rows.
const ACCOUNT_SCOPE = 'account';
const ACCOUNT_SCOPE_KEYS = ['account', 'user'];

function readAccountDoc(store, kind, userId) {
  for (const key of ACCOUNT_SCOPE_KEYS) {
    const doc = store.getDoc(kind, userId, key);
    if (doc) return doc;
  }
  return null;
}

function writeAccountDoc(store, kind, userId, data) {
  store.putDoc(kind, userId, ACCOUNT_SCOPE, data);
}

// A user-initiated delete has to clear both keys. Otherwise a leftover "user"
// row would be read back. This is not a migration.
function deleteAccountDoc(store, kind, userId) {
  for (const key of ACCOUNT_SCOPE_KEYS) {
    if (store.getDoc(kind, userId, key)) store.delDoc(kind, userId, key);
  }
}

module.exports = {
  ACCOUNT_SCOPE,
  ACCOUNT_SCOPE_KEYS,
  readAccountDoc,
  writeAccountDoc,
  deleteAccountDoc,
};
