'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { supportsNode, dependencyProblems, needsBuild, npmInvocation, runNpm,
  probeConsole, openBrowser, launch } = require('../scripts/launch');

function fixture(t, { built = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu launcher 测试 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(root, 'web', 'src', 'main.jsx'), '// fixture');
  const build = () => {
    fs.mkdirSync(path.join(root, 'web', 'dist'), { recursive: true });
    const file = path.join(root, 'web', 'dist', 'index.html');
    fs.writeFileSync(file, '<html></html>');
    const future = new Date(Date.now() + 10000);
    fs.utimesSync(file, future, future);
  };
  if (built) build();
  return { root, build };
}

function dependencies(t, options = {}) {
  const { root, build } = fixture(t, options);
  const calls = [];
  const signals = new EventEmitter();
  const server = {
    async start() { calls.push('start'); return { url: 'http://127.0.0.1:19423/' }; },
    async close() { calls.push('close'); },
  };
  return { root, build, calls, signals, server, args: {
    root, version: '20.20.2', probe: async () => 'offline', check: () => [], toolchain: () => true,
    npm: (cwd, args) => { calls.push({ npm: args, cwd }); if (args.includes('build')) build(); },
    checkNative: () => calls.push('native'), initialize: () => calls.push('init'),
    createServer: ({ root: actualRoot, port }) => { assert.equal(actualRoot, root); assert.equal(port, 19423); calls.push('create'); return server; },
    open: url => calls.push({ open: url }), signals, log: () => {},
  } };
}

test('launcher accepts Vite supported Node versions and rejects older/unsupported lines', () => {
  for (const value of ['20.19.0', 'v20.20.2', '22.12.0', '23.0.0', '24.0.0']) assert.equal(supportsNode(value), true, value);
  for (const value of ['18.20.0', '20.12.0', '20.18.9', '21.7.0', '22.11.0', 'invalid']) assert.equal(supportsNode(value), false, value);
});

test('dependency check detects absent and locked-version mismatches, including new UI modules', t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/react': { version: '19.0.0' }, 'node_modules/fastify': { version: '5.0.0' },
  } }));
  const problems = dependencyProblems(root, { resolveVersion(name) {
    if (name === 'antd') throw new Error('missing');
    return name === 'react' ? '18.0.0' : name === 'fastify' ? '5.0.0' : '1.0.0';
  } });
  assert.deepEqual(problems.sort(), ['antd', 'react']);
});

test('build freshness tracks frontend source and lockfile but ignores generated outputs', t => {
  const { root } = fixture(t);
  assert.equal(needsBuild(root), false);
  fs.writeFileSync(path.join(root, 'web', 'dist', 'generated.js'), 'generated');
  assert.equal(needsBuild(root), false);
  const newer = new Date(Date.now() + 20000);
  fs.utimesSync(path.join(root, 'web', 'src', 'main.jsx'), newer, newer);
  assert.equal(needsBuild(root), true);
  const output = path.join(root, 'web', 'dist', 'index.html');
  fs.utimesSync(output, new Date(Date.now() + 30000), new Date(Date.now() + 30000));
  fs.utimesSync(path.join(root, 'package-lock.json'), new Date(Date.now() + 40000), new Date(Date.now() + 40000));
  assert.equal(needsBuild(root), true);
  fs.unlinkSync(output);
  assert.equal(needsBuild(root), true);
});

test('Windows npm invocation returns through cmd and preserves cwd with spaces', t => {
  const { root } = fixture(t);
  const expected = { file: 'cmd.exe', args: ['/d', '/s', '/c', '"npm.cmd ci --include=optional"'] };
  assert.deepEqual(npmInvocation(['ci', '--include=optional'], 'win32'), expected);
  runNpm(root, ['ci', '--include=optional'], { platform: 'win32', run(file, args, options) {
    assert.equal(file, expected.file); assert.deepEqual(args, expected.args); assert.equal(options.cwd, root);
    assert.equal(options.stdio, 'inherit'); return { status: 0 };
  } });
  assert.throws(() => npmInvocation(['ci', '&&do-something'], 'win32'), /Invalid/);
  assert.throws(() => runNpm(root, ['run', 'build'], { run: () => ({ status: 1 }) }), /failed/);
});

function fakeGet({ body = '{}', statusCode = 200, error, timeout = false } = {}) {
  return (url, callback) => {
    assert.equal(url.pathname, '/api/health');
    const req = new EventEmitter();
    req.destroy = () => {};
    req.setTimeout = (duration, fn) => { assert.ok(duration > 0); if (timeout) queueMicrotask(fn); };
    queueMicrotask(() => {
      if (error) return req.emit('error', { code: error });
      if (timeout) return;
      const response = new EventEmitter();
      response.statusCode = statusCode; response.setEncoding = () => {}; response.destroy = () => {};
      callback(response); response.emit('data', body); response.emit('end');
    });
    return req;
  };
}

test('existing-console probe requires its application marker and refuses other services', async () => {
  const url = 'http://127.0.0.1:19423/';
  assert.equal(await probeConsole(url, { get: fakeGet({ body: '{"application":"dafeiyu-douyin-console","version":"0.2.0"}' }) }), 'console');
  for (const options of [{ body: '{"application":"another-app"}' }, { body: 'not json' },
    { body: '{"application":"dafeiyu-douyin-console"}', statusCode: 401 }, { error: 'EPERM' }, { timeout: true }]) {
    assert.equal(await probeConsole(url, { get: fakeGet(options) }), 'other');
  }
  assert.equal(await probeConsole(url, { get: fakeGet({ error: 'ECONNREFUSED' }) }), 'offline');
});

test('launcher reuses an existing matching console without installing, initializing or creating a worker', async t => {
  const f = dependencies(t);
  const result = await launch({ ...f.args, probe: async () => 'console' });
  assert.equal(result.existing, true);
  assert.deepEqual(f.calls, [{ open: 'http://127.0.0.1:19423/' }]);
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
});

test('launcher refuses occupied ports and unsupported Node before changing files or starting servers', async t => {
  const f = dependencies(t);
  await assert.rejects(launch({ ...f.args, probe: async () => 'other' }), /occupied or inaccessible/);
  await assert.rejects(launch({ ...f.args, version: '18.0.0' }), /Node.js/);
  assert.deepEqual(f.calls, []);
});

test('fresh frontend dependencies install before building, and opening the console does not run send commands', async t => {
  const f = dependencies(t, { built: false });
  let checked = 0;
  const result = await launch({ ...f.args, check: () => checked++ ? [] : ['antd', 'vite'] });
  assert.deepEqual(f.calls, [
    { npm: ['ci', '--include=optional'], cwd: f.root }, 'native', 'init',
    { npm: ['run', 'build'], cwd: f.root }, 'create', 'start', { open: 'http://127.0.0.1:19423/' },
  ]);
  assert.equal(result.existing, false);
  await result.stop();
  assert.equal(f.calls.at(-1), 'close');
});

test('up-to-date installation does not reinstall or rebuild and Ctrl+C closes only the owned console once', async t => {
  const f = dependencies(t);
  const result = await launch(f.args);
  assert.deepEqual(f.calls.slice(0, 4), ['native', 'init', 'create', 'start']);
  assert.equal(f.calls.some(call => call?.npm), false);
  f.signals.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve));
  await result.stop();
  assert.equal(f.calls.filter(call => call === 'close').length, 1);
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('CLI-only installation with missing Vite native bindings is repaired with optional dependencies', async t => {
  const f = dependencies(t);
  let checked = 0;
  const result = await launch({ ...f.args, toolchain: () => checked++ > 0 });
  assert.deepEqual(f.calls[0], { npm: ['ci', '--include=optional'], cwd: f.root });
  assert.equal(f.calls.filter(call => call?.npm).length, 1);
  await result.stop();
});

test('simultaneous double-click preparation cannot race dependency installation or start a second console', async t => {
  const f = dependencies(t);
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let finishStart;
  f.server.start = () => { signalStarted(); return new Promise(resolve => { finishStart = resolve; }); };
  const first = launch(f.args);
  await started;
  await assert.rejects(launch(f.args), /Another launcher is preparing/);
  assert.equal(f.calls.filter(call => call === 'create').length, 1);
  finishStart({ url: 'http://127.0.0.1:19423/' });
  const result = await first;
  assert.equal(fs.existsSync(path.join(f.root, 'runtime', 'console-launch.lock')), false);
  await result.stop();
});

test('interrupting a slow console startup does not open its browser after shutdown was requested', async t => {
  const f = dependencies(t);
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let finishStart;
  f.server.start = () => { signalStarted(); return new Promise(resolve => { finishStart = resolve; }); };
  const pending = launch(f.args);
  await started;
  f.signals.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve));
  finishStart({ url: 'http://127.0.0.1:19423/' });
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(f.calls.some(call => call?.open), false);
  assert.equal(fs.existsSync(path.join(f.root, 'runtime', 'console-launch.lock')), false);
});

test('native dependency mismatch stops with a repair instruction and never starts the console', async t => {
  const f = dependencies(t);
  await assert.rejects(launch({ ...f.args, checkNative() { throw new Error('internal binding details'); } }), /npm rebuild better-sqlite3/);
  assert.deepEqual(f.calls, []);
});

test('browser opening uses platform commands with separate arguments and rejects nonlocal URLs', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    let invocation;
    openBrowser('http://127.0.0.1:19423/', { platform, run(file, args, options) {
      invocation = { file, args, options };
      const child = new EventEmitter(); child.unref = () => {}; return child;
    } });
    assert.ok(invocation.args.join(' ').includes('http://127.0.0.1:19423/'));
    assert.equal(invocation.options.stdio, 'ignore');
  }
  for (const url of ['https://example.com/', 'http://127.0.0.1:19423/?x=1', 'http://user@127.0.0.1:19423/', 'http://127.0.0.1:19423/other']) {
    assert.throws(() => openBrowser(url), /Only the local/);
  }
});

test('double-click launchers quote their working directory and preserve visible errors', () => {
  const root = path.resolve(__dirname, '..');
  const windows = fs.readFileSync(path.join(root, 'start.bat'), 'utf8');
  const mac = fs.readFileSync(path.join(root, 'start.command'), 'utf8');
  assert.match(windows, /cd \/d "%~dp0"/);
  assert.match(windows, /call npm\.cmd --version/);
  assert.match(windows, /node "%~dp0scripts\\launch\.js"/);
  assert.match(windows, /pause/);
  assert.match(mac, /exec node scripts\/launch\.js/);
  assert.match(mac, /\$\{0:A:h\}/);
});
