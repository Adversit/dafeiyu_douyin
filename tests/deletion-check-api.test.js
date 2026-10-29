'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initialize } = require('../src/config');
const { Store } = require('../src/store');
const { createConsoleServer } = require('../src/web/server');
const { RuntimeController } = require('../src/services/runtime');

test('只读核查 API 需要会话和 CSRF，只接受任务标识，返回匿名状态', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-check-api-')); initialize({ root });
  const configPath = path.join(root, 'config.local.json'); const config = JSON.parse(fs.readFileSync(configPath));
  config.accountUid = '10001'; config.videos = ['20001']; fs.writeFileSync(configPath, JSON.stringify(config));
  const store = new Store(path.join(root, 'runtime/agent.sqlite'));
  const key = store.enqueue('10001', { videoId: '20001', cid: '40001', rootCid: '40001', authorUid: '30001', text: 'fixture' }, {});
  store.finish(key, 'unknown', { result: { cid: '90001' } });
  const calls = [];
  const bridgeClient = { async call(command) {
    calls.push(command);
    if (command === 'identity.get') return { uid: '10001' };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
    if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40001', user: { uid: '30001' }, reply_comment_total: 0 }], has_more: 0 };
    if (command === 'comments.replies') return { status_code: 0, _bridge_reply_query: 'item_id-v1', comments: null, total: 0, has_more: 0 };
    throw Error('unexpected');
  } };
  const server = createConsoleServer({ root, bridgeClient, manageBridge: false });
  t.after(async () => { await server.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const host = '127.0.0.1:19423'; const request = payload => ({ method: 'POST', url: '/api/activity/check', headers: { host }, payload });
  assert.equal((await server.app.inject(request({ jobKey: key }))).statusCode, 401);
  const session = await server.app.inject({ url: '/api/session', headers: { host } });
  const headers = { host, cookie: session.headers['set-cookie'].split(';')[0], 'x-csrf-token': session.json().csrfToken };
  assert.equal((await server.app.inject({ ...request({ jobKey: key }), headers: { ...headers, 'x-csrf-token': 'wrong' } })).statusCode, 403);
  assert.equal((await server.app.inject({ ...request({ jobKey: key, commentCid: '99999' }), headers })).statusCode, 400);
  assert.deepEqual(calls, []);
  const response = await server.app.inject({ ...request({ jobKey: key }), headers });
  assert.equal(response.statusCode, 200); assert.equal(response.json().status, 'absent');
  assert.deepEqual(Object.keys(response.json()).sort(), ['checkedAt', 'promoted', 'reason', 'status']);
  assert.equal(response.json().promoted, false);
  const history = await server.app.inject({ url: '/api/activity', headers });
  assert.equal(history.json().items[0].checkStatus, 'absent');
  assert.equal(store.get(key).status, 'unknown');
  assert.ok(calls.every(c => ['identity.get', 'video.get', 'comments.list', 'comments.replies'].includes(c)));
});

test('轮询执行后自动只读核查，不调用模型或改变旧发送状态', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-check-runtime-')); initialize({ root });
  const configPath = path.join(root, 'config.local.json'); const config = JSON.parse(fs.readFileSync(configPath));
  config.accountUid = '10001'; config.videos = ['20001']; fs.writeFileSync(configPath, JSON.stringify(config));
  const store = new Store(path.join(root, 'runtime/agent.sqlite'));
  const key = store.enqueue('10001', { videoId: '20001', cid: '40001', rootCid: '40001', authorUid: '30001', text: 'fixture' }, {});
  store.finish(key, 'unknown', { result: { cid: '90001' } });
  store.db.prepare('UPDATE jobs SET updated_at=? WHERE job_key=?').run(Date.now() - 120000, key);
  const calls = [];
  const bridgeClient = { async call(command) {
    calls.push(command);
    if (command === 'identity.get') return { uid: '10001' };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
    if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40001', user: { uid: '30001' }, reply_comment_total: 0 }], has_more: 0 };
    if (command === 'comments.replies') return { status_code: 0, _bridge_reply_query: 'item_id-v1', comments: null, total: 0, has_more: 0 };
    throw Error('unexpected');
  } };
  const runtime = new RuntimeController({ root, bridgeClient, validateReady: async () => {}, createWorker: () => ({ worker: {
    async runOnce() { return { scanned: 0, considered: 0, attempted: 0, sent: 0, skipped: 0, failed: 0, unknown: 0, warnings: [] }; },
  } }) });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await runtime.start({ once: true }); await runtime.wait();
  assert.equal(store.db.prepare('SELECT status FROM reply_checks WHERE job_key=?').get(key).status, 'absent');
  assert.equal(store.get(key).status, 'unknown'); assert.equal(store.claim('10001', ['20001']), null);
  assert.deepEqual(calls, ['identity.get', 'video.get', 'comments.list', 'comments.replies']);
});
