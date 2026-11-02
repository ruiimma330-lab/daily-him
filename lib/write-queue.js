'use strict';

const fs = require('fs');
const path = require('path');

// Pending Turso writes. Ops for the same key stay in order. A failure waits
// and tries that same op again. Other keys are not blocked.
function createWriteQueue({ file, run, sleep, shutdownTries = 3 }) {
  const tails = new Map();
  let ops = [];
  let seq = 1;
  let shuttingDown = false;

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      ops = Array.isArray(parsed.ops) ? parsed.ops : [];
      seq = ops.reduce((max, op) => Math.max(max, op.seq || 0), 0) + 1;
    } catch (_) {
      ops = [];
    }
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ops }));
    fs.renameSync(tmp, file);
  }

  function delay(attempt) {
    return Math.min(15000, 200 * (4 ** attempt));
  }

  async function deliver(op) {
    let attempt = 0;
    for (;;) {
      try {
        await run(op);
        ops = ops.filter((item) => item.id !== op.id);
        persist();
        return;
      } catch (err) {
        const wait = shuttingDown ? Math.min(500, delay(attempt)) : delay(attempt);
        console.error(`Storage write failed (${op.key}): ${err && err.message ? err.message : 'error'}; retry in ${wait}ms`);
        attempt += 1;
        if (shuttingDown && attempt >= shutdownTries) return;
        await sleep(wait);
      }
    }
  }

  function kick(key) {
    const prev = tails.get(key) || Promise.resolve();
    const next = prev.then(async () => {
      for (;;) {
        const op = ops.find((item) => item.key === key);
        if (!op) return;
        await deliver(op);
        if (ops.some((item) => item.id === op.id)) return;
      }
    });
    tails.set(key, next.catch((err) => {
      console.error(`Storage queue stopped (${key}): ${err && err.message ? err.message : 'error'}`);
    }));
  }

  function push(op) {
    const stored = { ...op, seq };
    seq += 1;
    ops.push(stored);
    persist();
    kick(stored.key);
    return stored;
  }

  function start() {
    [...new Set(ops.map((op) => op.key))].forEach(kick);
  }

  function flush(opts = {}) {
    if (opts.shutdown) shuttingDown = true;
    return Promise.all([...tails.values()]).then(() => undefined);
  }

  function pending() {
    return ops.map((op) => ({ ...op }));
  }

  load();

  return { push, start, flush, pending };
}

module.exports = { createWriteQueue };
