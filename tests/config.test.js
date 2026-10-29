'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseVideoId, loadConfig } = require('../src/config');

test('手动作品ID与完整链接解析，拒绝任意域名和短链猜测', () => {
  assert.equal(parseVideoId('1234567890123456789'), '1234567890123456789');
  assert.equal(parseVideoId('https://www.douyin.com/video/1234567890123456789?extra=1'), '1234567890123456789');
  assert.equal(parseVideoId('https://www.douyin.com/?modal_id=1234567890123456789'), '1234567890123456789');
  for (const input of ['https://evil.example/video/1234567', 'https://douyin.com.evil.example/video/1234567', 'https://v.douyin.com/short/', 'file:///tmp/1234567']) assert.throws(() => parseVideoId(input));
  assert.throws(() => parseVideoId(JSON.parse('7456789012345678901')), /字符串/);
  assert.throws(() => parseVideoId(1234567), /字符串/);
});

test('配置验证账号ID类型、配额、功能开关及本地监听', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const good = { accountUid: '10001', videos: ['20001'], bridge: { token: 'ab'.repeat(24) } };
  const write = x => fs.writeFileSync(file, JSON.stringify(x));
  write(good);
  assert.equal(loadConfig(file, { requireAccount: true }).worker.maxRepliesPerRound, 3);
  assert.equal(loadConfig(file).douyin.inboundSchemaConfirmed, false);
  write({ ...good, accountUid: 10001 }); assert.throws(() => loadConfig(file), /字符串/);
  write({ ...good, bridge: { ...good.bridge, host: '0.0.0.0' } }); assert.throws(() => loadConfig(file), /127/);
  write({ ...good, worker: { maxRepliesPerRound: 0 } }); assert.throws(() => loadConfig(file), /maxRepliesPerRound/);
  write({ ...good, stickers: { enabled: 'yes' } }); assert.throws(() => loadConfig(file), /布尔值/);
});
