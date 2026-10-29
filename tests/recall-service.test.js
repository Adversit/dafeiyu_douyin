'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { acquireLock } = require('../src/lock');
const { createRecallService } = require('../src/services/recall');
const { readActivity } = require('../src/web/activity');

function fixture(t, bridgeOverride) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-recall-'));
  const store = new Store(path.join(root, 'runtime/agent.sqlite'));
  const event = { videoId: '20001', cid: '40001', rootCid: '40000', authorUid: '30001', text: '你好' };
  const key = store.enqueue('10001', event, { eligible: true });
  store.finish(key, 'succeeded', { result: { cid: '90001' } });
  const config = { accountUid: '10001', videos: ['20001'], douyin: { maxReplyPages: 3 } };
  const calls = [];
  const bridge = { async call(command, args) {
    calls.push({ command, args });
    if (bridgeOverride) return bridgeOverride(command, args, calls);
    if (command === 'comments.delete') return { status_code: 0 };
    if (command === 'identity.get') return { uid: '10001' };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
    if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40000', reply_comment_total: 1 }], has_more: 0 };
    if (command === 'comments.replies') return { status_code: 0, _bridge_reply_query: 'item_id-v1', comments: [{ cid: '40001', user: { uid: '30001' }, reply_id: '40000' }], has_more: 0 };
    throw Error('unexpected command');
  } };
  const service = createRecallService({ root, bridge, getConfig: () => config });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, key, event, config, calls, service };
}

test('明确成功且整楼回读未发现目标时确认撤回，原发送记录保持去重', async t => {
  const f = fixture(t);
  assert.equal(readActivity({ root: f.root, accountUid: f.config.accountUid, videos: f.config.videos }).items[0].canRecall, true);
  const result = await f.service.recall(f.key);
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(f.calls[0], { command: 'comments.delete', args: { accountUid: '10001', videoId: '20001', rootCid: '40000', commentCid: '90001' } });
  assert.equal(f.store.get(f.key).status, 'succeeded');
  const activity = readActivity({ root: f.root, accountUid: '10001', videos: f.config.videos }).items[0];
  assert.equal(activity.recallStatus, 'confirmed'); assert.equal(activity.canRecall, false);
  await assert.rejects(f.service.recall(f.key), { code: 'RECALL_ALREADY_ATTEMPTED' });
  assert.equal(f.calls.filter(c => c.command === 'comments.delete').length, 1);
});

test('回执丢失或不完整回读均记为 unknown，不能重复删除', async t => {
  for (const mode of ['lost', 'no_ack', 'partial', 'still_visible', 'old_script']) {
    const f = fixture(t, (command) => {
      if (command === 'comments.delete') { if (mode === 'lost') throw Error('timeout'); return mode === 'no_ack' ? {} : { status_code: 0 }; }
      if (command === 'identity.get') return { uid: '10001' };
      if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
      if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40000', reply_comment_total: 1 }], has_more: 0 };
      if (command === 'comments.replies') return { status_code: 0, ...(mode === 'old_script' ? {} : { _bridge_reply_query: 'item_id-v1' }), comments: mode === 'still_visible' ? [{ cid: '90001' }] : [], ...(mode === 'partial' ? {} : { has_more: 0 }) };
      throw Error('unexpected command');
    });
    assert.equal((await f.service.recall(f.key)).status, 'unknown', mode);
    await assert.rejects(f.service.recall(f.key), { code: 'RECALL_ALREADY_ATTEMPTED' });
    assert.equal(f.calls.filter(c => c.command === 'comments.delete').length, 1);
    assert.equal(f.store.get(f.key).status, 'succeeded');
  }
});

test('明确未送达才允许手动重试；重启遗留 requesting 变为 unknown', async t => {
  let count = 0;
  const f = fixture(t, command => {
    if (command === 'comments.delete') { count++; throw Object.assign(Error('offline'), { definitelyNotSent: true }); }
    throw Error('unexpected command');
  });
  assert.equal((await f.service.recall(f.key)).status, 'failed');
  assert.equal((await f.service.recall(f.key)).status, 'failed');
  assert.equal(count, 2);
  f.store.db.prepare("UPDATE recalls SET status='requesting' WHERE job_key=?").run(f.key);
  const release = acquireLock(path.join(f.root, 'runtime/worker.lock'));
  f.service.recoverPending();
  assert.equal(f.store.db.prepare('SELECT status FROM recalls WHERE job_key=?').get(f.key).status, 'requesting');
  release();
  f.service.recoverPending();
  assert.equal(f.store.db.prepare('SELECT status FROM recalls WHERE job_key=?').get(f.key).status, 'unknown');
  await assert.rejects(f.service.recall(f.key), { code: 'RECALL_ALREADY_ATTEMPTED' });
  assert.equal(f.store.db.prepare('SELECT status FROM recalls WHERE job_key=?').get(f.key).status, 'unknown');
  assert.equal(count, 2);
});

test('限制当前账号、指定作品、Agent 来源和有效回执，繁忙时拒绝', async t => {
  const f = fixture(t);
  const row = f.store.get(f.key);
  for (const [config, result] of [
    [{ ...f.config, accountUid: '10002' }, row.result_json],
    [{ ...f.config, videos: [] }, row.result_json],
    [f.config, JSON.stringify({ cid: '90001', source: 'platform-history' })],
    [f.config, JSON.stringify({ cid: '40000' })],
    [f.config, '{}'],
  ]) {
    Object.assign(f.config, config); f.store.db.prepare('UPDATE jobs SET result_json=? WHERE job_key=?').run(result, f.key);
    await assert.rejects(f.service.recall(f.key), { code: 'RECALL_INELIGIBLE' });
    f.config.accountUid = '10001'; f.config.videos = ['20001'];
  }
  f.store.db.prepare('UPDATE jobs SET result_json=? WHERE job_key=?').run(row.result_json, f.key);
  const release = acquireLock(path.join(f.root, 'runtime/worker.lock'));
  await assert.rejects(f.service.recall(f.key), { code: 'RUNTIME_BUSY' }); release();
  assert.equal(f.calls.length, 0);
});

test('删除后楼层计数矛盾或目标评论缺失时，仅标记待核查', async t => {
  for (const mode of ['count_mismatch', 'target_absent']) {
    const f = fixture(t, command => {
      if (command === 'comments.delete') return { status_code: 0 };
      if (command === 'identity.get') return { uid: '10001' };
      if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
      if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40000', reply_comment_total: 1 }], has_more: 0 };
      if (command === 'comments.replies') return { status_code: 0, _bridge_reply_query: 'item_id-v1', has_more: 0,
        comments: mode === 'count_mismatch' ? [] : [{ cid: '40005', user: { uid: '30001' }, reply_id: '40000' }] };
      throw Error('unexpected');
    });
    assert.equal((await f.service.recall(f.key)).status, 'unknown');
    assert.equal(f.store.get(f.key).status, 'succeeded');
  }
});
