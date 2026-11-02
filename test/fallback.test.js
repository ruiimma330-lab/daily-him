const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestChatCompletion } = require('../lib/llm-chat');
const { pickFallback, resetRecent, loadLines } = require('../lib/fallbacks');
const { createWriteQueue } = require('../lib/write-queue');
const { commitTurn, fromHistory } = require('../lib/chat-context');
const memory = require('../lib/memory');

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
  assert.deepEqual(lines, [
    { ko: '잠깐만, 전화 왔어. 금방 올게!', zh: '等一下，来电话了，马上回来！' },
    { ko: '아 매니저 형이 불러… 조금만 기다려 줘.', zh: '啊经纪人哥叫我……稍微等我一下。' },
    { ko: '미안, 지금 리허설 들어가야 돼. 끝나고 바로 연락할게.', zh: '抱歉，现在得去彩排了，结束马上联系你。' },
    { ko: '잠깐 누가 문 두드려. 기다려, 도망가지 말고 ㅋㅋ', zh: '等下有人敲门。等我哦，不许跑哈哈。' },
    { ko: '앗 스태프가 찾는다. 5분만! 진짜 5분.', zh: '啊工作人员在找我。就 5 分钟！真的 5 分钟。' },
    { ko: '잠깐 정신없어서… 조금 있다가 다시 얘기하자, 응?', zh: '这会儿有点忙乱……等会儿再聊，嗯？' },
  ]);
  for (const line of lines) {
    assert.equal(/AI|服务器|系统|server|system/i.test(`${line.ko} ${line.zh}`), false);
  }
  const seen = [];
  for (let i = 0; i < lines.length; i += 1) {
    const pick = pickFallback('baekhyun', seen);
    assert.equal(seen.includes(pick.ko), false);
    seen.push(pick.ko);
  }
  assert.equal(new Set(seen).size, 6);
});

test('a fallback reply stays on the record and stays out of the next reply and memory', async () => {
  const line = loadLines('baekhyun')[0];
  const stored = commitTurn([], '뭐해', [{ ko: line.ko, zh: line.zh, mood: 'soft', fallback: true }], 'turnfb0001');
  assert.equal(stored.duplicate, false);
  assert.equal(stored.messages.at(-1).text, line.ko);
  assert.equal(stored.messages.at(-1).fallback, true);
  const next = fromHistory(stored.messages, '밥 먹었어?');
  assert.deepEqual(next.map((item) => item.content), ['뭐해', '밥 먹었어?']);
  assert.equal(next.some((item) => item.content === line.ko), false);

  const docs = new Map();
  memory.setBackend({
    load: (userId, characterId) => {
      const found = docs.get(`${userId}|${characterId}`);
      return found ? JSON.parse(JSON.stringify(found)) : null;
    },
    save: (userId, characterId, data) => docs.set(`${userId}|${characterId}`, JSON.parse(JSON.stringify(data))),
  });
  try {
    const history = [];
    for (let i = 0; i < 32; i += 1) {
      history.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: i === 1 ? line.ko : `line-${i}`,
        time: i + 1,
        ...(i === 1 ? { fallback: true } : {}),
      });
    }
    let seen = '';
    await memory.afterTurn({
      userId: 'fbuser',
      characterId: 'baekhyun',
      userText: '안녕',
      replyText: '',
      llm: async (messages) => {
        seen += messages.map((item) => item.content || '').join('\n');
        return '用户打过招呼。';
      },
      userName: '에리',
      getHistory: () => history,
    });
    assert.equal(seen.includes('line-0'), true);
    assert.equal(seen.includes(line.ko), false);
    assert.equal(JSON.stringify(docs.get('fbuser|baekhyun')).includes(line.ko), false);
  } finally {
    memory.setBackend(memory.storeBackend);
  }
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
