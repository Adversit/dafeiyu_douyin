'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DouyinAdapter } = require('../src/douyin/adapter');
const { Worker } = require('../src/worker');
const { Store } = require('../src/store');

test('历史顶层回复经真实normalizer进入worker后，不再次回复已有本人回复的目标', async t => {
  const accountUid = '10001', videoId = '20001', targetCid = '40001';
  let publishes = 0, generations = 0;
  const bridge = { async call(command) {
    if (command === 'identity.get') return { uid: accountUid };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: accountUid } } };
    if (command === 'comments.list') return { status_code: 0, has_more: 0, comments: [{ cid: targetCid, user: { uid: '30001' }, text: '大肥鱼在吗', create_time: 1700000000, text_extra: [{ type: 0, user_id: accountUid }], reply_comment_total: 1 }] };
    if (command === 'comments.replies') return { status_code: 0, _bridge_reply_query: 'item_id-v1', has_more: 0, comments: [{ cid: '50001', user: { uid: accountUid }, text: '鱼早就来啦', create_time: 1700000001, reply_id: targetCid, reply_to_reply_id: '0', reply_to_uid: '30001' }] };
    if (command === 'comments.publish') { publishes++; throw new Error('Must not publish a second reply'); }
    throw new Error(`Unexpected command ${command}`);
  } };
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = { accountUid, videos: [videoId], douyin: { inboundSchemaConfirmed: true }, worker: { maxRepliesPerRound: 3, maxCandidatesPerRound: 30, sendIntervalMs: 1000 }, stickers: { enabled: false } };
  const worker = new Worker({ config, adapter: new DouyinAdapter({ bridge, accountUid, inboundSchemaConfirmed: true }), store,
    agent: { async decideAddressed() { return { addressed: true }; }, async generate() { generations++; return { text: '鱼又来啦' }; } }, sleep: async () => {} });
  const result = await worker.runOnce();
  assert.equal(result.attempted, 0); assert.equal(publishes, 0); assert.equal(generations, 0);
  const job = store.get(`${accountUid}:${videoId}:${targetCid}`);
  assert.equal(job.status, 'succeeded');
  assert.equal(JSON.parse(job.result_json).cid, '50001');
});
