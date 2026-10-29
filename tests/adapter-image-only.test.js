'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DouyinAdapter } = require('../src/douyin/adapter');

const ACCOUNT = '10001', VIDEO = '20001', ROOT = '40001', TARGET = '40002';
const image = { uri: 'tos/fixture-image', width: 100, height: 100, format: 'gif' };

function setup() {
  const calls = [];
  const bridge = { async call(command, args) {
    calls.push({ command, args });
    if (command === 'identity.get') return { uid: ACCOUNT };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: ACCOUNT } } };
    if (command === 'comments.publish') return { status_code: 0, comment: {
      cid: '90001', aweme_id: VIDEO, reply_id: ROOT, reply_to_reply_id: TARGET,
      user: { uid: ACCOUNT }, image_list: [image],
    } };
    throw new Error(`不应调用 ${command}`);
  } };
  return { calls, adapter: new DouyinAdapter({ bridge, accountUid: ACCOUNT }) };
}

test('真实适配器允许无文字但有图的回复，并保留目标及图片回执', async () => {
  const { calls, adapter } = setup();
  const receipt = await adapter.publishReply({ videoId: VIDEO, rootCid: ROOT, targetCid: TARGET, text: '', images: [image] });
  assert.equal(receipt.targetVerified, true);
  assert.equal(receipt.imageCount, 1);
  const publish = calls.filter(call => call.command === 'comments.publish');
  assert.equal(publish.length, 1);
  assert.equal(publish[0].args.text, '');
  assert.deepEqual(publish[0].args.images, [image]);
  assert.equal(publish[0].args.targetCid, TARGET);
  assert.equal(publish[0].args.rootCid, ROOT);
});

test('真实适配器拒绝空文字和空图片，且不跨越发送边界', async () => {
  for (const text of ['', '  ']) {
    const { calls, adapter } = setup();
    await assert.rejects(adapter.publishReply({ videoId: VIDEO, targetCid: ROOT, text, images: [] }),
      error => error.definitelyNotSent === true && error.outcomeUnknown === false);
    assert.equal(calls.length, 0);
  }
});
