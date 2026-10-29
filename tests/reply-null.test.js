'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DouyinAdapter } = require('../src/douyin/adapter');
const { verifyAbsent } = require('../src/services/recall');

const accountUid = '123456', videoId = '1234567890123456789', rootCid = '101', targetCid = '202';
const empty = { status_code: 0, comments: null, has_more: 0, total: 0, _bridge_reply_query: 'item_id-v1' };
function fixture(replyCount, reply = empty) {
  const root = { cid: rootCid, user: { uid: '300' }, text: '大肥鱼', reply_comment_total: replyCount };
  const bridge = { async call(command) {
    if (command === 'identity.get') return { uid: accountUid };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: accountUid } } };
    if (command === 'comments.list') return { status_code: 0, comments: [root], has_more: 0 };
    if (command === 'comments.replies') return reply;
    throw Error('unexpected command');
  } };
  return { bridge, adapter: new DouyinAdapter({ bridge, accountUid }) };
}

test('抖音成功返回 null 且根计数和回复总数均为零，可读取根评论整楼', async () => {
  const { adapter } = fixture(0);
  const thread = await adapter.readThread(videoId, { rootCid, targetCid: rootCid, targetAuthorUid: '300' });
  assert.equal(thread.complete, true);
  assert.deepEqual(thread.comments.map(c => c.cid), [rootCid]);
});

test('回复计数与 null 矛盾时保留续扫和警告，不宣称扫描完整', async () => {
  const { adapter } = fixture(1);
  const scan = await adapter.scanVideo(videoId);
  assert.equal(scan.complete, false);
  assert.equal(scan.comments.length, 1);
  assert.deepEqual(scan.continuation, { rootCursor: null, replies: [{ rootCid, cursor: '0' }] });
  assert.match(scan.warnings.join(' '), /未完整读取/);
  await assert.rejects(adapter.readThread(videoId, { rootCid, targetCid: rootCid, targetAuthorUid: '300' }), /无法确认该楼回复是否完整/);
});

test('某楼持续空值时后续轮次仍扫描新根评论且不会重复添加续扫任务', async () => {
  let round = 0;
  const bridge = { async call(command) {
    if (command === 'identity.get') return { uid: accountUid };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: accountUid } } };
    if (command === 'comments.list') {
      round++;
      return { status_code: 0, has_more: 0, comments: [
        { cid: rootCid, user: { uid: '300' }, reply_comment_total: 1 },
        ...(round > 1 ? [{ cid: '303', user: { uid: '400' }, reply_comment_total: 0 }] : []),
      ] };
    }
    if (command === 'comments.replies') return empty;
    throw Error('unexpected command');
  } };
  const adapter = new DouyinAdapter({ bridge, accountUid });
  const first = await adapter.scanVideo(videoId);
  const second = await adapter.scanVideo(videoId, { continuation: first.continuation });
  assert.ok(second.comments.some(c => c.cid === '303'));
  assert.deepEqual(second.continuation.replies, [{ rootCid, cursor: '0' }]);
  assert.equal(second.complete, false);
});

test('缺少计数、总数不为零、未知分页或失败返回不能按空楼处理', async t => {
  for (const [name, count, reply] of [
    ['缺少根计数', undefined, empty],
    ['回复总数非零', 0, { ...empty, total: 1 }],
    ['缺少总数', 0, { status_code: 0, comments: null, has_more: 0 }],
    ['旧脚本的查询参数未验证', 0, { status_code: 0, comments: null, has_more: 0, total: 0 }],
    ['仍有下一页', 0, { ...empty, has_more: 1 }],
    ['接口失败', 0, { ...empty, status_code: 1 }],
    ['评论字段缺失', 0, { status_code: 0, has_more: 0, total: 0 }],
  ]) await t.test(name, async () => {
    const { adapter } = fixture(count, reply);
    await assert.rejects(adapter.readThread(videoId, { rootCid, targetCid: rootCid, targetAuthorUid: '300' }));
  });
});

test('撤回核验只在零计数与空回复证据一致时接受 null', async () => {
  const args = { accountUid, videoId, rootCid, commentCid: targetCid };
  const row = { target_cid: rootCid, event_json: JSON.stringify({ authorUid: '300' }) };
  await verifyAbsent(fixture(0).bridge, args, 10, 10, row);
  await assert.rejects(verifyAbsent(fixture(1).bridge, args, 10, 10, row));
});

test('旧脚本返回数组也不能用作完整楼层或已撤回的证据', async () => {
  const oldReply = { status_code: 0, comments: [], has_more: 0, total: 0 };
  const { bridge, adapter } = fixture(0, oldReply);
  await assert.rejects(adapter.readThread(videoId, { rootCid, targetCid: rootCid, targetAuthorUid: '300' }), /更新脚本/);
  await assert.rejects(verifyAbsent(bridge, { accountUid, videoId, rootCid, commentCid: targetCid }, 10, 10, { target_cid: rootCid, event_json: JSON.stringify({ authorUid: '300' }) }), /更新脚本/);
});

test('新版脚本缺少成功状态时不能判定完整楼层', async () => {
  const { adapter } = fixture(0, { comments: [], has_more: 0, _bridge_reply_query: 'item_id-v1' });
  await assert.rejects(adapter.readThread(videoId, { rootCid, targetCid: rootCid, targetAuthorUid: '300' }), /未返回明确成功/);
});
