'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initialize } = require('../src/config');
const { RuntimeController, lockState } = require('../src/services/runtime');
const SUMMARY = { scanned: 1, considered: 1, attempted: 1, sent: 1, skipped: 0, failed: 0, unknown: 0 };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-runtime-'));
  const config = initialize({ root });
  const file = path.join(root, 'config.local.json');
  const raw = JSON.parse(fs.readFileSync(file)); Object.assign(raw, { accountUid: '10001', videos: ['20001'] });
  fs.writeFileSync(file, JSON.stringify(raw));
  const entries = [];
  const runtime = new RuntimeController({ root, logger: { write: e => entries.push(e) }, validateReady: async () => {},
    createWorker: () => ({ worker: { runOnce: async () => SUMMARY } }), ...options });
  t.after(async () => { runtime.stop(); await runtime.wait(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, config, runtime, entries };
}
test('网页重复启动和执行一轮互斥，停止中不会提前释放执行锁', async t => {
  const hold = deferred(); let created = 0, closed = 0;
  const { runtime, root } = fixture(t, { createWorker: () => { created++; return { worker: { runOnce: () => hold.promise }, close: () => { closed++; } }; } });
  runtime.on('change', () => { throw new Error('Disconnected UI'); });
  const running = await runtime.start();
  assert.equal(running.state, 'running');
  await assert.rejects(runtime.start({ once: true }), e => e.statusCode === 409);
  assert.equal(runtime.stop().state, 'stopping');
  assert.equal(fs.existsSync(path.join(root, 'runtime/worker.lock')), true);
  hold.resolve(SUMMARY); await runtime.wait();
  assert.equal(runtime.snapshot().state, 'stopped'); assert.equal(closed, 1); assert.equal(created, 1);
  assert.equal(fs.existsSync(path.join(root, 'runtime/worker.lock')), false);
});
test('执行一轮不会进入轮询等待，完成后可再次启动', async t => {
  let scans = 0;
  const { runtime, entries } = fixture(t, { createWorker: () => ({ worker: { runOnce: async () => { scans++; return SUMMARY; } } }), sleepImpl: () => { throw new Error('unexpected sleep'); } });
  await runtime.start({ once: true }); await runtime.wait();
  assert.equal(runtime.snapshot().lastSummary.sent, 1);
  await runtime.start({ once: true }); await runtime.wait();
  assert.equal(scans, 2);
  assert.equal(entries.filter(e => e.event === 'round.completed').length, 2);
});
test('轮询等待记录下次时间，停止立即中断等待而不再扫描', async t => {
  const waiting = deferred(); let scans = 0;
  const { runtime } = fixture(t, { createWorker: () => ({ worker: { runOnce: async () => { scans++; return SUMMARY; } } }),
    sleepImpl: (_ms, _value, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })), { once: true }); waiting.resolve(); }) });
  await runtime.start(); await waiting.promise;
  assert.ok(runtime.snapshot().nextScanAt > Date.now());
  runtime.stop(); await runtime.wait(); assert.equal(scans, 1); assert.equal(runtime.snapshot().state, 'stopped');
});
test('启动初始化异常会释放锁并允许修正后重新启动', async t => {
  let first = true;
  const { runtime, root } = fixture(t, { createWorker: () => { if (first) { first = false; throw new Error('setup failed'); } return { worker: { runOnce: async () => SUMMARY } }; } });
  await runtime.start({ once: true }); await runtime.wait();
  assert.equal(runtime.snapshot().error, 'setup failed'); assert.equal(fs.existsSync(path.join(root, 'runtime/worker.lock')), false);
  await runtime.start({ once: true }); await runtime.wait(); assert.equal(runtime.snapshot().error, null);
});
test('外部CLI或遗留锁不会被网页删除、抢占或终止', async t => {
  const { runtime, root } = fixture(t);
  const file = path.join(root, 'runtime/worker.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: 'other' }));
  assert.equal(runtime.snapshot().state, 'external');
  await assert.rejects(runtime.start(), e => e.statusCode === 409);
  runtime.stop(); assert.equal(fs.existsSync(file), true);
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, nonce: 'stale' }));
  assert.equal(lockState(file).state, 'stale-lock');
  await assert.rejects(runtime.start(), e => e.statusCode === 409);
  assert.equal(fs.existsSync(file), true); fs.unlinkSync(file);
});
test('每次启动读取已保存配置，预检错误返回400且不启动worker', async t => {
  const captured = [];
  const { runtime, file } = fixture(t, { createWorker: cfg => { captured.push(cfg.videos); return { worker: { runOnce: async () => SUMMARY } }; } });
  await runtime.start({ once: true }); await runtime.wait();
  const raw = JSON.parse(fs.readFileSync(file)); raw.videos = ['30001']; fs.writeFileSync(file, JSON.stringify(raw));
  await runtime.start({ once: true }); await runtime.wait(); assert.deepEqual(captured, [['20001'], ['30001']]);
  raw.accountUid = ''; fs.writeFileSync(file, JSON.stringify(raw));
  await assert.rejects(runtime.start(), e => e.statusCode === 400); assert.equal(captured.length, 2);
});

test('日志落盘失败会停止后续任务并释放锁，不会卡在运行中', async t => {
  let scans = 0;
  const { runtime, root } = fixture(t, { logger: { write() { throw new Error('disk full'); } }, createWorker: () => ({ worker: { runOnce: async () => { scans++; return SUMMARY; } } }) });
  await runtime.start(); await runtime.wait();
  assert.equal(runtime.snapshot().state, 'stopped'); assert.match(runtime.snapshot().error, /日志/);
  assert.equal(scans, 0); assert.equal(fs.existsSync(path.join(root, 'runtime/worker.lock')), false);
});

test('状态订阅once只执行一次，同时隔离已断开的观察者', t => {
  const { runtime } = fixture(t); let calls = 0;
  runtime.once('change', () => { calls++; });
  runtime.update({ stage: 'scan' }); runtime.update({ stage: 'complete' });
  assert.equal(calls, 1);
});

test('预检读取配置时已经持锁，关闭与配置保存交错的窗口', async t => {
  let inspected = false;
  const f = fixture(t, { validateReady: async () => {
    const lock = JSON.parse(fs.readFileSync(path.join(f.root, 'runtime/worker.lock'), 'utf8'));
    assert.equal(lock.pid, process.pid); inspected = true;
  } });
  await f.runtime.start({ once: true }); await f.runtime.wait(); assert.equal(inspected, true);
});
