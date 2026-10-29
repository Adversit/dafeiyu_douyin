'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridgeServer } = require('../src/bridge/server');

test('浏览器未连接时，给出打开抖音并启用油猴的可操作提示', async t => {
  const bridge = createBridgeServer({ token: 'test-token', port: 0 });
  await bridge.start();
  t.after(() => bridge.close());
  await assert.rejects(bridge.call('identity.get', { accountUid: '10001' }), error => {
    assert.equal(error.code, 'BRIDGE_REJECTED');
    assert.match(error.message, /打开.*抖音/);
    assert.match(error.message, /油猴/);
    return true;
  });
});
