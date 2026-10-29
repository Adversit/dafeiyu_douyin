'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateTrigger } = require('../src/agent/trigger');

const comment = patch => ({
  videoId: 'video-1', cid: 'comment-1', authorUid: 'viewer', text: '你今天吃了啥',
  rootCid: '', replyToCid: '', replyToUid: '', mentionUids: [],
  replyRelationKnown: true, mentionsKnown: true, ...patch,
});

test('结构化回复本人及@本人可同时触发，保留关系证据', () => {
  const input = comment({ replyToUid: 'me', mentionUids: ['other', 'me'] });
  const before = structuredClone(input);
  assert.deepEqual(evaluateTrigger(input, { accountUid: 'me' }), {
    eligible: true, kinds: ['reply_to_me', 'mention_me'],
    evidence: ['reply_to_account_uid', 'structured_mention_uid', 'structured_mention_other_uid'], needsSemantic: false,
    relationships: { replyRelationKnown: true, mentionsKnown: true, isReplyToSelf: true, isReplyToOther: false, isMentioningSelf: true, isMentioningOther: true },
  });
  assert.deepEqual(input, before);
});

test('已知父评论属于本账号时，即使缺少replyToUid也命中', () => {
  const result = evaluateTrigger(comment({ replyToCid: 'mine' }), {
    accountUid: 'me', ownCommentIds: new Set(['mine']),
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.kinds, ['reply_to_me']);
  assert.deepEqual(result.evidence, ['reply_to_own_comment_cid']);
});

test('关系未知时不能把猜测的uid或@文本视为真实关系', () => {
  const result = evaluateTrigger(comment({
    text: '@大肥鱼 来看看', replyToUid: 'me', mentionUids: ['me'],
    replyRelationKnown: false, mentionsKnown: false,
  }), { accountUid: 'me' });
  assert.equal(result.eligible, false);
  assert.equal(result.needsSemantic, true);
});

test('普通文字无需先含大肥鱼关键词，一律交语义层判断', () => {
  for (const text of ['能教教我吗', '这条鱼好圆啊', '@朋友 来看', '大肥鱼今天也很可爱']) {
    const result = evaluateTrigger(comment({ text, mentionUids: ['friend'] }), { accountUid: 'me' });
    assert.equal(result.eligible, false);
    assert.equal(result.needsSemantic, true);
  }
});

test('本人、空文字以及无法确定身份时不触发也不调用语义层', () => {
  for (const input of [comment({ authorUid: 'me' }), comment({ text: '  ' }), comment({ text: '' }), null,
    comment({ authorUid: '' })]) {
    const result = evaluateTrigger(input, { accountUid: 'me' });
    assert.equal(result.eligible, false);
    assert.equal(result.needsSemantic, false);
  }
  assert.equal(evaluateTrigger(comment(), {}).needsSemantic, false);
});

test('已知回复他人与@他人的反证保留给语义层，仍允许明确向鱼发问', () => {
  const result = evaluateTrigger(comment({
    text: '大肥鱼能教我吗', replyToUid: 'viewer-a', mentionUids: ['viewer-b'],
  }), { accountUid: 'me' });
  assert.equal(result.eligible, false);
  assert.equal(result.needsSemantic, true);
  assert.deepEqual(result.relationships, {
    replyRelationKnown: true, mentionsKnown: true,
    isReplyToSelf: false, isReplyToOther: true,
    isMentioningSelf: false, isMentioningOther: true,
  });
});

test('未知字段不能变成回复他人与@他人的反证', () => {
  const result = evaluateTrigger(comment({
    replyToUid: 'viewer-a', mentionUids: ['viewer-b'],
    replyRelationKnown: false, mentionsKnown: false,
  }), { accountUid: 'me' });
  assert.equal(result.relationships.isReplyToOther, false);
  assert.equal(result.relationships.isMentioningOther, false);
});

test('目标cid不在本人缓存中不等于已知回复他人', () => {
  const result = evaluateTrigger(comment({ replyToCid: 'not-cached', replyToUid: '' }), { accountUid: 'me', ownCommentIds: [] });
  assert.equal(result.relationships.isReplyToOther, false);
  assert.equal(result.relationships.isReplyToSelf, false);
  assert.equal(result.needsSemantic, true);
});
