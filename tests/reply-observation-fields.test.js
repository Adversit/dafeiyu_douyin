'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectReply } = require('../src/services/reply-observation');

test('根评论直接回复必须由平台明确返回零，畸形或缺失字段不得判为找到', async t => {
  const args = { accountUid: '10001', videoId: '20001', rootCid: '40001', commentCid: '90001' };
  const row = { target_cid: '40001', event_json: JSON.stringify({ authorUid: '30001' }) };
  for (const value of [0, '0', null, '', 'invalid', {}, undefined]) await t.test(typeof value === 'object' ? JSON.stringify(value) : String(value), async () => {
    const bridge = { async call(command) {
      if (command === 'identity.get') return { uid: '10001' };
      if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
      if (command === 'comments.list') return { status_code: 0, has_more: 0, comments: [{ cid: '40001', user: { uid: '30001' }, reply_comment_total: 1 }] };
      if (command === 'comments.replies') return { status_code: 0, _bridge_reply_query: 'item_id-v1', has_more: 0, total: 1, comments: [{ cid: '90001', user: { uid: '10001' }, reply_id: '40001', ...(value === undefined ? {} : { reply_to_reply_id: value }) }] };
      throw Error('unexpected command');
    } };
    const operation = inspectReply(bridge, row, args, { douyin: {} });
    if (value === 0 || value === '0') assert.equal(await operation, 'present');
    else await assert.rejects(operation, /作者或目标不一致/);
  });
});
