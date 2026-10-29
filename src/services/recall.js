'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { acquireLock } = require('../lock');
const { validateCommand } = require('../bridge/protocol');
const { inspectReply } = require('./reply-observation');
const { problem } = require('../web/config-service');

const schema = `CREATE TABLE IF NOT EXISTS recalls (
  job_key TEXT PRIMARY KEY, account_uid TEXT NOT NULL, video_id TEXT NOT NULL,
  root_cid TEXT NOT NULL, comment_cid TEXT NOT NULL, status TEXT NOT NULL,
  reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`;
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

// Only the local send ledger can select a target. The browser checks identity,
// video ownership and actual comment author again before the delete request.
function eligibleRecord(row, config) {
  if (!row || !['succeeded', 'unknown'].includes(row.status) || row.account_uid !== config.accountUid || !config.videos.includes(row.video_id)) return null;
  const event = parse(row.event_json), result = parse(row.result_json);
  if (!event || !result || result.source === 'platform-history' || event.videoId !== row.video_id || event.cid !== row.target_cid) return null;
  const args = { accountUid: row.account_uid, videoId: row.video_id, rootCid: event.rootCid || event.cid, commentCid: result.cid };
  try { validateCommand('comments.delete', args); } catch { return null; }
  return args;
}

// A failed or incomplete observation must never confirm a deletion.
async function verifyAbsent(bridge, args, maxPages, maxReplyPages = maxPages, row) {
  if (!row) throw new Error('缺少目标评论记录，无法确认楼层');
  const status = await inspectReply(bridge, row, args, { douyin: { maxPages, maxReplyPages } });
  if (status !== 'absent') throw new Error('撤回后仍可见该回复');
}

function createRecallService({ root, bridge, getConfig, isBusy = () => false, log = () => {} }) {
  const filename = path.join(root, 'runtime/agent.sqlite');
  const lockFile = path.join(root, 'runtime/worker.lock');
  function recoverPending() {
    if (!fs.existsSync(filename) || isBusy()) return;
    let release;
    try { release = acquireLock(lockFile); } catch { return; }
    let db;
    try {
      db = new Database(filename, { fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recalls'").get()) {
        db.prepare("UPDATE recalls SET status='unknown',reason='撤回过程中服务退出，请到抖音核查',updated_at=? WHERE status='requesting'").run(Date.now());
      }
    } finally { db?.close(); release(); }
  }
  async function recall(jobKey) {
    if (typeof jobKey !== 'string' || jobKey.length < 1 || jobKey.length > 256) throw problem(400, '处理记录标识无效', 'RECALL_INVALID');
    if (isBusy()) throw problem(409, '请先停止轮询，再撤回回复', 'RUNTIME_BUSY');
    let release;
    try { release = acquireLock(lockFile); } catch { throw problem(409, '请先停止轮询或其他任务，再撤回回复', 'RUNTIME_BUSY'); }
    let db;
    try {
      if (!fs.existsSync(filename)) throw problem(404, '没有可撤回的发送记录', 'RECALL_NOT_FOUND');
      db = new Database(filename, { fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      db.exec(schema);
      // Holding the shared worker lock proves no prior recall is still running.
      db.prepare("UPDATE recalls SET status='unknown',reason='撤回过程中服务退出，请到抖音核查',updated_at=? WHERE status='requesting'").run(Date.now());
      const row = db.prepare('SELECT * FROM jobs WHERE job_key=?').get(jobKey);
      const config = getConfig();
      const args = eligibleRecord(row, config);
      if (!args) throw problem(400, '该记录不满足撤回条件，请确认账号、作品和发送回执', 'RECALL_INELIGIBLE');
      const existing = db.prepare('SELECT status FROM recalls WHERE job_key=?').get(jobKey);
      if (existing && existing.status !== 'failed') throw problem(409, '该回复已撤回或结果待核查，请勿重复撤回', 'RECALL_ALREADY_ATTEMPTED');
      const now = Date.now();
      db.prepare(`INSERT INTO recalls(job_key,account_uid,video_id,root_cid,comment_cid,status,reason,created_at,updated_at)
        VALUES (?,?,?,?,?,'requesting',NULL,?,?) ON CONFLICT(job_key) DO UPDATE SET
        account_uid=excluded.account_uid,video_id=excluded.video_id,root_cid=excluded.root_cid,
        comment_cid=excluded.comment_cid,status='requesting',reason=NULL,updated_at=excluded.updated_at`)
        .run(jobKey, args.accountUid, args.videoId, args.rootCid, args.commentCid, now, now);
      let deleteReturned = false;
      let status, reason;
      try {
        const response = await bridge.call('comments.delete', args);
        deleteReturned = true;
        if (!response || response.status_code !== 0) throw new Error('撤回接口未返回明确成功');
        await verifyAbsent(bridge, args, config.douyin?.maxPages || 50, config.douyin?.maxReplyPages || 50, row);
        status = 'confirmed'; reason = '平台返回成功，完整楼层回读未发现该回复';
      } catch (error) {
        status = !deleteReturned && error.definitelyNotSent === true ? 'failed' : 'unknown';
        reason = status === 'failed' ? '撤回请求尚未发送，请检查连接后手动重试' : '撤回结果未确认，请到抖音核查；不要重复撤回';
      }
      db.prepare('UPDATE recalls SET status=?,reason=?,updated_at=? WHERE job_key=?').run(status, reason, Date.now(), jobKey);
      log({ level: status === 'confirmed' ? 'info' : 'warn', event: `recall.${status}`, stage: 'recall', message: reason,
        videoId: args.videoId, targetCid: row.target_cid, data: { jobKey, commentCid: args.commentCid } });
      return { status, reason };
    } finally { db?.close(); release(); }
  }
  return { recall, recoverPending };
}

module.exports = { createRecallService, eligibleRecord, verifyAbsent };
