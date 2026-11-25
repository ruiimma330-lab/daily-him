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
const docs = fs.readFileSync(path.join(root, 'deploy/hk/README.md'), 'utf8');

function runnableBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  if (!fs.existsSync(gitBash)) return null;
  const probe = spawnSync(gitBash, ['-c', 'true'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0 ? gitBash : null;
}

test('Hong Kong deployment scripts are valid, executable, and contain idempotent service controls', () => {
  const bash = runnableBash();
  for (const file of [setupPath, updatePath]) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content.includes('\r\n'), false, `${path.basename(file)} must use LF line endings`);
    if (bash) {
      const syntax = spawnSync(bash, ['-n', file], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr);
    }
    if (process.platform !== 'win32') {
      assert.ok(fs.statSync(file).mode & 0o111, `${path.basename(file)} must be executable`);
    }
  }
  assert.match(setup, /NODE_MAJOR=22/);
  assert.match(setup, /useradd --system[\s\S]*\/usr\/sbin\/nologin/);
  assert.match(setup, /run_as_app npm --prefix "\$APP_DIR" ci --omit=dev/);
  assert.match(setup, /systemctl disable --now dailyhim\.service/);
  assert.match(setup, /run_as_app pm2 start[\s\S]*-i 1/);
  assert.match(setup, /pm2 startup systemd[\s\S]*pm2 save/);
  assert.match(setup, /wait_for_health "http:\/\/127\.0\.0\.1/);
  assert.match(setup, /location \^~ \/characters\/ \{[\s\S]*proxy_pass http:\/\/127\.0\.0\.1:\$\{APP_PORT\};/);
  assert.doesNotMatch(setup, /location ~\*\s*\^\/\(\?:[^)]*characters[^)]*\)/);
  assert.match(setup, /server_name www\.dailyhim\.cn[\s\S]*301 https:\/\/dailyhim\.cn/);
  assert.match(setup, /server_name dailyhim\.cn/);
  assert.match(setup, /certbot --nginx[\s\S]*-d dailyhim\.cn -d www\.dailyhim\.cn/);
  assert.match(setup, /curl -fsS[\s\S]*https:\/\/dailyhim\.cn\/api\/health/);
  assert.match(update, /git -C "\$APP_DIR" pull --ff-only origin "\$BRANCH"/);
  assert.match(update, /run_as_app npm --prefix "\$APP_DIR" ci --omit=dev/);
  assert.match(update, /systemctl disable --now dailyhim\.service/);
  assert.match(update, /run_as_app pm2 start "\$APP_DIR\/server\.js"[\s\S]*-i 1/);
  assert.match(update, /wait_for_health "http:\/\/127\.0\.0\.1/);
  assert.match(docs, /github\.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl/);
  assert.match(docs, /SHA256:\+DiY3wvvV6TuJJhbpZisF\/zLDA0zPMSvHdkr4UvCOqU/);
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
