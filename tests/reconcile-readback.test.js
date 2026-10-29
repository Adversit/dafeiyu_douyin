'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { createDeletionCheckService } = require('../src/services/deletion-check');
const { readActivity } = require('../src/web/activity');
const { eligibleResend, retryResendSource, reserveManualResend } = require('../src/services/resend');

function setup(t, { mode = 'present', receipt = {}, recallStatus = null, sticker = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-readback-'));
  const store = new Store(path.join(root, 'runtime/agent.sqlite'));
  const config = { accountUid: '10001', videos: ['20001'], douyin: { maxPages: 3, maxReplyPages: 3 } };
  const event = { videoId: '20001', cid: '40001', rootCid: '40001', authorUid: '30001', text: 'fixture' };
  const key = store.enqueue('10001', event, { eligible: true });
  store.db.prepare("UPDATE jobs SET status='preparing' WHERE job_key=?").run(key);
  store.prepare(key, { text: '鱼来啦', ...(sticker ? { stickerId: 'fake-sticker', stickerPath: '/fake.png' } : {}) });
  store.beginSend(key);
  const original = { cid: '90001', authorVerified: true, targetVerified: false, imageCount: 0, expectedImageCount: 0, imagesAttached: true,
    targetVerification: { aweme_id: 'missing', reply_id: 'matched', reply_to_reply_id: 'matched' }, ...receipt };
  store.finish(key, 'unknown', { reason: '发布回执不完整', result: original });
  if (recallStatus) {
    store.db.exec('CREATE TABLE recalls(job_key TEXT PRIMARY KEY,status TEXT)');
    store.db.prepare('INSERT INTO recalls VALUES (?,?)').run(key, recallStatus);
  }
  const calls = [];
  const bridge = { async call(command) {
    calls.push(command);
    if (command === 'identity.get') return { uid: '10001' };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { aweme_id: '20001', author: { uid: '10001' } } };
    if (command === 'comments.list') return { status_code: 0, comments: [{ cid: '40001', user: { uid: '30001' }, reply_comment_total: mode === 'absent' ? 0 : 1 }], has_more: 0 };
    if (command === 'comments.replies') return mode === 'absent'
      ? { status_code: 0, comments: null, total: 0, has_more: 0, _bridge_reply_query: 'item_id-v1' }
      : mode === 'incomplete' ? { status_code: 0, comments: [], total: 1, has_more: 0, _bridge_reply_query: 'item_id-v1' }
      : { status_code: 0, comments: [{ cid: '90001', user: { uid: mode === 'mismatch' ? '99999' : '10001' }, reply_id: '40001', reply_to_reply_id: '0' }], total: 1, has_more: 0, _bridge_reply_query: 'item_id-v1' };
    throw Error('unexpected command');
  } };
  const service = createDeletionCheckService({ root, bridge, getConfig: () => config });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, config, key, original, calls, bridge, service, setMode(value) { mode = value; } };
}

test('完整只读回读后将待核查更新为已发送，保留原回执和先前原因及去重', async t => {
  const f = setup(t);
  const before = f.store.get(f.key);
  const result = await f.service.check(f.key);
  const after = f.store.get(f.key);
  assert.equal(result.status, 'present'); assert.equal(result.promoted, true);
  assert.equal(after.status, 'succeeded'); assert.equal(after.result_json, before.result_json);
  assert.match(after.reason, /只读核查/);
  const evidence = f.store.db.prepare('SELECT * FROM reply_verifications WHERE job_key=?').get(f.key);
  assert.equal(evidence.method, 'readback'); assert.equal(evidence.prior_reason, '发布回执不完整');
  assert.equal(f.store.claim('10001', ['20001']), null);
  const activity = readActivity({ root: f.root, accountUid: '10001', videos: f.config.videos }).items[0];
  assert.equal(activity.status, 'succeeded'); assert.equal(activity.verificationSource, 'readback');
  assert.equal(activity.verificationCheckedAt, result.checkedAt); assert.equal(activity.checkStatus, 'present');
  assert.deepEqual(activity.result.targetVerification, f.original.targetVerification);
  assert.equal(activity.canResend, true);
  assert.ok(f.calls.every(c => ['identity.get', 'video.get', 'comments.list', 'comments.replies'].includes(c)));
  const second = await f.service.check(f.key); assert.equal(second.promoted, false);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reply_verifications').get().n, 1);
});

test('缺席、不匹配、图片未确认及撤回存在不确定时不能提升发送状态', async t => {
  for (const options of [{ mode: 'absent' }, { mode: 'mismatch' }, { sticker: true },
    { receipt: { imagesAttached: false, imageCount: 0, expectedImageCount: 1 }, sticker: true },
    { receipt: { expectedImageCount: undefined } }, { recallStatus: 'unknown' }, { recallStatus: 'confirmed' }]) {
    const f = setup(t, options);
    const before = f.store.get(f.key);
    const result = await f.service.check(f.key);
    assert.equal(result.promoted, false);
    assert.equal(f.store.get(f.key).status, 'unknown');
    assert.equal(f.store.get(f.key).result_json, before.result_json);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reply_verifications').get().n, 0);
  }
});

test('只读确认后的旧回执可以安全重新发送并保留核查证据历史', async t => {
  const f = setup(t); await f.service.check(f.key);
  const row = f.store.get(f.key);
  const verification = f.store.db.prepare('SELECT * FROM reply_verifications WHERE job_key=?').get(f.key);
  assert.ok(eligibleResend(row, f.config, null, verification));
  f.store.prepareManualResend(f.key, '90001', 'succeeded');
  const history = f.store.db.prepare('SELECT * FROM resend_history WHERE job_key=?').get(f.key);
  assert.equal(JSON.parse(history.prior_verification_json).method, 'readback');
  f.store.failUnclaimedManual(f.key);
  assert.ok(retryResendSource(f.store.get(f.key), f.config, history));
});

test('记录变化后旧的只读核验证据不可用于展示或授权重发', async t => {
  const f = setup(t); await f.service.check(f.key);
  const evidence = f.store.db.prepare('SELECT * FROM reply_verifications WHERE job_key=?').get(f.key);
  f.store.db.prepare('UPDATE jobs SET result_json=? WHERE job_key=?').run(JSON.stringify({ ...f.original, cid: '90002' }), f.key);
  const row = f.store.get(f.key);
  assert.equal(eligibleResend(row, f.config, null, evidence), null);
  assert.equal(readActivity({ root: f.root, accountUid: '10001', videos: f.config.videos }).items[0].verificationSource, null);
});

test('已确认的图片回执及楼层才能提升；缺少素材记录或图片回执不行', async t => {
  for (const [sticker, receipt, expected] of [
    [true, { imageCount: 1, expectedImageCount: 1, imagesAttached: true }, true],
    [false, { imageCount: 1, expectedImageCount: 1, imagesAttached: true }, false],
    [true, { imageCount: 0, expectedImageCount: 1, imagesAttached: false }, false],
  ]) {
    const f = setup(t, { sticker, receipt });
    assert.equal((await f.service.check(f.key)).promoted, expected);
    assert.equal(f.store.get(f.key).status, expected ? 'succeeded' : 'unknown');
  }
});

test('只读确认后重发仍重新核查原回复：仍可见不重发，消失才保留历史并准备', async t => {
  const f = setup(t); await f.service.check(f.key);
  await assert.rejects(reserveManualResend({ root: f.root, config: f.config, bridge: f.bridge, jobKey: f.key }), { code: 'RESEND_UNVERIFIED' });
  assert.equal(f.store.get(f.key).status, 'succeeded');
  f.setMode('incomplete');
  await assert.rejects(reserveManualResend({ root: f.root, config: f.config, bridge: f.bridge, jobKey: f.key }), { code: 'RESEND_UNVERIFIED' });
  assert.equal(f.store.get(f.key).status, 'succeeded');
  f.setMode('absent');
  await reserveManualResend({ root: f.root, config: f.config, bridge: f.bridge, jobKey: f.key });
  assert.equal(f.store.get(f.key).status, 'manual_pending');
  const history = f.store.db.prepare('SELECT * FROM resend_history WHERE job_key=?').get(f.key);
  assert.equal(JSON.parse(history.prior_verification_json).method, 'readback');
  assert.equal(f.store.claim('10001', ['20001']), null);
});
