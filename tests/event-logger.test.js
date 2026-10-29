'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventLogger } = require('../src/services/logger');
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-logs-'));
  const log = new EventLogger({ directory, ...options });
  t.after(() => { log.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { log, directory };
}
test('落盘、实时流和历史查询都不泄露密钥或认证字段', t => {
  const secret = 'private-bridge-pairing-123456';
  const { log, directory } = fixture(t, { secretValues: () => [secret] });
  let received;
  log.subscribe(e => { received = e; });
  log.write({ message: `请求失败 ${secret}`, data: { apiKey: secret, token: secret, cookie: 'session=private', Authorization: 'Bearer private123', safe: '评论内容' } });
  const text = JSON.stringify({ received, result: log.list() }) + fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8');
  assert.equal(text.includes(secret), false); assert.equal(text.includes('session=private'), false); assert.equal(text.includes('Bearer private123'), false);
  assert.ok(text.includes('评论内容')); assert.ok(text.includes('[REDACTED]'));
  const restored = new EventLogger({ directory, secretValues: () => [secret] });
  assert.equal(restored.list().items.length, 1); restored.close();
});
test('级别与搜索独立筛选，游标只返回之后的事件', t => {
  const { log } = fixture(t);
  log.write({ level: 'debug', message: '扫描' });
  const first = log.write({ level: 'info', message: '回复成功' });
  log.write({ level: 'warn', message: '回执待核查' });
  log.write({ level: 'error', message: '模型失败' });
  assert.equal(log.list({ level: 'warn' }).items.length, 2);
  assert.deepEqual(log.list({ after: first.id, query: '回执' }).items.map(e => e.level), ['warn']);
  assert.equal(log.list({ after: 'expired-cursor', limit: 1 }).reset, true);
});
test('日志轮转和缓存有界，重启后跳过损坏的尾行', t => {
  const { log, directory } = fixture(t, { maxBytes: 250, maxRecords: 3 });
  for (let i = 0; i < 12; i++) log.write({ message: '事件' + i });
  assert.equal(log.list().items.length, 3);
  assert.ok(fs.readdirSync(directory).length <= 4);
  fs.appendFileSync(path.join(directory, 'events.jsonl'), '{incomplete');
  const restored = new EventLogger({ directory, maxRecords: 3 });
  assert.equal(restored.list().items.at(-1).message, '事件11'); restored.close();
});
test('日志观察者断开或抛错不会中断业务，取消订阅后不再通知', t => {
  const { log } = fixture(t); let calls = 0;
  log.subscribe(() => { throw new Error('UI closed'); });
  const unsubscribe = log.subscribe(() => { calls++; });
  assert.doesNotThrow(() => log.write({ message: '发送结果' }));
  unsubscribe(); log.write({ message: '下一轮' }); assert.equal(calls, 1);
});

test('序列化错误文字中的临时上传凭证也会脱敏', t => {
  const { log } = fixture(t);
  const entry = log.write({ message: '上传失败 {"AccessKeyId":"temporary-access-value","SecretAccessKey":"temporary-secret-value","SessionToken":"temporary-session-value"}' });
  const visible = JSON.stringify(entry) + JSON.stringify(log.list());
  for (const value of ['temporary-access-value', 'temporary-secret-value', 'temporary-session-value']) assert.equal(visible.includes(value), false);
});
