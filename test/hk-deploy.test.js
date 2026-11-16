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

// setup.sh 开头的 umask 077 也会影响全局安装：root 跑 npm install -g pm2 后
// /usr/lib/node_modules/pm2 与 /usr/bin/pm2 变成 700，dailyhim 执行时报
// “env: 'pm2': Permission denied”，且重跑 setup.sh 会再次把它锁回去。
test('global Node/PM2 installs stay executable for the app user', { skip: process.platform !== 'linux' }, (t) => {
  for (const [name, script] of [['setup.sh', setup], ['update.sh', update]]) {
    const fn = extractFunction(script, 'relax_global_paths');
    assert.match(fn, /a\+rX/, `${name} must relax with a+rX`);
    assert.match(fn, /GLOBAL_NODE_MODULES_DIRS/, `${name} must cover the npm global tree`);
    assert.match(fn, /GLOBAL_EXECUTABLES/, `${name} must cover pm2 and the other entry points`);
    // 不能粗暴地给全局目录加写权限。
    assert.doesNotMatch(fn, /a\+rwX|a\+w|o\+w/, `${name} must not add write bits`);

    // 目标路径必须包含 npm 全局包树与 pm2 可执行文件。
    assert.match(script, /GLOBAL_NODE_MODULES_DIRS=\("[^)]*lib\/node_modules/, `${name} must target lib/node_modules`);
    assert.match(script, /GLOBAL_EXECUTABLES=\([^)]*"pm2"/, `${name} must include pm2 in the executable list`);
  }

  // setup.sh 必须在安装 Node 与 PM2 时局部放开 umask，并在安装后修复权限。
  assert.match(setup, /\( umask 022; npm install --global pm2@latest/,
    'setup.sh must install pm2 under a permissive umask');
  assert.match(setup, /\( umask 022; apt-get install -y nodejs \)/,
    'setup.sh must install nodejs under a permissive umask');
  const pm2Install = setup.indexOf('npm install --global pm2@latest');
  const pm2Relax = setup.indexOf('relax_global_paths', pm2Install);
  assert.ok(pm2Relax > pm2Install, 'setup.sh must relax global paths after installing pm2');
  // 局部 umask 不能泄漏成全局：脚本主体仍必须严格。
  assert.match(setup, /^umask 077$/m, 'setup.sh must keep the global umask 077');

  // update.sh 同样要能在老机器上修好已锁死的 pm2（它自己没装 pm2）。
  const updateRelax = update.indexOf('relax_global_paths()');
  assert.ok(updateRelax > 0, 'update.sh must define relax_global_paths');
  const updateCall = update.indexOf('relax_global_paths\n');
  assert.ok(updateCall > updateRelax, 'update.sh must call relax_global_paths');
  assert.ok(updateCall < update.indexOf('run_as_app pm2 reload'),
    'update.sh must relax pm2 permissions before invoking pm2 as the app user');
});

test('relax_global_paths repairs a 700 pm2 tree without granting write access', { skip: process.platform !== 'linux' }, (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dailyhim-global-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const libDir = path.join(sandbox, 'lib', 'node_modules');
  const binDir = path.join(sandbox, 'bin');
  const pm2PkgDir = path.join(libDir, 'pm2');
  const pm2Entry = path.join(pm2PkgDir, 'bin', 'pm2');
  const binShim = path.join(binDir, 'pm2');

  // 复现 root + umask 077 安装后的形态：目录 700、可执行文件 700。
  // 沙箱根目录代表 /usr/lib 这类系统父目录，本来就是 755，不是本函数的处理目标。
  fs.mkdirSync(path.dirname(pm2Entry), { recursive: true, mode: 0o700 });
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pm2Entry, '#!/bin/sh\necho pm2\n', { mode: 0o700 });
  fs.writeFileSync(path.join(pm2PkgDir, 'package.json'), '{}', { mode: 0o600 });
  fs.symlinkSync('../lib/node_modules/pm2/bin/pm2', binShim);
  fs.chmodSync(sandbox, 0o755);
  for (const dir of [path.join(sandbox, 'lib'), libDir, pm2PkgDir, path.dirname(pm2Entry), binDir]) {
    fs.chmodSync(dir, 0o700);
  }
  fs.chmodSync(pm2Entry, 0o700);
  fs.chmodSync(path.join(pm2PkgDir, 'package.json'), 0o600);

  const script = [
    `GLOBAL_NODE_MODULES_DIRS=(${JSON.stringify(libDir)})`,
    `GLOBAL_BIN_DIRS=(${JSON.stringify(binDir)})`,
    'GLOBAL_EXECUTABLES=("pm2")',
    // 让 $(npm root -g) / $(npm prefix -g) 不指向真实全局目录。
    'npm() { return 0; }',
    extractFunction(setup, 'relax_global_paths'),
    'relax_global_paths',
  ].join('\n');
  const run = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);

  const modeOf = (p) => fs.statSync(p).mode & 0o777;

  assert.equal(modeOf(sandbox), 0o755);
  assert.equal(modeOf(libDir), 0o755);
  assert.equal(modeOf(pm2PkgDir), 0o755);
  assert.equal(modeOf(path.dirname(pm2Entry)), 0o755);
  assert.equal(modeOf(pm2Entry), 0o755, 'pm2 entry must be executable by the app user');
  assert.equal(modeOf(path.join(pm2PkgDir, 'package.json')), 0o644, 'pm2 package files must be readable');
  assert.equal(modeOf(binDir), 0o755, 'the bin directory must be traversable');

  // 只加读/执行，绝不授予 group/other 写权限。
  for (const p of [sandbox, libDir, pm2PkgDir, path.dirname(pm2Entry), binDir,
    pm2Entry, path.join(pm2PkgDir, 'package.json')]) {
    assert.equal(modeOf(p) & 0o022, 0, `${p} must not be group/world writable`);
  }

  // 低权限用户现在真的能读到并执行了。
  const readable = spawnSync('bash', ['-c', `test -r ${JSON.stringify(pm2Entry)} && echo ok`], { encoding: 'utf8' });
  assert.equal(readable.stdout.trim(), 'ok');
});

// set -Eeuo pipefail 下，单个 chmod 失败不应让整个部署脚本中断；
// 这里故意让 chmod 失败（非 root 碰 root 拥有的 700 文件），断言只告警且继续。
test('relax_global_paths warns and continues instead of aborting the deploy', { skip: process.platform !== 'linux' || process.getuid?.() === 0 }, (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dailyhim-warn-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const binDir = path.join(sandbox, 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(binDir, 'pm2'), '#!/bin/sh\n', { mode: 0o700 });

  const script = [
    'set -Eeuo pipefail',
    `GLOBAL_NODE_MODULES_DIRS=(${JSON.stringify(sandbox)})`,
    `GLOBAL_BIN_DIRS=(${JSON.stringify(binDir)})`,
    'GLOBAL_EXECUTABLES=("pm2")',
    extractFunction(setup, 'relax_global_paths'),
    'relax_global_paths',
    'echo REACHED_END',
  ].join('\n');

  const run = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, 'a chmod failure must not abort the script');
  assert.match(run.stdout, /REACHED_END/, 'execution must continue after a chmod failure');
});
