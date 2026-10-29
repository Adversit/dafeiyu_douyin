'use strict';

const { DouyinAdapter, optionalId } = require('../douyin/adapter');

function platformUserMatches(raw, uid) {
  const values = ['uid', 'uid_str'].filter(k => raw?.user && Object.hasOwn(raw.user, k)).map(k => optionalId(raw.user[k]));
  return values.length > 0 && values.every(value => value === uid);
}

// Values derived from comments are used only locally for comparisons; neither
// results nor logs expose the fetched comment, identity, IDs or credentials.
async function inspectReply(bridge, row, args, config, signal) {
  const event = JSON.parse(row.event_json);
  if (!event.authorUid || typeof event.authorUid !== 'string') throw new Error('目标作者未知');
  const strictBridge = { async call(command, params) {
    signal?.throwIfAborted();
    const result = await bridge.call(command, params);
    signal?.throwIfAborted();
    if (['video.get', 'comments.list', 'comments.replies'].includes(command) && result?.status_code !== 0) throw new Error('读取状态不明确');
    return result;
  } };
  const adapter = new DouyinAdapter({ bridge: strictBridge, accountUid: args.accountUid });
  const detail = await adapter.verifyVideo(args.videoId);
  if (Object.hasOwn(detail, 'aweme_id') && optionalId(detail.aweme_id) !== args.videoId) throw new Error('作品不一致');
  const maxPages = config.douyin?.maxPages ?? 50;
  const maxReplyPages = config.douyin?.maxReplyPages ?? 50;
  let root = null;
  const roots = await adapter._walkPages(args.videoId, 'comments.list', {}, maxPages, page => {
    for (const raw of page) {
      if (optionalId(raw.cid) !== args.rootCid) continue;
      if (root) throw new Error('根评论重复');
      if (Object.hasOwn(raw, 'aweme_id') && optionalId(raw.aweme_id) !== args.videoId) throw new Error('根评论作品不一致');
      root = raw;
    }
  }, { label: '根评论核查', signal, requireStable: true });
  if (roots.warning || !root) throw new Error('根评论读取不完整');
  if (row.target_cid === args.rootCid && !platformUserMatches(root, event.authorUid)) throw new Error('目标作者不匹配');
  const count = root.reply_comment_total;
  if (!(Number.isSafeInteger(count) && count >= 0) && !(typeof count === 'string' && /^\d+$/.test(count) && Number.isSafeInteger(Number(count)))) throw new Error('楼层回复数未知');
  const expectedCount = Number(count);
  let targetFound = row.target_cid === args.rootCid;
  let found = null;
  let replyCount = 0;
  let total = null;
  // Check metadata as well as all pages; a count contradiction is not proof
  // of absence and can be caused by stale, hidden, or filtered platform data.
  const replyBridge = { async call(command, params) {
    const data = await strictBridge.call(command, params);
    if (command === 'comments.replies' && data?.total !== undefined) {
      const n = data.total;
      if (!(Number.isSafeInteger(n) && n >= 0) && !(typeof n === 'string' && /^\d+$/.test(n) && Number.isSafeInteger(Number(n)))) throw new Error('楼层总数无效');
      if (total !== null && total !== Number(n)) throw new Error('楼层总数变化');
      total = Number(n);
    }
    return data;
  } };
  const replyAdapter = new DouyinAdapter({ bridge: replyBridge, accountUid: args.accountUid });
  const replies = await replyAdapter._walkPages(args.videoId, 'comments.replies', { rootCid: args.rootCid }, maxReplyPages, page => {
    for (const raw of page) {
      replyCount++;
      const cid = optionalId(raw.cid);
      if (!cid || cid === args.rootCid) throw new Error('回复编号无效');
      if (Object.hasOwn(raw, 'aweme_id') && optionalId(raw.aweme_id) !== args.videoId) throw new Error('回复作品不一致');
      if (cid === row.target_cid) {
        if (!platformUserMatches(raw, event.authorUid)) throw new Error('目标作者不匹配');
        if (Object.hasOwn(raw, 'reply_id') && optionalId(raw.reply_id) !== args.rootCid) throw new Error('目标楼层不匹配');
        targetFound = true;
      }
      if (cid === args.commentCid) found = raw;
    }
  }, { label: '回复核查', signal, requireStable: true, nullReply: expectedCount === 0 ? 'known-empty' : 'reject' });
  if (replies.warning || !targetFound || replyCount !== expectedCount || (total !== null && total !== replyCount)) throw new Error('楼层不完整或计数不一致');
  if (!found) return 'absent';
  const expectedDirect = row.target_cid === args.rootCid ? null : row.target_cid;
  // Only the explicit platform zero means a direct reply to the root; null,
  // malformed strings and other values are not evidence of that relationship.
  const directMatches = expectedDirect === null
    ? found.reply_to_reply_id === 0 || found.reply_to_reply_id === '0'
    : optionalId(found.reply_to_reply_id) === expectedDirect;
  if (!platformUserMatches(found, args.accountUid) || !Object.hasOwn(found, 'reply_id') || !Object.hasOwn(found, 'reply_to_reply_id') ||
      optionalId(found.reply_id) !== args.rootCid || !directMatches) throw new Error('回复作者或目标不一致');
  return 'present';
}


module.exports = { inspectReply };
