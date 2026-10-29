#!/usr/bin/env node
'use strict';

// The launcher only prepares and opens the local console. Sending remains an
// explicit action in the console; no worker or model command is run here.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APPLICATION = 'dafeiyu-douyin-console';
const MODULES = [
  ['better-sqlite3', 'better-sqlite3'],
  ['dsh-nekowhale-stickers', 'dsh-nekowhale-stickers/core'],
  ['fastify', 'fastify'], ['@fastify/static', '@fastify/static'], ['pino', 'pino'],
  ['react', 'react'], ['react-dom', 'react-dom'], ['antd', 'antd'],
  ['@ant-design/icons', '@ant-design/icons'], ['vite', 'vite'],
];

function supportsNode(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  // Match Vite's supported Node lines: ^20.19.0 || >=22.12.0.
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
}

function packageVersion(requireFromRoot, name, request) {
  let directory = path.dirname(requireFromRoot.resolve(request));
  for (;;) {
    const filename = path.join(directory, 'package.json');
    if (fs.existsSync(filename)) {
      const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (metadata.name === name) return metadata.version;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function dependencyProblems(root, { resolveVersion } = {}) {
  const requireFromRoot = createRequire(path.join(root, 'package.json'));
  const lockFile = path.join(root, 'package-lock.json');
  const lock = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : {};
  const problems = [];
  for (const [name, request] of MODULES) {
    try {
      const installed = resolveVersion ? resolveVersion(name, request) : packageVersion(requireFromRoot, name, request);
      const expected = lock.packages?.[`node_modules/${name}`]?.version;
      if (!installed || (expected && installed !== expected)) problems.push(name);
    } catch { problems.push(name); }
  }
  return problems;
}

function npmInvocation(args, platform = process.platform) {
  if (!args.every(value => /^[a-zA-Z0-9_./=:-]+$/.test(value))) throw new Error('Invalid npm launcher arguments');
  if (platform === 'win32') return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"npm.cmd ${args.join(' ')}"`] };
  return { file: 'npm', args };
}

function runNpm(root, args, { platform = process.platform, run = spawnSync } = {}) {
  const invocation = npmInvocation(args, platform);
  const result = run(invocation.file, invocation.args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    if (result.error?.code === 'ENOENT') throw new Error('npm was not found. Install Node.js with npm and reopen this launcher.');
    throw new Error(`npm ${args.join(' ')} failed. See the output above; no comments were sent by the launcher.`);
  }
}

function buildToolReady(root, { run = spawnSync } = {}) {
  // Loading Vite in a fresh process also validates its platform-specific optional
  // binding. A prior CLI-only install may have the package but omit that binding.
  const result = run(process.execPath, ['--input-type=module', '-e', "await import('vite');"], {
    cwd: root, stdio: 'pipe', windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function needsBuild(root) {
  const output = path.join(root, 'web', 'dist', 'index.html');
  if (!fs.existsSync(output)) return true;
  const builtAt = fs.statSync(output).mtimeMs;
  const newer = filename => fs.existsSync(filename) && fs.statSync(filename).mtimeMs > builtAt;
  if (['package.json', 'package-lock.json'].some(name => newer(path.join(root, name)))) return true;
  function walk(directory) {
    if (!fs.existsSync(directory)) return false;
    return fs.readdirSync(directory, { withFileTypes: true }).some(entry => {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name.startsWith('.')) return false;
      const filename = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(filename) : newer(filename);
    });
  }
  return walk(path.join(root, 'web'));
}

function probeConsole(url, { get = http.get, timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    const req = get(new URL('/api/health', url), response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) { response.destroy(); finish('other'); }
      });
      response.on('error', () => finish('other'));
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          finish(response.statusCode === 200 && value.application === APPLICATION ? 'console' : 'other');
        } catch { finish('other'); }
      });
    });
    req.setTimeout(timeoutMs, () => { finish('other'); req.destroy(); });
    req.on('error', error => finish(error.code === 'ECONNREFUSED' ? 'offline' : 'other'));
  });
}

function openBrowser(url, { platform = process.platform, run = spawn, log = console.log } = {}) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.pathname !== '/' ||
      address.username || address.password || address.search || address.hash) throw new Error('Only the local console URL can be opened');
  url = address.href;
  const invocation = platform === 'darwin'
    ? { file: '/usr/bin/open', args: [url] }
    : platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${url}"`] }
      : { file: 'xdg-open', args: [url] };
  const child = run(invocation.file, invocation.args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', () => log(`Could not open the browser automatically. Open ${url} manually.`));
  child.unref();
}

async function withPreparationLock(root, operation) {
  const directory = path.join(root, 'runtime');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'console-launch.lock');
  const nonce = randomUUID();
  let fd;
  try { fd = fs.openSync(filename, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Another launcher is preparing this project, or a prior launch was interrupted. Keep the first window open. Only after confirming no launcher is running, remove runtime/console-launch.lock and retry.');
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); } finally { fs.closeSync(fd); }
  try { return await operation(); } finally {
    // Never remove a lock that another process replaced.
    try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).nonce === nonce) fs.unlinkSync(filename); } catch { /* keep an unfamiliar lock for inspection */ }
  }
}

async function launch({ root = ROOT, port = 19423, version = process.versions.node,
  probe = probeConsole, check = dependencyProblems, npm = runNpm,
  toolchain = buildToolReady,
  checkNative, initialize, createServer, open = openBrowser,
  signals = process, log = console.log } = {}) {
  if (!supportsNode(version)) throw new Error('Use Node.js 20.19+, 22.12+, or 24+ (LTS); then reopen this launcher.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Console port must be between 1024 and 65535');
  const url = `http://127.0.0.1:${port}/`;
  const existing = await probe(url);
  if (existing === 'console') {
    log(`The console is already running: ${url}`);
    open(url);
    return { existing: true, url, stop: async () => {} };
  }
  if (existing !== 'offline') throw new Error(`Port ${port} is occupied or inaccessible. Stop the conflicting service or check local network permissions; it was not changed.`);

  return withPreparationLock(root, async () => {
    const missing = check(root);
    let installed = false;
    if (missing.length) {
      log(`Installing locked project dependencies (${missing.join(', ')})...`);
      // Vite/Rollup requires its platform-specific optional native binding.
      npm(root, ['ci', '--include=optional']);
      installed = true;
      if (check(root).length) throw new Error('Required dependencies are still missing. Check npm output and retry.');
    }
    if (!toolchain(root)) {
      if (!installed) {
        log('Restoring the frontend platform binding...');
        npm(root, ['ci', '--include=optional']);
      }
      if (!toolchain(root)) throw new Error('The frontend toolchain could not load. Check npm output; run npm ci --include=optional with a supported Node.js version.');
    }
    try {
      if (checkNative) checkNative(root);
      else {
        const Database = createRequire(path.join(root, 'package.json'))('better-sqlite3');
        const database = new Database(':memory:'); database.close();
      }
    } catch {
      throw new Error('better-sqlite3 could not load for this Node.js version. Run npm rebuild better-sqlite3 in this folder, then retry.');
    }
    if (initialize) initialize(root);
    else createRequire(path.join(root, 'package.json'))('./src/config').initialize();
    if (needsBuild(root)) {
      log('Building the local console...');
      npm(root, ['run', 'build']);
    }
    if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) throw new Error('Console build is missing. Run npm run build in this folder.');
    const server = await (createServer
      ? createServer({ root, port })
      : createRequire(path.join(root, 'package.json'))('./src/web/server').createConsoleServer({ root, port }));
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      log('Stopping the console; waiting for any in-flight operation to finish...');
      try { await server.close(); } finally {
        signals.removeListener('SIGINT', onSignal);
        signals.removeListener('SIGTERM', onSignal);
      }
    };
    const onSignal = () => { stop().catch(error => { log(error.message); process.exitCode = 1; }); };
    signals.on('SIGINT', onSignal);
    signals.on('SIGTERM', onSignal);
    try {
      const address = await server.start();
      const actualUrl = address?.url || server.url || url;
      if (stopped) {
        await server.close();
        return { server, url: actualUrl, stop, existing: false, stopped: true };
      }
      log(`Console ready: ${actualUrl}`);
      log('Opening the console does not send comments. Use its Run once / Start buttons when ready.');
      log('Keep this terminal open. Press Ctrl+C to stop gracefully.');
      open(actualUrl);
      return { server, url: actualUrl, stop, existing: false };
    } catch (error) { await stop(); throw error; }
  });
}

if (require.main === module) launch().catch(async error => {
  console.error(error.message); process.exitCode = 1;
  if (process.env.DAFEIYU_PAUSE_ON_ERROR === '1' && process.stdin.isTTY) {
    const { createInterface } = require('node:readline/promises');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try { await input.question('Press Return to close...'); } finally { input.close(); }
  }
});
module.exports = { APPLICATION, MODULES, supportsNode, dependencyProblems, npmInvocation, runNpm, buildToolReady, needsBuild, probeConsole, openBrowser, launch };
