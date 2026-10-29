'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const { ROOT, initialize, loadLocalEnv } = require('../config');
const { BridgeClient } = require('../bridge/client');
const { createBridgeServer } = require('../bridge/server');
const { createConfigService, problem } = require('./config-service');
const { readActivity } = require('./activity');
const { redact } = require('../services/logger');
const { createRecallService } = require('../services/recall');
const { createDeletionCheckService } = require('../services/deletion-check');

const COOKIE = 'dafeiyu_console_session';
const HEALTH = Object.freeze({ application: 'dafeiyu-douyin-console', version: '0.2.0' });
const LEVELS = ['debug', 'info', 'warn', 'error'];
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function createConsoleServer(options = {}) {
  const { root = ROOT, port = 19423, host = '127.0.0.1', manageBridge = true,
    staticDir = path.join(root, 'web/dist') } = options;
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('控制台只能监听 127.0.0.1 的有效端口');
  initialize({ root });
  loadLocalEnv({ root, override: true });
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const session = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(32).toString('hex');
  let runtime;
  const settings = createConfigService({ root, isBusy: () => runtime?.isBusy() });
  const ownLogger = !options.logger;
  const logger = options.logger || new (require('../services/logger').EventLogger)({
    directory: path.join(root, 'runtime/logs'), secretValues: () => settings.secretValues(),
  });
  const bridge = options.bridgeClient || new BridgeClient(settings.config().bridge);
  runtime = options.runtime || new (require('../services/runtime').RuntimeController)({ root, configFile: settings.configFile, logger, bridgeClient: bridge });
  const diagnose = options.diagnose || require('../services/diagnostics').diagnose;
  let ownedBridge = null;
  let activePort = port;
  let url = null;
  let started = false;
  let disposed = false;
  const streams = new Set();
  const writeLog = entry => {
    try { return logger.write(entry); }
    catch {
      if (typeof runtime.reportLogFailure === 'function') runtime.reportLogFailure();
      else runtime.stop();
      return null;
    }
  };
  const publicData = value => redact(value, settings.secretValues());
  const recall = createRecallService({ root, bridge, getConfig: () => settings.config(), isBusy: () => runtime.isBusy(), log: writeLog });
  const deletionCheck = createDeletionCheckService({ root, bridge, getConfig: () => settings.config(), isBusy: () => runtime.isBusy(), log: writeLog });
  recall.recoverPending();

  app.addHook('onRequest', async (request, reply) => {
    const validHosts = [`127.0.0.1:${activePort}`, `localhost:${activePort}`];
    const authority = request.headers.host;
    if (!validHosts.includes(authority)) throw problem(403, '控制台只接受本机地址请求', 'HOST_DENIED');
    const pathname = request.url.split('?')[0];
    // The landing document is public static HTML. A link from another app must
    // be able to open it; no configuration is embedded in this document.
    const landingPage = ['GET', 'HEAD'].includes(request.method) && pathname === '/';
    const origin = request.headers.origin;
    if (!landingPage && origin && origin !== `http://${authority}`) throw problem(403, '控制台拒绝跨站请求', 'ORIGIN_DENIED');
    if (!landingPage && request.headers['sec-fetch-site'] === 'cross-site') throw problem(403, '控制台拒绝跨站请求', 'ORIGIN_DENIED');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    reply.header('Cache-Control', 'no-store');
    if (!pathname.startsWith('/api/') || pathname === '/api/session' || pathname === '/api/health') return;
    const cookies = Object.fromEntries((request.headers.cookie || '').split(';').map(pair => pair.trim().split(/=(.*)/s).slice(0, 2)));
    if (!equal(cookies[COOKIE], session)) throw problem(401, '控制台会话已失效，请刷新页面', 'SESSION_REQUIRED');
    if (!['GET', 'HEAD'].includes(request.method) && !equal(request.headers['x-csrf-token'], csrf)) throw problem(403, '请求校验失败，请刷新页面重试', 'CSRF_REQUIRED');
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    let message = '请求处理失败，请检查配置';
    try { message = redact(String(error.message || message), settings.secretValues()); } catch { /* unreadable settings must not leak via error handling */ }
    if (String(error.code || '').startsWith('FST_ERR_CTP_')) message = '请求格式或 Content-Type 无效';
    if (statusCode >= 500) writeLog({ level: 'error', event: 'console.request_failed', stage: 'console', message: '控制台请求处理失败', data: { code: error.code, error: message } });
    reply.code(statusCode).send({ error: statusCode >= 500 ? '控制台处理失败，请查看完整日志' : message, code: error.code || 'CONSOLE_ERROR' });
  });
  app.get('/api/health', async () => HEALTH);
  app.get('/api/session', async (request, reply) => {
    reply.header('Set-Cookie', `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`);
    return { csrfToken: csrf };
  });
  app.get('/api/config', async () => settings.read());
  app.put('/api/config', async request => {
    const result = settings.save(request.body);
    writeLog({ level: 'info', event: 'config.saved', stage: 'config', message: '配置已保存，下次启动任务时生效' });
    return result;
  });
  app.post('/api/bridge/token', async () => ({ token: settings.config().bridge.token }));
  app.get('/api/userscript', async (request, reply) => {
    const file = path.join(root, 'runtime/dafeiyu-douyin.user.js');
    reply.header('Content-Disposition', 'attachment; filename="dafeiyu-douyin.user.js"');
    reply.type('text/javascript; charset=utf-8');
    return fs.readFileSync(file, 'utf8');
  });
  app.get('/api/runtime', async () => publicData(runtime.snapshot()));
  app.post('/api/runtime/start', async (request, reply) => { reply.code(202); return publicData(await runtime.start({ once: false })); });
  app.post('/api/runtime/once', async (request, reply) => { reply.code(202); return publicData(await runtime.start({ once: true })); });
  app.post('/api/runtime/stop', async () => publicData(runtime.stop()));
  app.post('/api/check', async () => {
    loadLocalEnv({ root, override: true });
    const result = await diagnose({ config: settings.config(), bridge, runtime });
    writeLog({ level: result.overall === 'ok' ? 'info' : 'warn', event: 'diagnostics.completed', stage: 'diagnostics', message: result.overall === 'ok' ? '状态检测完成，各项检查通过' : '状态检测完成，请查看需要处理的检查项', data: { checks: result.checks } });
    return publicData(result);
  });
  app.get('/api/activity', async request => {
    recall.recoverPending();
    const config = settings.config();
    return publicData(readActivity({ root, accountUid: config.accountUid, videos: config.videos, logger,
      limit: request.query.limit, before: request.query.before, query: request.query.query, status: request.query.status }));
  });
  app.post('/api/activity/recall', async request => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) ||
        Object.keys(request.body).length !== 1 || !Object.hasOwn(request.body, 'jobKey')) throw problem(400, '撤回请求格式无效', 'RECALL_INVALID');
    return publicData(await recall.recall(request.body.jobKey));
  });
  app.post('/api/activity/check', async request => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) ||
        Object.keys(request.body).length !== 1 || !Object.hasOwn(request.body, 'jobKey')) throw problem(400, '核查请求格式无效', 'CHECK_INVALID');
    return publicData(await deletionCheck.check(request.body.jobKey));
  });
  app.post('/api/activity/resend', async (request, reply) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) ||
        Object.keys(request.body).length !== 1 || !Object.hasOwn(request.body, 'jobKey') ||
        typeof request.body.jobKey !== 'string' || !request.body.jobKey || request.body.jobKey.length > 256) throw problem(400, '重发请求格式无效', 'RESEND_INVALID');
    const result = await runtime.start({ once: true, resendJobKey: request.body.jobKey });
    reply.code(202); return publicData(result);
  });
  function logQuery(input = {}, max = 1000) {
    const level = input.level || 'debug';
    const limit = input.limit === undefined ? 200 : Number(input.limit);
    if (!LEVELS.includes(level) || !Number.isInteger(limit) || limit < 1 || limit > max ||
        (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 240)) ||
        (input.after !== undefined && (typeof input.after !== 'string' || input.after.length > 128))) throw problem(400, '日志筛选条件无效', 'QUERY_INVALID');
    return { level, limit, query: input.query || '', after: input.after || undefined };
  }
  app.get('/api/logs', async request => logger.list(logQuery(request.query)));
  app.get('/api/logs/export', async (request, reply) => {
    const format = request.query.format || 'jsonl';
    if (!['jsonl', 'txt'].includes(format)) throw problem(400, '只支持 JSONL 或 TXT 导出', 'QUERY_INVALID');
    const { items } = logger.list(logQuery({ ...request.query, limit: 10000 }, 10000));
    const text = items.map(entry => format === 'jsonl' ? JSON.stringify(entry) :
      `${new Date(entry.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} [${entry.level.toUpperCase()}] ${entry.message}`).join('\n');
    reply.header('Content-Disposition', `attachment; filename="dafeiyu-logs.${format}"`);
    reply.type('text/plain; charset=utf-8');
    return `${text}${text ? '\n' : ''}`;
  });
  app.get('/api/events', async (request, reply) => {
    if (streams.size >= 8) throw problem(429, '已打开过多实时日志连接，请关闭其他控制台页面', 'TOO_MANY_STREAMS');
    const after = request.headers['last-event-id'] || request.query.after;
    // Replay every retained record after the cursor, not just the first page.
    const query = logQuery({ after, limit: 10000 }, 10000);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let closed = false;
    let pendingBytes = 0;
    const send = (type, value, id) => {
      if (closed || res.destroyed || res.writableEnded) return;
      const payload = `${id ? `id: ${String(id).replace(/[\r\n]/g, '')}\n` : ''}event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
      if (!res.write(payload)) pendingBytes += Buffer.byteLength(payload);
      if (pendingBytes > 1024 * 1024) res.end();
    };
    res.on('drain', () => { pendingBytes = 0; });
    for (const item of logger.list(query).items) send('log', item, item.id);
    send('runtime', publicData(runtime.snapshot()));
    const unsubscribe = logger.subscribe(item => send('log', item, item.id));
    const onRuntime = state => send('runtime', publicData(state));
    runtime.on('change', onRuntime);
    const heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 15000);
    heartbeat.unref?.();
    const cleanup = () => {
      if (closed) return;
      closed = true; clearInterval(heartbeat); unsubscribe(); runtime.off('change', onRuntime); streams.delete(res);
    };
    res.once('close', cleanup);
    res.once('error', cleanup);
    request.raw.once('aborted', cleanup);
    streams.add(res);
  });

  const assets = path.join(staticDir, 'assets');
  if (fs.existsSync(assets)) app.register(require('@fastify/static'), { root: assets, prefix: '/assets/', index: false });
  app.get('/', async (request, reply) => {
    const file = path.join(staticDir, 'index.html');
    if (!fs.existsSync(file)) { reply.code(503); return { error: '前端尚未构建，请运行 npm run build 后重新启动控制台' }; }
    reply.type('text/html; charset=utf-8');
    return fs.readFileSync(file, 'utf8');
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: '没有这个页面或接口', code: 'NOT_FOUND' }));

  async function dispose() {
    if (disposed) return;
    disposed = true;
    for (const res of streams) res.end();
    try { runtime.stop(); await runtime.wait(); }
    finally {
      if (ownedBridge) await ownedBridge.close();
      if (ownLogger) logger.close();
    }
  }
  app.addHook('preClose', dispose);
  async function start() {
    if (started) return { url };
    if (disposed) throw new Error('控制台已关闭');
    if (manageBridge) {
      try {
        const status = await bridge.status();
        if (typeof status?.connected !== 'boolean' || typeof status?.pending !== 'number') throw problem(409, 'Bridge 端口被其他服务占用', 'BRIDGE_CONFLICT');
      } catch (error) {
        if (error.code !== 'ECONNREFUSED') throw problem(409, '无法复用现有 Bridge，请检查端口和本地 Token 配置', 'BRIDGE_CONFLICT');
        ownedBridge = createBridgeServer(settings.config().bridge);
        try { await ownedBridge.start(); }
        catch (failure) { ownedBridge = null; throw problem(409, failure.code === 'EADDRINUSE' ? 'Bridge 端口已被占用，请关闭冲突服务后重试' : 'Bridge 启动失败', 'BRIDGE_CONFLICT'); }
      }
    }
    try {
      const address = await app.listen({ host, port });
      activePort = app.server.address().port;
      url = address;
      started = true;
      writeLog({ level: 'info', event: 'console.started', stage: 'console', message: '本地控制台已启动，等待手动开始任务' });
      return { url };
    } catch (error) { await dispose(); throw error; }
  }
  async function close() { await app.close(); }
  return { app, start, close, get url() { return url; } };
}

if (require.main === module) {
  let consoleServer;
  try { consoleServer = createConsoleServer(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (consoleServer) {
    const stop = () => consoleServer.close().catch(() => { process.exitCode = 1; });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    consoleServer.start().then(({ url }) => console.log(`大肥鱼控制台：${url}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = { createConsoleServer, HEALTH };
