'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const SOURCE = fs.readFileSync(path.join(__dirname, '../userscript/dafeiyu-douyin.user.js'), 'utf8');
function harness(fetcher) {
  const calls = [];
  const context = { GM_getValue: () => 'fixture-token', GM_registerMenuCommand() {},
    console: { info() {} }, URLSearchParams, TextEncoder, AbortController, setTimeout, clearTimeout,
    unsafeWindow: { document: { cookie: '' }, navigator: { platform: 'MacIntel', userAgent: 'Chrome/148.0.0.0', language: 'zh-CN', onLine: true }, screen: { width: 1200, height: 800 }, crypto: webcrypto,
      async fetch(url, init) { calls.push({ url, init }); const value = await fetcher(url, init); return { ok: true, text: async () => typeof value === 'string' ? value : JSON.stringify(value) }; } } };
  // Expose the otherwise private dispatcher in an isolated fake browser; do not
  // start polling or contact the user's browser, localhost bridge or platform.
  vm.runInNewContext(SOURCE.replace('  run();\n})();', '  globalThis.testApi = { dispatch, losslessJson, strictUid };\n})();'), context);
  return { api: context.testApi, calls };
}
test('userscript JSON parsing preserves numeric 19-digit IDs before rounding', () => {
  const { api } = harness(() => ({}));
  const data = api.losslessJson('{"cid":1234567890123456789,"text":"x 1234567890123456789 \\"quoted\\"","n":1.25}');
  assert.equal(data.cid, '1234567890123456789'); assert.equal(data.text, 'x 1234567890123456789 "quoted"'); assert.equal(data.n, 1.25);
});
test('userscript dispatcher maps thread and direct reply IDs and preserves receipt IDs', async () => {
  const { api, calls } = harness(url => {
    if (url.includes('/query/user/')) return { status_code: 0, user_uid: '123456' };
    if (url.includes('/aweme/detail/')) return { aweme_detail: { author: { uid: '123456' } } };
    return '{"status_code":0,"comment":{"cid":1234567890123456789}}';
  });
  const receipt = await api.dispatch('comments.publish', { accountUid: '123456', videoId: '1', rootCid: '2', targetCid: '3', text: '收到', images: [] });
  const publish = calls.find(c => c.url.includes('/comment/publish/'));
  const body = new URLSearchParams(publish.init.body);
  assert.equal(body.get('reply_id'), '2'); assert.equal(body.get('reply_to_reply_id'), '3'); assert.equal(body.get('text'), '收到');
  assert.equal(receipt.comment.cid, '1234567890123456789'); assert.equal(calls.filter(c => c.url.includes('/query/user/')).length, 2);
});
test('userscript refuses a changed login and never reaches publishing', async () => {
  let probes = 0;
  const { api, calls } = harness(url => {
    if (url.includes('/query/user/')) return { user_uid: ++probes === 1 ? '123456' : '654321' };
    return { aweme_detail: { author: { uid: '123456' } } };
  });
  await assert.rejects(api.dispatch('comments.publish', { accountUid: '123456', videoId: '1', targetCid: '2', text: '收到', images: [] }), /changed/);
  assert.equal(calls.some(c => c.url.includes('/comment/publish/')), false);
  await assert.rejects(api.dispatch('eval', { accountUid: '123456', expression: 'fetch("https://example.com")' }), /Unsupported/);
});
test('userscript refuses non-owner videos before publishing', async () => {
  const { api, calls } = harness(url => url.includes('/query/user/') ? { user_uid: '123456' } : { aweme_detail: { author: { uid: '654321' } } });
  await assert.rejects(api.dispatch('comments.publish', { accountUid: '123456', videoId: '1', targetCid: '2', text: '收到', images: [] }), /ownership/);
  assert.equal(calls.some(c => c.url.includes('/comment/publish/')), false);
});
