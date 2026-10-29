'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { initialize } = require('../src/config');
const { createConsoleServer, HEALTH } = require('../src/web/server');

class FakeRuntime extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.starts = []; this.stops = 0; }
  snapshot() { return { state: this.state, mode: this.mode || null, round: 0, stage: 'idle', nextScanAt: null }; }
  isBusy() { return ['running', 'stopping'].includes(this.state); }
  async start({ once }) {
    if (this.isBusy()) throw Object.assign(new Error('已有任务正在运行'), { statusCode: 409 });
    this.starts.push({ once }); this.state = 'running'; this.mode = once ? 'once' : 'poll'; this.emit('change', this.snapshot()); return this.snapshot();
  }
  stop() { this.stops++; if (this.state === 'running') this.state = 'stopping'; this.emit('change', this.snapshot()); return this.snapshot(); }
  async wait() { this.state = 'stopped'; }
}
class FakeLogger {
  constructor() { this.items = []; this.listeners = new Set(); }
  write(entry) { const item = { id: `log-${this.items.length + 1}`, ts: Date.now(), ...entry }; this.items.push(item); for (const listener of this.listeners) listener(item); return item; }
  list({ after, level = 'debug', query = '', limit = 200 } = {}) {
    const ranks = ['debug', 'info', 'warn', 'error'];
    const start = after ? this.items.findIndex(item => item.id === after) + 1 : 0;
    const items = this.items.slice(start).filter(item => ranks.indexOf(item.level) >= ranks.indexOf(level) && JSON.stringify(item).includes(query)).slice(-limit);
    return { items, nextCursor: items.at(-1)?.id || after || null };
  }
  subscribe(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); this.onUnsubscribe?.(); }; }
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-web-server-'));
  initialize({ root });
  const configFile = path.join(root, 'config.local.json');
  const value = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  value.accountUid = '10001'; value.videos = ['20001'];
  fs.writeFileSync(configFile, JSON.stringify(value));
  const runtime = new FakeRuntime(); const logger = new FakeLogger();
  const calls = [];
  const bridgeClient = { async status() { calls.push('status'); return { connected: false, pending: 0, accountUid: null, lastSeen: null }; }, async call(command) { calls.push(command); throw new Error('Unexpected browser command'); } };
  const diagnose = async ({ config, bridge }) => ({ checkedAt: Date.now(), overall: 'warning',
    browser: await bridge.status(), account: { configuredUid: config.accountUid, actualUid: null, matched: false },
    checks: [{ key: 'browser', label: '浏览器连接', status: 'warn', message: '请连接油猴' }], videos: [],
    model: { provider: config.model.provider, keyConfigured: false, apiVerified: false }, runtime: runtime.snapshot(), relationshipTriggersReady: false });
  const server = createConsoleServer({ root, logger, runtime, bridgeClient, diagnose, manageBridge: false, ...options });
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, server, runtime, logger, calls, token: value.bridge.token };
}
async function session(server, host = '127.0.0.1:19423') {
  const response = await server.app.inject({ url: '/api/session', headers: { host } });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  return { host, cookie: response.headers['set-cookie'].split(';')[0], 'x-csrf-token': response.json().csrfToken };
}

test('配置已经保存后日志失败仍返回保存结果，并停止后台任务', async t => {
  const { server, logger, runtime } = fixture(t);
  const headers = await session(server);
  const previous = (await server.app.inject({ url: '/api/config', headers })).json();
  logger.write = () => { throw new Error('disk full'); };
  const result = await server.app.inject({ method: 'PUT', url: '/api/config', headers,
    payload: { config: { accountUid: '10002' }, revision: previous.revision } });
  assert.equal(result.statusCode, 200); assert.equal(result.json().config.accountUid, '10002');
  assert.ok(runtime.stops > 0);
});

test('从外部链接可打开公开首页，跨站API和会话请求仍被拒绝', async t => {
  const { server, root } = fixture(t);
  fs.mkdirSync(path.join(root, 'web/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/dist/index.html'), '<!doctype html><title>本地控制台</title>');
  const cross = { host: '127.0.0.1:19423', origin: 'https://example.org', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
  const page = await server.app.inject({ url: '/', headers: cross });
  assert.equal(page.statusCode, 200); assert.match(page.body, /本地控制台/);
  assert.equal((await server.app.inject({ url: '/api/session', headers: cross })).statusCode, 403);
  const headers = { ...await session(server), ...cross };
  assert.equal((await server.app.inject({ url: '/api/config', headers })).statusCode, 403);
  assert.equal((await server.app.inject({ method: 'POST', url: '/api/runtime/start', headers })).statusCode, 403);
  assert.equal((await server.app.inject({ url: '/', headers: { ...cross, host: 'evil.test:19423' } })).statusCode, 403);
});

test('console starts idle and protects configuration and mutations with local origin, session and CSRF', async t => {
  const { server, runtime } = fixture(t);
  const host = '127.0.0.1:19423';
  assert.deepEqual((await server.app.inject({ url: '/api/health', headers: { host } })).json(), HEALTH);
  assert.equal(runtime.starts.length, 0);
  assert.equal((await server.app.inject({ url: '/api/config', headers: { host } })).statusCode, 401);
  assert.equal((await server.app.inject({ url: '/api/session', headers: { host: 'evil.test:19423' } })).statusCode, 403);
  assert.equal((await server.app.inject({ url: '/api/session', headers: { host, origin: 'https://www.douyin.com' } })).statusCode, 403);
  const headers = await session(server);
  assert.equal((await server.app.inject({ url: '/api/config', headers })).statusCode, 200);
  const wrong = { ...headers, 'x-csrf-token': 'wrong' };
  assert.equal((await server.app.inject({ method: 'POST', url: '/api/runtime/start', headers: wrong })).statusCode, 403);
  assert.equal(runtime.starts.length, 0);
  assert.equal((await server.app.inject({ method: 'POST', url: '/api/runtime/start', headers: { ...headers, origin: 'https://www.douyin.com' } })).statusCode, 403);
  assert.equal((await server.app.inject({ method: 'POST', url: '/api/runtime/start', headers })).statusCode, 202);
  assert.deepEqual(runtime.starts, [{ once: false }]);
  assert.equal((await server.app.inject({ method: 'POST', url: '/api/runtime/once', headers })).statusCode, 409);
  assert.equal(runtime.starts.length, 1);
  const state = await server.app.inject({ method: 'POST', url: '/api/runtime/stop', headers });
  assert.equal(state.json().state, 'stopping');
});

test('state check only invokes diagnosis; keys and bridge token are absent unless explicitly requested', async t => {
  const { server, runtime, calls, token, logger } = fixture(t);
  const headers = await session(server);
  const response = await server.app.inject({ method: 'POST', url: '/api/check', headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ['status']);
  assert.equal(response.json().model.apiVerified, false);
  assert.equal(runtime.starts.length, 0);
  const config = await server.app.inject({ url: '/api/config', headers });
  assert.equal(config.body.includes(token), false);
  const logCount = logger.items.length;
  assert.equal((await server.app.inject({ method: 'POST', url: '/api/bridge/token', headers })).json().token, token);
  assert.equal(logger.items.length, logCount);
  assert.equal(JSON.stringify(logger.items).includes(token), false);
  assert.equal((await server.app.inject({ url: '/api/userscript', headers })).statusCode, 200);
  assert.equal((await server.app.inject({ url: '/.env.local', headers })).statusCode, 404);
  assert.equal((await server.app.inject({ method: 'POST', url: '/api/call', headers, payload: { command: 'comments.publish' } })).statusCode, 404);
  assert.equal((await server.app.inject({ url: '/api/activity?root=/&accountUid=other', headers })).statusCode, 200);
});

test('config saves require current revision and idle runtime, and log export follows severity filtering', async t => {
  const { server, runtime, logger } = fixture(t);
  const headers = await session(server);
  const state = (await server.app.inject({ url: '/api/config', headers })).json();
  runtime.state = 'running';
  const payload = { revision: state.revision, config: { worker: { maxRepliesPerRound: 1 } } };
  assert.equal((await server.app.inject({ method: 'PUT', url: '/api/config', headers, payload })).statusCode, 409);
  runtime.state = 'stopped';
  assert.equal((await server.app.inject({ method: 'PUT', url: '/api/config', headers, payload })).statusCode, 200);
  assert.equal((await server.app.inject({ method: 'PUT', url: '/api/config', headers, payload })).statusCode, 409);
  logger.write({ level: 'debug', event: 'debug', message: '调试详情' });
  logger.write({ level: 'warn', event: 'pending', message: '发布结果待核查' });
  const exportResult = await server.app.inject({ url: '/api/logs/export?format=txt&level=warn', headers });
  assert.equal(exportResult.statusCode, 200);
  assert.match(exportResult.body, /发布结果待核查/);
  assert.doesNotMatch(exportResult.body, /调试详情/);
  assert.match(exportResult.headers['content-disposition'], /attachment/);
  assert.equal((await server.app.inject({ url: '/api/logs?level=invalid', headers })).statusCode, 400);
  assert.equal((await server.app.inject({ url: '/api/logs/export?format=html', headers })).statusCode, 400);
});

test('real diagnostic service via the status button only reads browser identity and video ownership', async t => {
  const calls = []; let modelRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { modelRequests++; throw new Error('This check must not request a model'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const bridgeClient = {
    async status() { calls.push('status'); return { connected: true, accountUid: '10001', lastSeen: Date.now(), pending: 0 }; },
    async call(command) {
      calls.push(command);
      if (command === 'identity.get') return { uid: '10001' };
      if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: '10001' } } };
      throw new Error('Unexpected mutating browser command');
    },
  };
  const { server, runtime } = fixture(t, { bridgeClient, diagnose: require('../src/services/diagnostics').diagnose });
  const headers = await session(server);
  const response = await server.app.inject({ method: 'POST', url: '/api/check', headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().account.matched, true);
  assert.equal(response.json().videos[0].owned, true);
  assert.ok(calls.every(command => ['status', 'identity.get', 'video.get'].includes(command)));
  assert.equal(modelRequests, 0);
  assert.equal(runtime.starts.length, 0);
});

test('HTTP errors redact configured secrets and malformed JSON never echoes the request body', async t => {
  const { server, runtime, root } = fixture(t);
  const secret = 'fixture-private-key-that-must-not-echo';
  fs.writeFileSync(path.join(root, '.env.local'), `DEEPSEEK_API_KEY=${secret}\n`);
  runtime.start = async () => { throw Object.assign(new Error(`配置错误 ${secret}`), { statusCode: 400 }); };
  const headers = await session(server);
  const response = await server.app.inject({ method: 'POST', url: '/api/runtime/start', headers });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.includes(secret), false);
  const malformed = await server.app.inject({ method: 'PUT', url: '/api/config', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"secrets":{"deepseek":"new-private-fixture-body' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.includes('new-private-fixture-body'), false);
});

test('SSE replays after a cursor, streams new events and unsubscribes when the browser disconnects', { timeout: 10000 }, async t => {
  const { server, logger, runtime } = fixture(t, { port: 0 });
  const { url } = await server.start();
  const boot = await fetch(`${url}/api/session`);
  const cookie = boot.headers.get('set-cookie').split(';')[0];
  await boot.json();
  assert.equal((await fetch(`${url}/api/events`)).status, 401);
  const first = logger.write({ level: 'info', event: 'first', message: '第一条' });
  const second = logger.write({ level: 'warn', event: 'second', message: '第二条' });
  let lastReplay;
  for (let i = 0; i < 1100; i++) lastReplay = logger.write({ level: 'info', event: 'replay', message: `断线期间事件 ${i}` });
  const controller = new AbortController();
  const response = await fetch(`${url}/api/events?after=${first.id}`, { headers: { cookie }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('event: runtime')) received += decoder.decode((await reader.read()).value);
  assert.match(received, new RegExp(`id: ${second.id}`));
  assert.match(received, new RegExp(`id: ${lastReplay.id}`));
  assert.doesNotMatch(received, new RegExp(`id: ${first.id}\\n`));
  const live = logger.write({ level: 'info', event: 'live', message: '实时事件' });
  while (!received.includes(`id: ${live.id}`)) received += decoder.decode((await reader.read()).value);
  assert.equal(logger.listeners.size, 1);
  assert.equal(runtime.listenerCount('change'), 1);
  const unsubscribed = new Promise(resolve => { logger.onUnsubscribe = resolve; });
  controller.abort(); await reader.cancel().catch(() => {}); await unsubscribed;
  assert.equal(logger.listeners.size, 0);
  assert.equal(runtime.listenerCount('change'), 0);
});
