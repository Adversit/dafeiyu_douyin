'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../store');
const { eligibleRecord } = require('./recall');
const { inspectReply } = require('./reply-observation');
const { matchingVerification } = require('./deletion-check');
const { problem } = require('../web/config-service');

function eligibleResend(row, config, recall = null, verification = null) {
  const args = eligibleRecord(row, config);
  if (!args) return null;
  let result;
  try { result = JSON.parse(row.result_json); } catch { return null; }
  if (row.status === 'succeeded' && (result?.targetVerified === true || matchingVerification(row, verification))) return args;
  // Some platform receipts omit only aweme_id. The author and both target
  // fields must match, and a fresh complete readback is still required. This
  // assumes the platform's comment/parent ID semantics and a stable snapshot.
  const recallConsistent = !recall || (recall.status !== 'requesting' &&
      recall.account_uid === args.accountUid && recall.video_id === args.videoId &&
      recall.root_cid === args.rootCid && recall.comment_cid === args.commentCid);
  if (row.status === 'unknown' && recallConsistent &&
      result?.authorVerified === true && result?.targetVerification?.aweme_id === 'missing' &&
      result?.targetVerification?.reply_id === 'matched' &&
      result?.targetVerification?.reply_to_reply_id === 'matched') return args;
  return null;
}

// Failed/skipped manual attempts never crossed a confirmed send boundary.
// Reuse the original archived receipt, never an empty retry row, and repeat
// all identity/absence checks before every new manual attempt.
function retryResendSource(row, config, history, currentRecall = null) {
  if (!row || row.manual_only !== 1 || !['failed', 'skipped'].includes(row.status) || currentRecall || !history || history.job_key !== row.job_key) return null;
  let prior, priorRecall, priorVerification, currentEvent, priorEvent;
  try {
    prior = JSON.parse(history.prior_job_json);
    priorRecall = history.prior_recall_json ? JSON.parse(history.prior_recall_json) : null;
    priorVerification = history.prior_verification_json ? JSON.parse(history.prior_verification_json) : null;
    currentEvent = JSON.parse(row.event_json);
    priorEvent = JSON.parse(prior.event_json);
  } catch { return null; }
  if (!prior || prior.job_key !== row.job_key || prior.account_uid !== row.account_uid ||
      prior.video_id !== row.video_id || prior.target_cid !== row.target_cid ||
      (currentEvent?.rootCid || currentEvent?.cid) !== (priorEvent?.rootCid || priorEvent?.cid) ||
      currentEvent?.authorUid !== priorEvent?.authorUid) return null;
  const args = eligibleResend(prior, config, priorRecall, priorVerification);
  return args ? { args, historyId: history.id } : null;
}

// Called only while the runtime owns worker.lock. The network calls are reads;
// the job is not reopened until the complete current thread proves absence.
async function reserveManualResend({ root, config, bridge, jobKey }) {
  if (typeof jobKey !== 'string' || !jobKey || jobKey.length > 256) throw problem(400, '处理记录标识无效', 'RESEND_INVALID');
  const filename = path.join(root, 'runtime/agent.sqlite');
  if (!fs.existsSync(filename)) throw problem(404, '没有可重新发送的记录', 'RESEND_NOT_FOUND');
  const store = new Store(filename);
  try {
    const row = store.get(jobKey);
    const recallsExist = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recalls'").get();
    const recall = recallsExist ? store.db.prepare('SELECT * FROM recalls WHERE job_key=?').get(jobKey) : null;
    const verificationsExist = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reply_verifications'").get();
    const verification = verificationsExist ? store.db.prepare('SELECT * FROM reply_verifications WHERE job_key=?').get(jobKey) : null;
    const direct = eligibleResend(row, config, recall, verification);
    const history = direct ? null : store.db.prepare('SELECT * FROM resend_history WHERE job_key=? ORDER BY id DESC LIMIT 1').get(jobKey);
    const retry = direct ? null : retryResendSource(row, config, history, recall);
    const args = direct || retry?.args;
    if (!args) throw problem(400, '原回复缺少已确认的目标或回执，不能重新发送', 'RESEND_INELIGIBLE');
    try {
      if (await inspectReply(bridge, row, args, config) !== 'absent') throw new Error('回复仍可见');
    } catch {
      throw problem(409, '无法确认原回复已从目标楼层撤回，请先在抖音核查', 'RESEND_UNVERIFIED');
    }
    if (retry) store.prepareManualRetry(jobKey, row.status, row.updated_at, retry.historyId);
    else store.prepareManualResend(jobKey, args.commentCid, row.status);
  } finally { store.close(); }
}

module.exports = { eligibleResend, retryResendSource, reserveManualResend };
