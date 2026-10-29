'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initialize } = require('../src/config');
const { EventLogger } = require('../src/services/logger');
const { RuntimeController } = require('../src/services/runtime');
const { createConsoleServer } = require('../src/web/server');
const { Worker } = require('../src/worker');
const { Store } = require('../src/store');
const { Agent } = require('../src/agent/reply');
const { ChatClient } = require('../src/agent/llm');

test('网页执行一轮串联真实Runtime、Agent、日志和SQLite，纯呼唤一次发布且状态检测零发布', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-web-runtime-'));
  const previous = process.env.DAFEIYU_WEB_TEST_KEY;
  const key = 'mock-only-private-model-credential';
  const initial = initialize({ root });
  const local = JSON.parse(fs.readFileSync(path.join(root, 'config.local.json'), 'utf8'));
  Object.assign(local, { accountUid: '10001', videos: ['20001'] });
  local.model.apiKeyEnv = 'DAFEIYU_WEB_TEST_KEY';
  fs.writeFileSync(path.join(root, 'config.local.json'), JSON.stringify(local));
  fs.writeFileSync(path.join(root, '.env.local'), `DAFEIYU_WEB_TEST_KEY=${key}\n`);
  const logger = new EventLogger({ directory: path.join(root, 'runtime/logs'), secretValues: () => [key, initial.bridge.token] });
  const writes = []; let modelCalls = 0;
  const event = { cid: '40001', videoId: '20001', rootCid: '40001', authorUid: '30001', text: '大肥鱼！', mentionsKnown: false, mentionUids: [], replyRelationKnown: false };
  const runtime = new RuntimeController({ root, logger, createWorker: (config, log) => {
    const store = new Store(path.join(root, 'runtime/agent.sqlite')); store.recoverInFlight();
    const llm = new ChatClient(config.model, { log, fetchImpl: async (_url, options) => {
      modelCalls++; assert.equal(options.headers.Authorization, `Bearer ${key}`);
      const request = JSON.parse(options.body);
      const safety = request.messages[0].content.includes('独立的评论安全分类器');
      if (!safety) assert.ok(request.messages[1].content.includes('name_call'));
      const result = safety ? { safe: true, reason: '安全' } : { text: '鱼在呢，找我什么事呀', stickerQuery: null };
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }) };
    } });
    const adapter = { verifyVideo: async () => {}, scanVideo: async () => ({ comments: [event], complete: true, warnings: [] }),
      readThread: async () => ({ complete: true, target: event, comments: [event] }),
      publishReply: async value => { writes.push(value); return { cid: '90001', targetVerified: true, imageCount: 0 }; } };
    return { worker: new Worker({ config, store, adapter, agent: new Agent({ llm }), log }), close: () => store.close() };
  } });
  const reads = [];
  const bridgeClient = { status: async () => ({ connected: true, accountUid: '10001', pending: 0 }), call: async command => {
    reads.push(command); assert.ok(['identity.get', 'video.get'].includes(command));
    return command === 'identity.get' ? { uid: '10001' } : { aweme_detail: { author: { uid: '10001' } } };
  } };
  const server = createConsoleServer({ root, logger, runtime, bridgeClient, manageBridge: false });
  t.after(async () => {
    await server.close(); logger.close();
    if (previous === undefined) delete process.env.DAFEIYU_WEB_TEST_KEY; else process.env.DAFEIYU_WEB_TEST_KEY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const boot = await server.app.inject({ url: '/api/session', headers: { host: '127.0.0.1:19423' } });
  const headers = { host: '127.0.0.1:19423', cookie: boot.headers['set-cookie'].split(';')[0], 'x-csrf-token': boot.json().csrfToken };
  const check = await server.app.inject({ method: 'POST', url: '/api/check', headers });
  assert.equal(check.statusCode, 200); assert.equal(modelCalls, 0); assert.equal(writes.length, 0);
  assert.ok(reads.includes('video.get'));
  assert.equal((await server.app.inject({ method: 'POST', url: '/api/runtime/once', headers })).statusCode, 202);
  await runtime.wait();
  assert.equal(modelCalls, 3); assert.equal(writes.length, 1); assert.equal(writes[0].targetCid, event.cid);
  const activity = (await server.app.inject({ url: '/api/activity', headers })).json();
  assert.equal(activity.items[0].status, 'succeeded'); assert.equal(activity.items[0].commentText, event.text);
  const logs = (await server.app.inject({ url: '/api/logs?level=debug&limit=200', headers })).json();
  assert.ok(logs.items.some(e => e.event === 'model.request' && e.targetCid === event.cid));
  assert.ok(logs.items.some(e => e.event === 'comment.succeeded'));
  const exported = await server.app.inject({ url: '/api/logs/export?format=jsonl', headers });
  assert.equal(exported.body.includes(key), false); assert.equal(exported.body.includes(initial.bridge.token), false);
  assert.equal((await server.app.inject({ method: 'POST', url: '/api/runtime/once', headers })).statusCode, 202);
  await runtime.wait(); assert.equal(writes.length, 1); assert.equal(modelCalls, 3);
});
