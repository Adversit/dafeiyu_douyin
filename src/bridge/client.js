'use strict';
const http = require('node:http');
const { validateCommand, WRITE_COMMANDS } = require('./protocol');
const { translateBridgeError } = require('./errors');
class BridgeClient {
  constructor({ host = '127.0.0.1', port = 19422, token, timeout = 35000 } = {}) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Bridge must use a loopback host');
    if (!token) throw new Error('Bridge token is required');
    Object.assign(this, { host, port, token, timeout });
  }
  call(command, args) {
    try { validateCommand(command, args); } catch (error) {
      error.definitelyNotSent = true; error.outcomeUnknown = false;
      return Promise.reject(error);
    }
    return this._request('POST', '/api/call', { command, args }).catch(error => {
      if (WRITE_COMMANDS.has(command)) {
        if (error.definitelyNotSent === true) error.outcomeUnknown = false;
        else error.outcomeUnknown = true; // No definitive server response: do not retry a write.
      }
      throw error;
    });
  }
  status() { return this._request('GET', '/api/status'); }
  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ hostname: this.host, port: this.port, method, path,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) }, timeout: this.timeout }, res => {
        let data = ''; let size = 0;
        res.setEncoding('utf8');
        res.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 12 * 1024 * 1024) req.destroy(new Error('Bridge response too large')); else data += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (res.statusCode >= 400 || !result.ok) {
              const error = new Error(result.error || `Bridge HTTP ${res.statusCode}`);
              error.code = result.code || 'BRIDGE_ERROR';
              if (typeof result.outcomeUnknown === 'boolean') {
                error.outcomeUnknown = result.outcomeUnknown;
                if (result.outcomeUnknown === false) error.definitelyNotSent = true;
              } else if (error.code === 'BRIDGE_REJECTED') {
                error.outcomeUnknown = false; error.definitelyNotSent = true;
              }
              reject(translateBridgeError(error));
            } else resolve(result.value === undefined ? result : result.value);
          } catch (error) { reject(error); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Bridge request timeout')));
      if (payload) req.write(payload);
      req.end();
    });
  }
}
module.exports = { BridgeClient };
