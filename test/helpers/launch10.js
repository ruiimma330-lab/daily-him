'use strict';
// The 10 launch characters. Exactly these are open in the public picker (2026-11-13).
const LAUNCH = Object.freeze(['baekhyun', 'jungkook', 'taehyung', 'jimin', 'zhanghao', 'karina', 'wonyoung', 'wonbin', 'myungjaehyun', 'dohoon']);
const LAUNCH_SET = new Set(LAUNCH);
module.exports = { LAUNCH, isLaunch: (id) => LAUNCH_SET.has(id) };

// Calls a real requireAvailable middleware offline: launch characters pass, everyone else gets 404.
function expectGuard(assert, guard, id, label = '') {
  let status, body, passed = false;
  const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  guard({ characterId: id, body: {} }, res, () => { passed = true; });
  if (LAUNCH_SET.has(id)) {
    assert.equal(passed, true, `${id}${label} should pass`);
  } else {
    assert.equal(passed, false, `${id}${label} should be blocked`);
    assert.equal(status, 404, id + label);
    assert.equal(body.error, 'character unavailable', id + label);
  }
}
module.exports.expectGuard = expectGuard;
