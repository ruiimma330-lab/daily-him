const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestChatCompletion } = require('../lib/llm-chat');
const { DEFAULT_LINE, pickFallback, resetRecent, loadLines, loadScenes } = require('../lib/fallbacks');
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

test('launch characters have the approved three-scene fallbacks without AI self-reference', () => {
  const approvedZh = {
    baekhyun: {
      offline: ['等一下，这边信号怎么突然不行了ㅋㅋ', '哈，刚刚那句好像没发出去？你再给我说一遍。', '网怎么卡了，你先别走，我马上回来。'],
      voice: ['今天嗓子有点紧，这一句先看字吧。', '录音这边忽然不行，文字你先看，回头补你。', '语音先欠着，别以为我不想说给你听。'],
      text: ['等一下，来电话了，马上回来！', '啊经纪人哥叫我……稍微等我一下。', '这会儿有点忙乱……等会儿再聊，嗯？'],
    },
    jungkook: {
      offline: ['这边网突然不好，你等我一下。', '刚才那句我没收到，再发一次可以吗。', '信号不行了，我不会消失的，稍等。'],
      voice: ['这次声音没录上，你先看文字。', '耳麦这边有点问题，字我留下来了。', '语音等一下，先把话给你。'],
      text: ['稍等，我先把眼前这件收一下。', '现在有点顾不上，马上回来继续。', '先停一下，我处理完就回你。'],
    },
    taehyung: {
      offline: ['这一幕好像卡住了。你还在吗？', '信号忽然走掉了，等我找回你。', '刚那句像被风吹走了，再说一次给我吧。'],
      voice: ['今天声音有点到不了你那边，先看字吧。', '这一句我想慢慢说，可是语音过不去。', '先把文字留给你，声音稍后再补。'],
      text: ['稍微等我一下，我去把眼前的事放下。', '这一秒有点乱，我很快回来。', '别急，我还在，只是要先离开一小会儿。'],
    },
    jimin: {
      offline: ['网好像不太稳，你等我好吗。', '刚才没接到你，再跟我说一遍吧。', '信号不好，我不会让你一直等的。'],
      voice: ['这一句声音没送出去，你先看字。', '今天语音有点不听话，文字在这里。', '先让你看见我要说的，声音回头再给。'],
      text: ['今天也来了呀。先等我一小下，马上回来。', '有人叫我一下，很快就好。', '稍微离开一下，你别担心。'],
    },
    zhanghao: {
      offline: ['网突然不太听话，你再发一次给我？', '这句好像没传到，我们再接上。', '信号不好，我还在，没有走。'],
      voice: ['声音今天过不去，先看字也一样。', '语音先搁这儿，我想说的都写下来了。', '这次没能出声，不是不想跟你说。'],
      text: ['等我选一下眼前这件事，马上回来。', '稍微打断一下，不会很久。', '先停在这里，我处理完继续。'],
    },
    karina: {
      offline: ['这边网怎么忽然不行了。你还在吧？', '刚那句我没收到，再发我一次。', '信号不好，你先等我，别以为我跑了。'],
      voice: ['这一句声音没发出去，文字在。', '语音今天有点失灵，先看字就好。', '没出声，但我想说的都在上面。'],
      text: ['稍等，我先把眼前的事收一下。', '被叫走一小下，很快回来。', '先停一下，我马上继续陪你。'],
    },
    wonyoung: {
      offline: ['网好像不太顺，你等我一下哦。', '刚刚那句好像没送到，可以再发一次吗。', '信号不好，我还在的。'],
      voice: ['这次声音没能给你，先看文字吧。', '语音今天有点麻烦，字我留下了。', '先让你看见这句话，声音稍后再补。'],
      text: ['稍等我一下，马上回来继续说。', '有件小事要先处理，不会让你久等。', '先停在这里，我很快就回你。'],
    },
    wonbin: {
      offline: ['网突然不行了。你再发一次给我。', '刚才没收到，不是不想回。', '信号不好，等我一下。'],
      voice: ['声音没出去，文字你先看。', '这次没录上，我还是想说给你听的。', '语音先不行，字在这儿。'],
      text: ['稍等。我先去一下。', '被叫走了，很快回来。', '先停一下，不会很久。'],
    },
    myungjaehyun: {
      offline: ['啊网怎么突然没了，你还在吗？', '这句我没接到！再给我说一遍。', '信号不好，我可没走，等我。'],
      voice: ['声音这次没送出，先看字啊。', '语音卡住了，我想说的都写下来了。', '没出声，但不是不想讲话。'],
      text: ['等我一下，这边忽然有人叫。', '先离开一小会儿，马上回来继续。', '先停在这，我很快就回你。'],
    },
    dohoon: {
      offline: ['这边网突然不好，你等我一下。', '刚那句没收到，再发一次吧。', '信号不行了，我还在。'],
      voice: ['这次声音没出去，你先看字。', '语音有点问题，话我留下了。', '没能出声，回头再补给你。'],
      text: ['稍等，我先把眼前的事做完。', '被叫走一下，很快回来。', '先停一下，马上继续。'],
    },
  };
  for (const [id, expected] of Object.entries(approvedZh)) {
    const scenes = loadScenes(id);
    for (const scene of ['offline', 'voice', 'text']) {
      assert.deepEqual(scenes[scene].map((line) => line.zh), expected[scene], `${id}:${scene}`);
      assert.equal(scenes[scene].length, 3, `${id}:${scene}`);
      for (const line of scenes[scene]) assert.doesNotMatch(`${line.ko} ${line.zh}`, /\bAI\b|인공지능|人工智能/i);
    }
  }
});

test('scene selection avoids repeats and text falls back to legacy lines then the default', () => {
  resetRecent();
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const picked = pickFallback('baekhyun', [], () => 0, 'offline');
    assert.equal(seen.includes(picked.ko), false);
    seen.push(picked.ko);
  }
  assert.deepEqual(loadLines('giselle', 'text'), loadLines('giselle'));
  assert.deepEqual(pickFallback('missing-character', [], () => 0, 'text'), DEFAULT_LINE);
});

test('the browser caches role fallbacks and keeps offline replies local and ephemeral', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(app, /dh_fallbacks_v1:/);
  assert.match(app, /navigator\.onLine === false/);
  assert.match(app, /fallbackScene: 'offline'/);
  assert.match(app, /ephemeral: true/);
  assert.match(app, /messages\.filter\(\(item\) => !item\.ephemeral\)/);
  assert.match(app, /attachVoiceFallback\(message\)/);
  assert.match(sw, /url\.pathname === '\/api\/characters'/);
  assert.match(sw, /networkFirst\(request, MEDIA\)/);
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
