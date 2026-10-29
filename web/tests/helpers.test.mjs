import test from 'node:test';
import assert from 'node:assert/strict';
import { activityReason, filterActivities, filterLogs, isBusy, mergeUnique, serializeActivities, toForm, toPayload } from '../src/helpers.mjs';

test('configuration round-trip preserves advanced fields and string IDs without returning secrets or bridge settings', () => {
  const current = {
    accountUid: '123456', videos: ['1234567890123456789'],
    bridge: { tokenConfigured: true, host: '127.0.0.1', port: 19422 },
    model: { provider: 'deepseek', model: '', timeoutMs: 31500, apiKeyEnv: 'CUSTOM_KEY' },
    worker: { pollIntervalMs: 1500, sendIntervalMs: 60000, maxRepliesPerRound: 3, maxCandidatesPerRound: 30 },
    stickers: { enabled: false, mode: 'optional', limit: 5, autoSync: 'lazy', allowedMimeTypes: ['image/gif'] },
    douyin: { inboundSchemaConfirmed: false, maxPages: 50, maxReplyPages: 50 },
    triggers: { respondToNameCall: true },
  };
  const form = toForm(current);
  form.videosText += '\nhttps://www.douyin.com/user/self?modal_id=7701931167167171868\n';
  form.secrets.deepseek = ' replacement-key ';
  const payload = toPayload(form, current, 'revision');
  assert.equal(payload.config.accountUid, '123456');
  assert.equal(payload.config.videos[0], '1234567890123456789');
  assert.equal(payload.config.videos.length, 2);
  assert.equal(payload.config.worker.pollIntervalMs, 1500);
  assert.equal(payload.config.model.timeoutMs, 31500);
  assert.equal(payload.config.model.apiKeyEnv, 'CUSTOM_KEY');
  assert.deepEqual(payload.config.stickers.allowedMimeTypes, ['image/gif']);
  assert.equal(Object.hasOwn(payload.config, 'bridge'), false);
  assert.equal(Object.hasOwn(payload.config.model, 'timeoutSeconds'), false);
  assert.deepEqual(payload.secrets, { deepseek: 'replacement-key' });
  assert.equal(current.videos.length, 1);
  assert.equal(payload.revision, 'revision');
});

test('blank password fields preserve stored keys and running states lock configuration', () => {
  const config = { model: {}, worker: {}, stickers: {}, douyin: {} };
  const payload = toPayload(toForm(config), config, 'r1');
  assert.deepEqual(payload.secrets, {});
  assert.equal(isBusy('stopping'), true);
  assert.equal(isBusy('external'), true);
  assert.equal(isBusy('running'), true);
  assert.equal(isBusy('stopped'), false);
});

test('log view independently applies minimum level and text search across event details', () => {
  const logs = [
    { id: 'a', level: 'debug', message: '扫描开始' },
    { id: 'b', level: 'info', message: '已生成回复' },
    { id: 'c', level: 'warn', message: '待核查', data: { missing: 'aweme_id' } },
    { id: 'd', level: 'error', message: '请求失败' },
  ];
  assert.deepEqual(filterLogs(logs, 'warn', '').map(item => item.id), ['c', 'd']);
  assert.deepEqual(filterLogs(logs, 'debug', 'AWEME_ID').map(item => item.id), ['c']);
  assert.deepEqual(filterLogs(logs, 'error', '待核查'), []);
});

test('replayed SSE entries update in place without duplicating and remain bounded', () => {
  const merged = mergeUnique([{ id: 'a', message: 'old' }, { id: 'b' }], [{ id: 'a', message: 'new' }, { id: 'c' }], 'id', 3);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].message, 'new');
  assert.deepEqual(mergeUnique(merged, [{ id: 'd' }], 'id', 2).map(item => item.id), ['c', 'd']);
});

test('conversation view keeps unknown distinct from failed and obeys the independent severity filter', () => {
  const records = ['succeeded', 'skipped', 'unknown', 'failed'].map(status => ({ status }));
  assert.deepEqual(filterActivities(records, 'warn').map(item => item.status), ['unknown', 'failed']);
  assert.deepEqual(filterActivities(records, 'error').map(item => item.status), ['failed']);
});

test('conversation export preserves the visible comment, reply, result and reason instead of exporting process messages', () => {
  const records = [
    { jobKey: 'old', videoId: '20001', targetCid: '40001', commentText: '大肥鱼！', replyText: '鱼在呢', status: 'succeeded', updatedAt: 1793260000000 },
    { jobKey: 'uncertain', videoId: '20001', targetCid: '40002', commentText: '大肥鱼，吃了吗？', replyText: '鱼刚吃完', status: 'unknown', reason: '缺少作品 ID，待核查', updatedAt: 1793260010000 },
  ];
  const visible = filterActivities(records, 'warn');
  const text = serializeActivities(visible, 'txt');
  assert.match(text, /观众：大肥鱼，吃了吗？/);
  assert.match(text, /大肥鱼：鱼刚吃完/);
  assert.match(text, /结果：待核查/);
  assert.match(text, /原因：缺少作品 ID，待核查/);
  assert.doesNotMatch(text, /鱼在呢/);
  assert.deepEqual(serializeActivities(visible, 'jsonl').trim().split('\n').map(line => JSON.parse(line)), visible);
  assert.equal(serializeActivities([], 'txt'), '');
  assert.equal(serializeActivities([], 'jsonl'), '');
  assert.throws(() => serializeActivities(records, 'csv'), /TXT/);
});

test('readback-confirmed reply is not presented as a complete publishing receipt', () => {
  const readback = { status: 'succeeded', verificationSource: 'readback', reason: '评论已提交，但回执未确认目标楼层；核查前不重发' };
  assert.equal(activityReason(readback), '只读核查确认发送，原始发布回执不完整。');
  const text = serializeActivities([{ ...readback, videoId: '1', targetCid: '2' }], 'txt');
  assert.match(text, /只读核查确认发送，原始发布回执不完整/);
  assert.doesNotMatch(text, /发布回执已确认/);
  assert.equal(activityReason({ status: 'succeeded' }), '账号、目标楼层与发布回执已确认。');
  assert.equal(activityReason({ status: 'unknown', reason: '结果不确定' }), '结果不确定');
});
