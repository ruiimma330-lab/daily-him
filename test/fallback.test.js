const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestChatCompletion } = require('../lib/llm-chat');
const { pickFallback, resetRecent, loadLines } = require('../lib/fallbacks');
const { createWriteQueue } = require('../lib/write-queue');
const { commitTurn } = require('../lib/chat-context');

function scripted(steps) {
  let index = 0;
  return async () => {
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step.error) throw step.error;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.json || {},
    };
  };
}

const chatBody = { model: 'test', messages: [] };

test('DeepSeek retries timeout, 429, 5xx, and an empty reply once', async () => {
  const cases = [
    { name: 'timeout', first: { error: Object.assign(new Error('slow'), { name: 'TimeoutError' }) } },
    { name: '429', first: { status: 429, json: {} } },
    { name: '500', first: { status: 502, json: {} } },
    { name: 'empty', first: { status: 200, json: { choices: [{ message: { content: '   ' } }] } } },
  ];
  for (const item of cases) {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return scripted([item.first])();
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"messages":[{"ko":"응","zh":"嗯"}]}' } }] }),
      };
    };
    const result = await requestChatCompletion({
      fetchImpl,
      url: 'https://example.test/chat',
      headers: {},
      body: chatBody,
      attemptMs: 50,
      deadlineMs: 200,
      accept: (content) => content.includes('응'),
    });
    assert.equal(result.ok, true, item.name);
    assert.equal(result.calls, 2, item.name);
  }
});

test('a repeated turn id does not store the user line or the reply twice', () => {
  const first = commitTurn([], '안녕', [{ ko: '응', zh: '嗯' }], 'turn12345');
  assert.equal(first.duplicate, false);
  assert.equal(first.messages.filter((item) => item.role === 'user').length, 1);
  const second = commitTurn(first.messages, '안녕', [{ ko: '다른말', zh: '另一句' }], 'turn12345');
  assert.equal(second.duplicate, true);
  assert.equal(second.messages, first.messages);
  assert.equal(second.replies[0].text, '응');
});

test('Baekhyun fallback lines do not repeat until the set is used', () => {
  resetRecent();
  const lines = loadLines('baekhyun');
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.equal(/AI|服务器|系统|server|system/i.test(`${line.ko} ${line.zh}`), false);
    assert.ok(line.ko.trim());
    assert.ok(line.zh.trim());
  }
  const seen = [];
  for (let i = 0; i < lines.length; i += 1) {
    const pick = pickFallback('baekhyun', seen);
    assert.equal(seen.includes(pick.ko), false);
    seen.push(pick.ko);
  }
  assert.equal(new Set(seen).size, 6);
});

test('Turso writes for one account and character stay in order and survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idol-queue-'));
  const file = path.join(dir, 'write-queue.json');
  const seen = [];
  let down = true;
  const first = createWriteQueue({
    file,
    sleep: () => Promise.resolve(),
    shutdownTries: 2,
    run: async (op) => {
      seen.push(op.mark);
      if (down && op.mark === 'first') {
        down = false;
        throw new Error('turso down');
      }
    },
  });
  first.push({ id: 'a', key: 'user|baekhyun', mark: 'first' });
  first.push({ id: 'b', key: 'user|baekhyun', mark: 'second' });
  await first.flush();
  assert.deepEqual(seen, ['first', 'first', 'second']);

  const crashed = createWriteQueue({
    file: path.join(dir, 'restart.json'),
    sleep: () => Promise.resolve(),
    shutdownTries: 2,
    run: async () => { throw new Error('still down'); },
  });
  crashed.push({ id: 'keep', key: 'user|baekhyun', type: 'putDoc', data: { messages: ['kept'] } });
  await crashed.flush({ shutdown: true });
  assert.equal(crashed.pending().length, 1);

  const applied = [];
  const restarted = createWriteQueue({
    file: path.join(dir, 'restart.json'),
    sleep: () => Promise.resolve(),
    run: async (op) => { applied.push(op.data.messages[0]); },
  });
  restarted.start();
  await restarted.flush();
  assert.deepEqual(applied, ['kept']);
  assert.equal(restarted.pending().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
