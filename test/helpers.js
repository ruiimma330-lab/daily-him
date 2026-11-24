'use strict';

let seq = 0;

/** Unique 8–12 digit username for registration tests. */
function digitUsername() {
  seq += 1;
  return `${Date.now()}${String(seq).padStart(3, '0')}`.slice(-12);
}

module.exports = { digitUsername };
