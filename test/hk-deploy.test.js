const fs = require('node:fs');
const os = require('node:os');
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

test('Hong Kong deployment scripts are valid, executable, and contain idempotent service controls', () => {
  for (const file of [setupPath, updatePath]) {
    const syntax = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.ok(fs.statSync(file).mode & 0o111, `${path.basename(file)} must be executable`);
  }
  assert.match(setup, /NODE_MAJOR=22/);
  assert.match(setup, /useradd --system[\s\S]*\/usr\/sbin\/nologin/);
  assert.match(setup, /run_as_app npm --prefix "\$APP_DIR" ci --omit=dev/);
  assert.match(setup, /run_as_app pm2 start[\s\S]*--exec-mode cluster/);
  assert.match(setup, /pm2 startup systemd[\s\S]*pm2 save/);
  assert.match(setup, /wait_for_health "http:\/\/127\.0\.0\.1/);
  assert.match(setup, /server_name www\.dailyhim\.cn[\s\S]*301 https:\/\/dailyhim\.cn/);
  assert.match(setup, /server_name dailyhim\.cn/);
  assert.match(setup, /certbot --nginx[\s\S]*-d dailyhim\.cn -d www\.dailyhim\.cn/);
  assert.match(setup, /curl -fsS[\s\S]*https:\/\/dailyhim\.cn\/api\/health/);
  assert.match(update, /git -C "\$APP_DIR" pull --ff-only origin "\$BRANCH"/);
  assert.match(update, /run_as_app npm --prefix "\$APP_DIR" ci --omit=dev/);
  assert.match(update, /run_as_app pm2 reload "\$APP_NAME" --update-env/);
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

function extractFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} must be defined`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name} must be terminated`);
  return source.slice(start, end + 3);
}

// setup.sh 以 umask 077 和 root 身份 git clone，源码树会是 700/600；
// 低权限用户 dailyhim 读不到 package-lock.json，npm ci 于是误报缺少 lockfile。
test('clone/pull permission fix keeps the source tree readable by the app user', { skip: process.platform !== 'linux' }, () => {
  for (const [name, script] of [['setup.sh', setup], ['update.sh', update]]) {
    assert.match(script, /umask 077/, `${name} must keep its strict umask`);
    const fn = extractFunction(script, 'fix_app_tree');
    assert.match(fn, /-type d -exec chmod 755/, `${name} must relax directories`);
    assert.match(fn, /-type f ! -perm -u\+x -exec chmod 644/, `${name} must relax regular files`);
    assert.doesNotMatch(fn, /chmod -R 777|chmod 777|chmod -R a\+rwx/, `${name} must not open the tree to everyone`);
    assert.match(fn, /-name '\.env'/, `${name} must keep .env private`);
    assert.match(fn, /-name '\*\.pem'/, `${name} must keep private keys private`);
  }

  // setup.sh: 权限修复必须在 npm ci 之前，pull 之后。
  const setupFix = setup.indexOf('fix_app_tree "$APP_DIR"');
  assert.ok(setupFix > 0, 'setup.sh must call fix_app_tree');
  assert.ok(setupFix < setup.indexOf('npm --prefix "$APP_DIR" ci'), 'setup.sh must fix permissions before npm ci');
  assert.ok(setupFix > setup.lastIndexOf('git pull --ff-only'), 'setup.sh must fix permissions after pull');

  const updateFix = update.indexOf('fix_app_tree "$APP_DIR"');
  assert.ok(updateFix > 0, 'update.sh must call fix_app_tree');
  assert.ok(updateFix < update.indexOf('npm --prefix "$APP_DIR" ci'), 'update.sh must fix permissions before npm ci');
  assert.ok(updateFix > update.indexOf('git -C "$APP_DIR" pull --ff-only'), 'update.sh must fix permissions after pull');
});

test('fix_app_tree makes a real umask 077 clone readable without exposing secrets', { skip: process.platform !== 'linux' }, (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dailyhim-perm-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  // 复现 root + umask 077 的 clone 结果：所有目录 700、文件 600。
  const layout = {
    'package-lock.json': 0o600,
    'server.js': 0o600,
    'deploy/hk/setup.sh': 0o700,
    'lib/deep/nested.js': 0o600,
    '.git/config': 0o600,
    'node_modules/pkg/index.js': 0o600,
    'cache/audio/clip.mp3': 0o600,
    'data/store.json': 0o600,
    '.env': 0o600,
    'certs/tls.pem': 0o600,
    'android/release.p12': 0o600,
  };
  for (const [rel, mode] of Object.entries(layout)) {
    const target = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, 'x', { mode });
    fs.chmodSync(target, mode);
  }
  const dirs = ['', 'deploy', 'deploy/hk', 'lib', 'lib/deep', '.git', 'node_modules',
    'node_modules/pkg', 'cache', 'cache/audio', 'data', 'certs', 'android'];
  for (const dir of dirs) {
    fs.chmodSync(path.join(appDir, dir), 0o700);
  }

  const script = `${extractFunction(setup, 'fix_app_tree')}\nfix_app_tree "$1"\n`;
  const run = spawnSync('bash', ['-c', script, 'bash', appDir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);

  const modeOf = (rel) => fs.statSync(path.join(appDir, rel)).mode & 0o777;

  assert.equal(modeOf(''), 0o755);
  assert.equal(modeOf('deploy'), 0o755);
  assert.equal(modeOf('deploy/hk'), 0o755);
  assert.equal(modeOf('lib/deep'), 0o755);
  assert.equal(modeOf('certs'), 0o755);
  assert.equal(modeOf('package-lock.json'), 0o644, 'lockfile must be readable by the app user');
  assert.equal(modeOf('server.js'), 0o644);
  assert.equal(modeOf('lib/deep/nested.js'), 0o644);
  assert.equal(modeOf('deploy/hk/setup.sh'), 0o755, 'executable bits must be preserved');

  // 保密/可写路径保持原样，避免密钥或运行数据被其他人读到。
  assert.equal(modeOf('.git'), 0o700);
  assert.equal(modeOf('.git/config'), 0o600);
  assert.equal(modeOf('node_modules'), 0o700);
  assert.equal(modeOf('cache'), 0o700);
  assert.equal(modeOf('cache/audio'), 0o700);
  assert.equal(modeOf('cache/audio/clip.mp3'), 0o600);
  assert.equal(modeOf('data'), 0o700);
  assert.equal(modeOf('data/store.json'), 0o600);
  assert.equal(modeOf('.env'), 0o600, 'a stray .env must stay private');
  assert.equal(modeOf('certs/tls.pem'), 0o600, 'private keys must stay private');
  assert.equal(modeOf('android/release.p12'), 0o600, 'signing material must stay private');

  // 没有任何 group/other 写权限。
  for (const rel of Object.keys(layout).concat(dirs)) {
    assert.equal(modeOf(rel) & 0o022, 0, `${rel} must not be group/world writable`);
  }
});
