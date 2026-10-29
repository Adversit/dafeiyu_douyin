'use strict';
// WAL, busy_timeout and transaction patterns adapted from douyin-cli/lib/memory/db.js
// MIT, Yht20927, commit 4073159bea585de6d33a4747a475669440737932; see licenses/.
// Tables here describe this project's approved task lifecycle, not upstream schema.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const keyFor = c => `${c.accountUid}:${c.videoId}:${c.cid}`;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function eventFingerprint(comment, trigger) {
  const { cid, videoId, authorUid, text, rootCid, replyToCid, replyToUid, mentionUids, replyRelationKnown, mentionsKnown } = comment;
  return fingerprint({ cid, videoId, authorUid, text, rootCid, replyToCid, replyToUid, mentionUids, replyRelationKnown, mentionsKnown, trigger });
}

class Store {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        account_uid TEXT NOT NULL, video_id TEXT NOT NULL, cid TEXT NOT NULL,
        author_uid TEXT NOT NULL, event_json TEXT NOT NULL, seen_at INTEGER NOT NULL,
        PRIMARY KEY (account_uid, video_id, cid)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        job_key TEXT PRIMARY KEY, account_uid TEXT NOT NULL, video_id TEXT NOT NULL,
        target_cid TEXT NOT NULL, event_json TEXT NOT NULL, event_hash TEXT NOT NULL,
        trigger_json TEXT NOT NULL, status TEXT NOT NULL,
        text TEXT, sticker_id TEXT, sticker_path TEXT, result_json TEXT,
        reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(account_uid, video_id, target_cid)
      );
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(account_uid, status, created_at);
      CREATE TABLE IF NOT EXISTS scans (
        account_uid TEXT NOT NULL, video_id TEXT NOT NULL, complete INTEGER NOT NULL,
        warnings_json TEXT NOT NULL, scanned_at INTEGER NOT NULL,
        PRIMARY KEY(account_uid, video_id)
      );
      PRAGMA user_version = 1;
    `);
    if (!this.db.prepare('PRAGMA table_info(scans)').all().some(c => c.name === 'continuation_json')) {
      this.db.exec('ALTER TABLE scans ADD COLUMN continuation_json TEXT');
    }
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(c => c.name === 'manual_only')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN manual_only INTEGER NOT NULL DEFAULT 0');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS resend_history (
      id INTEGER PRIMARY KEY, job_key TEXT NOT NULL, prior_job_json TEXT NOT NULL,
      prior_recall_json TEXT, archived_at INTEGER NOT NULL
    )`);
    if (!this.db.prepare('PRAGMA table_info(resend_history)').all().some(c => c.name === 'prior_verification_json')) {
      this.db.exec('ALTER TABLE resend_history ADD COLUMN prior_verification_json TEXT');
    }
    this.db.pragma('user_version = 2');
    if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
  }

  saveComments(accountUid, comments) {
    const stmt = this.db.prepare(`INSERT INTO comments VALUES (@accountUid,@videoId,@cid,@authorUid,@event,@now)
      ON CONFLICT(account_uid,video_id,cid) DO UPDATE SET author_uid=excluded.author_uid,event_json=excluded.event_json,seen_at=excluded.seen_at`);
    this.db.transaction(() => {
      for (const c of comments) stmt.run({ accountUid, videoId: c.videoId, cid: c.cid, authorUid: c.authorUid || '', event: JSON.stringify(c), now: Date.now() });
    })();
  }

  ownCommentIds(accountUid, videoId) {
    return new Set(this.db.prepare('SELECT cid FROM comments WHERE account_uid=? AND video_id=? AND author_uid=?').all(accountUid, videoId, accountUid).map(c => c.cid));
  }

  getComment(accountUid, videoId, cid) {
    const row = this.db.prepare('SELECT event_json FROM comments WHERE account_uid=? AND video_id=? AND cid=?').get(accountUid, videoId, cid);
    return row ? JSON.parse(row.event_json) : null;
  }

  thread(accountUid, comment, limit = 12) {
    const seen = new Set([comment.cid]);
    const ancestors = [];
    let current = comment;
    // An ordered direct-parent chain is context; unrelated recent siblings are not.
    // Root membership alone never proves a direct reply or its addressee.
    while (current.replyRelationKnown === true && current.replyToCid && !seen.has(current.replyToCid) && ancestors.length < 100) {
      seen.add(current.replyToCid);
      const parent = this.getComment(accountUid, comment.videoId, current.replyToCid);
      if (!parent) break;
      ancestors.push(parent);
      current = parent;
    }
    let rows = ancestors.reverse();
    const rootCid = comment.rootCid || comment.cid;
    if (!seen.has(rootCid)) {
      const root = this.getComment(accountUid, comment.videoId, rootCid);
      if (root) rows.unshift(root);
    }
    const bound = Number.isInteger(limit) ? Math.max(2, Math.min(limit, 100)) : 12;
    if (rows.length > bound) rows = [rows[0], ...rows.slice(-(bound - 1))];
    return rows.map(c => ({ cid: c.cid, authorUid: c.authorUid, isOwn: c.authorUid === accountUid, text: c.text,
      replyToCid: c.replyToCid || null, replyToUid: c.replyToUid || null, replyRelationKnown: c.replyRelationKnown === true }));
  }

  primeReplies(accountUid, comments, { inboundSchemaConfirmed = false } = {}) {
    if (inboundSchemaConfirmed !== true) return 0;
    const insert = this.db.prepare(`INSERT INTO jobs(job_key,account_uid,video_id,target_cid,event_json,event_hash,trigger_json,
      status,text,result_json,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'succeeded',?,?,?,?,?)
      ON CONFLICT(job_key) DO UPDATE SET event_json=excluded.event_json,event_hash=excluded.event_hash,
        trigger_json=excluded.trigger_json,status='succeeded',text=excluded.text,sticker_id=NULL,sticker_path=NULL,
        result_json=excluded.result_json,reason=excluded.reason,updated_at=excluded.updated_at
      WHERE jobs.status IN ('pending','preparing','failed','skipped')`);
    return this.db.transaction(() => {
      let count = 0;
      for (const reply of comments) {
        if (reply.authorUid !== accountUid || reply.replyRelationKnown !== true ||
            typeof reply.replyToCid !== 'string' || !reply.replyToCid || reply.replyToCid === reply.cid) continue;
        const target = this.getComment(accountUid, reply.videoId, reply.replyToCid) || {
          videoId: reply.videoId, cid: reply.replyToCid, authorUid: '', text: '', rootCid: reply.rootCid || reply.replyToCid,
        };
        const trigger = { eligible: false, kinds: [], needsSemantic: false, evidence: ['existing_own_direct_reply'] };
        const now = Date.now();
        const observedAt = Number.isFinite(reply.createdAt) && reply.createdAt > 0 ? Math.min(reply.createdAt, now) : 0;
        count += insert.run(keyFor({ ...target, accountUid }), accountUid, reply.videoId, reply.replyToCid,
          JSON.stringify(target), eventFingerprint(target, trigger), JSON.stringify(trigger), reply.text || '',
          JSON.stringify({ cid: reply.cid, authorUid: reply.authorUid, targetCid: reply.replyToCid, source: 'platform-history' }),
          '已扫描到本账号对该评论的已确认直接回复', observedAt || now, observedAt).changes;
      }
      return count;
    })();
  }

  enqueue(accountUid, comment, trigger) {
    const c = { ...comment, accountUid };
    const key = keyFor(c);
    const event = JSON.stringify(comment);
    const hash = eventFingerprint(comment, trigger);
    const now = Date.now();
    this.db.prepare(`INSERT INTO jobs(job_key,account_uid,video_id,target_cid,event_json,event_hash,trigger_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'pending',?,?)
      ON CONFLICT(job_key) DO UPDATE SET event_json=excluded.event_json,event_hash=excluded.event_hash,
        trigger_json=excluded.trigger_json,status='pending',reason=NULL,updated_at=excluded.updated_at
      WHERE jobs.status='pending' OR (jobs.status='skipped' AND jobs.event_hash != excluded.event_hash)`)
      .run(key, accountUid, comment.videoId, comment.cid, event, hash, JSON.stringify(trigger), now, now);
    return key;
  }

  refreshPreparing(key, comment, trigger, { requeue = false } = {}) {
    const result = this.db.prepare(`UPDATE jobs SET event_json=?,event_hash=?,trigger_json=?,status=?,
      text=NULL,sticker_id=NULL,sticker_path=NULL,result_json=NULL,reason=NULL,updated_at=?
      WHERE job_key=? AND status='preparing'`).run(JSON.stringify(comment), eventFingerprint(comment, trigger),
      JSON.stringify(trigger), requeue ? 'pending' : 'preparing', Date.now(), key);
    if (result.changes !== 1) throw new Error('任务未处于生成状态，不能刷新快照');
  }

  matchesPreparing(key, comment, trigger) {
    const row = this.get(key);
    return row?.status === 'preparing' && row.event_hash === eventFingerprint(comment, trigger);
  }

  claim(accountUid, videoIds) {
    if (!videoIds.length) return null;
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM jobs WHERE account_uid=? AND status='pending' AND manual_only=0 AND video_id IN (${videoIds.map(() => '?').join(',')}) ORDER BY created_at,job_key LIMIT 1`).get(accountUid, ...videoIds);
      if (!row) return null;
      const claimed = this.db.prepare("UPDATE jobs SET status='preparing',updated_at=? WHERE job_key=? AND status='pending'").run(Date.now(), row.job_key);
      if (!claimed.changes) return null;
      return { ...row, status: 'preparing', comment: JSON.parse(row.event_json), trigger: JSON.parse(row.trigger_json) };
    })();
  }

  prepareManualResend(key, expectedCid, expectedStatus = 'succeeded') {
    return this.db.transaction(() => {
      const row = this.get(key);
      const result = row?.result_json && JSON.parse(row.result_json);
      const recallsExist = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recalls'").get();
      const recall = recallsExist ? this.db.prepare('SELECT * FROM recalls WHERE job_key=?').get(key) : null;
      const verificationsExist = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reply_verifications'").get();
      const verification = verificationsExist ? this.db.prepare('SELECT * FROM reply_verifications WHERE job_key=?').get(key) : null;
      const event = row?.event_json && JSON.parse(row.event_json);
      const supported = row?.status === 'succeeded' && (result?.targetVerified === true ||
        require('./services/deletion-check').matchingVerification(row, verification)) ||
        row?.status === 'unknown' && (!recall || (recall.status !== 'requesting' &&
        recall.account_uid === row.account_uid && recall.video_id === row.video_id &&
        recall.root_cid === (event?.rootCid || event?.cid) && recall.comment_cid === expectedCid)) &&
        result?.authorVerified === true && result?.targetVerification?.aweme_id === 'missing' && result?.targetVerification?.reply_id === 'matched' &&
        result?.targetVerification?.reply_to_reply_id === 'matched';
      if (!row || row.status !== expectedStatus || result?.cid !== expectedCid || !supported) throw new Error('原回复记录已变化，不能重新发送');
      this.db.prepare('INSERT INTO resend_history(job_key,prior_job_json,prior_recall_json,archived_at,prior_verification_json) VALUES (?,?,?,?,?)')
        .run(key, JSON.stringify(row), recall ? JSON.stringify(recall) : null, Date.now(), verification ? JSON.stringify(verification) : null);
      if (recallsExist) this.db.prepare('DELETE FROM recalls WHERE job_key=?').run(key);
      if (verificationsExist) this.db.prepare('DELETE FROM reply_verifications WHERE job_key=?').run(key);
      const updated = this.db.prepare("UPDATE jobs SET status='manual_pending',manual_only=1,text=NULL,sticker_id=NULL,sticker_path=NULL,result_json=NULL,reason=NULL,updated_at=? WHERE job_key=? AND status=?").run(Date.now(), key, expectedStatus);
      if (updated.changes !== 1) throw new Error('原回复记录已变化，不能重新发送');
    })();
  }

  prepareManualRetry(key, expectedStatus, expectedUpdatedAt, historyId) {
    this.db.transaction(() => {
      const latest = this.db.prepare('SELECT id FROM resend_history WHERE job_key=? ORDER BY id DESC LIMIT 1').get(key);
      if (!latest || latest.id !== historyId) throw new Error('原发送记录已变化，不能重新发送');
      const recallsExist = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recalls'").get();
      if (recallsExist && this.db.prepare('SELECT 1 FROM recalls WHERE job_key=?').get(key)) throw new Error('撤回状态已变化，不能重新发送');
      const updated = this.db.prepare(`UPDATE jobs SET status='manual_pending',text=NULL,sticker_id=NULL,sticker_path=NULL,
        result_json=NULL,reason=NULL,updated_at=? WHERE job_key=? AND manual_only=1 AND status=? AND updated_at=?`)
        .run(Date.now(), key, expectedStatus, expectedUpdatedAt);
      if (updated.changes !== 1) throw new Error('手动重发记录已变化，不能重新发送');
    })();
  }

  claimManual(accountUid, videoIds, key) {
    if (!videoIds.length) return null;
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM jobs WHERE job_key=? AND account_uid=? AND status='manual_pending' AND manual_only=1 AND video_id IN (${videoIds.map(() => '?').join(',')})`).get(key, accountUid, ...videoIds);
      if (!row) return null;
      if (!this.db.prepare("UPDATE jobs SET status='preparing',updated_at=? WHERE job_key=? AND status='manual_pending' AND manual_only=1").run(Date.now(), key).changes) return null;
      return { ...row, status: 'preparing', comment: JSON.parse(row.event_json), trigger: JSON.parse(row.trigger_json) };
    })();
  }

  failUnclaimedManual(key) {
    this.db.prepare("UPDATE jobs SET status='failed',reason='手动重发在发送前中断，未自动重试',updated_at=? WHERE job_key=? AND manual_only=1 AND status='manual_pending'").run(Date.now(), key);
  }

  retryFailed(key, accountUid) {
    const row = this.db.prepare('SELECT status,manual_only FROM jobs WHERE job_key=? AND account_uid=?').get(key, accountUid);
    if (row?.manual_only === 1) throw new Error('手动重发任务请在前端重新核验后操作');
    const result = this.db.prepare("UPDATE jobs SET status='pending',reason=NULL,updated_at=? WHERE job_key=? AND account_uid=? AND status='failed' AND manual_only=0").run(Date.now(), key, accountUid);
    if (result.changes !== 1) throw new Error('仅能重试当前账号的 failed 任务；unknown 结果须先核对平台');
  }

  prepare(key, { text, stickerId = null, stickerPath = null }) {
    this.db.prepare("UPDATE jobs SET text=?,sticker_id=?,sticker_path=?,updated_at=? WHERE job_key=? AND status='preparing'")
      .run(text, stickerId, stickerPath, Date.now(), key);
  }

  beginSend(key) {
    const result = this.db.prepare("UPDATE jobs SET status='sending',updated_at=? WHERE job_key=? AND status='preparing'").run(Date.now(), key);
    if (result.changes !== 1) throw new Error('任务未处于待发送状态');
  }

  cancelBeforeSend(key, { definitelyNotSent = false } = {}) {
    const result = this.db.prepare(`UPDATE jobs SET status=CASE WHEN manual_only=1 THEN 'failed' ELSE 'pending' END,text=NULL,sticker_id=NULL,
      sticker_path=NULL,result_json=NULL,reason=NULL,updated_at=? WHERE job_key=?
      AND (status='preparing' OR (status='sending' AND ?=1))`).run(Date.now(), key, definitelyNotSent ? 1 : 0);
    if (result.changes !== 1) throw new Error('只有明确尚未发送的任务才能因停止而回到待处理');
  }

  finish(key, status, { reason = null, result = null } = {}) {
    if (!['succeeded', 'failed', 'unknown', 'skipped'].includes(status)) throw new Error('无效的任务结果');
    this.db.prepare('UPDATE jobs SET status=?,reason=?,result_json=?,updated_at=? WHERE job_key=?').run(status, reason, result ? JSON.stringify(result) : null, Date.now(), key);
  }

  recoverInFlight({ preserveManualJobKey = null } = {}) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status='unknown',reason='进程退出时发送尚未确认',updated_at=? WHERE status='sending'").run(Date.now());
      this.db.prepare("UPDATE jobs SET status='pending',updated_at=? WHERE status='preparing' AND manual_only=0").run(Date.now());
      this.db.prepare("UPDATE jobs SET status='failed',reason='手动重发在发送前中断，未自动重试',updated_at=? WHERE manual_only=1 AND (status='preparing' OR (status='manual_pending' AND job_key IS NOT ?))").run(Date.now(), preserveManualJobKey);
    })();
  }

  recentReplies(accountUid, videoId, limit = 15) {
    return this.db.prepare("SELECT text,sticker_id FROM jobs WHERE account_uid=? AND video_id=? AND status='succeeded' ORDER BY updated_at DESC LIMIT ?")
      .all(accountUid, videoId, limit).map(r => ({ text: r.text, stickerId: r.sticker_id }));
  }

  hasRecentText(accountUid, text, limit = 100) {
    const normalize = s => String(s).replace(/\s+/g, '').toLowerCase();
    return this.db.prepare("SELECT text FROM jobs WHERE account_uid=? AND status IN ('succeeded','sending','unknown') AND text IS NOT NULL ORDER BY updated_at DESC LIMIT ?")
      .all(accountUid, limit).some(r => normalize(r.text) === normalize(text));
  }

  lastSendAt(accountUid) {
    return this.db.prepare("SELECT MAX(updated_at) AS ts FROM jobs WHERE account_uid=? AND status IN ('sending','succeeded','unknown')").get(accountUid).ts || 0;
  }

  recordScan(accountUid, videoId, { complete, warnings = [], continuation = null }) {
    this.db.prepare(`INSERT INTO scans(account_uid,video_id,complete,warnings_json,scanned_at,continuation_json) VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_uid,video_id) DO UPDATE SET complete=excluded.complete,warnings_json=excluded.warnings_json,scanned_at=excluded.scanned_at,continuation_json=excluded.continuation_json`)
      .run(accountUid, videoId, complete ? 1 : 0, JSON.stringify(warnings), Date.now(), continuation ? JSON.stringify(continuation) : null);
  }

  scanContinuation(accountUid, videoId) {
    const row = this.db.prepare('SELECT continuation_json FROM scans WHERE account_uid=? AND video_id=?').get(accountUid, videoId);
    return row?.continuation_json ? JSON.parse(row.continuation_json) : null;
  }

  get(key) { return this.db.prepare('SELECT * FROM jobs WHERE job_key=?').get(key); }
  status(accountUid) {
    return {
      jobs: this.db.prepare('SELECT status,count(*) AS count FROM jobs WHERE account_uid=? GROUP BY status').all(accountUid),
      scans: this.db.prepare('SELECT video_id,complete,warnings_json,scanned_at FROM scans WHERE account_uid=?').all(accountUid),
      attention: this.db.prepare("SELECT job_key,video_id,target_cid,status,reason FROM jobs WHERE account_uid=? AND status IN ('unknown','failed') ORDER BY updated_at DESC LIMIT 20").all(accountUid),
    };
  }
  close() { this.db.close(); }
}

module.exports = { Store, keyFor };
