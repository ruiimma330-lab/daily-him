'use strict';
function prepare(text) { return String(text || '').trim(); }
function canSpeak(text) { return /[\p{L}\p{N}]/u.test(String(text || '').replace(/\[[^\]]*\]/g, '')); }
module.exports = { prepare, canSpeak };
