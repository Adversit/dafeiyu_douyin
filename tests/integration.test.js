'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBridgeServer } = require('../src/bridge/server');
const { BridgeClient } = require('../src/bridge/client');
const { DouyinAdapter } = require('../src/douyin/adapter');
const { ChatClient } = require('../src/agent/llm');
const { Agent } = require('../src/agent/reply');
const { Store } = require('../src/store');
const { Worker } = require('../src/worker');
const { StickerService } = require('../src/stickers/service');

test('真实Bridge/adapter/Agent/SQLite串联，模型与浏览器模拟，跨轮只发布一次', async t => {
  const accountUid = '10001', videoId = '20001', targetCid = '40001';
  const token = 'fixture-local-token';
  const bridge = createBridgeServer({ token, port: 0, requestTimeout: 1000 });
  const { port } = await bridge.start();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-integration-'));
  const store = new Store(path.join(directory, 'state.sqlite'));
  let stopped = false, writes = 0, modelCalls = 0;
  const post = async (route, data) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return response.json();
  };
  const { sessionId } = await post('/api/connect', { accountUid });
  const poller = (async () => {
    while (!stopped) {
      let command;
      try { command = await post('/api/poll', { sessionId }); }
      catch (error) { if (stopped) return; throw error; }
      if (command.type !== 'command') continue;
      const a = command.args;
      let value;
      if (command.command === 'identity.get') value = { uid: accountUid };
      else if (command.command === 'video.get') value = { status_code: 0, aweme_detail: { author: { uid: accountUid } } };
      else if (command.command === 'comments.list') value = { status_code: 0, has_more: 0, comments: [{ cid: targetCid, user: { uid: '30001' }, text: '大肥鱼你在干嘛呀', text_extra: [{ type: 0, user_id: accountUid }], reply_comment_total: 0 }] };
      else if (command.command === 'comments.publish') {
        writes++;
        assert.equal(a.targetCid, targetCid); assert.equal(a.videoId, videoId); assert.equal(a.accountUid, accountUid);
        value = { status_code: 0, comment: { cid: '90001', aweme_id: videoId, reply_id: targetCid, reply_to_reply_id: '0', user: { uid: accountUid }, image_list: [] } };
      } else throw new Error(`Unexpected fixture command ${command.command}`);
      await post('/api/result', { sessionId, id: command.id, value });
    }
  })();
  t.after(async () => { stopped = true; await bridge.close(); await poller; store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const previous = process.env.DAFEIYU_TEST_KEY;
  process.env.DAFEIYU_TEST_KEY = 'mock-only-not-a-real-key';
  t.after(() => { if (previous === undefined) delete process.env.DAFEIYU_TEST_KEY; else process.env.DAFEIYU_TEST_KEY = previous; });
  const llm = new ChatClient({ provider: 'deepseek', apiKeyEnv: 'DAFEIYU_TEST_KEY' }, { fetchImpl: async () => {
    modelCalls++;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '鱼正在认真摸鱼呢', stickerQuery: null }) } }] }) };
  } });
  const adapter = new DouyinAdapter({ accountUid, inboundSchemaConfirmed: true, bridge: new BridgeClient({ port, token }) });
  const worker = new Worker({ config: { accountUid, videos: [videoId], douyin: {}, worker: { maxRepliesPerRound: 3, maxCandidatesPerRound: 30, sendIntervalMs: 1000 }, stickers: { enabled: false } }, adapter, agent: new Agent({ llm }), store, sleep: async () => {} });
  assert.equal((await worker.runOnce()).sent, 1);
  assert.equal((await worker.runOnce()).attempted, 0);
  assert.equal(writes, 1); assert.equal(modelCalls, 1);
});

test('已安装的真实nekowhale包可离线检索，不加载DSH或下载GIF', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-real-kit-'));
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('This test forbids network'); };
  t.after(() => { globalThis.fetch = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  const service = new StickerService({ enabled: true, cacheDir: directory, autoSync: 'off' });
  const candidates = await service.search('开心', { limit: 3 });
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every(c => c.id.startsWith('大肥鱼/')));
  assert.equal(requests, 0);
});
