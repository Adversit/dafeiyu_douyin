'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { id, validateCommand } = require('../bridge/protocol');

function optionalId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Unsafe numeric platform ID; use a lossless JSON parser');
    value = String(value);
  }
  return typeof value === 'string' && /^\d{1,30}$/.test(value) && !/^0+$/.test(value) ? value : null;
}
function requirePlatformId(value, name) {
  const result = optionalId(value);
  if (!result) throw new Error(`Platform response has no valid ${name}`);
  return result;
}
function checkResult(data, operation) {
  if (!data || typeof data !== 'object') throw new Error(`Invalid ${operation} response`);
  if (data.status_code !== undefined && data.status_code !== 0) throw new Error(`${operation} rejected (status_code=${data.status_code})`);
  return data;
}
function timestampMs(seconds) {
  // Douyin create_time is epoch seconds; local events use epoch milliseconds.
  // Reject coerced null/bools, fractional seconds and values outside Date's range.
  if (typeof seconds !== 'number' && (typeof seconds !== 'string' || !/^\d+$/.test(seconds))) return null;
  const value = Number(seconds);
  return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000 ? value * 1000 : null;
}
// IMPORTANT: the mapping below is provisional. Unit fixtures demonstrate parsing,
// not live platform semantics. Keep the flags false until real read-only samples
// confirm direct-reply IDs and user-mention entries for the installed web version.
function normalizeComment(raw, { videoId, rootCid = null, inboundSchemaConfirmed = false }) {
  const cid = requirePlatformId(raw.cid, 'comment cid');
  const authorUid = optionalId(raw.user?.uid ?? raw.user?.uid_str);
  let replyToCid = optionalId(raw.reply_to_reply_id);
  // This combination is direct-root evidence ONLY after this exact incoming
  // schema has been verified: explicit zero means no nested target, while the
  // API's reply_id must agree with the thread queried. Placement alone is not evidence.
  if (!replyToCid && inboundSchemaConfirmed && rootCid
      && (raw.reply_to_reply_id === 0 || raw.reply_to_reply_id === '0')
      && optionalId(raw.reply_id) === rootCid) replyToCid = rootCid;
  const replyToUid = optionalId(raw.reply_to_uid ?? raw.reply_to_userid);
  const extras = raw.text_extra;
  const mentionEntries = Array.isArray(extras) ? extras.filter(e => e && (e.type === 0 || e.type === '0') && optionalId(e.user_id)) : [];
  return {
    videoId, cid, authorUid, text: typeof raw.text === 'string' ? raw.text : '',
    createdAt: timestampMs(raw.create_time),
    rootCid: rootCid || cid, replyToCid, replyToUid,
    mentionUids: [...new Set(mentionEntries.map(e => optionalId(e.user_id)))],
    replyRelationKnown: Boolean(inboundSchemaConfirmed && (replyToCid || replyToUid)),
    mentionsKnown: Boolean(inboundSchemaConfirmed && Array.isArray(extras)),
    // Preserve the originals so the confirmed schema, including explicit-zero
    // root replies, can be checked against actual read-only platform samples.
    rawRelationshipFields: Object.fromEntries(Object.entries(raw).filter(([key]) => /^(reply(?:_|$)|mention(?:s|_|$)|text_extra$)/.test(key))),
  };
}

class DouyinAdapter {
  constructor({ bridge, accountUid, inboundSchemaConfirmed = false } = {}) {
    if (!bridge || typeof bridge.call !== 'function') throw new Error('A bridge.call(command,args) implementation is required');
    this.bridge = bridge; this.accountUid = id(accountUid, 'accountUid'); this.inboundSchemaConfirmed = inboundSchemaConfirmed;
  }
  _call(command, args = {}) { return this.bridge.call(command, { ...args, accountUid: this.accountUid }); }
  async verifyVideo(videoId) {
    id(videoId, 'videoId');
    const identity = await this._call('identity.get');
    if (optionalId(identity?.uid) !== this.accountUid) throw Object.assign(new Error('Current browser login does not match configured accountUid'), { code: 'IDENTITY_MISMATCH' });
    const data = checkResult(await this._call('video.get', { videoId }), 'video.get');
    const detail = data.aweme_detail;
    if (!detail || optionalId(detail.author?.uid ?? detail.author?.uid_str) !== this.accountUid) throw Object.assign(new Error('Video does not belong to configured accountUid, or author identity is missing'), { code: 'OWNERSHIP_MISMATCH' });
    return detail;
  }
  async _walkPages(videoId, command, args, limit, consume, { label = command, startCursor = '0', signal, requireStable = false, nullReply = 'reject' } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Pagination limits must be positive integers');
    if (typeof startCursor !== 'string' || !/^\d{1,30}$/.test(startCursor)) throw new Error('Invalid continuation cursor');
    let cursor = startCursor;
    const cursors = new Set([cursor]); const pageSeen = new Set();
    for (let page = 0; page < limit; page++) {
      signal?.throwIfAborted();
      const data = checkResult(await this._call(command, { ...args, videoId, cursor, count: 20 }), command);
      signal?.throwIfAborted();
      if (command === 'comments.replies' && (data._bridge_reply_query !== 'item_id-v1' || data.status_code !== 0)) {
        const warning = data._bridge_reply_query !== 'item_id-v1'
          ? '抖音回复查询可能来自旧油猴脚本；请更新脚本并刷新抖音页面'
          : '抖音回复查询未返回明确成功状态';
        if (nullReply === 'incomplete') return { nextCursor: cursor, warning: `${label}: ${warning}；本楼未完整读取`, stopped: false };
        throw new Error(warning);
      }
      if (!Array.isArray(data.comments)) {
        // The live reply endpoint uses null for some empty-looking pages. It is
        // only safe to call the first page empty when the root also says zero.
        const emptyReply = command === 'comments.replies' && data.status_code === 0 && data.comments === null &&
          (data.has_more === 0 || data.has_more === false) && cursor === '0' && pageSeen.size === 0;
        if (emptyReply && nullReply === 'known-empty' && data._bridge_reply_query === 'item_id-v1' &&
            (data.total === 0 || data.total === '0')) {
          await consume([]);
          return { nextCursor: null, warning: null, stopped: false };
        }
        if (emptyReply && nullReply === 'incomplete') {
          const hint = data._bridge_reply_query === 'item_id-v1' ? '' : '；请更新油猴脚本并刷新抖音页面';
          return { nextCursor: cursor, warning: `${label}: 回复列表为空值且楼层计数无法确认；本楼未完整读取，将继续检查${hint}`, stopped: false };
        }
        if (emptyReply && data._bridge_reply_query !== 'item_id-v1') throw new Error('抖音回复查询可能来自旧油猴脚本；请更新脚本并刷新抖音页面后重试');
        if (emptyReply) throw new Error('抖音回复列表为空，无法确认该楼回复是否完整');
        throw new Error(`${command} response has no comments array`);
      }
      let newIds = 0;
      for (const raw of data.comments) {
        const cid = requirePlatformId(raw.cid, 'comment cid');
        if (pageSeen.has(cid)) {
          if (requireStable) throw Object.assign(new Error(`${label}: duplicate comment during pagination; thread may have changed`), { code: 'THREAD_INCOMPLETE' });
        } else { newIds++; pageSeen.add(cid); }
      }
      if (await consume(data.comments) === false) return { nextCursor: null, warning: null, stopped: true };
      const moreKnown = [true, false, 0, 1].includes(data.has_more);
      if (!moreKnown) return { nextCursor: null, warning: `${label}: has_more is missing or unrecognized; no safe continuation is available`, stopped: false };
      if (!data.has_more) return { nextCursor: null, warning: null, stopped: false };
      const next = data.cursor === 0 || data.cursor === '0' ? '0' : optionalId(data.cursor);
      if (!next || cursors.has(next) || newIds === 0) throw Object.assign(new Error(`${label}: pagination stalled (cursor did not advance or page made no progress)`), { code: 'PAGINATION_STALLED' });
      cursors.add(next); cursor = next;
    }
    return { nextCursor: cursor, warning: `${label}: page limit ${limit} reached; continue from cursor ${cursor}`, stopped: false };
  }
  async scanVideo(videoId, { maxPages = 50, maxReplyPages = 50, continuation = null } = {}) {
    for (const limit of [maxPages, maxReplyPages]) if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Pagination limits must be positive integers');
    if (continuation && (typeof continuation !== 'object' || !Array.isArray(continuation.replies))) throw new Error('Invalid scan continuation');
    await this.verifyVideo(videoId);
    const comments = []; const warnings = []; const seen = new Set(); let complete = true;
    const nextReplies = [];
    const add = (raw, rootCid) => {
      const event = normalizeComment(raw, { videoId, rootCid, inboundSchemaConfirmed: this.inboundSchemaConfirmed });
      if (!seen.has(event.cid)) { seen.add(event.cid); comments.push(event); }
    };
    const readPages = async (command, args, limit, consume, label, startCursor = '0') => {
      const result = await this._walkPages(videoId, command, args, limit, consume, { label, startCursor,
        nullReply: command === 'comments.replies' ? 'incomplete' : 'reject' });
      if (result.warning) { complete = false; warnings.push(result.warning); }
      return result.nextCursor;
    };
    const readReplies = async (rootCid, cursor = '0') => {
      id(rootCid, 'rootCid');
      const next = await readPages('comments.replies', { rootCid }, maxReplyPages,
        replies => { for (const reply of replies) add(reply, rootCid); }, `replies(${rootCid})`, cursor);
      if (next !== null) nextReplies.push({ rootCid, cursor: next });
    };
    // Resume capped threads before advancing the root list. Tree position is
    // retained across rounds, but is never treated as direct reply evidence.
    const resumedRoots = new Set();
    for (const task of continuation?.replies || []) {
      if (resumedRoots.has(task.rootCid)) continue;
      resumedRoots.add(task.rootCid);
      await readReplies(task.rootCid, task.cursor);
    }
    // An unresolved reply page must not prevent the next round from seeing
    // newly added root comments after the root traversal has finished.
    const startingRoot = continuation?.rootCursor ?? '0';
    let rootCursor = null;
    if (startingRoot !== null) rootCursor = await readPages('comments.list', {}, maxPages, async roots => {
      for (const root of roots) {
        const rootCid = requirePlatformId(root.cid, 'root comment cid'); add(root, null);
        if (root.reply_comment_total === 0 || root.reply_comment_total === '0') continue;
        if (resumedRoots.has(rootCid)) continue;
        await readReplies(rootCid);
      }
    }, 'comments', startingRoot);
    if (!this.inboundSchemaConfirmed) warnings.push('Inbound reply/@ field semantics are unverified; relation-based triggers remain disabled');
    const next = rootCursor !== null || nextReplies.length ? { rootCursor, replies: nextReplies } : null;
    return { comments, complete, warnings, continuation: next };
  }
  async readThread(videoId, { rootCid, targetCid, targetAuthorUid, maxPages = 50, maxReplyPages = 50, signal } = {}) {
    id(videoId, 'videoId'); id(rootCid, 'rootCid'); id(targetCid, 'targetCid'); id(targetAuthorUid, 'targetAuthorUid');
    for (const limit of [maxPages, maxReplyPages]) if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Pagination limits must be positive integers');
    signal?.throwIfAborted();
    await this.verifyVideo(videoId);
    signal?.throwIfAborted();
    const validateVideo = raw => {
      if (Object.hasOwn(raw, 'aweme_id')) {
        let actual;
        try { actual = optionalId(raw.aweme_id); } catch { actual = null; }
        if (actual !== videoId) throw Object.assign(new Error('评论返回的作品 ID 与指定作品不一致'), { code: 'THREAD_MISMATCH' });
      }
    };
    let rawRoot = null;
    const rootResult = await this._walkPages(videoId, 'comments.list', {}, maxPages, roots => {
      rawRoot = roots.find(item => requirePlatformId(item.cid, 'root comment cid') === rootCid) || null;
      if (rawRoot) { validateVideo(rawRoot); return false; }
      return true;
    }, { label: '根评论', signal, requireStable: true });
    if (rootResult.warning) throw Object.assign(new Error(`根评论读取不完整：${rootResult.warning}`), { code: 'THREAD_INCOMPLETE' });
    if (!rawRoot) throw Object.assign(new Error('在指定作品中未找到目标根评论；无法确认回复位置'), { code: 'THREAD_ROOT_NOT_FOUND' });
    const root = normalizeComment(rawRoot, { videoId, inboundSchemaConfirmed: this.inboundSchemaConfirmed });
    const comments = [root];
    const replyResult = await this._walkPages(videoId, 'comments.replies', { rootCid }, maxReplyPages, replies => {
      for (const raw of replies) {
        validateVideo(raw);
        if (requirePlatformId(raw.cid, 'reply cid') === rootCid) throw Object.assign(new Error('子回复列表含根评论 ID，无法确认楼层'), { code: 'THREAD_MISMATCH' });
        // reply_id is a provisional platform field; only interpret it after
        // the user has confirmed this exact inbound schema against live data.
        if (this.inboundSchemaConfirmed) {
          const parentRoot = optionalId(raw.reply_id);
          if (parentRoot && parentRoot !== rootCid) throw Object.assign(new Error('回复返回的根评论 ID 与查询楼层不一致'), { code: 'THREAD_MISMATCH' });
        }
        comments.push(normalizeComment(raw, { videoId, rootCid, inboundSchemaConfirmed: this.inboundSchemaConfirmed }));
      }
    }, { label: '楼中回复', signal, requireStable: true,
      nullReply: rawRoot.reply_comment_total === 0 || rawRoot.reply_comment_total === '0' ? 'known-empty' : 'reject' });
    if (replyResult.warning) throw Object.assign(new Error(`楼中回复读取不完整：${replyResult.warning}`), { code: 'THREAD_INCOMPLETE' });
    const target = comments.find(comment => comment.cid === targetCid);
    if (!target) throw Object.assign(new Error('完整楼层中未找到目标评论；无法继续回复'), { code: 'THREAD_TARGET_NOT_FOUND' });
    if (!target.authorUid || target.authorUid !== targetAuthorUid) throw Object.assign(new Error('目标评论作者与先前记录不一致；无法继续回复'), { code: 'THREAD_TARGET_MISMATCH' });
    return { complete: true, root, target, comments };
  }
  async uploadImage(filePath) {
    if (typeof filePath !== 'string' || !filePath) throw new Error('Image path is required');
    const ext = path.extname(filePath).toLowerCase();
    const formats = { '.gif': 'gif', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp' };
    if (!formats[ext]) throw new Error('Unsupported local image format');
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > 10 * 1024 * 1024) throw new Error('Image must be a regular file between 1 byte and 10 MiB');
    const identity = await this._call('identity.get');
    if (optionalId(identity?.uid) !== this.accountUid) throw new Error('Current login changed before upload');
    const bytes = await fs.readFile(filePath);
    const actual = bytes.subarray(0, 6).toString('ascii');
    const valid = formats[ext] === 'gif' ? /^GIF8[79]a$/.test(actual)
      : formats[ext] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : formats[ext] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!valid) throw new Error('Image bytes do not match the file extension');
    const base64 = bytes.toString('base64'); const uploadId = randomUUID();
    await this._call('images.begin', { uploadId, expectedLength: base64.length });
    try {
      for (let i = 0; i < base64.length; i += 384 * 1024) await this._call('images.append', { uploadId, chunk: base64.slice(i, i + 384 * 1024) });
      const image = await this._call('images.upload', { uploadId });
      if (!image?.uri) throw new Error('Image upload did not return a URI');
      return { uri: image.uri, width: image.width, height: image.height, format: image.format || formats[ext] };
    } catch (error) { try { await this._call('images.reset', { uploadId }); } catch {} throw error; }
  }
  async publishReply({ videoId, targetCid, rootCid = null, text, images = [], signal }) {
    let publishStarted = false;
    let receiptCid;
    try {
      signal?.throwIfAborted();
      id(videoId, 'videoId'); id(targetCid, 'targetCid'); if (rootCid != null) id(rootCid, 'rootCid');
      if (!Array.isArray(images) || images.length > 9) throw new Error('At most nine reply images are allowed');
      if (typeof text !== 'string' || (!text.trim() && images.length === 0)) throw new Error('Reply text or an image is required');
      await this.verifyVideo(videoId);
      signal?.throwIfAborted();
      const uploaded = [];
      for (const image of images) uploaded.push(typeof image === 'string' ? await this.uploadImage(image) : image);
      await this.verifyVideo(videoId);
      signal?.throwIfAborted();
      // Validate before crossing the comment-send boundary, including any image
      // metadata produced by upload. An invalid local payload was never published.
      validateCommand('comments.publish', { accountUid: this.accountUid, videoId, targetCid, rootCid, text, images: uploaded });
      publishStarted = true;
      const response = await this._call('comments.publish', { videoId, targetCid, rootCid, text, images: uploaded });
      // Even a contradictory business rejection can contain a usable receipt;
      // retain its ID for reconciliation rather than assuming nothing was sent.
      try { receiptCid = optionalId(response?.comment?.cid) || undefined; } catch { /* malformed receipt ID */ }
      const data = checkResult(response, 'comments.publish');
      if (!data.comment?.cid) throw Object.assign(new Error('Publish response has no comment receipt; reconcile before retrying'), { outcomeUnknown: true });
      const cid = requirePlatformId(data.comment.cid, 'published comment cid');
      const expected = { aweme_id: videoId, reply_id: rootCid || targetCid,
        reply_to_reply_id: rootCid && rootCid !== targetCid ? targetCid : null };
      const targetVerification = {};
      for (const [key, value] of Object.entries(expected)) {
        if (!Object.hasOwn(data.comment, key)) { targetVerification[key] = 'missing'; continue; }
        let actual;
        try { actual = optionalId(data.comment[key]); } catch { actual = undefined; }
        if (actual !== value) throw Object.assign(new Error(`Publish receipt ${key} does not match requested target; reconcile before retrying`), { outcomeUnknown: true, cid });
        targetVerification[key] = 'matched';
      }
      const suppliedAuthorKeys = ['uid', 'uid_str'].filter(key => data.comment.user && Object.hasOwn(data.comment.user, key));
      for (const key of suppliedAuthorKeys) {
        let actual;
        try { actual = optionalId(data.comment.user[key]); } catch { actual = undefined; }
        if (actual !== this.accountUid) throw Object.assign(new Error('Publish receipt author does not match configured account; reconcile before retrying'), { outcomeUnknown: true, cid });
      }
      const authorVerified = suppliedAuthorKeys.length > 0;
      const targetVerified = authorVerified && Object.values(targetVerification).every(value => value === 'matched');
      const imageCount = Array.isArray(data.comment.image_list) ? data.comment.image_list.length : 0;
      const warnings = [];
      if (!Object.values(targetVerification).every(value => value === 'matched')) warnings.push('Platform receipt omits target fields; reply placement is not fully verified');
      if (!authorVerified) warnings.push('Platform receipt omits author identity; publishing account is not fully verified');
      if (imageCount < uploaded.length) warnings.push(`Platform receipt contains ${imageCount}/${uploaded.length} images; inspect before retrying`);
      return { cid, imageCount, expectedImageCount: uploaded.length, imagesAttached: imageCount >= uploaded.length,
        targetVerified, targetVerification, authorVerified, warnings, warning: warnings.join('; ') || null };
    } catch (error) {
      // Before comments.publish (including upload failures), no comment was
      // sent. After that boundary, only explicit bridge evidence can prove it.
      if (!publishStarted || error.definitelyNotSent === true) {
        error.definitelyNotSent = true;
        error.outcomeUnknown = false;
      } else {
        error.outcomeUnknown = true;
        if (receiptCid) error.cid = receiptCid;
      }
      throw error;
    }
  }
}
module.exports = { DouyinAdapter, normalizeComment, optionalId };
