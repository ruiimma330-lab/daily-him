'use strict';

// Demo wallet only — purchases never add real balance.
const store = require('./store');
const ACCOUNT = 'account';

const PACKAGES = {
  p1: { coins: 60, priceLabel: '¥6' },
  p2: { coins: 300, priceLabel: '¥30' },
  p3: { coins: 680, priceLabel: '¥68' },
};

function load(userId) {
  const d = store.getDoc('wallet', userId, ACCOUNT) || {};
  return {
    balance: Number.isFinite(d.balance) ? d.balance : 0,
    purchases: Array.isArray(d.purchases) ? d.purchases.slice(-50) : [],
  };
}

function save(userId, data) {
  store.putDoc('wallet', userId, ACCOUNT, data);
}

function purchase(userId, packageId) {
  const pkg = PACKAGES[packageId];
  if (!pkg) {
    const err = new Error('unknown package');
    err.code = 'UNKNOWN_PACKAGE';
    throw err;
  }
  const w = load(userId);
  w.purchases.push({ packageId, at: Date.now(), demo: true, coins: pkg.coins });
  // Intentionally do NOT increase balance — payment not enabled.
  save(userId, w);
  return {
    balance: w.balance,
    message: '演示，未开通支付',
    packageId,
  };
}

module.exports = { load, purchase, PACKAGES, ACCOUNT };
