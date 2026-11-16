const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const setupPath = path.join(root, 'deploy/hk/setup.sh');
const updatePath = path.join(root, 'deploy/hk/update.sh');
const setup = fs.readFileSync(setupPath, 'utf8');
const update = fs.readFileSync(updatePath, 'utf8');

test('Hong Kong deployment scripts are valid, executable, and repeatable', () => {
  for (const file of [setupPath, updatePath]) {
    const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.ok(fs.statSync(file).mode & 0o111, `${path.basename(file)} must be executable`);
  }
  assert.match(setup, /NODE_MAJOR=22/);
  assert.match(setup, /npm --prefix "\$APP_DIR" ci --omit=dev/);
  assert.match(setup, /pm2 startup systemd[\s\S]*pm2 save/);
  assert.match(setup, /server_name www\.dailyhim\.cn[\s\S]*301 https:\/\/dailyhim\.cn/);
  assert.match(setup, /server_name dailyhim\.cn/);
  assert.match(setup, /certbot --nginx[\s\S]*-d dailyhim\.cn -d www\.dailyhim\.cn/);
  assert.match(setup, /curl -fsS[\s\S]*https:\/\/dailyhim\.cn\/api\/health/);
  assert.match(update, /git -C "\$APP_DIR" pull --ff-only origin "\$BRANCH"/);
  assert.match(update, /pm2 reload "\$APP_NAME" --update-env/);
});

test('first-run environment setup covers production configuration without echoing input', () => {
  const names = [
    'NODE_ENV', 'PORT', 'STORE_DATA_DIR', 'PUBLIC_SITE_URL', 'MOVED_TO_URL',
    'DEEPSEEK_CHAT_API_KEY', 'ELEVENLABS_API_KEY', 'TURSO_DATABASE_URL',
    'TURSO_AUTH_TOKEN', 'SESSION_SECRET', 'APP_PASSWORD', 'LLM_MODEL',
    'LLM_TIMEOUT_MS', 'LLM_EFFORT', 'VOICE_ID', 'TTS_MODEL', 'ADMINS',
    'MOMENTS_ADMINS', 'MOMENTS_REFRESH_SECRET', 'MOMENTS_SYNC',
  ];
  for (const name of names) assert.match(setup, new RegExp(`\\b${name}\\b`), name);
  assert.match(setup, /read -r -s value <\/dev\/tty/);
  assert.match(setup, /openssl rand -hex 32/);
  assert.match(setup, /install -o root -g root -m 600/);
});
