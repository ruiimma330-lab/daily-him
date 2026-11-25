'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const singing = require('../lib/singing');
const store = require('../lib/store');
const { stripAudioTags, toSpeechText, parseReply, resolveRuntimeConfig } = require('../server');
const makeSingingClip = require('../scripts/make-singing-clip');

test('detectIntent distinguishes specified songs, general requests + occasions, and normal chat', () => {
  const star = singing.detectIntent('唱《小星星》');
  assert.equal(star.sing, true);
  assert.equal(star.mode, 'specified');
  assert.equal(star.song, '小星星');
  assert.equal(star.occasion, 'any');

  const sunny = singing.detectIntent('清唱晴天');
  assert.equal(sunny.sing, true);
  assert.equal(sunny.mode, 'specified');
  assert.equal(sunny.song, '晴天');

  const general = singing.detectIntent('给我清唱一段吧');
  assert.equal(general.sing, true);
  assert.equal(general.mode, 'general');
  assert.equal(general.song, '');
  assert.equal(general.occasion, 'any');

  const lullaby = singing.detectIntent('唱首歌哄我睡觉');
  assert.equal(lullaby.sing, true);
  assert.equal(lullaby.mode, 'general');
  assert.equal(lullaby.occasion, 'lullaby');

  const birthday = singing.detectIntent('唱生日快乐歌给我听');
  assert.equal(birthday.sing, true);
  assert.equal(birthday.mode, 'general');
  assert.equal(birthday.occasion, 'birthday');

  const koGeneral = singing.detectIntent('노래 불러줘');
  assert.equal(koGeneral.sing, true);
  assert.equal(koGeneral.mode, 'general');
  assert.equal(koGeneral.occasion, 'any');

  const koLullaby = singing.detectIntent('자장가 불러줘');
  assert.equal(koLullaby.sing, true);
  assert.equal(koLullaby.mode, 'general');
  assert.equal(koLullaby.occasion, 'lullaby');

  const chat = singing.detectIntent('今天吃什么');
  assert.equal(chat.sing, false);
  assert.equal(chat.mode, null);
  assert.equal(chat.occasion, null);

  const concertChat = singing.detectIntent('演唱会门票好难抢啊');
  assert.equal(concertChat.sing, false);
});

test('pickPresetClip checks real .mp3 files, avoids recent clips, and resolveClipPath blocks traversal', () => {
  const tmpCharDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-singing-'));
  try {
    // Path traversal & invalid extension checks
    assert.equal(singing.resolveClipPath('baekhyun', '../secret.mp3', tmpCharDir), null);
    assert.equal(singing.resolveClipPath('baekhyun', 'sub/clip.mp3', tmpCharDir), null);
    assert.equal(singing.resolveClipPath('baekhyun', 'clip.wav', tmpCharDir), null);
    assert.equal(singing.resolveClipPath('../etc', 'clip.mp3', tmpCharDir), null);
    const validPath = singing.resolveClipPath('baekhyun', 'lullaby-1.mp3', tmpCharDir);
    assert.equal(validPath, path.resolve(tmpCharDir, 'baekhyun', 'singing', 'lullaby-1.mp3'));

    const config = {
      characters: {
        baekhyun: [
          {
            id: 'lullaby-1',
            file: 'lullaby-1.mp3',
            occasion: 'lullaby',
            ko: '잘 자요~ 내 꿈 꿔요~',
            zh: '晚安哦～梦到我吧～',
            mood: 'soft',
          },
          {
            id: 'lullaby-2',
            file: 'lullaby-2.mp3',
            occasion: 'lullaby',
            ko: '눈 감아요~ 내가 곁에 있어요~',
            zh: '闭上眼睛吧～我在你身边～',
            mood: 'sweet',
          },
          {
            id: 'missing-clip',
            file: 'missing.mp3',
            occasion: 'any',
            ko: '없는 노래',
            zh: '不存在的歌',
            mood: 'soft',
          },
        ],
      },
    };

    // No files on disk yet -> null
    assert.equal(singing.pickPresetClip('baekhyun', 'lullaby', [], { config, charDir: tmpCharDir }), null);

    // Create a tiny invalid (<64 bytes) file -> still null
    const singingDir = path.join(tmpCharDir, 'baekhyun', 'singing');
    fs.mkdirSync(singingDir, { recursive: true });
    fs.writeFileSync(path.join(singingDir, 'lullaby-1.mp3'), Buffer.alloc(16, 1));
    assert.equal(singing.pickPresetClip('baekhyun', 'lullaby', [], { config, charDir: tmpCharDir }), null);

    // Write valid (>64 bytes) mp3 clips
    fs.writeFileSync(path.join(singingDir, 'lullaby-1.mp3'), Buffer.alloc(256, 7));
    fs.writeFileSync(path.join(singingDir, 'lullaby-2.mp3'), Buffer.alloc(256, 9));

    const first = singing.pickPresetClip('baekhyun', 'lullaby', [], {
      config,
      charDir: tmpCharDir,
      random: () => 0,
    });
    assert.ok(first);
    assert.equal(first.id, 'lullaby-1');
    assert.equal(first.audioUrl, '/singing/baekhyun/lullaby-1.mp3');

    // When first clip's ko was recently used, pickPresetClip avoids repeating it
    const second = singing.pickPresetClip('baekhyun', 'lullaby', [first.ko], {
      config,
      charDir: tmpCharDir,
      random: () => 0,
    });
    assert.ok(second);
    assert.equal(second.id, 'lullaby-2');
    assert.equal(second.audioUrl, '/singing/baekhyun/lullaby-2.mp3');
  } finally {
    fs.rmSync(tmpCharDir, { recursive: true, force: true });
  }
});

test('buildSingingHint and audio tag stripping preserve [sings softly] / [hums] for eleven_v3', () => {
  const hint = singing.buildSingingHint({ sing: true, mode: 'specified', song: '小星星', occasion: 'any' });
  assert.match(hint, /\[sings softly\]/);
  assert.match(hint, /\[hums\]/);
  assert.match(hint, /小星星/);

  const rawLine = '[sings softly] 반짝반짝 작은 별~ 아름답게 비치네~';
  assert.equal(stripAudioTags(rawLine), '반짝반짝 작은 별~ 아름답게 비치네~');
  assert.equal(toSpeechText([rawLine]), rawLine);

  const humLine = '[hums] 음~ 오늘도 고생 많았어~';
  assert.equal(stripAudioTags(humLine), '음~ 오늘도 고생 많았어~');
  assert.equal(toSpeechText([humLine]), humLine);

  const config = resolveRuntimeConfig('baekhyun');
  const parsed = parseReply(JSON.stringify({
    messages: [{ mood: 'soft', ko: rawLine, zh: '一闪一闪亮晶晶～' }],
  }), config);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].raw, rawLine);
  assert.equal(parsed[0].ko, '반짝반짝 작은 별~ 아름답게 비치네~');
  assert.equal(toSpeechText([parsed[0].raw]), rawLine);
});

test('UI safeAudioUrl allows /singing/ and /audio/ while blocking .., and #sheet-sing is wired', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="sheet-sing"/);
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appJs, /sheet-sing/);
  assert.match(appJs, /给我清唱一段吧/);
  assert.match(appJs, /\(\?:audio\|singing\)/);
});

test('scripts/make-singing-clip.js supports --dry-run without an API key', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-sts-dry-'));
  try {
    const wav = path.join(tmpDir, 'dry.wav');
    fs.writeFileSync(wav, Buffer.alloc(128, 3));
    const res = await makeSingingClip.run([
      '--character', 'baekhyun',
      '--input', wav,
      '--id', 'goodnight-1',
      '--occasion', 'lullaby',
      '--ko', '잘 자요~ 내 꿈 꿔요~',
      '--zh', '晚安～梦到我～',
      '--dry-run',
    ]);
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.match(res.endpoint, /speech-to-speech\/zG6oPYFpVjyTj1zUmVTY/);
    assert.equal(res.entry.file, 'goodnight-1.mp3');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('store.sanitizeMessages preserves valid /singing/ URLs and rejects traversal', () => {
  const hashAudio = `/audio/${'a'.repeat(64)}.mp3`;
  const sanitized = store.sanitizeMessages([
    { role: 'assistant', text: '잘 자요~', time: 1000, audioUrl: '/singing/baekhyun/lullaby.mp3' },
    { role: 'assistant', text: 'bad', time: 1001, audioUrl: '/singing/../evil.mp3' },
    { role: 'assistant', text: 'tts', time: 1002, audioUrl: hashAudio },
  ]);
  assert.equal(sanitized.length, 3);
  assert.equal(sanitized[0].audioUrl, '/singing/baekhyun/lullaby.mp3');
  assert.equal(sanitized[1].audioUrl, null);
  assert.equal(sanitized[2].audioUrl, hashAudio);
});
