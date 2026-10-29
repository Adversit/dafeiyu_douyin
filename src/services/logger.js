'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const pino = require('pino');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const PRIVATE_KEY = /(?:api.?key|access.?key|session.?key|token|authorization|cookie|password|secret|credential)/i;
function redact(value, secrets = [], depth = 0) {
  if (depth > 14) return '[嵌套内容已省略]';
  if (typeof value === 'string') {
    let text = value.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
    text = text.replace(/((?:"|')?(?:api[-_]?key|authorization|cookies?|password|secret[-_]?(?:access[-_]?)?key|session[-_]?(?:token|key)|access[-_]?key(?:[-_]?id)?|x-amz-security-token|token)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1"[REDACTED]"');
    for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
    return text.length > 100000 ? text.slice(0, 100000) + '…[已截断]' : text;
  }
  if (Array.isArray(value)) return value.slice(0, 300).map(item => redact(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: redact(value.message, secrets), code: value.code };
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) =>
      [key, PRIVATE_KEY.test(key) ? '[REDACTED]' : redact(item, secrets, depth + 1)]));
  }
  return typeof value === 'bigint' ? String(value) : value;
}

class EventLogger {
  constructor({ directory, secretValues = () => [], maxBytes = 5 * 1024 * 1024, maxRecords = 5000 } = {}) {
    if (!directory) throw new Error('日志目录未配置');
    this.directory = directory; this.secretValues = secretValues; this.maxBytes = maxBytes; this.maxRecords = maxRecords;
    this.records = []; this.events = new EventEmitter(); this.events.setMaxListeners(50); this.closed = false;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'events.jsonl');
    for (const name of ['events.3.jsonl', 'events.2.jsonl', 'events.1.jsonl', 'events.jsonl']) {
      const file = path.join(directory, name);
      if (!fs.existsSync(file)) continue;
      // Files are bounded by rotation; tolerate a partial final line after a crash.
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const line of lines) { try { const entry = JSON.parse(line); if (entry.id && LEVELS[entry.level]) this.records.push(entry); } catch { /* incomplete line */ } }
    }
    this.records = this.records.slice(-maxRecords);
    this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    this.pino = pino({ level: 'debug', base: null, timestamp: false, formatters: { level: level => ({ level }) } }, {
      write: line => {
        const bytes = Buffer.byteLength(line);
        if (this.bytes && this.bytes + bytes > this.maxBytes) this.rotate();
        fs.appendFileSync(this.file, line, { mode: 0o600 });
        this.bytes += bytes;
      },
    });
  }
  secrets() {
    let supplied = [];
    try { supplied = this.secretValues() || []; } catch { /* never expose configuration errors */ }
    return [...supplied, ...Object.entries(process.env).filter(([key]) => PRIVATE_KEY.test(key)).map(([, value]) => value)];
  }
  rotate() {
    fs.rmSync(path.join(this.directory, 'events.3.jsonl'), { force: true });
    for (let i = 2; i >= 1; i--) {
      const old = path.join(this.directory, `events.${i}.jsonl`);
      if (fs.existsSync(old)) fs.renameSync(old, path.join(this.directory, `events.${i + 1}.jsonl`));
    }
    if (fs.existsSync(this.file)) fs.renameSync(this.file, path.join(this.directory, 'events.1.jsonl'));
    this.bytes = 0;
  }
  write(input = {}) {
    if (this.closed) return null;
    const level = Object.hasOwn(LEVELS, input.level) ? input.level : 'info';
    const entry = redact({ ...input, id: randomUUID(), ts: Date.now(), level,
      event: input.event || 'message', message: String(input.message || '') }, this.secrets());
    this.pino[level](entry, entry.message);
    this.records.push(entry);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    this.events.emit('entry', entry);
    return entry;
  }
  child(context = {}) { return { write: entry => this.write({ ...context, ...entry }) }; }
  list({ after, level = 'debug', query = '', limit = 200 } = {}) {
    const count = Math.max(1, Math.min(Number(limit) || 200, this.maxRecords));
    const index = after ? this.records.findIndex(entry => entry.id === after) : -1;
    const reset = Boolean(after && index === -1);
    const source = after && index !== -1 ? this.records.slice(index + 1) : this.records;
    const needle = String(query).toLocaleLowerCase();
    const selected = source.filter(entry => LEVELS[entry.level] >= (LEVELS[level] || LEVELS.debug)
      && (!needle || JSON.stringify(entry).toLocaleLowerCase().includes(needle)));
    const items = (after && !reset ? selected.slice(0, count) : selected.slice(-count)).map(entry => redact(entry, this.secrets()));
    return { items, nextCursor: items.at(-1)?.id || after || null, reset };
  }
  subscribe(listener) {
    const safe = entry => { try { listener(entry); } catch { /* a closed log viewer must not interrupt sending */ } };
    this.events.on('entry', safe); return () => this.events.off('entry', safe);
  }
  close() { this.closed = true; this.events.removeAllListeners(); }
}

module.exports = { EventLogger, redact, LEVELS };
