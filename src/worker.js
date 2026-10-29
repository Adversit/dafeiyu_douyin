'use strict';
// Select → compose → queue → execute follows the mature upstream separation;
// persistent pre-send/unknown states follow dsh_douyin_tools (MIT), see docs/SOURCES.md.
const { setTimeout: delay } = require('node:timers/promises');
const { evaluateTrigger } = require('./agent/trigger');

class Worker {
  constructor({ config, adapter, agent, stickers, store, sleep = delay, log = () => {} }) {
    Object.assign(this, { config, adapter, agent, stickers, store, sleep, log });
  }

  currentSnapshot(comment) {
    const { config: cfg, store } = this;
    const current = { ...(store.getComment(cfg.accountUid, comment.videoId, comment.cid) || comment) };
    // Persisted evidence cannot bypass a relationship gate disabled since enqueue.
    if (cfg.douyin.inboundSchemaConfirmed === false) {
      current.replyRelationKnown = false;
      current.mentionsKnown = false;
    }
    const trigger = evaluateTrigger(current, {
      accountUid: cfg.accountUid,
      ownCommentIds: store.ownCommentIds(cfg.accountUid, current.videoId),
    });
    return { comment: current, trigger };
  }

  async runOnce({ signal } = {}) {
    const { config: cfg, adapter, agent, store } = this;
    if (!cfg.accountUid || !cfg.videos.length) throw new Error('请先配置固定 accountUid 和手动作品列表 videos');
    const summary = { scanned: 0, considered: 0, attempted: 0, sent: 0, skipped: 0, failed: 0, unknown: 0, warnings: [] };
    for (const videoId of cfg.videos) {
      signal?.throwIfAborted();
      await adapter.verifyVideo(videoId);
      const scan = await adapter.scanVideo(videoId, { ...cfg.douyin, continuation: store.scanContinuation(cfg.accountUid, videoId) });
      const comments = scan.comments;
      if (comments.some(c => c.videoId !== videoId)) throw new Error('评论回包作品与手动指定作品不一致');
      // Persist the scan, historical reply facts and queue before advancing its cursor.
      store.db.transaction(() => {
        store.saveComments(cfg.accountUid, comments);
        store.primeReplies(cfg.accountUid, comments, { inboundSchemaConfirmed: cfg.douyin.inboundSchemaConfirmed === true });
        for (const comment of comments) {
          const current = this.currentSnapshot(comment);
          if (current.trigger.eligible || current.trigger.needsSemantic) store.enqueue(cfg.accountUid, current.comment, current.trigger);
        }
        store.recordScan(cfg.accountUid, videoId, scan);
      })();
      summary.scanned += comments.length;
      summary.warnings.push(...(scan.warnings || []).map(w => `${videoId}: ${w}`));
    }

    while (summary.attempted < cfg.worker.maxRepliesPerRound && summary.considered < cfg.worker.maxCandidatesPerRound) {
      signal?.throwIfAborted();
      const job = store.claim(cfg.accountUid, cfg.videos);
      if (!job) break;
      summary.considered++;
      let sending = false;
      let receipt = null;
      try {
        const { comment, trigger } = this.currentSnapshot(job.comment);
        store.refreshPreparing(job.job_key, comment, trigger);
        if (!trigger.eligible && !trigger.needsSemantic) {
          store.finish(job.job_key, 'skipped', { reason: trigger.evidence.join(',') || '当前记录不满足触发规则' });
          summary.skipped++; continue;
        }
        const context = {
          thread: store.thread(cfg.accountUid, comment).map(c => cfg.douyin.inboundSchemaConfirmed === false ? { ...c, replyRelationKnown: false } : c),
          recentReplies: store.recentReplies(cfg.accountUid, comment.videoId),
          kinds: [...trigger.kinds],
          relationships: trigger.relationships,
        };
        if (!trigger.eligible) {
          const decision = await agent.decideAddressed(comment, context);
          if (!decision.addressed) {
            store.finish(job.job_key, 'skipped', { reason: decision.reason || '没有向大肥鱼提问' });
            summary.skipped++; continue;
          }
          context.kinds.push('question_to_fish');
        }
        const reply = await agent.generate(comment, { ...context, stickersEnabled: cfg.stickers.enabled, allowImageOnly: false });
        if (!reply || typeof reply.text !== 'string') throw new Error('生成的回复文字无效');
        const text = reply.text.trim();
        if (!text && !reply.stickerQuery) {
          store.finish(job.job_key, 'skipped', { reason: '模型判断本轮不回复' });
          summary.skipped++; continue;
        }
        if (!text) throw new Error('当前发送接口要求非空文字，纯图片评论须先验证平台能力');
        if (store.hasRecentText(cfg.accountUid, text)) {
          store.finish(job.job_key, 'skipped', { reason: '近期已发送或待确认的相同回复' });
          summary.skipped++; continue;
        }
        let stickerId = null;
        let stickerPath = null;
        if (cfg.stickers.enabled && this.stickers && reply.stickerQuery) {
          const candidates = await this.stickers.search(reply.stickerQuery, {
            limit: cfg.stickers.limit,
            excludeIds: context.recentReplies.map(r => r.stickerId).filter(Boolean),
          });
          stickerId = await agent.chooseSticker(candidates, { text, comment, stickerQuery: reply.stickerQuery });
          if (stickerId) {
            if (!candidates.some(c => c.id === stickerId)) throw new Error('表情不在本轮检索候选中');
            const file = await this.stickers.file(stickerId);
            if (!cfg.stickers.allowedMimeTypes.includes(file.mime)) throw new Error('当前配置未启用该图片格式');
            stickerPath = file.path;
          }
        }
        if (cfg.stickers.enabled && cfg.stickers.mode === 'required' && !stickerPath) throw new Error('本轮要求附表情，但没有取得合适素材');
        store.prepare(job.job_key, { text, stickerId, stickerPath });
        const wait = cfg.worker.sendIntervalMs - (Date.now() - store.lastSendAt(cfg.accountUid));
        if (wait > 0) await this.sleep(wait, undefined, { signal });
        signal?.throwIfAborted();
        // Upload cannot publish a comment; errors here remain definitely pre-send.
        const images = stickerPath ? [await adapter.uploadImage(stickerPath)] : [];
        signal?.throwIfAborted();
        const latest = this.currentSnapshot(comment);
        if (!store.matchesPreparing(job.job_key, latest.comment, latest.trigger)) {
          store.refreshPreparing(job.job_key, latest.comment, latest.trigger, { requeue: true });
          summary.warnings.push(`${comment.videoId}:${comment.cid}: 评论或触发证据已变化，已重新排队`);
          continue;
        }
        store.beginSend(job.job_key);
        sending = true;
        summary.attempted++;
        const result = await adapter.publishReply({ videoId: comment.videoId, targetCid: comment.cid, rootCid: comment.rootCid, text, images });
        receipt = result;
        if (!result?.cid) throw new Error('发送后未取得评论 ID');
        if (result.targetVerified !== true) throw new Error('评论已提交，但回执未确认目标楼层；核查前不重发');
        if (images.length && result.imageCount !== images.length) throw new Error('发送回包未确认图片已全部附上');
        store.finish(job.job_key, 'succeeded', { result });
        store.saveComments(cfg.accountUid, [{ videoId: comment.videoId, cid: result.cid, authorUid: cfg.accountUid, text, rootCid: comment.rootCid || comment.cid, replyToCid: comment.cid, replyToUid: comment.authorUid, replyRelationKnown: true, mentionUids: [], mentionsKnown: true, createdAt: Date.now() }]);
        summary.sent++;
      } catch (error) {
        const status = sending && !error.definitelyNotSent ? 'unknown' : 'failed';
        store.finish(job.job_key, status, { reason: error.message, result: receipt || (error.cid ? { cid: error.cid } : null) });
        summary[status]++;
        this.log({ job: job.job_key, status, reason: error.message });
        if (signal?.aborted) throw error;
        // Stop a round after an uncertain write; do not continue posting through an outage.
        if (status === 'unknown') break;
      }
    }
    return summary;
  }
}

module.exports = { Worker };
