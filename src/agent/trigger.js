'use strict';

function id(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

/** Structural evidence is evaluated locally; ordinary text goes to semantic review. */
function evaluateTrigger(comment, { accountUid, ownCommentIds = [] } = {}) {
  const relationships = {
    replyRelationKnown: false, mentionsKnown: false,
    isReplyToSelf: false, isReplyToOther: false,
    isMentioningSelf: false, isMentioningOther: false,
  };
  const result = { eligible: false, kinds: [], evidence: [], needsSemantic: false, relationships };
  if (!comment || typeof comment.text !== 'string' || !comment.text.trim()) {
    result.evidence.push('empty_text');
    return result;
  }
  const me = id(accountUid);
  const author = id(comment.authorUid);
  if (!me || !author) {
    result.evidence.push('missing_account_or_author_identity');
    return result;
  }
  if (author === me) {
    result.evidence.push('own_comment');
    return result;
  }
  const own = new Set(Array.from(ownCommentIds || [], id).filter(Boolean));
  relationships.replyRelationKnown = comment.replyRelationKnown === true;
  relationships.mentionsKnown = comment.mentionsKnown === true;
  if (relationships.replyRelationKnown) {
    const replyUid = id(comment.replyToUid);
    // A missing target CID in the local own-comment set is not evidence that
    // the target belongs to someone else. Only an explicit other UID proves it.
    relationships.isReplyToSelf = replyUid ? replyUid === me : Boolean(id(comment.replyToCid) && own.has(id(comment.replyToCid)));
    relationships.isReplyToOther = Boolean(replyUid && replyUid !== me);
    if (relationships.isReplyToSelf) {
      result.kinds.push('reply_to_me');
      result.evidence.push(replyUid === me ? 'reply_to_account_uid' : 'reply_to_own_comment_cid');
    } else if (relationships.isReplyToOther) result.evidence.push('reply_to_other_account_uid');
  }
  if (relationships.mentionsKnown && Array.isArray(comment.mentionUids)) {
    const mentioned = comment.mentionUids.map(id).filter(Boolean);
    relationships.isMentioningSelf = mentioned.includes(me);
    relationships.isMentioningOther = mentioned.some(uid => uid !== me);
    if (relationships.isMentioningSelf) {
      result.kinds.push('mention_me');
      result.evidence.push('structured_mention_uid');
    }
    if (relationships.isMentioningOther) result.evidence.push('structured_mention_other_uid');
  }
  result.eligible = result.kinds.length > 0;
  result.needsSemantic = !result.eligible;
  if (result.needsSemantic) result.evidence.push('text_requires_addressed_question_review');
  return result;
}

module.exports = { evaluateTrigger };
