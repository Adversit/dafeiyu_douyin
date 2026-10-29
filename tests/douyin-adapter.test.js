'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DouyinAdapter, normalizeComment } = require('../src/douyin/adapter');
const ACCOUNT = '123456'; const VIDEO = '1234567890123456789';
function bridgeWith(handler = () => { throw new Error('Unexpected command'); }) {
  const calls = [];
  return { calls, async call(command, args) {
    calls.push({ command, args });
    if (command === 'identity.get') return { uid: ACCOUNT };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: ACCOUNT }, desc: 'Owned fixture' } };
    return handler(command, args);
  } };
}
test('normalization keeps full text and never infers a direct target from tree position', () => {
  const raw = { cid: '42', text: '字'.repeat(300), user: { uid: '55555' }, reply_id: '7', text_extra: [{ type: 0, user_id: ACCOUNT }] };
  const event = normalizeComment(raw, { videoId: VIDEO, rootCid: '7' });
  assert.equal(event.text.length, 300); assert.equal(event.rootCid, '7'); assert.equal(event.replyToCid, null);
  assert.equal(event.replyRelationKnown, false); assert.equal(event.mentionsKnown, false);
  assert.deepEqual(event.mentionUids, [ACCOUNT]); assert.equal(event.rawRelationshipFields.reply_id, '7');
});
test('provisional incoming field parsing requires explicit live-schema confirmation', () => {
  const raw = { cid: '42', text: '@大肥鱼', reply_to_reply_id: '40', reply_to_uid: ACCOUNT, text_extra: [{ type: 0, user_id: ACCOUNT }, { type: 1, user_id: '90000' }] };
  const event = normalizeComment(raw, { videoId: VIDEO, inboundSchemaConfirmed: true });
  assert.equal(event.replyToCid, '40'); assert.equal(event.replyToUid, ACCOUNT);
  assert.equal(event.replyRelationKnown, true); assert.equal(event.mentionsKnown, true); assert.deepEqual(event.mentionUids, [ACCOUNT]);
  const missing = normalizeComment({ cid: '43', text: 'hello' }, { videoId: VIDEO, inboundSchemaConfirmed: true });
  assert.equal(missing.mentionsKnown, false); assert.equal(missing.replyRelationKnown, false);
});
test('numeric IDs that already lost precision are rejected', () => {
  assert.throws(() => normalizeComment({ cid: 1234567890123456789 }, { videoId: VIDEO }), /Unsafe numeric/);
});
test('verifyVideo rejects changed login and other authors before reading comments', async () => {
  const changed = { async call() { return { uid: '654321' }; } };
  await assert.rejects(new DouyinAdapter({ bridge: changed, accountUid: ACCOUNT }).verifyVideo(VIDEO), /login/);
  const other = { async call(cmd) { return cmd === 'identity.get' ? { uid: ACCOUNT } : { aweme_detail: { author: { uid: '654321' } } }; } };
  await assert.rejects(new DouyinAdapter({ bridge: other, accountUid: ACCOUNT }).verifyVideo(VIDEO), /belong/);
});
test('scan reads complete root and reply pagination, preserving string IDs and direct-reply uncertainty', async () => {
  const bridge = bridgeWith((cmd, args) => {
    if (cmd === 'comments.list') return args.cursor === '0'
      ? { comments: [{ cid: '1', text: 'root', reply_comment_total: 2 }], has_more: 1, cursor: 20 }
      : { comments: [{ cid: '4', text: 'next', reply_comment_total: 0 }], has_more: 0 };
    if (cmd === 'comments.replies') return args.cursor === '0'
      ? { comments: [{ cid: '2', text: 'child' }], has_more: true, cursor: '20' }
      : { comments: [{ cid: '3', text: 'child 2', reply_to_reply_id: '2' }], has_more: false };
    throw new Error(cmd);
  });
  const result = await new DouyinAdapter({ bridge, accountUid: ACCOUNT }).scanVideo(VIDEO);
  assert.equal(result.complete, true); assert.deepEqual(result.comments.map(c => c.cid), ['1', '2', '3', '4']);
  assert.equal(result.comments[2].rootCid, '1'); assert.equal(result.comments[2].replyToCid, '2'); assert.equal(result.comments[2].replyRelationKnown, false);
  assert.equal(bridge.calls.filter(c => c.command === 'comments.replies').length, 2);
});
test('scan page limit and absent pagination metadata explicitly report incomplete', async () => {
  const bridge = bridgeWith(() => ({ comments: [{ cid: '1', reply_comment_total: 0 }], cursor: '20', has_more: true }));
  const result = await new DouyinAdapter({ bridge, accountUid: ACCOUNT }).scanVideo(VIDEO, { maxPages: 1 });
  assert.equal(result.complete, false); assert.match(result.warnings.join(' '), /limit/);
  const missing = bridgeWith(() => ({ comments: [{ cid: '1', reply_comment_total: 0 }] }));
  const result2 = await new DouyinAdapter({ bridge: missing, accountUid: ACCOUNT }).scanVideo(VIDEO);
  assert.equal(result2.complete, false); assert.match(result2.warnings.join(' '), /has_more/);
});
test('scan refuses repeating cursors or pages with no progress', async () => {
  const repeated = bridgeWith(() => ({ comments: [{ cid: '1', reply_comment_total: 0 }], cursor: '0', has_more: true }));
  await assert.rejects(new DouyinAdapter({ bridge: repeated, accountUid: ACCOUNT }).scanVideo(VIDEO), { code: 'PAGINATION_STALLED' });
  const sameItems = bridgeWith((cmd, args) => ({ comments: [{ cid: '1', reply_comment_total: 0 }], cursor: args.cursor === '0' ? '20' : '40', has_more: true }));
  await assert.rejects(new DouyinAdapter({ bridge: sameItems, accountUid: ACCOUNT }).scanVideo(VIDEO), { code: 'PAGINATION_STALLED' });
});
test('publish rechecks identity and ownership and passes thread root plus actual target', async () => {
  const bridge = bridgeWith((cmd, args) => {
    assert.equal(cmd, 'comments.publish'); assert.equal(args.targetCid, '3'); assert.equal(args.rootCid, '1');
    assert.equal(args.accountUid, ACCOUNT); return { status_code: 0, comment: { cid: '19', image_list: [] } };
  });
  const result = await new DouyinAdapter({ bridge, accountUid: ACCOUNT }).publishReply({ videoId: VIDEO, targetCid: '3', rootCid: '1', text: '收到' });
  assert.equal(result.cid, '19'); assert.equal(result.imageCount, 0);
  assert.deepEqual(bridge.calls.map(c => c.command), ['identity.get', 'video.get', 'identity.get', 'video.get', 'comments.publish']);
});
test('publish receipt without a cid is uncertain and is not retried', async () => {
  const bridge = bridgeWith(() => ({ status_code: 0 }));
  await assert.rejects(new DouyinAdapter({ bridge, accountUid: ACCOUNT }).publishReply({ videoId: VIDEO, targetCid: '1', text: '收到' }), error => error.outcomeUnknown === true);
  assert.equal(bridge.calls.filter(c => c.command === 'comments.publish').length, 1);
});
test('image upload checks bytes and delivers bounded chunks with one upload ID', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-test-'));
  try {
    const filename = path.join(dir, 'fixture.gif'); await fs.writeFile(filename, Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(400000)]));
    const bridge = bridgeWith(cmd => cmd === 'images.upload' ? { uri: 'tos/fixture', width: 100, height: 100, format: 'gif' } : true);
    const image = await new DouyinAdapter({ bridge, accountUid: ACCOUNT }).uploadImage(filename);
    assert.equal(image.format, 'gif'); const chunks = bridge.calls.filter(c => c.command === 'images.append');
    assert.equal(chunks.length, 2); assert.equal(new Set(chunks.map(c => c.args.uploadId)).size, 1);
    await fs.writeFile(filename, 'not a gif');
    await assert.rejects(new DouyinAdapter({ bridge, accountUid: ACCOUNT }).uploadImage(filename), /bytes/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('capped root and reply cursors resume across rounds until the scan cycle completes', async () => {
  const bridge = bridgeWith((cmd, args) => {
    if (cmd === 'comments.list') return args.cursor === '0'
      ? { comments: [{ cid: '1', reply_comment_total: 2 }], has_more: true, cursor: '20' }
      : { comments: [{ cid: '4', reply_comment_total: 0 }], has_more: false };
    return args.cursor === '0'
      ? { comments: [{ cid: '2' }], has_more: true, cursor: '20' }
      : { comments: [{ cid: '3' }], has_more: false };
  });
  const adapter = new DouyinAdapter({ bridge, accountUid: ACCOUNT });
  const first = await adapter.scanVideo(VIDEO, { maxPages: 1, maxReplyPages: 1 });
  assert.equal(first.complete, false);
  assert.deepEqual(first.continuation, { rootCursor: '20', replies: [{ rootCid: '1', cursor: '20' }] });
  const second = await adapter.scanVideo(VIDEO, { maxPages: 1, maxReplyPages: 1, continuation: first.continuation });
  assert.equal(second.complete, true); assert.equal(second.continuation, null); assert.deepEqual(second.comments.map(c => c.cid), ['3', '4']);
});
test('publish checks receipt destination and marks missing fields as unverified', async () => {
  const bridge = bridgeWith(() => ({ comment: { cid: '19', aweme_id: VIDEO, reply_id: '1', reply_to_reply_id: '3', user: { uid: ACCOUNT } } }));
  const adapter = new DouyinAdapter({ bridge, accountUid: ACCOUNT });
  assert.equal((await adapter.publishReply({ videoId: VIDEO, targetCid: '3', rootCid: '1', text: '收到' })).targetVerified, true);
  const mismatch = bridgeWith(() => ({ comment: { cid: '20', aweme_id: VIDEO, reply_id: '999' } }));
  await assert.rejects(new DouyinAdapter({ bridge: mismatch, accountUid: ACCOUNT }).publishReply({ videoId: VIDEO, targetCid: '3', rootCid: '1', text: '收到' }), error => error.outcomeUnknown === true && error.cid === '20');
  const missing = bridgeWith(() => ({ comment: { cid: '21' } }));
  const receipt = await new DouyinAdapter({ bridge: missing, accountUid: ACCOUNT }).publishReply({ videoId: VIDEO, targetCid: '1', text: '收到' });
  assert.equal(receipt.targetVerified, false); assert.equal(receipt.targetVerification.reply_id, 'missing'); assert.match(receipt.warning, /not fully verified/);
});

test('comment timestamps convert seconds to safe integer milliseconds', () => {
  const normalized = value => normalizeComment({ cid: '42', create_time: value }, { videoId: VIDEO }).createdAt;
  assert.equal(normalized(1700000000), 1700000000000);
  assert.equal(normalized('1700000000'), 1700000000000);
  assert.equal(normalized(0), 0);
  assert.equal(normalized(8640000000000), 8640000000000000);
  for (const value of [undefined, null, '', true, [], -1, 1.5, Infinity, NaN, '0x10', '1e9', 8640000000001]) {
    assert.equal(normalized(value), null, `invalid timestamp: ${String(value)}`);
  }
});

test('confirmed explicit-zero direct-root evidence requires matching query root and reply_id', () => {
  const event = normalizeComment({ cid: '42', reply_id: '7', reply_to_reply_id: '0' }, {
    videoId: VIDEO, rootCid: '7', inboundSchemaConfirmed: true,
  });
  assert.equal(event.replyToCid, '7');
  assert.equal(event.replyRelationKnown, true);
  for (const [raw, options] of [
    [{ reply_id: '7', reply_to_reply_id: '0' }, { rootCid: '7', inboundSchemaConfirmed: false }],
    [{ reply_id: '7' }, { rootCid: '7', inboundSchemaConfirmed: true }],
    [{ reply_id: '8', reply_to_reply_id: '0' }, { rootCid: '7', inboundSchemaConfirmed: true }],
    [{ reply_to_reply_id: '0' }, { rootCid: '7', inboundSchemaConfirmed: true }],
    [{ reply_id: '7', reply_to_reply_id: '0' }, { inboundSchemaConfirmed: true }],
  ]) {
    const other = normalizeComment({ cid: '42', ...raw }, { videoId: VIDEO, ...options });
    assert.equal(other.replyToCid, null);
    assert.equal(other.replyRelationKnown, false);
  }
});

test('publish verifies all provided author IDs and retains the receipt on a mismatch', async () => {
  for (const user of [{ uid: '654321' }, { uid_str: '654321' }, { uid: ACCOUNT, uid_str: '654321' }]) {
    const bridge = bridgeWith(() => ({ comment: {
      cid: '19', aweme_id: VIDEO, reply_id: '1', reply_to_reply_id: '3', user,
    } }));
    await assert.rejects(new DouyinAdapter({ bridge, accountUid: ACCOUNT }).publishReply({
      videoId: VIDEO, targetCid: '3', rootCid: '1', text: '收到',
    }), error => error.outcomeUnknown === true && error.cid === '19' && !error.definitelyNotSent);
    assert.equal(bridge.calls.filter(c => c.command === 'comments.publish').length, 1);
  }
});

test('a uid_str author is accepted but a missing author cannot fully verify publishing', async () => {
  const adapterFor = user => new DouyinAdapter({ accountUid: ACCOUNT, bridge: bridgeWith(() => ({ comment: {
    cid: '19', aweme_id: VIDEO, reply_id: '1', reply_to_reply_id: '0', ...(user ? { user } : {}),
  } })) });
  const args = { videoId: VIDEO, targetCid: '1', text: '收到' };
  const verified = await adapterFor({ uid_str: ACCOUNT }).publishReply(args);
  assert.equal(verified.authorVerified, true);
  assert.equal(verified.targetVerified, true);
  const missing = await adapterFor(null).publishReply(args);
  assert.equal(missing.authorVerified, false);
  assert.equal(missing.targetVerified, false);
  assert.match(missing.warning, /author|account/i);
});

test('payload, identity, ownership, protocol and preupload failures are definitely before comment sending', async () => {
  const cases = [
    { args: { text: '' } },
    { identity: '654321' },
    { author: '654321' },
    { args: { images: [{ uri: 'bad uri', width: 20, height: 20, format: 'gif' }] } },
    { args: { images: ['/private/tmp/dafeiyu-nonexistent-preupload.gif'] } },
  ];
  for (const fixture of cases) {
    const calls = [];
    const adapter = new DouyinAdapter({ accountUid: ACCOUNT, bridge: { async call(command) {
      calls.push(command);
      if (command === 'identity.get') return { uid: fixture.identity || ACCOUNT };
      if (command === 'video.get') return { aweme_detail: { author: { uid: fixture.author || ACCOUNT } } };
      throw new Error('Should not dispatch a comment');
    } } });
    await assert.rejects(adapter.publishReply({ videoId: VIDEO, targetCid: '1', text: '收到', ...fixture.args }),
      error => error.definitelyNotSent === true && error.outcomeUnknown === false);
    assert.equal(calls.includes('comments.publish'), false);
  }
});

test('publish keeps explicit bridge non-dispatch evidence but treats transport and receipt failures as unknown', async () => {
  const unsent = Object.assign(new Error('Never dispatched'), { definitelyNotSent: true, outcomeUnknown: false });
  const before = bridgeWith(() => { throw unsent; });
  await assert.rejects(new DouyinAdapter({ bridge: before, accountUid: ACCOUNT }).publishReply({ videoId: VIDEO, targetCid: '1', text: '收到' }),
    error => error.definitelyNotSent === true && error.outcomeUnknown === false);
  for (const handler of [() => { throw new Error('Connection reset'); }, () => ({ status_code: 1001 })]) {
    const bridge = bridgeWith(handler);
    await assert.rejects(new DouyinAdapter({ bridge, accountUid: ACCOUNT }).publishReply({ videoId: VIDEO, targetCid: '1', text: '收到' }),
      error => error.outcomeUnknown === true && error.definitelyNotSent !== true);
    assert.equal(bridge.calls.filter(c => c.command === 'comments.publish').length, 1);
  }
  const contradictory = bridgeWith(() => ({ status_code: 1001, comment: { cid: '20' } }));
  await assert.rejects(new DouyinAdapter({ bridge: contradictory, accountUid: ACCOUNT }).publishReply({ videoId: VIDEO, targetCid: '1', text: '收到' }),
    error => error.outcomeUnknown === true && error.cid === '20' && error.definitelyNotSent !== true);
});
