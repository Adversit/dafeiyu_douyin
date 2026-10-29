'use strict';
const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { validateCommand, id, WRITE_COMMANDS } = require('./protocol');
const { BROWSER_DISCONNECTED_MESSAGE } = require('./errors');

// Poll queue and correlated receipts adapted from douyin-cli's MIT router;
// see vendor/douyin-cli/NOTICE.md. One browser identity, no WebSocket or eval API.
function createBridgeServer({ token, host = '127.0.0.1', port = 19422, requestTimeout = 30000, sessionTtl = 60000 } = {}) {
  if (!token || typeof token !== 'string') throw new Error('Bridge token is required');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Bridge must bind to loopback');
  let session = null; let waiter = null; let closed = false;
  const pending = new Map(); const queue = [];
  const reply = (res, status, body) => { if (!res.writableEnded && !res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); } };
  function rejectPending(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); const e = new Error(error); e.code = 'BRIDGE_OFFLINE'; e.outcomeUnknown = item.dispatched && WRITE_COMMANDS.has(item.command); item.reject(e); }
    pending.clear(); queue.length = 0;
  }
  function status() { return { connected: Boolean(session && Date.now() - session.lastSeen <= sessionTtl), accountUid: session?.accountUid || null, lastSeen: session?.lastSeen || null, pending: pending.size }; }
  function drain() {
    if (!waiter || !queue.length) return;
    const current = waiter; waiter = null; clearTimeout(current.timer);
    const item = queue.shift(); item.dispatched = true;
    reply(current.res, 200, { ok: true, type: 'command', id: item.id, command: item.command, args: item.args });
  }
  function call(command, args) {
    validateCommand(command, args);
    if (closed || !status().connected) return Promise.reject(Object.assign(new Error(BROWSER_DISCONNECTED_MESSAGE), { code: 'BRIDGE_REJECTED' }));
    if (session.accountUid !== args.accountUid) return Promise.reject(Object.assign(new Error('Connected browser identity does not match accountUid'), { code: 'BRIDGE_REJECTED' }));
    return new Promise((resolve, reject) => {
      const item = { id: randomUUID(), sessionId: session.id, command, args, resolve, reject, dispatched: false };
      item.timer = setTimeout(() => {
        pending.delete(item.id); const i = queue.indexOf(item); if (i >= 0) queue.splice(i, 1);
        const error = new Error('Browser command timed out'); error.code = 'BRIDGE_TIMEOUT'; error.outcomeUnknown = item.dispatched && WRITE_COMMANDS.has(command); reject(error);
      }, requestTimeout);
      pending.set(item.id, item); queue.push(item); drain();
    });
  }
  async function readBody(req) {
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 10 * 1024 * 1024) throw new Error('Request body too large'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  function authorized(req) {
    const actual = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const origin = req.headers.origin;
      if (origin) {
        const parsed = new URL(origin);
        const allowed = ['http:', 'https:'].includes(parsed.protocol) && (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || (parsed.protocol === 'https:' && ['douyin.com', 'www.douyin.com'].includes(parsed.hostname)));
        if (!allowed) return reply(res, 403, { ok: false, error: 'Origin denied' });
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Private-Network', 'true'); res.writeHead(204); res.end(); return; }
      if (!authorized(req)) return reply(res, 401, { ok: false, code: 'BRIDGE_REJECTED', error: 'Unauthorized' });
      if (req.method === 'GET' && url.pathname === '/api/status') return reply(res, 200, { ok: true, value: status() });
      if (req.method !== 'POST') return reply(res, 404, { ok: false, error: 'Unknown bridge route' });
      const body = await readBody(req);
      if (url.pathname === '/api/connect') {
        id(body.accountUid, 'accountUid');
        rejectPending('Browser reconnected; pending commands were cancelled');
        if (waiter) { clearTimeout(waiter.timer); reply(waiter.res, 409, { ok: false, error: 'Browser session replaced' }); waiter = null; }
        session = { id: randomUUID(), accountUid: body.accountUid, lastSeen: Date.now() };
        return reply(res, 200, { ok: true, sessionId: session.id });
      }
      if (url.pathname === '/api/call') {
        try { const value = await call(body.command, body.args); return reply(res, 200, { ok: true, value }); }
        catch (error) { return reply(res, error.code === 'BRIDGE_REJECTED' ? 409 : 503, { ok: false, code: error.code || 'BRIDGE_ERROR', error: error.message, outcomeUnknown: Boolean(error.outcomeUnknown) }); }
      }
      if (!session || body.sessionId !== session.id) return reply(res, 409, { ok: false, code: 'SESSION_EXPIRED', error: 'Browser session expired' });
      session.lastSeen = Date.now();
      if (url.pathname === '/api/poll') {
        if (waiter) return reply(res, 409, { ok: false, error: 'A browser poll is already pending' });
        const current = { res, timer: null };
        current.timer = setTimeout(() => { if (waiter === current) waiter = null; reply(res, 200, { ok: true, type: 'idle' }); }, 25000);
        waiter = current;
        res.on('close', () => { if (waiter === current) { clearTimeout(current.timer); waiter = null; } });
        drain(); return;
      }
      if (url.pathname === '/api/result') {
        const item = pending.get(body.id);
        if (!item || item.sessionId !== session.id || !item.dispatched) return reply(res, 409, { ok: false, error: 'Unknown or expired command receipt' });
        clearTimeout(item.timer); pending.delete(body.id);
        if (body.error) { const error = new Error(String(body.error).slice(0, 1000)); error.code = 'BROWSER_COMMAND_ERROR'; error.outcomeUnknown = Boolean(body.outcomeUnknown); item.reject(error); }
        else item.resolve(body.value);
        return reply(res, 200, { ok: true });
      }
      return reply(res, 404, { ok: false, error: 'Unknown bridge route' });
    } catch (error) { reply(res, 400, { ok: false, code: 'BRIDGE_REJECTED', error: error.message }); }
  });
  function start() { return new Promise((resolve, reject) => { closed = false; server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); }); }); }
  function close() { closed = true; rejectPending('Bridge server closed'); if (waiter) { clearTimeout(waiter.timer); reply(waiter.res, 503, { ok: false, error: 'Bridge closed' }); waiter = null; } return new Promise((resolve, reject) => { if (!server.listening) return resolve(); server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections?.(); }); }
  return { server, call, start, close, status };
}
module.exports = { createBridgeServer };
