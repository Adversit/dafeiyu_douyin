'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Worker } = require('../src/worker');
const { reserveManualResend } = require('../src/services/resend');
const { readActivity } = require('../src/web/activity');

function fixture(t, { replyPage, result } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-resend-'));
  const file = path.join(root, 'runtime/agent.sqlite');
  const store = new Store(file);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const config = { accountUid: '10001', videos: ['20001'], douyin: { maxPages: 2, maxReplyPages: 2 },
    worker: { maxRepliesPerRound: 3, maxCandidatesPerRound: 30, sendIntervalMs: 0 }, stickers: { enabled: false } };
  const comment = { videoId: '20001', cid: '40001', rootCid: '40000', authorUid: '30001', text: '大肥鱼', mentionUids: [], mentionsKnown: false, replyRelationKnown: false };
  store.saveComments(config.accountUid, [comment]);
  const key = store.enqueue(config.accountUid, comment, { eligible: true });
  store.finish(key, 'succeeded', { result: result || { cid: '90001', targetVerified: true } });
  const other = { ...comment, cid: '40002', rootCid: '40002' };
  const otherKey = store.enqueue(config.accountUid, other, { eligible: true });
  const calls = [];
  const bridge = { async call(command, args) {
    calls.push(command);
    if (command === 'identity.get') return { uid: '10001' };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
    if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40000', reply_comment_total: 1 }], has_more: 0 };
    if (command === 'comments.replies') return { _bridge_reply_query: 'item_id-v1', ...(replyPage || { status_code: 0, comments: [{ cid: '40001', user: { uid: '30001' }, reply_id: '40000' }], has_more: 0 }) };
    throw new Error('unexpected bridge call');
  } };
  return { root, file, store, config, comment, key, otherKey, bridge, calls };
}

test('已确认位置的旧回复消失后手动保留历史并仅处理所选目标', async t => {
  const f = fixture(t);
  f.store.db.exec(`CREATE TABLE recalls (job_key TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, account_uid TEXT, video_id TEXT, root_cid TEXT, comment_cid TEXT)`);
  f.store.db.prepare("INSERT INTO recalls(job_key,status) VALUES (?,'confirmed')").run(f.key);
  await reserveManualResend({ ...f, jobKey: f.key });
  const history = f.store.db.prepare('SELECT * FROM resend_history WHERE job_key=?').get(f.key);
  assert.equal(JSON.parse(history.prior_job_json).result_json, JSON.stringify({ cid: '90001', targetVerified: true }));
  assert.equal(JSON.parse(history.prior_recall_json).status, 'confirmed');
  assert.equal(f.store.get(f.key).status, 'manual_pending');
  let sent = [];
  const adapter = { async readThread() { return { complete: true, target: f.comment, comments: [f.comment] }; },
    async publishReply(reply) { sent.push(reply); return { cid: '90002', targetVerified: true, imageCount: 0 }; } };
  const agent = { async reviewInput() { return { safe: true }; }, async reviewOutput() { return { safe: true }; }, async generate() { return { text: '本鱼来啦' }; } };
  const worker = new Worker({ config: f.config, store: f.store, adapter, agent, sleep: async () => {} });
  const summary = await worker.runOnce({ onlyJobKey: f.key });
  assert.equal(summary.sent, 1); assert.equal(sent.length, 1);
  assert.equal(sent[0].targetCid, f.comment.cid); assert.equal(sent[0].rootCid, f.comment.rootCid);
  assert.equal(f.store.get(f.otherKey).status, 'pending');
  assert.equal(f.store.get(f.key).status, 'succeeded');
  const activity = readActivity({ root: f.root, accountUid: f.config.accountUid, videos: f.config.videos }).items.find(x => x.jobKey === f.key);
  assert.equal(activity.canResend, true); assert.equal(activity.canRecall, true);
  assert.equal((await worker.runOnce({ onlyJobKey: f.key })).attempted, 0);
});

test('unknown 仅缺作品字段时可人工核验重发，作者和两种回复目标必须明确匹配', async t => {
  const verified = { cid: '90001', authorVerified: true, targetVerified: false,
    targetVerification: { aweme_id: 'missing', reply_id: 'matched', reply_to_reply_id: 'matched' } };
  const variants = [
    { name: 'confirmed', recall: 'confirmed', result: verified, cid: '90001', allowed: true },
    { name: '手动撤回无系统记录', recall: null, result: verified, cid: '90001', allowed: true },
    { name: '撤回状态待核查', recall: 'unknown', result: verified, cid: '90001', allowed: true },
    { name: '撤回请求中', recall: 'requesting', result: verified, cid: '90001' },
    { name: 'wrong cid', recall: 'confirmed', result: verified, cid: '90002' },
    { name: 'missing author', recall: 'confirmed', result: { ...verified, authorVerified: false }, cid: '90001' },
    { name: 'wrong video field', recall: 'confirmed', result: { ...verified, targetVerification: { aweme_id: 'mismatch', reply_id: 'matched', reply_to_reply_id: 'matched' } }, cid: '90001' },
    { name: 'missing direct target', recall: 'confirmed', result: { ...verified, targetVerification: { reply_id: 'matched', reply_to_reply_id: 'missing' } }, cid: '90001' },
  ];
  for (const v of variants) {
    const f = fixture(t, { result: v.result });
    f.store.finish(f.key, 'unknown', { result: v.result });
    f.store.db.exec(`CREATE TABLE recalls (job_key TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, account_uid TEXT, video_id TEXT, root_cid TEXT, comment_cid TEXT)`);
    if (v.recall) f.store.db.prepare('INSERT INTO recalls VALUES (?,?,NULL,?,?,?,?)').run(f.key, v.recall, '10001', '20001', '40000', v.cid);
    const item = readActivity({ root: f.root, accountUid: '10001', videos: f.config.videos }).items.find(x => x.jobKey === f.key);
    assert.equal(item.canResend, Boolean(v.allowed), v.name);
    if (v.allowed) {
      await reserveManualResend({ ...f, jobKey: f.key });
      assert.equal(f.store.get(f.key).status, 'manual_pending');
      const archivedRecall = f.store.db.prepare('SELECT prior_recall_json FROM resend_history').get().prior_recall_json;
      if (v.recall) assert.equal(JSON.parse(archivedRecall).comment_cid, '90001');
      else assert.equal(archivedRecall, null);
    } else {
      await assert.rejects(reserveManualResend({ ...f, jobKey: f.key }), { code: 'RESEND_INELIGIBLE' });
      assert.equal(f.store.get(f.key).status, 'unknown');
    }
  }
});

test('回复仍可见、不完整、回执不确定或目标不符均不能重发', async t => {
  for (const options of [
    { replyPage: { status_code: 0, comments: [{ cid: '90001' }], has_more: 0 } },
    { replyPage: { status_code: 0, comments: null, has_more: 0 } },
    { replyPage: { status_code: 0, comments: [], has_more: 0, _bridge_reply_query: undefined } },
    { replyPage: { comments: [], has_more: 0 } },
    { replyPage: { status_code: 0, comments: [], has_more: 1, cursor: '20' } },
    { result: { cid: '90001', targetVerified: false } },
  ]) {
    const f = fixture(t, options);
    await assert.rejects(reserveManualResend({ ...f, jobKey: f.key }), e => ['RESEND_UNVERIFIED', 'RESEND_INELIGIBLE'].includes(e.code));
    assert.equal(f.store.get(f.key).status, 'succeeded');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM resend_history').get().n, 0);
    assert.ok(f.calls.every(command => command !== 'comments.publish'));
  }
});

test('楼层计数与返回不一致，或原目标评论不存在时不重新发送', async t => {
  for (const replyPage of [
    { status_code: 0, comments: [], has_more: 0, total: 0 },
    { status_code: 0, comments: [{ cid: '40005', user: { uid: '30001' }, reply_id: '40000' }], has_more: 0, total: 1 },
    { status_code: 0, comments: [{ cid: '40001', user: { uid: '88888' }, reply_id: '40000' }], has_more: 0, total: 1 },
  ]) {
    const f = fixture(t, { replyPage });
    await assert.rejects(reserveManualResend({ ...f, jobKey: f.key }), { code: 'RESEND_UNVERIFIED' });
    assert.equal(f.store.get(f.key).status, 'succeeded');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM resend_history').get().n, 0);
    assert.ok(f.calls.every(command => command !== 'comments.publish'));
  }
});

test('中断后的手动待发送或生成中状态不会进入自动轮询，发送中恢复为 unknown', async t => {
  for (const phase of ['manual_pending', 'preparing', 'sending']) {
    const f = fixture(t);
    await reserveManualResend({ ...f, jobKey: f.key });
    if (phase !== 'manual_pending') f.store.claimManual(f.config.accountUid, f.config.videos, f.key);
    if (phase === 'sending') f.store.beginSend(f.key);
    f.store.recoverInFlight();
    assert.equal(f.store.get(f.key).status, phase === 'sending' ? 'unknown' : 'failed');
    assert.equal(f.store.claim(f.config.accountUid, f.config.videos).job_key, f.otherKey);
    assert.equal(f.store.claim(f.config.accountUid, f.config.videos), null);
  }
});

test('手动发送前失败或跳过后，可再次点击并重核原回执，不覆盖或重复归档', async t => {
  for (const status of ['failed', 'skipped']) {
    const f = fixture(t);
    await reserveManualResend({ ...f, jobKey: f.key });
    for (let n = 0; n < 2; n++) {
      f.store.claimManual(f.config.accountUid, f.config.videos, f.key);
      f.store.finish(f.key, status, { reason: '发送前停止' });
      const item = readActivity({ root: f.root, accountUid: f.config.accountUid, videos: f.config.videos }).items.find(x => x.jobKey === f.key);
      assert.equal(item.canResend, true);
      assert.throws(() => f.store.retryFailed(f.key, f.config.accountUid), /前端/);
      await reserveManualResend({ ...f, jobKey: f.key });
      assert.equal(f.store.get(f.key).status, 'manual_pending');
      const history = f.store.db.prepare('SELECT * FROM resend_history WHERE job_key=?').all(f.key);
      assert.equal(history.length, 1);
      assert.equal(JSON.parse(JSON.parse(history[0].prior_job_json).result_json).cid, '90001');
    }
    f.store.claimManual(f.config.accountUid, f.config.videos, f.key);
    f.store.beginSend(f.key);
    f.store.finish(f.key, 'unknown', { reason: '无法确认发送结果' });
    const uncertain = readActivity({ root: f.root, accountUid: f.config.accountUid, videos: f.config.videos }).items.find(x => x.jobKey === f.key);
    assert.equal(uncertain.canResend, false);
    await assert.rejects(reserveManualResend({ ...f, jobKey: f.key }), { code: 'RESEND_INELIGIBLE' });
  }
});

test('本人已有目标回复或关系未知的子回复时拒绝手动重发', async t => {
  for (const ownReply of [
    { cid: '50001', rootCid: '40000', authorUid: '10001', replyRelationKnown: true, replyToCid: '40001' },
    { cid: '50001', rootCid: '40000', authorUid: '10001', replyRelationKnown: false },
    { cid: '50001', rootCid: '40000', authorUid: '10001', replyRelationKnown: true, replyToCid: null },
  ]) {
    const f = fixture(t); await reserveManualResend({ ...f, jobKey: f.key });
    let generated = 0, published = 0;
    const adapter = { async readThread() { return { complete: true, target: f.comment, comments: [f.comment, ownReply] }; },
      async publishReply() { published++; } };
    const agent = { async reviewInput() { return { safe: true }; }, async reviewOutput() { return { safe: true }; },
      async generate() { generated++; return { text: '本鱼来啦' }; } };
    const worker = new Worker({ config: f.config, store: f.store, adapter, agent });
    const summary = await worker.runOnce({ onlyJobKey: f.key });
    assert.equal(summary.failed, 1); assert.equal(generated, 0); assert.equal(published, 0);
    assert.match(f.store.get(f.key).reason, /本人回复/);
  }
});

test('本人根评论及明确指向其他目标的本人子回复不会误判为目标回复', async t => {
  const f = fixture(t); await reserveManualResend({ ...f, jobKey: f.key });
  const root = { cid: '40000', authorUid: '10001' };
  const other = { cid: '50001', authorUid: '10001', replyRelationKnown: true, replyToCid: '40002' };
  let published = 0;
  const adapter = { async readThread() { return { complete: true, target: f.comment, comments: [root, f.comment, other] }; },
    async publishReply() { published++; return { cid: '90002', targetVerified: true, imageCount: 0 }; } };
  const agent = { async reviewInput() { return { safe: true }; }, async reviewOutput() { return { safe: true }; }, async generate() { return { text: '本鱼来啦' }; } };
  const worker = new Worker({ config: f.config, store: f.store, adapter, agent, sleep: async () => {} });
  assert.equal((await worker.runOnce({ onlyJobKey: f.key })).sent, 1);
  assert.equal(published, 1);
});
