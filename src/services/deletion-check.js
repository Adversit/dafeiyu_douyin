'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { acquireLock } = require('../lock');
const { eligibleRecord } = require('./recall');
const { inspectReply } = require('./reply-observation');
const { problem } = require('../web/config-service');

const schema = `CREATE TABLE IF NOT EXISTS reply_checks (
  job_key TEXT PRIMARY KEY, account_uid TEXT NOT NULL, video_id TEXT NOT NULL,
  root_cid TEXT NOT NULL, target_cid TEXT NOT NULL, comment_cid TEXT NOT NULL,
  target_author_uid TEXT, source_fingerprint TEXT,
  status TEXT NOT NULL, reason TEXT NOT NULL, checked_at INTEGER NOT NULL
)`;
const verificationSchema = `CREATE TABLE IF NOT EXISTS reply_verifications (
  job_key TEXT PRIMARY KEY, source_fingerprint TEXT NOT NULL,
  method TEXT NOT NULL, checked_at INTEGER NOT NULL, prior_reason TEXT
)`;
const reasons = {
  present: '当前在目标楼层找到该回复；这是一次只读快照。',
  absent: '当前目标楼层未找到该回复；可能已删除、隐藏或存在平台延迟，不能作为删除证明。',
  inconclusive: '本次无法完整核验目标楼层，请稍后重试；不会自动发送。',
};

const sourceFingerprint = row => crypto.createHash('sha256').update(JSON.stringify([row.status, row.updated_at, row.event_json, row.result_json])).digest('hex');
function matchingCheck(row, args, check) {
  let author;
  try { author = JSON.parse(row.event_json).authorUid; } catch { return false; }
  return Boolean(check && args && check.job_key === row.job_key && check.account_uid === args.accountUid &&
    check.video_id === args.videoId && check.root_cid === args.rootCid && check.target_cid === row.target_cid && check.comment_cid === args.commentCid &&
    check.target_author_uid === author && check.source_fingerprint === sourceFingerprint(row) &&
    ['present', 'absent', 'inconclusive'].includes(check.status));
}

function matchingVerification(row, verification) {
  return Boolean(row?.status === 'succeeded' && verification?.job_key === row.job_key &&
    verification.method === 'readback' && verification.source_fingerprint === sourceFingerprint(row));
}

// A confirmed text location is not evidence that an attached image was sent.
// Existing receipts record these counts before the write outcome is classified.
function imagesConfirmed(row) {
  let result;
  try { result = JSON.parse(row.result_json); } catch { return false; }
  if (!Number.isInteger(result?.expectedImageCount) || result.expectedImageCount < 0 ||
      result.imageCount !== result.expectedImageCount || result.imagesAttached !== true) return false;
  if (result.expectedImageCount === 0) return !row.sticker_id && !row.sticker_path;
  return Boolean(row.sticker_id && row.sticker_path);
}


function createDeletionCheckService({ root, bridge, getConfig, isBusy = () => false, log = () => {} }) {
  const filename = path.join(root, 'runtime/agent.sqlite');
  const lockFile = path.join(root, 'runtime/worker.lock');
  function open() {
    const db = new Database(filename, { fileMustExist: true }); db.pragma('busy_timeout = 5000'); db.exec(schema); db.exec(verificationSchema);
    const columns = db.prepare('PRAGMA table_info(reply_checks)').all().map(c => c.name);
    if (!columns.includes('target_author_uid')) db.exec('ALTER TABLE reply_checks ADD COLUMN target_author_uid TEXT');
    if (!columns.includes('source_fingerprint')) db.exec('ALTER TABLE reply_checks ADD COLUMN source_fingerprint TEXT');
    return db;
  }
  async function checkLocked(db, row, config, signal, currentBridge = bridge) {
    const args = eligibleRecord(row, config);
    if (!args) throw problem(400, '该记录没有可核查的发送回执，或账号作品配置不匹配', 'CHECK_INELIGIBLE');
    let status;
    try { status = await inspectReply(currentBridge, row, args, config, signal); }
    catch (error) { if (signal?.aborted) throw error; status = 'inconclusive'; }
    signal?.throwIfAborted();
    const checkedAt = Date.now();
    let promoted = false;
    db.transaction(() => {
      let current = db.prepare('SELECT * FROM jobs WHERE job_key=?').get(row.job_key);
      if (!current || current.account_uid !== row.account_uid || current.video_id !== row.video_id || current.target_cid !== row.target_cid ||
        current.status !== row.status || current.event_json !== row.event_json || current.result_json !== row.result_json || current.updated_at !== row.updated_at) {
        throw problem(409, '处理记录已变化，请刷新后重新核查', 'CHECK_STALE');
      }
      const hasRecalls = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recalls'").get();
      const recall = hasRecalls ? db.prepare('SELECT status FROM recalls WHERE job_key=?').get(row.job_key) : null;
      if (status === 'present' && current.status === 'unknown' && imagesConfirmed(current) && (!recall || recall.status === 'failed')) {
        const priorReason = current.reason;
        const updated = db.prepare("UPDATE jobs SET status='succeeded',reason=?,updated_at=? WHERE job_key=? AND status='unknown'")
          .run('只读核查确认发送和目标楼层；原始发布回执不完整', checkedAt, row.job_key);
        if (updated.changes !== 1) throw problem(409, '处理记录已变化，请刷新后重新核查', 'CHECK_STALE');
        current = db.prepare('SELECT * FROM jobs WHERE job_key=?').get(row.job_key);
        db.prepare(`INSERT INTO reply_verifications(job_key,source_fingerprint,method,checked_at,prior_reason)
          VALUES (?,?,'readback',?,?) ON CONFLICT(job_key) DO UPDATE SET source_fingerprint=excluded.source_fingerprint,
          method=excluded.method,checked_at=excluded.checked_at,prior_reason=excluded.prior_reason`)
          .run(row.job_key, sourceFingerprint(current), checkedAt, priorReason);
        promoted = true;
      }
      db.prepare(`INSERT INTO reply_checks(job_key,account_uid,video_id,root_cid,target_cid,comment_cid,target_author_uid,source_fingerprint,status,reason,checked_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_key) DO UPDATE SET account_uid=excluded.account_uid,video_id=excluded.video_id,
        root_cid=excluded.root_cid,target_cid=excluded.target_cid,comment_cid=excluded.comment_cid,
        target_author_uid=excluded.target_author_uid,source_fingerprint=excluded.source_fingerprint,
        status=excluded.status,reason=excluded.reason,checked_at=excluded.checked_at`).run(row.job_key, args.accountUid, args.videoId,
        args.rootCid, row.target_cid, args.commentCid, JSON.parse(current.event_json).authorUid, sourceFingerprint(current), status, reasons[status], checkedAt);
    })();
    log({ level: status === 'inconclusive' ? 'warn' : 'info', event: 'reply_check.completed', stage: 'check', message: reasons[status] });
    return { status, reason: reasons[status], checkedAt, promoted };
  }
  async function check(jobKey) {
    if (typeof jobKey !== 'string' || !jobKey || jobKey.length > 256) throw problem(400, '处理记录标识无效', 'CHECK_INVALID');
    if (isBusy()) throw problem(409, '请先停止轮询，再手动核查', 'RUNTIME_BUSY');
    let release;
    try { release = acquireLock(lockFile); } catch { throw problem(409, '请先停止轮询或其他任务，再手动核查', 'RUNTIME_BUSY'); }
    let db;
    try {
      if (!fs.existsSync(filename)) throw problem(404, '没有可核查的处理记录', 'CHECK_NOT_FOUND');
      db = open();
      return await checkLocked(db, db.prepare('SELECT * FROM jobs WHERE job_key=?').get(jobKey), getConfig());
    } finally { db?.close(); release(); }
  }
  // Caller owns worker.lock; do not reacquire it and do not send or alter jobs.
  async function checkBatchWhileLocked(config, { signal, limit = 3, now = Date.now(), budgetMs = 15000, requestTimeoutMs = 5000 } = {}) {
    if (!fs.existsSync(filename) || !config.accountUid || !config.videos.length) return { checked: 0 };
    const db = open();
    try {
      const rows = db.prepare(`SELECT j.*,c.checked_at AS prior_checked_at,c.source_fingerprint AS prior_fingerprint FROM jobs j LEFT JOIN reply_checks c ON c.job_key=j.job_key
        AND c.account_uid=j.account_uid AND c.video_id=j.video_id AND c.target_cid=j.target_cid
        AND c.comment_cid=CASE WHEN json_valid(j.result_json) THEN json_extract(j.result_json,'$.cid') END
        WHERE j.account_uid=? AND j.status IN ('succeeded','unknown') AND json_valid(j.result_json)
        AND j.updated_at<=?
        AND j.video_id IN (${config.videos.map(() => '?').join(',')})
        ORDER BY c.checked_at IS NOT NULL, c.checked_at, j.created_at, j.job_key`).iterate(config.accountUid, now - 60000, ...config.videos);
      const candidates = [];
      for (const row of rows) {
        if (row.prior_fingerprint === sourceFingerprint(row) && row.prior_checked_at > now - 300000) continue;
        if (eligibleRecord(row, config)) candidates.push(row);
        if (candidates.length >= limit) break;
      }
      const deadline = Date.now() + budgetMs;
      const budgetBridge = { call(command, args) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return Promise.reject(new Error('本轮只读核查超时'));
        return new Promise((resolve, reject) => {
          let done = false;
          const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); fn(value); };
          const aborted = () => finish(reject, signal.reason || Object.assign(new Error('已停止'), { name: 'AbortError' }));
          const timer = setTimeout(() => finish(reject, new Error('本轮只读核查超时')), Math.min(remaining, requestTimeoutMs));
          if (signal?.aborted) return aborted();
          signal?.addEventListener('abort', aborted, { once: true });
          Promise.resolve().then(() => bridge.call(command, args)).then(value => finish(resolve, value), error => finish(reject, error));
        });
      } };
      let checked = 0;
      for (const row of candidates) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) break;
        await checkLocked(db, row, config, signal, budgetBridge);
        checked++;
      }
      return { checked };
    } finally { db.close(); }
  }
  return { check, checkBatchWhileLocked };
}

module.exports = { createDeletionCheckService, matchingCheck, matchingVerification };
