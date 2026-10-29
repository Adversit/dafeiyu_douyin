'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseEnv } = require('node:util');
const { ROOT, validateConfig } = require('../config');
const { ChatClient } = require('../agent/llm');
const { acquireLock } = require('../lock');

const FIELDS = {
  model: ['provider', 'model', 'baseUrl', 'apiKeyEnv', 'timeoutMs', 'maxTokens'],
  douyin: ['inboundSchemaConfirmed', 'maxPages', 'maxReplyPages'],
  worker: ['pollIntervalMs', 'sendIntervalMs', 'maxRepliesPerRound', 'maxCandidatesPerRound'],
  stickers: ['enabled', 'mode', 'limit', 'autoSync', 'allowedMimeTypes'],
  triggers: ['respondToNameCall'],
};
const KEYS = { deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY' };
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const pick = (value, fields) => Object.fromEntries(fields.filter(key => own(value || {}, key)).map(key => [key, value[key]]));
function problem(statusCode, message, code = 'CONFIG_INVALID') {
  return Object.assign(new Error(message), { statusCode, code });
}

function createConfigService({ root = ROOT, isBusy = () => false } = {}) {
  const configFile = path.join(root, 'config.local.json');
  const envFile = path.join(root, '.env.local');
  const bytes = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const raw = () => JSON.parse(bytes(configFile));
  const environment = () => parseEnv(bytes(envFile));
  const revision = () => crypto.createHash('sha256').update(bytes(configFile)).update('\0').update(bytes(envFile)).digest('hex');
  const config = () => validateConfig(raw(), { root, requireAccount: false });
  function secretValues() {
    const values = Object.entries({ ...process.env, ...environment() })
      .filter(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(key) && value).map(([, value]) => value);
    try { values.push(raw().bridge?.token); } catch { /* malformed settings are reported by read */ }
    return values.filter(value => typeof value === 'string' && value.length > 0);
  }
  function read() {
    const value = config();
    const env = environment();
    const visible = { accountUid: value.accountUid, videos: value.videos,
      bridge: { host: value.bridge.host, port: value.bridge.port, tokenConfigured: Boolean(value.bridge.token) } };
    for (const [section, fields] of Object.entries(FIELDS)) visible[section] = pick(value[section], fields);
    return { config: visible,
      secrets: Object.fromEntries(Object.entries(KEYS).map(([provider, name]) => [`${provider}Configured`, Boolean((env[name] ?? process.env[name])?.trim())])),
      revision: revision() };
  }
  function saveUnderLock(body) {
    if (!record(body) || Object.keys(body).some(key => !['config', 'secrets', 'revision'].includes(key))) throw problem(400, '配置请求格式无效');
    if (typeof body.revision !== 'string' || body.revision !== revision()) throw problem(409, '配置已在其他位置修改，请重新加载后再保存', 'CONFIG_CHANGED');
    if (!record(body.config) || Object.keys(body.config).some(key => !['accountUid', 'videos', ...Object.keys(FIELDS)].includes(key))) throw problem(400, '只允许保存页面中可编辑的配置');
    const current = raw();
    const next = { ...current };
    for (const key of ['accountUid', 'videos']) if (own(body.config, key)) next[key] = body.config[key];
    for (const [section, fields] of Object.entries(FIELDS)) {
      if (!own(body.config, section)) continue;
      const patch = body.config[section];
      if (!record(patch) || Object.keys(patch).some(key => !fields.includes(key))) throw problem(400, `${section} 包含不支持的配置项`);
      next[section] = { ...current[section], ...patch };
    }
    for (const key of ['baseUrl', 'apiKeyEnv']) if (next.model && next.model[key] === '') delete next.model[key];
    let validated;
    try {
      validated = validateConfig(next, { root, requireAccount: false });
      new ChatClient(validated.model); // Validation only; never calls the provider.
      if (validated.accountUid && !/^\d{5,30}$/.test(validated.accountUid)) throw new Error('账号 UID 必须是 5–30 位数字字符串');
    } catch (error) { throw problem(400, error.message); }
    next.accountUid = validated.accountUid;
    next.videos = validated.videos;
    const env = environment();
    if (body.secrets !== undefined && (!record(body.secrets) || Object.keys(body.secrets).some(key => !own(KEYS, key)))) throw problem(400, '模型密钥字段无效');
    let changedSecret = false;
    for (const [provider, value] of Object.entries(body.secrets || {})) {
      if (typeof value !== 'string' || (value && value.length < 8) || value.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw problem(400, `${provider} 密钥格式无效`);
      if (!value) continue; // Empty password inputs preserve an existing secret.
      env[KEYS[provider]] = value;
      changedSecret = true;
    }
    const configText = `${JSON.stringify(next, null, 2)}\n`;
    const envText = `${Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')}\n`;
    const writes = [[configFile, configText]];
    if (changedSecret) writes.push([envFile, envText]);
    const staged = [];
    const originals = new Map(writes.map(([file]) => [file, fs.existsSync(file) ? bytes(file) : null]));
    const committed = [];
    try {
      for (const [file, content] of writes) {
        const temp = `${file}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        staged.push([temp, file]);
      }
      for (const [temp, file] of staged) { fs.renameSync(temp, file); committed.push(file); }
    } catch (error) {
      for (const file of committed) {
        const original = originals.get(file);
        if (original === null) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, original, { mode: 0o600 });
      }
      throw error;
    } finally {
      for (const [temp] of staged) fs.rmSync(temp, { force: true });
    }
    // The web process can check newly saved keys without waiting for a restart.
    for (const provider of Object.keys(body.secrets || {})) if (body.secrets[provider]) process.env[KEYS[provider]] = body.secrets[provider];
    return read();
  }
  function save(body) {
    if (isBusy()) throw problem(409, '请先停止轮询或执行中的任务，再保存配置', 'RUNTIME_BUSY');
    let release;
    try { release = acquireLock(path.join(root, 'runtime/worker.lock')); }
    catch { throw problem(409, '配置保存被执行锁阻止，请确认没有正在运行的任务或遗留执行锁', 'RUNTIME_BUSY'); }
    try { return saveUnderLock(body); }
    finally { release(); }
  }
  return { read, save, config, secretValues, configFile, envFile };
}

module.exports = { createConfigService, problem };
