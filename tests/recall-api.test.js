'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initialize } = require('../src/config');
const { Store } = require('../src/store');
const { createConsoleServer } = require('../src/web/server');

test('撤回 API 需要会话与 CSRF，拒绝客户端指定其他目标', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-recall-api-'));
  initialize({ root });
  const filename = path.join(root, 'config.local.json');
  const cfg = JSON.parse(fs.readFileSync(filename)); cfg.accountUid = '10001'; cfg.videos = ['20001'];
  fs.writeFileSync(filename, JSON.stringify(cfg));
  const store = new Store(path.join(root, 'runtime/agent.sqlite'));
  const key = store.enqueue('10001', { videoId: '20001', cid: '40001', rootCid: '40000', authorUid: '30001', text: '你好' }, {});
  store.finish(key, 'succeeded', { result: { cid: '90001' } });
  const calls = [];
  const bridgeClient = { async call(command) {
    calls.push(command);
    if (command === 'comments.delete') return { status_code: 0 };
    if (command === 'identity.get') return { uid: '10001' };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
    if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40000', reply_comment_total: 1 }], has_more: 0 };
    if (command === 'comments.replies') return { status_code: 0, comments: [{ cid: '40001', user: { uid: '30001' }, reply_id: '40000' }], has_more: 0, _bridge_reply_query: 'item_id-v1' };
    throw Error('unexpected');
  } };
  const server = createConsoleServer({ root, bridgeClient, manageBridge: false });
  t.after(async () => { await server.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const host = '127.0.0.1:19423';
  const request = payload => ({ method: 'POST', url: '/api/activity/recall', headers: { host }, payload });
  assert.equal((await server.app.inject(request({ jobKey: key }))).statusCode, 401);
  const session = await server.app.inject({ url: '/api/session', headers: { host } });
  const headers = { host, cookie: session.headers['set-cookie'].split(';')[0], 'x-csrf-token': session.json().csrfToken };
  assert.equal((await server.app.inject({ ...request({ jobKey: key }), headers: { ...headers, 'x-csrf-token': 'wrong' } })).statusCode, 403);
  assert.equal((await server.app.inject({ ...request({ jobKey: key, commentCid: '99999' }), headers })).statusCode, 400);
  assert.deepEqual(calls, []);
  const response = await server.app.inject({ ...request({ jobKey: key }), headers });
  assert.equal(response.statusCode, 200); assert.equal(response.json().status, 'confirmed');
  assert.equal(calls.filter(command => command === 'comments.delete').length, 1);
  assert.equal(store.get(key).status, 'succeeded');
  // A prior console may have crashed while holding the lock; refreshing the
  // activity view recovers its in-flight marker without another write request.
  store.db.prepare("UPDATE recalls SET status='requesting' WHERE job_key=?").run(key);
  const history = await server.app.inject({ url: '/api/activity', headers });
  assert.equal(history.json().items[0].recallStatus, 'unknown');
  assert.equal(history.json().items[0].canRecall, false);
  assert.equal(calls.filter(command => command === 'comments.delete').length, 1);
});
