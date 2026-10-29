'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomBytes, createHmac } = require('node:crypto');
const { validateSchema } = require('./llm');

const ADDRESSED_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['addressed', 'reason'],
  properties: { addressed: { type: 'boolean' }, reason: { type: 'string', minLength: 1, maxLength: 240 } },
};
const REPLY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['text', 'stickerQuery'],
  properties: { text: { type: 'string', maxLength: 120 }, stickerQuery: { type: ['string', 'null'], maxLength: 60 } },
};

function textOf(value) {
  if (typeof value === 'string') return value;
  return typeof value?.text === 'string' ? value.text : typeof value?.reply === 'string' ? value.reply : '';
}

function localId(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

// IDs are used only inside this function. The model receives anonymous authors,
// local message references and host-derived relationships, never platform IDs.
function conversationData(comment, thread, relationships, speakerLabel) {
  const items = (Array.isArray(thread) ? thread : []).slice(-16);
  const ownUids = new Set(items.filter(item => item?.isOwn === true).map(item => localId(item.authorUid)).filter(Boolean));
  const byCid = new Map(items.filter(item => localId(item?.cid)).map(item => [localId(item.cid), item]));
  const refs = new Map(items.map((item, index) => [localId(item?.cid), `message-${index + 1}`]).filter(([cid]) => cid));
  const speaker = item => item?.isOwn === true || ownUids.has(localId(item?.authorUid))
    ? '大肥鱼' : speakerLabel(localId(item?.authorUid));
  const pointer = (item, known) => {
    if (!known) return { replyToMessageRef: null, replyToSpeaker: null };
    const parent = byCid.get(localId(item?.replyToCid));
    const targetUid = localId(item?.replyToUid);
    return {
      replyToMessageRef: refs.get(localId(item?.replyToCid)) || null,
      replyToSpeaker: parent ? speaker(parent) : targetUid ? (ownUids.has(targetUid) ? '大肥鱼' : speakerLabel(targetUid)) : null,
    };
  };
  const replyKnown = relationships?.replyRelationKnown === true || comment?.replyRelationKnown === true;
  const parent = replyKnown ? byCid.get(localId(comment?.replyToCid)) : undefined;
  const isReplyToSelf = replyKnown && (relationships?.isReplyToSelf === true || parent?.isOwn === true);
  const mentionsKnown = relationships?.mentionsKnown === true || comment?.mentionsKnown === true;
  const known = {
    replyRelationKnown: replyKnown, mentionsKnown,
    isReplyToSelf,
    isReplyToOther: replyKnown && !isReplyToSelf && (relationships?.isReplyToOther === true || Boolean(parent && parent.isOwn === false && localId(parent.authorUid))),
    isMentioningSelf: mentionsKnown && relationships?.isMentioningSelf === true,
    isMentioningOther: mentionsKnown && relationships?.isMentioningOther === true,
  };
  const messages = items.map((item, index) => ({
    messageRef: `message-${index + 1}`, text: textOf(item), speaker: speaker(item),
    ...pointer(item, item?.replyRelationKnown === true),
  }));
  const currentPointer = pointer(comment, replyKnown);
  if (known.isReplyToSelf) currentPointer.replyToSpeaker = '大肥鱼';
  return {
    comment: { text: textOf(comment), speaker: speaker(comment), messageRef: 'current', ...currentPointer },
    thread: messages,
    directParent: parent ? messages[items.indexOf(parent)] : null,
    relationships: known,
  };
}

function recentData(replies) {
  return (Array.isArray(replies) ? replies : []).slice(0, 12).map(textOf).filter(Boolean);
}

function meaningfulText(text) {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function outputError(message) {
  const error = new Error(message);
  error.code = 'AGENT_OUTPUT_INVALID';
  return error;
}

class Agent {
  constructor({ llm, promptDir = join(__dirname, '../../prompts') } = {}) {
    if (!llm || typeof llm.completeJson !== 'function') throw new TypeError('Agent 需要 completeJson 模型客户端');
    this.llm = llm;
    // Stable within this Agent process; a fresh salt prevents these labels from
    // becoming portable hashes of real account IDs in logs or model requests.
    const salt = randomBytes(32);
    this.speakerLabel = uid => uid ? `观众-${createHmac('sha256', salt).update(uid).digest('hex').slice(0, 12)}` : '身份未知的评论者';
    this.prompts = Object.fromEntries(['persona', 'addressed', 'reply', 'sticker'].map(name =>
      [name, readFileSync(join(promptDir, `${name}.md`), 'utf8')]));
  }

  async decideAddressed(comment, { thread = [], recentReplies = [], relationships = {} } = {}) {
    if (!textOf(comment).trim()) return { addressed: false, reason: '没有可理解的文字问题' };
    const result = await this.llm.completeJson(
      `${this.prompts.persona}\n\n${this.prompts.addressed}`,
      JSON.stringify({ ...conversationData(comment, thread, relationships, this.speakerLabel), recentReplies: recentData(recentReplies) }),
      { schema: ADDRESSED_SCHEMA },
    );
    validateSchema(result, ADDRESSED_SCHEMA);
    if (!result.reason.trim()) throw outputError('语义判定必须给出原因');
    return { addressed: result.addressed, reason: result.reason.trim() };
  }

  async generate(comment, { kinds = [], thread = [], recentReplies = [], relationships = {}, stickersEnabled = false, allowImageOnly = false } = {}) {
    const result = await this.llm.completeJson(
      `${this.prompts.persona}\n\n${this.prompts.reply}`,
      JSON.stringify({
        ...conversationData(comment, thread, relationships, this.speakerLabel),
        triggerKinds: Array.isArray(kinds) ? kinds : [],
        recentReplies: recentData(recentReplies),
        stickersEnabled: stickersEnabled === true,
        allowImageOnly: allowImageOnly === true,
      }),
      { schema: REPLY_SCHEMA },
    );
    validateSchema(result, REPLY_SCHEMA);
    const text = result.text.trim();
    const stickerQuery = result.stickerQuery?.trim() || '';
    if (!text && stickerQuery && allowImageOnly !== true) {
      throw outputError('当前未启用纯图回复，模型必须提供文字或跳过');
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text + stickerQuery)) {
      throw outputError('模型回复包含控制字符');
    }
    const normalized = meaningfulText(text);
    if (text && (!normalized || recentData(recentReplies).some(previous => meaningfulText(previous) === normalized))) {
      throw outputError('模型回复无有效文字或重复近期回复，本次不发送');
    }
    return { text, ...(stickerQuery ? { stickerQuery } : {}) };
  }

  async chooseSticker(candidates, context = {}) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    const allowed = new Map();
    for (const candidate of candidates) {
      const id = typeof candidate?.id === 'string' || typeof candidate?.id === 'number' ? String(candidate.id) : '';
      if (!id || allowed.has(id)) throw new TypeError('表情候选必须有唯一 ID');
      allowed.set(id, {
        id,
        tags: Array.isArray(candidate.tags) ? candidate.tags.map(String) : [],
        description: String(candidate.description || candidate.caption || candidate.name || ''),
      });
    }
    const schema = {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: { id: { type: ['string', 'null'], enum: [...allowed.keys(), null] } },
    };
    const result = await this.llm.completeJson(
      `${this.prompts.persona}\n\n${this.prompts.sticker}`,
      JSON.stringify({
        candidates: [...allowed.values()],
        context: { comment: textOf(context.comment), replyText: String(context.replyText || context.text || ''), stickerQuery: String(context.stickerQuery || '') },
      }),
      { schema },
    );
    validateSchema(result, schema);
    return result.id;
  }
}

module.exports = { Agent };
