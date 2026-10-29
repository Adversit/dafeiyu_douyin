'use strict';
// Select → compose → queue → execute follows the mature upstream separation;
// persistent pre-send/unknown states follow dsh_douyin_tools (MIT), see docs/SOURCES.md.
const { setTimeout: delay } = require('node:timers/promises');
const { evaluateTrigger } = require('./agent/trigger');

class Worker {
  constructor({ config, adapter, agent, stickers, store, sleep = delay, log = () => {} }) {
    Object.assign(this, { config, adapter, agent, stickers, store, sleep, log });
  }

  event(event, stage, message, data = {}, comment = null, level = 'info') {
    this.log({ level, event, stage, message,
      ...(comment ? { videoId: comment.videoId, targetCid: comment.cid } : {}), data });
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
      respondToNameCall: cfg.triggers?.respondToNameCall !== false,
    });
    return { comment: current, trigger };
  }

  async runOnce({ signal, onlyJobKey = null } = {}) {
    const { config: cfg, adapter, agent, store } = this;
    if (!cfg.accountUid || !cfg.videos.length) throw new Error('请先配置固定 accountUid 和手动作品列表 videos');
    const summary = { scanned: 0, considered: 0, attempted: 0, sent: 0, skipped: 0, failed: 0, unknown: 0, warnings: [] };
    for (const videoId of onlyJobKey ? [] : cfg.videos) {
      signal?.throwIfAborted();
      this.event('scan.started', 'scan', '正在核验并读取指定作品', { videoId });
      signal?.throwIfAborted();
      await adapter.verifyVideo(videoId);
      signal?.throwIfAborted();
      const scan = await adapter.scanVideo(videoId, { ...cfg.douyin, continuation: store.scanContinuation(cfg.accountUid, videoId) });
      signal?.throwIfAborted();
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
      this.event('scan.completed', 'scan', `读取到 ${comments.length} 条评论`, { videoId, count: comments.length, complete: scan.complete });
      for (const warning of scan.warnings || []) this.event('scan.warning', 'scan', warning, { videoId }, null, 'warn');
      for (const comment of comments) {
        const { trigger } = this.currentSnapshot(comment);
        this.event('comment.observed', 'trigger', trigger.eligible ? '评论命中直接触发规则' : trigger.needsSemantic ? '评论进入语义判断候选' : '评论不进入回复流程',
          { commentText: comment.text, authorUid: comment.authorUid, rootCid: comment.rootCid, trigger }, comment, 'debug');
      }
    }

    while (summary.attempted < cfg.worker.maxRepliesPerRound && summary.considered < cfg.worker.maxCandidatesPerRound) {
      signal?.throwIfAborted();
      if (onlyJobKey && summary.considered) break;
      const job = onlyJobKey ? store.claimManual(cfg.accountUid, cfg.videos, onlyJobKey) : store.claim(cfg.accountUid, cfg.videos);
      if (!job) break;
      summary.considered++;
      let sending = false;
      let receipt = null;
      try {
        const { comment, trigger } = this.currentSnapshot(job.comment);
        store.refreshPreparing(job.job_key, comment, trigger);
        this.event('trigger.evaluated', 'trigger', trigger.eligible ? '已命中触发规则' : '正在判断是否向大肥鱼寻求回应', { commentText: comment.text, trigger }, comment);
        signal?.throwIfAborted();
        if (!trigger.eligible && !trigger.needsSemantic) {
          store.finish(job.job_key, 'skipped', { reason: trigger.evidence.join(',') || '当前记录不满足触发规则' });
          this.event('comment.skipped', 'skipped', trigger.evidence.join(',') || '当前记录不满足触发规则', { commentText: comment.text }, comment);
          summary.skipped++; continue;
        }
        const liveThread = await adapter.readThread(comment.videoId, {
          rootCid: comment.rootCid || comment.cid, targetCid: comment.cid, targetAuthorUid: comment.authorUid,
          maxPages: cfg.douyin.maxPages, maxReplyPages: cfg.douyin.maxReplyPages, signal,
        });
        if (!liveThread?.complete || !Array.isArray(liveThread.comments) || !liveThread.target ||
            liveThread.target.text !== comment.text || (liveThread.target.rootCid || liveThread.target.cid) !== (comment.rootCid || comment.cid)) {
          throw new Error('目标评论或完整楼层已变化，停止本次回复');
        }
        if (onlyJobKey) {
          const rootCid = comment.rootCid || comment.cid;
          const otherOwnReply = liveThread.comments.some(c => c.authorUid === cfg.accountUid && c.cid !== rootCid &&
            (c.replyRelationKnown !== true || !c.replyToCid || c.replyToCid === comment.cid));
          if (otherOwnReply) throw new Error('该楼还有本人回复，无法排除已回复过目标，手动重发已停止');
        }
        const context = {
          thread: liveThread.comments.filter(c => c.cid !== comment.cid).map(c => ({ ...c, isOwn: c.authorUid === cfg.accountUid,
            ...(cfg.douyin.inboundSchemaConfirmed === false ? { replyRelationKnown: false } : {}) })),
          recentReplies: store.recentReplies(cfg.accountUid, comment.videoId),
          kinds: [...trigger.kinds],
          relationships: trigger.relationships,
        };
        const inputReview = await agent.reviewInput(comment, context);
        signal?.throwIfAborted();
        if (inputReview?.safe !== true) {
          const reason = inputReview?.reason || '输入未通过安全检查';
          store.finish(job.job_key, 'skipped', { reason });
          this.event('comment.skipped', 'safety', reason, { commentText: comment.text }, comment, 'warn');
          summary.skipped++; continue;
        }
        if (!trigger.eligible) {
          this.event('decision.started', 'decision', '正在判断评论的回应对象', {}, comment, 'debug');
          signal?.throwIfAborted();
          const decision = await agent.decideAddressed(comment, context);
          this.event('decision.completed', 'decision', decision.addressed ? 'AI 判断需要回应' : 'AI 判断跳过', { addressed: decision.addressed, reason: decision.reason, commentText: comment.text }, comment);
          signal?.throwIfAborted();
          if (!decision.addressed) {
            store.finish(job.job_key, 'skipped', { reason: decision.reason || '没有向大肥鱼提问' });
            this.event('comment.skipped', 'skipped', decision.reason || '没有向大肥鱼提问', { commentText: comment.text }, comment);
            summary.skipped++; continue;
          }
          context.kinds.push('question_to_fish');
        }
        this.event('generation.started', 'generation', '正在生成大肥鱼回复', { kinds: context.kinds }, comment);
        signal?.throwIfAborted();
        const reply = await agent.generate(comment, { ...context, stickersEnabled: cfg.stickers.enabled, allowImageOnly: cfg.stickers.enabled });
        signal?.throwIfAborted();
        if (!reply || typeof reply.text !== 'string') throw new Error('生成的回复文字无效');
        const text = reply.text.trim();
        this.event('generation.completed', 'generation', '已生成回复', { commentText: comment.text, replyText: text, stickerQuery: reply.stickerQuery || null }, comment);
        if (!text && !reply.stickerQuery) {
          store.finish(job.job_key, 'skipped', { reason: '模型判断本轮不回复' });
          this.event('comment.skipped', 'skipped', '模型判断本轮不回复', { commentText: comment.text }, comment);
          summary.skipped++; continue;
        }
        if (text && store.hasRecentText(cfg.accountUid, text)) {
          store.finish(job.job_key, 'skipped', { reason: '近期已发送或待确认的相同回复' });
          this.event('comment.skipped', 'skipped', '近期已发送或待确认的相同回复', { commentText: comment.text, replyText: text }, comment);
          summary.skipped++; continue;
        }
        let stickerId = null;
        let stickerPath = null;
        if (cfg.stickers.enabled && this.stickers && reply.stickerQuery) {
          this.event('sticker.search', 'sticker', '正在检索表情包', { query: reply.stickerQuery }, comment, 'debug');
          signal?.throwIfAborted();
          const candidates = await this.stickers.search(reply.stickerQuery, {
            limit: cfg.stickers.limit,
            excludeIds: context.recentReplies.map(r => r.stickerId).filter(Boolean),
          });
          signal?.throwIfAborted();
          stickerId = await agent.chooseSticker(candidates, { text, comment, stickerQuery: reply.stickerQuery });
          this.event('sticker.selected', 'sticker', stickerId ? '已选择表情包' : '没有选择表情，本轮仅回复文字', { stickerId, candidates: candidates.map(c => c.id) }, comment);
          signal?.throwIfAborted();
          if (stickerId) {
            if (!candidates.some(c => c.id === stickerId)) throw new Error('表情不在本轮检索候选中');
            const file = await this.stickers.file(stickerId);
            signal?.throwIfAborted();
            if (!cfg.stickers.allowedMimeTypes.includes(file.mime)) throw new Error('当前配置未启用该图片格式');
            stickerPath = file.path;
          }
        }
        if (cfg.stickers.enabled && cfg.stickers.mode === 'required' && !stickerPath) throw new Error('本轮要求附表情，但没有取得合适素材');
        if (!text && !stickerPath) {
          store.finish(job.job_key, 'skipped', { reason: '没有找到可发送的表情包' });
          this.event('comment.skipped', 'skipped', '没有找到可发送的表情包', { commentText: comment.text }, comment);
          summary.skipped++; continue;
        }
        const outputReview = await agent.reviewOutput(comment, { ...reply, text, stickerId }, context);
        signal?.throwIfAborted();
        if (outputReview?.safe !== true) {
          const reason = outputReview?.reason || '输出未通过安全检查';
          store.finish(job.job_key, 'skipped', { reason });
          this.event('comment.skipped', 'safety', reason, { commentText: comment.text, replyText: text }, comment, 'warn');
          summary.skipped++; continue;
        }
        store.prepare(job.job_key, { text, stickerId, stickerPath });
        const wait = cfg.worker.sendIntervalMs - (Date.now() - store.lastSendAt(cfg.accountUid));
        if (wait > 0) {
          this.event('send.waiting', 'waiting', '等待发送间隔', { waitMs: wait }, comment);
          await this.sleep(wait, undefined, { signal });
        }
        signal?.throwIfAborted();
        // Upload cannot publish a comment; errors here remain definitely pre-send.
        const images = stickerPath ? [await adapter.uploadImage(stickerPath)] : [];
        signal?.throwIfAborted();
        const latest = this.currentSnapshot(comment);
        if (!store.matchesPreparing(job.job_key, latest.comment, latest.trigger)) {
          if (onlyJobKey) {
            store.finish(job.job_key, 'failed', { reason: '评论或触发证据已变化，手动重发已停止' });
            summary.failed++;
            this.event('comment.failed', 'trigger', '评论或触发证据已变化，手动重发已停止', {}, comment, 'warn');
            continue;
          }
          store.refreshPreparing(job.job_key, latest.comment, latest.trigger, { requeue: true });
          summary.warnings.push(`${comment.videoId}:${comment.cid}: 评论或触发证据已变化，已重新排队`);
          this.event('comment.requeued', 'trigger', '评论或触发证据已变化，已重新排队', {}, comment, 'warn');
          continue;
        }
        this.event('send.started', 'sending', '正在准备提交回复', { commentText: comment.text, replyText: text, imageCount: images.length }, comment);
        signal?.throwIfAborted();
        store.beginSend(job.job_key);
        sending = true;
        summary.attempted++;
        const result = await adapter.publishReply({ videoId: comment.videoId, targetCid: comment.cid, rootCid: comment.rootCid, text, images, signal });
        receipt = result;
        this.event('send.receipt', 'receipt', result.targetVerified ? '回执核验通过' : '回执尚未完整核验', result, comment, result.targetVerified ? 'info' : 'warn');
        if (!result?.cid) throw new Error('发送后未取得评论 ID');
        if (result.targetVerified !== true) throw new Error('评论已提交，但回执未确认目标楼层；核查前不重发');
        if (images.length && result.imageCount !== images.length) throw new Error('发送回包未确认图片已全部附上');
        store.finish(job.job_key, 'succeeded', { result });
        store.saveComments(cfg.accountUid, [{ videoId: comment.videoId, cid: result.cid, authorUid: cfg.accountUid, text, rootCid: comment.rootCid || comment.cid, replyToCid: comment.cid, replyToUid: comment.authorUid, replyRelationKnown: true, mentionUids: [], mentionsKnown: true, createdAt: Date.now() }]);
        summary.sent++;
        this.event('comment.succeeded', 'complete', '已确认发送', { commentText: comment.text, replyText: text, cid: result.cid }, comment);
      } catch (error) {
        if (signal?.aborted && error.name === 'AbortError' && (!sending || error.definitelyNotSent === true)) {
          store.cancelBeforeSend(job.job_key, { definitelyNotSent: error.definitelyNotSent === true });
          this.event('comment.paused', 'stopped', '已停止，尚未发送的评论保留为待处理', { commentText: job.comment.text }, job.comment);
          throw error;
        }
        const status = sending && !error.definitelyNotSent ? 'unknown' : 'failed';
        store.finish(job.job_key, status, { reason: error.message, result: receipt || (error.cid ? { cid: error.cid } : null) });
        summary[status]++;
        this.log({ level: status === 'unknown' ? 'warn' : 'error', event: `comment.${status}`, stage: status,
          job: job.job_key, videoId: job.video_id, targetCid: job.target_cid, status, reason: error.message,
          message: error.message, data: { commentText: job.comment.text, result: receipt } });
        if (signal?.aborted) throw error;
        // Stop a round after an uncertain write; do not continue posting through an outage.
        if (status === 'unknown') break;
      }
    }
    return summary;
  }
}

module.exports = { Worker };
