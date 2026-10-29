'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DouyinAdapter } = require('../src/douyin/adapter');

const ACCOUNT = '123456'; const VIDEO = '1234567890123456789';
const ROOT = '100'; const TARGET = '221'; const AUTHOR = '321';
const root = () => ({ cid: ROOT, aweme_id: VIDEO, text: 'A 原文', user: { uid: '111' } });
const child = (cid, uid = AUTHOR) => ({ cid, aweme_id: VIDEO, reply_id: ROOT, text: `原文 ${cid}`, user: { uid } });
function fixture(handler, inboundSchemaConfirmed = false) {
  const calls = [];
  const bridge = { async call(command, args) {
    calls.push({ command, args });
    if (command === 'identity.get') return { uid: ACCOUNT };
    if (command === 'video.get') return { aweme_detail: { author: { uid: ACCOUNT } } };
    const value = await handler(command, args);
    return command === 'comments.replies' && value && typeof value === 'object'
      ? { status_code: 0, _bridge_reply_query: 'item_id-v1', ...value } : value;
  } };
  return { calls, adapter: new DouyinAdapter({ bridge, accountUid: ACCOUNT, inboundSchemaConfirmed }) };
}
const opts = { rootCid: ROOT, targetCid: TARGET, targetAuthorUid: AUTHOR };

test('实时读取指定作品整楼，保留多页原文、顺序、作者和未知的直接回复关系', async () => {
  const first = Array.from({ length: 20 }, (_, i) => child(String(201 + i), i === 0 ? '222' : AUTHOR));
  first[0].reply_to_reply_id = ROOT;
  const { adapter, calls } = fixture((command, args) => {
    if (command === 'comments.list') return args.cursor === '0'
      ? { comments: [{ cid: '1', user: { uid: '999' } }], has_more: 1, cursor: '20' }
      : { comments: [root()], has_more: 0 };
    assert.equal(command, 'comments.replies'); assert.equal(args.rootCid, ROOT);
    return args.cursor === '0' ? { comments: first, has_more: 1, cursor: '20' }
      : { comments: [child(TARGET)], has_more: 0 };
  });
  const result = await adapter.readThread(VIDEO, opts);
  assert.equal(result.complete, true);
  assert.deepEqual(result.comments.map(c => c.cid), [ROOT, ...first.map(c => c.cid), TARGET]);
  assert.equal(result.comments[0].text, 'A 原文');
  assert.equal(result.comments[1].authorUid, '222');
  assert.equal(result.comments[1].replyToCid, ROOT);
  assert.equal(result.comments[1].replyRelationKnown, false);
  assert.equal(result.comments[2].replyToCid, null);
  assert.equal(result.comments[2].replyRelationKnown, false);
  assert.equal(result.target.authorUid, AUTHOR);
  assert.deepEqual(calls.map(c => c.command), ['identity.get', 'video.get', 'comments.list', 'comments.list', 'comments.replies', 'comments.replies']);
});

test('只有已确认关系字段时才标记明确的直接回复', async () => {
  const { adapter } = fixture(command => command === 'comments.list'
    ? { comments: [root()], has_more: 0 }
    : { comments: [{ ...child(TARGET), reply_to_reply_id: '0' }], has_more: 0 }, true);
  const result = await adapter.readThread(VIDEO, opts);
  assert.equal(result.target.replyToCid, ROOT);
  assert.equal(result.target.replyRelationKnown, true);
});

test('未确认字段语义时不把 reply_id 推断为根评论 ID', async () => {
  const { adapter } = fixture(command => command === 'comments.list'
    ? { comments: [root()], has_more: 0 }
    : { comments: [{ ...child(TARGET), reply_id: '999' }], has_more: 0 });
  const result = await adapter.readThread(VIDEO, opts);
  assert.equal(result.target.rootCid, ROOT);
  assert.equal(result.target.replyRelationKnown, false);
});

test('根评论或目标不存在、作者或作品和楼层不符时拒绝返回上下文', async t => {
  const cases = [
    ['根不存在', { comments: [], has_more: 0 }, null, 'THREAD_ROOT_NOT_FOUND'],
    ['目标不存在', { comments: [root()], has_more: 0 }, { comments: [], has_more: 0 }, 'THREAD_TARGET_NOT_FOUND'],
    ['作者不同', { comments: [root()], has_more: 0 }, { comments: [child(TARGET, '999')], has_more: 0 }, 'THREAD_TARGET_MISMATCH'],
    ['根作品不同', { comments: [{ ...root(), aweme_id: '999' }], has_more: 0 }, null, 'THREAD_MISMATCH'],
    ['回复作品不同', { comments: [root()], has_more: 0 }, { comments: [{ ...child(TARGET), aweme_id: '999' }], has_more: 0 }, 'THREAD_MISMATCH'],
    ['回复楼层不同', { comments: [root()], has_more: 0 }, { comments: [{ ...child(TARGET), reply_id: '999' }], has_more: 0 }, 'THREAD_MISMATCH'],
  ];
  for (const [name, roots, replies, code] of cases) await t.test(name, async () => {
    const { adapter, calls } = fixture(command => command === 'comments.list' ? roots : replies, true);
    await assert.rejects(adapter.readThread(VIDEO, opts), { code });
    assert.ok(calls.every(c => ['identity.get', 'video.get', 'comments.list', 'comments.replies'].includes(c.command)));
  });
});

test('分页不完整、停滞、重复及网络失败时不返回部分楼层', async t => {
  const cases = [
    ['缺少 has_more', () => ({ comments: [child(TARGET)] }), {}, 'THREAD_INCOMPLETE'],
    ['超过页数', () => ({ comments: [child(TARGET)], has_more: 1, cursor: '20' }), { maxReplyPages: 1 }, 'THREAD_INCOMPLETE'],
    ['游标停滞', () => ({ comments: [child(TARGET)], has_more: 1, cursor: '0' }), {}, 'PAGINATION_STALLED'],
    ['重复页', (args) => ({ comments: [child(TARGET)], has_more: 1, cursor: args.cursor === '0' ? '20' : '40' }), {}, 'THREAD_INCOMPLETE'],
    ['网络失败', () => { throw new Error('connection failed'); }, {}, null],
  ];
  for (const [name, reply, limits, code] of cases) await t.test(name, async () => {
    const { adapter } = fixture((command, args) => command === 'comments.list' ? { comments: [root()], has_more: 0 } : reply(args));
    await assert.rejects(adapter.readThread(VIDEO, { ...opts, ...limits }), code ? { code } : /connection failed/);
  });
});

test('中止读取后不继续翻页', async () => {
  const controller = new AbortController();
  const { adapter, calls } = fixture(command => {
    if (command === 'comments.list') return { comments: [root()], has_more: 0 };
    controller.abort(); return { comments: [child(TARGET)], has_more: 1, cursor: '20' };
  });
  await assert.rejects(adapter.readThread(VIDEO, { ...opts, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.filter(c => c.command === 'comments.replies').length, 1);
});

test('旧脚本或缺少成功状态的回复数组不能用作完整楼层', async t => {
  for (const [name, response, expected] of [
    ['旧脚本返回数组', { status_code: 0, comments: [child(TARGET)], has_more: 0 }, /更新脚本/],
    ['缺少成功状态', { _bridge_reply_query: 'item_id-v1', comments: [child(TARGET)], has_more: 0 }, /未返回明确成功状态/],
  ]) await t.test(name, async () => {
    const bridge = { async call(command) {
      if (command === 'identity.get') return { uid: ACCOUNT };
      if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: ACCOUNT } } };
      if (command === 'comments.list') return { status_code: 0, comments: [{ ...root(), reply_comment_total: 1 }], has_more: 0 };
      if (command === 'comments.replies') return response;
      throw new Error('unexpected command');
    } };
    const adapter = new DouyinAdapter({ bridge, accountUid: ACCOUNT });
    await assert.rejects(adapter.readThread(VIDEO, opts), expected);
    const scan = await adapter.scanVideo(VIDEO);
    assert.equal(scan.complete, false);
    assert.ok(scan.warnings.some(warning => expected.test(warning)));
    assert.deepEqual(scan.continuation, { rootCursor: null, replies: [{ rootCid: ROOT, cursor: '0' }] });
  });
});
