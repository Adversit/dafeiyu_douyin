'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initialize } = require('../src/config');
const { Store } = require('../src/store');
const { RuntimeController } = require('../src/services/runtime');
const { createConsoleServer } = require('../src/web/server');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-resend-runtime-'));
  initialize({ root });
  const file = path.join(root, 'config.local.json');
  const config = JSON.parse(fs.readFileSync(file)); Object.assign(config, { accountUid: '10001', videos: ['20001'] }); fs.writeFileSync(file, JSON.stringify(config));
  const store = new Store(path.join(root, 'runtime/agent.sqlite'));
  const event = { videoId: '20001', cid: '40001', rootCid: '40000', authorUid: '30001', text: '你好' };
  const key = store.enqueue('10001', event, { eligible: true });
  store.finish(key, 'succeeded', { result: { cid: '90001', targetVerified: true } });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, key };
}

test('预检和运行期间持同一独占锁，双击不能生成或发送第二次', async t => {
  const f = setup(t), inCheck = deferred(), releaseCheck = deferred(), finish = deferred();
  let starts = 0, captured;
  const bridgeClient = { async call(command) {
    if (command === 'identity.get') { inCheck.resolve(); await releaseCheck.promise; return { uid: '10001' }; }
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
    if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40000', reply_comment_total: 1 }], has_more: 0 };
    if (command === 'comments.replies') return { status_code: 0, comments: [{ cid: '40001', user: { uid: '30001' }, reply_id: '40000' }], has_more: 0, _bridge_reply_query: 'item_id-v1' };
    throw new Error('unexpected');
  } };
  const runtime = new RuntimeController({ root: f.root, bridgeClient, validateReady: async () => {},
    createWorker: (_config, _log, opts) => {
      starts++; assert.equal(opts.manualJobKey, f.key);
      const store = new Store(path.join(f.root, 'runtime/agent.sqlite'));
      store.recoverInFlight({ preserveManualJobKey: opts.manualJobKey });
      return { worker: { store, async runOnce(args) { captured = args; await finish.promise; return { scanned: 0, considered: 0, attempted: 0, sent: 0, skipped: 0, failed: 0, unknown: 0 }; } }, close: () => store.close() };
    } });
  const first = runtime.start({ once: true, resendJobKey: f.key });
  await inCheck.promise;
  await assert.rejects(runtime.start({ once: true, resendJobKey: f.key }), { statusCode: 409 });
  releaseCheck.resolve(); await first;
  await assert.rejects(runtime.start({ once: true, resendJobKey: f.key }), { statusCode: 409 });
  assert.equal(captured.onlyJobKey, f.key); assert.equal(starts, 1);
  finish.resolve(); await runtime.wait();
  assert.equal(f.store.get(f.key).status, 'failed');
  assert.equal(f.store.claim('10001', ['20001']), null);
});

test('重发接口需要会话、CSRF、唯一 jobKey，接受后仅启动指定任务', async t => {
  const f = setup(t); const calls = [];
  const runtime = { isBusy: () => false, snapshot: () => ({ state: 'stopped' }), start: async options => { calls.push(options); return { state: 'running', mode: 'resend' }; }, on() {}, off() {}, stop() {}, async wait() {} };
  const server = createConsoleServer({ root: f.root, runtime, manageBridge: false });
  t.after(() => server.close());
  const host = '127.0.0.1:19423';
  const request = payload => ({ method: 'POST', url: '/api/activity/resend', headers: { host }, payload });
  assert.equal((await server.app.inject(request({ jobKey: f.key }))).statusCode, 401);
  const session = await server.app.inject({ url: '/api/session', headers: { host } });
  const headers = { host, cookie: session.headers['set-cookie'].split(';')[0], 'x-csrf-token': session.json().csrfToken };
  assert.equal((await server.app.inject({ ...request({ jobKey: f.key }), headers: { ...headers, 'x-csrf-token': 'wrong' } })).statusCode, 403);
  assert.equal((await server.app.inject({ ...request({ jobKey: f.key, targetCid: '999' }), headers })).statusCode, 400);
  const response = await server.app.inject({ ...request({ jobKey: f.key }), headers });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(calls, [{ once: true, resendJobKey: f.key }]);
});
