'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createBridgeServer } = require('../src/bridge/server');
const { BridgeClient } = require('../src/bridge/client');
const { validateCommand } = require('../src/bridge/protocol');
const TOKEN = 'test-token-for-local-fixture'; const ACCOUNT = '123456';

test('delete requires an owned video, explicit thread and distinct published reply ID', () => {
  const args = { accountUid: ACCOUNT, videoId: '11', rootCid: '22', commentCid: '33' };
  assert.equal(validateCommand('comments.delete', args).command, 'comments.delete');
  for (const changed of [{ commentCid: '22' }, { commentCid: 33 }, { rootCid: undefined }, { videoId: '../other' }]) {
    assert.throws(() => validateCommand('comments.delete', { ...args, ...changed }));
  }
});
test('publish permits verified image-only payloads but never an empty reply or invalid image', () => {
  const args = { accountUid: ACCOUNT, videoId: '11', targetCid: '22', text: '', images: [{ uri: 'tos/file', format: 'gif', width: 20, height: 20 }] };
  assert.equal(validateCommand('comments.publish', args).command, 'comments.publish');
  assert.throws(() => validateCommand('comments.publish', { ...args, images: [] }), /text|image/i);
  assert.throws(() => validateCommand('comments.publish', { ...args, images: [{ ...args.images[0], uri: '../bad uri' }] }), /image/i);
});
test('dispatched delete timeouts are unknown; delete is never redispatched by the bridge', async t => {
  const { bridge, port } = await setup(t, { requestTimeout: 40 });
  const connected = await request(port, '/api/connect', { accountUid: ACCOUNT });
  const operation = bridge.call('comments.delete', { accountUid: ACCOUNT, videoId: '11', rootCid: '22', commentCid: '33' });
  const failed = assert.rejects(operation, error => error.outcomeUnknown === true);
  const poll = await request(port, '/api/poll', { sessionId: connected.sessionId });
  assert.equal(poll.command, 'comments.delete');
  await failed;
  assert.equal(bridge.status().pending, 0);
});
function request(port, route, body, token = TOKEN, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers } }, res => {
      let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => { try { resolve({ status: res.statusCode, ...JSON.parse(data) }); } catch (error) { reject(error); } });
    }); req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
async function setup(t, options = {}) {
  const bridge = createBridgeServer({ token: TOKEN, port: 0, requestTimeout: 500, ...options });
  const address = await bridge.start(); t.after(() => bridge.close());
  return { bridge, port: address.port, client: new BridgeClient({ port: address.port, token: TOKEN, timeout: 1000 }) };
}
test('protocol rejects arbitrary code/URLs, numeric IDs, and invalid publish payloads', () => {
  assert.throws(() => validateCommand('eval', { accountUid: ACCOUNT, expression: 'process.exit()' }), /Unsupported/);
  assert.throws(() => validateCommand('video.get', { accountUid: ACCOUNT, videoId: 123 }), /string/);
  assert.throws(() => validateCommand('comments.publish', { accountUid: ACCOUNT, videoId: '1', targetCid: '2', text: '', images: [] }), /text/);
  assert.throws(() => createBridgeServer({ token: TOKEN, host: '0.0.0.0' }), /loopback/);
});
test('authenticated status, exact-origin checks, and fixed account selection', async t => {
  const { port, client } = await setup(t);
  assert.equal((await request(port, '/api/status', undefined, 'bad')).status, 401);
  assert.equal((await request(port, '/api/status', undefined, TOKEN, { Origin: 'https://www.douyin.com.evil.test' })).status, 403);
  await request(port, '/api/connect', { accountUid: ACCOUNT });
  assert.equal((await client.status()).connected, true);
  await assert.rejects(client.call('identity.get', { accountUid: '654321' }), /identity/);
});
test('HTTP poll dispatch and session-bound receipts resolve exactly one call', async t => {
  const { bridge, port, client } = await setup(t);
  const connected = await request(port, '/api/connect', { accountUid: ACCOUNT });
  const operation = client.call('comments.list', { accountUid: ACCOUNT, videoId: '1', cursor: '0', count: 20 });
  const poll = await request(port, '/api/poll', { sessionId: connected.sessionId });
  assert.equal(poll.type, 'command'); assert.equal(poll.command, 'comments.list'); assert.equal(poll.expression, undefined);
  const wrong = await request(port, '/api/result', { sessionId: 'other', id: poll.id, value: {} }); assert.equal(wrong.status, 409);
  await request(port, '/api/result', { sessionId: connected.sessionId, id: poll.id, value: { comments: [], has_more: false } });
  assert.deepEqual(await operation, { comments: [], has_more: false }); assert.equal(bridge.status().pending, 0);
  assert.equal((await request(port, '/api/result', { sessionId: connected.sessionId, id: poll.id, value: {} })).status, 409);
});
test('dispatched writes time out as unknown; queued writes that never left the server are known unsent', async t => {
  const { bridge, port } = await setup(t, { requestTimeout: 40 });
  const connected = await request(port, '/api/connect', { accountUid: ACCOUNT });
  const args = { accountUid: ACCOUNT, videoId: '1', targetCid: '2', text: 'test', images: [] };
  const first = bridge.call('comments.publish', args);
  const firstCheck = assert.rejects(first, error => error.outcomeUnknown === true);
  const poll = await request(port, '/api/poll', { sessionId: connected.sessionId }); assert.equal(poll.type, 'command');
  await firstCheck;
  await assert.rejects(bridge.call('comments.publish', args), error => error.outcomeUnknown === false);
});
test('reconnect cancels old pending calls and expires previous session', async t => {
  const { bridge, port } = await setup(t);
  const connected = await request(port, '/api/connect', { accountUid: ACCOUNT });
  const pending = bridge.call('identity.get', { accountUid: ACCOUNT }); const checked = assert.rejects(pending, /reconnected/);
  await request(port, '/api/connect', { accountUid: ACCOUNT }); await checked;
  assert.equal((await request(port, '/api/poll', { sessionId: connected.sessionId })).status, 409);
});

test('client marks local protocol rejection as definitely unsent without a request', async () => {
  const client = new BridgeClient({ token: TOKEN });
  client._request = () => { assert.fail('Invalid payload must not reach the bridge'); };
  await assert.rejects(client.call('comments.publish', { accountUid: ACCOUNT, videoId: '1', targetCid: '2', text: '', images: [] }),
    error => error.definitelyNotSent === true && error.outcomeUnknown === false);
});

test('client preserves server evidence that a queued write was never dispatched', async t => {
  const { port, client } = await setup(t, { requestTimeout: 40 });
  await request(port, '/api/connect', { accountUid: ACCOUNT });
  await assert.rejects(client.call('comments.publish', { accountUid: ACCOUNT, videoId: '1', targetCid: '2', text: '收到', images: [] }),
    error => error.code === 'BRIDGE_TIMEOUT' && error.outcomeUnknown === false && error.definitelyNotSent === true);
});

test('client preserves dispatched timeout uncertainty', async t => {
  const { port, client } = await setup(t, { requestTimeout: 40 });
  const connected = await request(port, '/api/connect', { accountUid: ACCOUNT });
  const operation = client.call('comments.publish', { accountUid: ACCOUNT, videoId: '1', targetCid: '2', text: '收到', images: [] });
  const checked = assert.rejects(operation, error => error.outcomeUnknown === true && error.definitelyNotSent !== true);
  const poll = await request(port, '/api/poll', { sessionId: connected.sessionId });
  assert.equal(poll.type, 'command');
  await checked;
});

test('browser preflight rejection and bridge authentication rejection are definitely unsent', async t => {
  const { port, client } = await setup(t);
  const connected = await request(port, '/api/connect', { accountUid: ACCOUNT });
  const args = { accountUid: ACCOUNT, videoId: '1', targetCid: '2', text: '收到', images: [] };
  const operation = client.call('comments.publish', args);
  const checked = assert.rejects(operation, error => error.outcomeUnknown === false && error.definitelyNotSent === true);
  const poll = await request(port, '/api/poll', { sessionId: connected.sessionId });
  await request(port, '/api/result', { sessionId: connected.sessionId, id: poll.id, error: 'Login changed before publishing', outcomeUnknown: false });
  await checked;
  const denied = new BridgeClient({ port, token: 'wrong-token' });
  await assert.rejects(denied.call('comments.publish', args), error => error.code === 'BRIDGE_REJECTED' && error.definitelyNotSent === true && error.outcomeUnknown === false);
});

test('a connection interrupted without a bridge result remains an unknown write', async t => {
  const server = http.createServer(req => req.socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new BridgeClient({ port: server.address().port, token: TOKEN, timeout: 1000 });
  await assert.rejects(client.call('comments.publish', { accountUid: ACCOUNT, videoId: '1', targetCid: '2', text: '收到', images: [] }),
    error => error.outcomeUnknown === true && error.definitelyNotSent !== true);
});
