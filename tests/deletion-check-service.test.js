'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { acquireLock } = require('../src/lock');
const { createDeletionCheckService } = require('../src/services/deletion-check');
const { readActivity } = require('../src/web/activity');

function setup(t, override) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-check-'));
  const store = new Store(path.join(root, 'runtime/agent.sqlite'));
  const config = { accountUid: '10001', videos: ['20001'], douyin: { maxPages: 4, maxReplyPages: 4 } };
  const event = { videoId: '20001', cid: '40001', rootCid: '40001', authorUid: '30001', text: 'fixture' };
  const key = store.enqueue(config.accountUid, event, { eligible: true });
  store.finish(key, 'unknown', { result: { cid: '90001', authorVerified: true, targetVerification: { aweme_id: 'missing', reply_id: 'matched', reply_to_reply_id: 'matched' } } });
  const calls = [];
  const bridge = { async call(command, args) {
    calls.push(command);
    if (override) return override(command, args, { store, key, config });
    if (command === 'identity.get') return { uid: config.accountUid };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { aweme_id: '20001', author: { uid: config.accountUid } } };
    if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40001', user: { uid: '30001' }, reply_comment_total: 0 }], has_more: 0 };
    if (command === 'comments.replies') return { status_code: 0, comments: null, total: 0, has_more: 0, _bridge_reply_query: 'item_id-v1' };
    throw new Error('unexpected command');
  } };
  const service = createDeletionCheckService({ root, bridge, getConfig: () => config });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, config, key, calls, bridge, service };
}

test('双零只读结果标为当前未找到，不改发送账本或允许自动重发', async t => {
  const f = setup(t);
  const before = f.store.get(f.key);
  const result = await f.service.check(f.key);
  assert.equal(result.status, 'absent'); assert.match(result.reason, /不能作为删除证明/);
  assert.deepEqual(f.store.get(f.key), before);
  assert.equal(f.store.claim(f.config.accountUid, f.config.videos), null);
  assert.deepEqual(f.calls, ['identity.get', 'video.get', 'comments.list', 'comments.replies']);
  const item = readActivity({ root: f.root, accountUid: f.config.accountUid, videos: f.config.videos }).items[0];
  assert.equal(item.status, 'unknown'); assert.equal(item.checkStatus, 'absent'); assert.equal(item.checkAt, result.checkedAt);
});

test('可见仅在作者和直接目标字段匹配时确认，任何矛盾均为不明确', async t => {
  for (const mode of ['match', 'author', 'target', 'missing']) {
    const f = setup(t, command => {
      if (command === 'identity.get') return { uid: '10001' };
      if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
      if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40001', user: { uid: '30001' }, reply_comment_total: 1 }], has_more: 0 };
      if (command === 'comments.replies') return { status_code: 0, _bridge_reply_query: 'item_id-v1', has_more: 0, total: 1, comments: [{ cid: '90001', user: { uid: mode === 'author' ? '99999' : '10001' }, reply_id: mode === 'target' ? '88888' : '40001', ...(mode === 'missing' ? {} : { reply_to_reply_id: '0' }) }] };
      throw Error('unexpected');
    });
    const value = await f.service.check(f.key);
    assert.equal(value.status, mode === 'match' ? 'present' : 'inconclusive');
  }
});

test('身份、根、目标、计数、脚本版本、分页及网络异常不误判缺席', async t => {
  for (const mode of ['identity', 'owner', 'root_missing', 'root_author', 'positive_null', 'count_mismatch', 'old_script', 'truncated', 'timeout']) {
    const f = setup(t, command => {
      if (command === 'identity.get') return { uid: mode === 'identity' ? '99999' : '10001' };
      if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: mode === 'owner' ? '99999' : '10001' } } };
      if (command === 'comments.list') return { status_code: 0, comments: mode === 'root_missing' ? [] : [{ cid: '40001', user: { uid: mode === 'root_author' ? '99999' : '30001' }, reply_comment_total: ['positive_null', 'count_mismatch'].includes(mode) ? 1 : 0 }], has_more: 0 };
      if (command === 'comments.replies') {
        if (mode === 'timeout') throw Error('PRIVATE CONTENT');
        return { status_code: 0, ...(mode === 'old_script' ? {} : { _bridge_reply_query: 'item_id-v1' }), comments: mode === 'count_mismatch' ? [] : null, total: 0, has_more: mode === 'truncated' ? 1 : 0, cursor: 20 };
      }
      throw Error('unexpected');
    });
    const result = await f.service.check(f.key);
    assert.equal(result.status, 'inconclusive', mode); assert.doesNotMatch(result.reason, /PRIVATE/);
    assert.equal(f.store.get(f.key).status, 'unknown');
  }
});

test('目标子评论不存在或作者不匹配时不可将原回复判为缺席', async t => {
  for (const mode of ['missing_target', 'wrong_author']) {
    const f = setup(t, command => {
      if (command === 'identity.get') return { uid: '10001' };
      if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
      if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40001', user: { uid: '55555' }, reply_comment_total: 1 }], has_more: 0 };
      if (command === 'comments.replies') return { status_code: 0, _bridge_reply_query: 'item_id-v1', has_more: 0, total: 1, comments: [{ cid: mode === 'missing_target' ? '77777' : '40002', user: { uid: mode === 'wrong_author' ? '99999' : '30001' }, reply_id: '40001' }] };
      throw Error('unexpected');
    });
    const row = f.store.get(f.key); const event = JSON.parse(row.event_json); event.cid = '40002'; event.rootCid = '40001';
    f.store.db.prepare('UPDATE jobs SET target_cid=?,event_json=? WHERE job_key=?').run(event.cid, JSON.stringify(event), f.key);
    assert.equal((await f.service.check(f.key)).status, 'inconclusive');
  }
});

test('锁占用时拒绝核查；发送记录改变后不显示旧快照', async t => {
  const f = setup(t);
  const release = acquireLock(path.join(f.root, 'runtime/worker.lock'));
  await assert.rejects(f.service.check(f.key), { code: 'RUNTIME_BUSY' }); release();
  await f.service.check(f.key);
  f.store.finish(f.key, 'succeeded', { result: { cid: '90002', targetVerified: true } });
  const item = readActivity({ root: f.root, accountUid: f.config.accountUid, videos: f.config.videos }).items[0];
  assert.equal(item.checkStatus, null); assert.equal(item.canCheck, true);
});

test('相同回复 CID 但目标作者或原回执变化时隐藏旧快照', async t => {
  const f = setup(t); await f.service.check(f.key);
  let row = f.store.get(f.key); let event = JSON.parse(row.event_json); event.authorUid = '99999';
  f.store.db.prepare('UPDATE jobs SET event_json=? WHERE job_key=?').run(JSON.stringify(event), f.key);
  assert.equal(readActivity({ root: f.root, accountUid: f.config.accountUid, videos: f.config.videos }).items[0].checkStatus, null);
  event.authorUid = '30001';
  f.store.db.prepare('UPDATE jobs SET event_json=?,result_json=? WHERE job_key=?').run(JSON.stringify(event), JSON.stringify({ cid: '90001', authorVerified: false }), f.key);
  assert.equal(readActivity({ root: f.root, accountUid: f.config.accountUid, videos: f.config.videos }).items[0].checkStatus, null);
});

test('核查期间任务记录变化，不覆盖其他任务的快照', async t => {
  const f = setup(t, (command, args, data) => {
    if (command === 'identity.get') return { uid: '10001' };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
    if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40001', user: { uid: '30001' }, reply_comment_total: 0 }], has_more: 0 };
    if (command === 'comments.replies') {
      data.store.finish(data.key, 'succeeded', { result: { cid: '90002' } });
      return { status_code: 0, _bridge_reply_query: 'item_id-v1', comments: null, total: 0, has_more: 0 };
    }
    throw Error('unexpected');
  });
  await assert.rejects(f.service.check(f.key), { code: 'CHECK_STALE' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reply_checks').get().n, 0);
});

test('自动核查每轮最多三条，公平处理未核查记录，五分钟内不重复', async t => {
  const f = setup(t, (command, args) => {
    if (command === 'identity.get') return { uid: '10001' };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
    if (command === 'comments.list') return { status_code: 0, comments: Array.from({ length: 5 }, (_, i) => ({ cid: String(40001 + i), user: { uid: '30001' }, reply_comment_total: 0 })), has_more: 0 };
    if (command === 'comments.replies') return { status_code: 0, _bridge_reply_query: 'item_id-v1', comments: null, total: 0, has_more: 0 };
    throw Error('unexpected');
  });
  for (let i = 1; i < 5; i++) {
    const cid = String(40001 + i);
    const key = f.store.enqueue('10001', { videoId: '20001', cid, rootCid: cid, authorUid: '30001', text: 'fixture' }, { eligible: true });
    f.store.finish(key, 'succeeded', { result: { cid: String(90001 + i) } });
  }
  f.store.db.prepare('UPDATE jobs SET updated_at=?').run(Date.now() - 120000);
  assert.equal((await f.service.checkBatchWhileLocked(f.config)).checked, 3);
  assert.equal((await f.service.checkBatchWhileLocked(f.config)).checked, 2);
  assert.equal((await f.service.checkBatchWhileLocked(f.config)).checked, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reply_checks').get().n, 5);
  assert.ok(f.calls.every(c => ['identity.get', 'video.get', 'comments.list', 'comments.replies'].includes(c)));
  assert.equal(f.store.claim('10001', ['20001']), null);
});

test('自动核查接收到停止信号时不再写入快照', async t => {
  const controller = new AbortController();
  const f = setup(t, command => {
    if (command === 'identity.get') { controller.abort(); return { uid: '10001' }; }
    throw Error('unexpected');
  });
  f.store.db.prepare('UPDATE jobs SET updated_at=?').run(Date.now() - 120000);
  await assert.rejects(f.service.checkBatchWhileLocked(f.config, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reply_checks').get().n, 0);
});

test('自动批次超时标记结果不明确，不改变原发送记录', async t => {
  const f = setup(t, () => new Promise(() => {}));
  f.store.db.prepare('UPDATE jobs SET updated_at=?').run(Date.now() - 120000);
  const before = f.store.get(f.key);
  assert.equal((await f.service.checkBatchWhileLocked(f.config, { budgetMs: 30, requestTimeoutMs: 20 })).checked, 1);
  assert.equal(f.store.db.prepare('SELECT status FROM reply_checks WHERE job_key=?').get(f.key).status, 'inconclusive');
  assert.deepEqual(f.store.get(f.key), before);
});
