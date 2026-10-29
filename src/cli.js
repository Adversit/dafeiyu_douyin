#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, initialize, loadConfig, loadLocalEnv, parseVideoId } = require('./config');
const { BridgeClient } = require('./bridge/client');
const { createBridgeServer } = require('./bridge/server');
const { DouyinAdapter } = require('./douyin/adapter');
const { Store } = require('./store');
const { acquireLock } = require('./lock');
const { RuntimeController } = require('./services/runtime');
const { EventLogger } = require('./services/logger');
const { diagnose } = require('./services/diagnostics');

const print = value => console.log(JSON.stringify(value, null, 2));
const HELP = `大肥鱼抖音评论 Agent

npm run launch                          打开本地网页控制台（不自动发送）

node src/cli.js init                     创建本地配置及空密钥文件
node src/cli.js bridge                   启动本地浏览器 Bridge
node src/cli.js doctor                   检查浏览器身份、作品归属及密钥是否填写
node src/cli.js videos add <ID或完整链接>  手动添加作品（仍需启动时核验归属）
node src/cli.js inspect [ID或完整链接]     只读采样配置中的作品，保存关系字段供核查
node src/cli.js run --once               执行一轮（会自动发送）
node src/cli.js run                      持续轮询（会自动发送）
node src/cli.js status                   查看本地任务及需关注结果
node src/cli.js retry <任务key>           仅重新排队明确失败、尚未发送的任务

配置：config.local.json；密钥：.env.local（DeepSeek / OpenAI 自行填写）
油猴：init 生成 runtime/dafeiyu-douyin.user.js，Token 在油猴菜单本地填写。
`;

function dependencies(config) {
  const bridge = new BridgeClient({ ...config.bridge, timeout: config.bridge.requestTimeout + 5000 });
  const adapter = config.accountUid ? new DouyinAdapter({ bridge, accountUid: config.accountUid, inboundSchemaConfirmed: config.douyin.inboundSchemaConfirmed }) : null;
  return { bridge, adapter };
}

async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'help';
  if (['help', '--help', '-h'].includes(command)) { console.log(HELP); return; }
  if (command === 'init') {
    const config = initialize();
    print({ config: path.join(ROOT, 'config.local.json'), env: path.join(ROOT, '.env.local'), userscript: path.join(config.runtimeDir, 'dafeiyu-douyin.user.js'), bridge: `http://${config.bridge.host}:${config.bridge.port}`, note: '未生成或写入模型密钥；请自行填写。Bridge Token 仅在 config.local.json 中查看。' });
    return;
  }
  loadLocalEnv();
  const config = loadConfig(undefined, { requireAccount: ['run', 'inspect', 'retry'].includes(command) });
  if (command === 'videos' && args[1] === 'add') {
    if (!args[2]) throw new Error('请提供作品 ID 或完整抖音作品链接');
    const videoId = parseVideoId(args[2]);
    const file = path.join(ROOT, 'config.local.json');
    const local = JSON.parse(fs.readFileSync(file, 'utf8'));
    local.videos = [...new Set([...(local.videos || []).map(parseVideoId), videoId])];
    fs.writeFileSync(file, JSON.stringify(local, null, 2) + '\n', { mode: 0o600 });
    print({ videoId, added: true, note: '运行前仍会核验当前登录账号及作品作者' });
    return;
  }
  if (command === 'bridge') {
    const bridge = createBridgeServer(config.bridge);
    const address = await bridge.start();
    print({ listening: `http://${address.address}:${address.port}`, note: '等待已登录的抖音油猴连接' });
    const stop = () => { bridge.close().catch(() => {}).finally(() => { process.exitCode = 0; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return;
  }
  if (command === 'doctor') {
    const { bridge } = dependencies(config);
    const runtime = new RuntimeController({ root: ROOT });
    print(await diagnose({ config, bridge, runtime })); return;
  }
  if (command === 'inspect') {
    const ids = args[1] ? [parseVideoId(args[1])] : config.videos;
    if (!ids.length || ids.some(id => !config.videos.includes(id))) throw new Error('inspect 仅采样手动配置的作品');
    const { adapter } = dependencies(config);
    const reports = [];
    fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
    for (const id of ids) {
      await adapter.verifyVideo(id);
      const scan = await adapter.scanVideo(id, config.douyin);
      const file = path.join(config.runtimeDir, `inspect-${id}.json`);
      fs.writeFileSync(file, JSON.stringify({ videoId: id, inspectedAt: new Date().toISOString(), ...scan }, null, 2), { mode: 0o600 });
      reports.push({ videoId: id, comments: scan.comments.length, complete: scan.complete, warnings: scan.warnings, file });
    }
    print(reports); return;
  }
  if (command === 'status') {
    const store = new Store(path.join(config.runtimeDir, 'agent.sqlite'));
    try { print(store.status(config.accountUid)); } finally { store.close(); }
    return;
  }
  if (command === 'retry') {
    if (!args[1]) throw new Error('请指定 status 中的任务 key；unknown 任务不能自动重试');
    const release = acquireLock(path.join(config.runtimeDir, 'worker.lock'));
    const store = new Store(path.join(config.runtimeDir, 'agent.sqlite'));
    try {
      store.retryFailed(args[1], config.accountUid);
      print({ requeued: args[1] });
    } finally { store.close(); release(); }
    return;
  }
  if (command !== 'run') throw new Error('未知命令；使用 node src/cli.js --help');
  const logger = new EventLogger({ directory: path.join(config.runtimeDir, 'logs'), secretValues: () => [config.bridge.token] });
  const unsubscribe = logger.subscribe(entry => print(entry.event === 'round.completed' ? entry.data : entry));
  const runtime = new RuntimeController({ root: ROOT, logger });
  const stop = () => runtime.stop();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await runtime.start({ once: args.includes('--once') });
    const final = await runtime.wait();
    if (final.error) throw new Error(final.error);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    unsubscribe(); logger.close();
  }
}

if (require.main === module) main().catch(error => {
  if (error.name !== 'AbortError') { console.error(error.message); process.exitCode = 1; }
});
module.exports = { main };
