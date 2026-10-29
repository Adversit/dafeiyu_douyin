'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const ID_RE = /^\d{5,30}$/;

function parseVideoId(value) {
  if (typeof value !== 'string') throw new Error('作品 ID 或链接必须用字符串填写；数字型长 ID 可能已丢失精度');
  const input = value.trim();
  if (ID_RE.test(input)) return input;
  let url;
  try { url = new URL(input); } catch { throw new Error('请填作品 ID 或 https://www.douyin.com/video/<ID> 链接'); }
  if (url.protocol !== 'https:' || !/(^|\.)douyin\.com$/i.test(url.hostname)) throw new Error('只接受抖音 HTTPS 作品链接');
  const id = url.pathname.match(/^\/video\/(\d{5,30})\/?$/)?.[1] || url.searchParams.get('modal_id');
  if (!id || !ID_RE.test(id)) throw new Error('短链接请先在浏览器打开，再复制包含作品 ID 的完整链接');
  return id;
}

function validateConfig(input, { root = ROOT, requireAccount = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是 JSON 对象');
  const config = { ...DEFAULTS, ...input };
  for (const key of ['bridge', 'douyin', 'model', 'worker', 'stickers', 'triggers']) {
    if (input[key] != null && (typeof input[key] !== 'object' || Array.isArray(input[key]))) throw new Error(`${key} 必须是配置对象`);
    config[key] = { ...DEFAULTS[key], ...input[key] };
  }
  if (!Array.isArray(config.videos)) throw new Error('videos 必须是作品 ID 或链接数组');
  config.videos = [...new Set(config.videos.map(parseVideoId))];
  if (typeof config.accountUid !== 'string') throw new Error('accountUid 必须是字符串，不能使用 JSON 数字');
  config.accountUid = config.accountUid.trim();
  if (config.accountUid && !ID_RE.test(config.accountUid)) throw new Error('accountUid 必须是 5..30 位数字字符串');
  if (requireAccount && !ID_RE.test(config.accountUid)) throw new Error('请用 doctor 确认登录账号，再填写字符串 accountUid');
  if (config.bridge.host !== '127.0.0.1') throw new Error('Bridge 仅监听 127.0.0.1');
  if (typeof config.bridge.token !== 'string' || !/^[a-f\d]{48,}$/i.test(config.bridge.token)) throw new Error('bridge.token 未配置，请运行 npm run init');
  for (const [label, n, min, max] of [
    ['bridge.port', config.bridge.port, 1024, 65535],
    ['bridge.requestTimeout', config.bridge.requestTimeout, 1000, 300000],
    ['douyin.maxPages', config.douyin.maxPages, 1, 1000],
    ['douyin.maxReplyPages', config.douyin.maxReplyPages, 1, 1000],
    ['worker.pollIntervalMs', config.worker.pollIntervalMs, 1000, 86400000],
    ['worker.sendIntervalMs', config.worker.sendIntervalMs, 1000, 86400000],
    ['worker.maxRepliesPerRound', config.worker.maxRepliesPerRound, 1, 100],
    ['worker.maxCandidatesPerRound', config.worker.maxCandidatesPerRound, 1, 1000],
  ]) if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} 必须是 ${min}..${max} 的整数`);
  if (!['deepseek', 'openai'].includes(config.model.provider)) throw new Error('model.provider 只支持 deepseek / openai');
  if (typeof config.douyin.inboundSchemaConfirmed !== 'boolean' || typeof config.stickers.enabled !== 'boolean' || typeof config.triggers.respondToNameCall !== 'boolean') throw new Error('功能开关必须是布尔值');
  if (!['optional', 'required'].includes(config.stickers.mode)) throw new Error('stickers.mode 只支持 optional / required');
  if (!['off', 'lazy'].includes(config.stickers.autoSync)) throw new Error('stickers.autoSync 只支持 off / lazy');
  if (!Number.isInteger(config.stickers.limit) || config.stickers.limit < 1 || config.stickers.limit > 50) throw new Error('stickers.limit 必须是 1..50 的整数');
  const allowedMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!Array.isArray(config.stickers.allowedMimeTypes) || !config.stickers.allowedMimeTypes.length || config.stickers.allowedMimeTypes.some(mime => !allowedMimes.includes(mime))) throw new Error('stickers.allowedMimeTypes 只能包含支持的图片格式');
  new (require('./agent/llm').ChatClient)(config.model);
  config.root = root;
  config.runtimeDir = path.join(root, 'runtime');
  return config;
}

function loadConfig(file = path.join(ROOT, 'config.local.json'), options = {}) {
  if (!fs.existsSync(file)) throw new Error('请先运行 npm run init，随后填写 config.local.json');
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')), { root: path.dirname(file), ...options });
}

function loadLocalEnv({ root = ROOT, override = false } = {}) {
  const file = path.join(root, '.env.local');
  if (!fs.existsSync(file)) return;
  if (override) Object.assign(process.env, require('node:util').parseEnv(fs.readFileSync(file, 'utf8')));
  else process.loadEnvFile(file);
}

function initialize({ root = ROOT } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'config.local.json');
  if (!fs.existsSync(file)) {
    const config = structuredClone(DEFAULTS);
    config.bridge.token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const envFile = path.join(root, '.env.local');
  if (!fs.existsSync(envFile)) fs.copyFileSync(path.join(ROOT, '.env.example'), envFile, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(envFile, 0o600);
  const config = loadConfig(file, { root });
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  const source = fs.readFileSync(path.join(ROOT, 'userscript/dafeiyu-douyin.user.js'), 'utf8');
  const address = `http://${config.bridge.host}:${config.bridge.port}`;
  const rendered = source.replace("const SERVER = 'http://127.0.0.1:19422';", `const SERVER = '${address}';`);
  fs.writeFileSync(path.join(config.runtimeDir, 'dafeiyu-douyin.user.js'), rendered, { mode: 0o600 });
  return config;
}

module.exports = { ROOT, DEFAULTS, loadConfig, validateConfig, loadLocalEnv, initialize, parseVideoId };
