'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { problem } = require('./config-service');
const { eligibleRecord } = require('../services/recall');
const { eligibleResend, retryResendSource } = require('../services/resend');
const { matchingCheck, matchingVerification } = require('../services/deletion-check');
const STATUSES = ['pending', 'preparing', 'sending', 'succeeded', 'failed', 'skipped', 'unknown'];
const parse = (text, fallback = null) => { try { return JSON.parse(text); } catch { return fallback; } };
const escapeLike = value => value.replace(/[\\%_]/g, '\\$&');
function readActivity({ root, accountUid, videos = [], limit = 50, before, query = '', status = '', logger } = {}) {
  limit = Number(limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw problem(400, '记录条数必须在 1–100 之间', 'QUERY_INVALID');
  if (typeof query !== 'string' || query.length > 240 || typeof status !== 'string' || (status && !STATUSES.includes(status))) throw problem(400, '记录筛选条件无效', 'QUERY_INVALID');
  const filename = path.join(root, 'runtime/agent.sqlite');
  if (!accountUid || !fs.existsSync(filename)) return { items: [], nextCursor: null };
  let cursor;
  if (before) {
    try { cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8')); } catch { throw problem(400, '记录游标无效', 'QUERY_INVALID'); }
    if (!Number.isSafeInteger(cursor.ts) || cursor.ts < 0 || typeof cursor.key !== 'string' || cursor.key.length > 256) throw problem(400, '记录游标无效', 'QUERY_INVALID');
  }
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get()) return { items: [], nextCursor: null };
    const clauses = ['account_uid = ?'];
    const args = [accountUid];
    if (status) { clauses.push('status = ?'); args.push(status); }
    if (cursor) { clauses.push('(updated_at < ? OR (updated_at = ? AND job_key < ?))'); args.push(cursor.ts, cursor.ts, cursor.key); }
    if (query) { clauses.push("(json_extract(event_json, '$.text') LIKE ? ESCAPE '\\' OR COALESCE(text,'') LIKE ? ESCAPE '\\' OR COALESCE(reason,'') LIKE ? ESCAPE '\\')"); args.push(...Array(3).fill(`%${escapeLike(query)}%`)); }
    const manualColumn = db.prepare('PRAGMA table_info(jobs)').all().some(c => c.name === 'manual_only') ? 'manual_only' : '0 AS manual_only';
    const rows = db.prepare(`SELECT job_key,account_uid,video_id,target_cid,event_json,trigger_json,status,text,result_json,reason,created_at,updated_at,${manualColumn} FROM jobs WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC,job_key DESC LIMIT ?`).all(...args, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const logs = logger?.list({ limit: 10000 })?.items || [];
    const hasRecalls = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recalls'").get();
    const getRecall = hasRecalls ? db.prepare('SELECT * FROM recalls WHERE job_key=?') : null;
    const hasHistory = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='resend_history'").get();
    const getHistory = hasHistory ? db.prepare('SELECT * FROM resend_history WHERE job_key=? ORDER BY id DESC LIMIT 1') : null;
    const hasChecks = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reply_checks'").get();
    const getCheck = hasChecks ? db.prepare('SELECT * FROM reply_checks WHERE job_key=?') : null;
    const hasVerifications = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reply_verifications'").get();
    const getVerification = hasVerifications ? db.prepare('SELECT * FROM reply_verifications WHERE job_key=?') : null;
    const items = page.map(row => {
      const event = parse(row.event_json, {});
      const trigger = parse(row.trigger_json, {});
      const result = parse(row.result_json);
      const safeResult = result && typeof result === 'object' ? Object.fromEntries(
        ['cid', 'imageCount', 'expectedImageCount', 'imagesAttached', 'targetVerified', 'targetVerification', 'authorVerified', 'warnings', 'warning', 'source', 'targetCid'].filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]])) : null;
      const recall = getRecall?.get(row.job_key);
      const args = eligibleRecord(row, { accountUid, videos });
      const candidateCheck = getCheck?.get(row.job_key);
      const check = matchingCheck(row, args, candidateCheck) ? candidateCheck : null;
      const candidateVerification = getVerification?.get(row.job_key);
      const verification = matchingVerification(row, candidateVerification) ? candidateVerification : null;
      return { jobKey: row.job_key, videoId: row.video_id, targetCid: row.target_cid,
        commentText: typeof event.text === 'string' ? event.text : '', replyText: row.text || '', status: row.status,
        reason: row.reason, triggerKinds: Array.isArray(trigger.kinds) ? trigger.kinds : [], result: safeResult,
        recallStatus: recall?.status || null, recallReason: recall?.reason || null,
        canCheck: Boolean(args), checkStatus: check?.status || null, checkReason: check?.reason || null, checkAt: check?.checked_at || null,
        verificationSource: verification?.method || null, verificationCheckedAt: verification?.checked_at || null,
        canRecall: Boolean(eligibleRecord(row, { accountUid, videos }) && (!recall || recall.status === 'failed')),
        canResend: Boolean(eligibleResend(row, { accountUid, videos }, recall, verification) || retryResendSource(row, { accountUid, videos }, getHistory?.get(row.job_key), recall)),
        createdAt: row.created_at, updatedAt: row.updated_at,
        hasDetailedLogs: logs.some(item => item.videoId === row.video_id && item.targetCid === row.target_cid) };
    });
    const last = page[page.length - 1];
    return { items, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ ts: last.updated_at, key: last.job_key })).toString('base64url') : null };
  } finally { db.close(); }
}

module.exports = { readActivity };
