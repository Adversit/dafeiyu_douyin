'use strict';
const { ChatClient } = require('../agent/llm');
const { DouyinAdapter } = require('../douyin/adapter');
const { redact } = require('./logger');

async function diagnose({ config, bridge, runtime } = {}) {
  const report = { checkedAt: Date.now(), overall: 'ok', checks: [], configuredAccount: config.accountUid || null,
    note: '状态检测不调用模型、不发送评论；模型密钥已配置不代表接口已验证。', browser: { connected: false, accountUid: null, lastSeen: null },
    account: { configuredUid: config.accountUid || null, actualUid: null, matched: false }, videos: [],
    model: null, runtime: runtime?.snapshot?.() || { state: 'stopped' }, relationshipTriggersReady: config.douyin.inboundSchemaConfirmed };
  const add = (key, label, status, message) => report.checks.push({ key, label, status, message });
  try {
    report.browser = await bridge.status();
    add('bridge', '本地 Bridge', 'ok', '本地服务可达，配对凭证匹配');
    add('browser', '抖音浏览器', report.browser.connected ? 'ok' : 'warn', report.browser.connected ? '油猴已连接' : '请启用油猴并打开已登录的抖音网页');
  } catch {
    add('bridge', '本地 Bridge', 'error', 'Bridge 不可达或配对凭证不匹配');
    add('browser', '抖音浏览器', 'skipped', '等待 Bridge 恢复后检测');
  }
  let actualUid = null;
  if (report.browser.connected && report.browser.accountUid) {
    try {
      const identity = await bridge.call('identity.get', { accountUid: report.browser.accountUid });
      actualUid = typeof identity?.uid === 'string' ? identity.uid : null;
      report.browser.identity = identity;
      if (!actualUid) throw new Error('未取得实际登录账号');
      report.account.actualUid = actualUid;
      report.account.matched = Boolean(config.accountUid && actualUid === config.accountUid);
      add('account', '登录账号', report.account.matched ? 'ok' : config.accountUid ? 'error' : 'warn',
        report.account.matched ? '实时登录账号与配置一致' : config.accountUid ? '实时登录账号与配置不一致，请核对 UID' : `已读取登录 UID：${actualUid}，请保存到配置`);
    } catch (error) { add('account', '登录账号', 'error', error.message); }
  } else add('account', '登录账号', 'skipped', '浏览器连接后可读取实际 UID');
  if (!config.videos.length) add('videos', '作品归属', 'warn', '尚未添加作品');
  for (const id of config.videos) {
    if (!report.account.matched) {
      report.videos.push({ id, owned: false, status: 'skipped', error: '请先连接并核验账号' });
      add(`video:${id}`, `作品 ${id}`, 'skipped', '请先连接并核验账号');
      continue;
    }
    try {
      await new DouyinAdapter({ bridge, accountUid: config.accountUid }).verifyVideo(id);
      report.videos.push({ id, owned: true, status: 'ok' });
      add(`video:${id}`, `作品 ${id}`, 'ok', '作品作者为当前配置账号');
    } catch (error) {
      report.videos.push({ id, owned: false, status: 'error', error: error.message });
      add(`video:${id}`, `作品 ${id}`, 'error', error.message);
    }
  }
  try {
    const client = new ChatClient(config.model);
    const keyConfigured = Boolean(process.env[client.apiKeyEnv]?.trim());
    report.model = { provider: client.provider, model: client.model, keyConfigured, apiVerified: false };
    add('model', '模型配置', keyConfigured ? 'ok' : 'warn', keyConfigured ? '密钥已配置；本次未调用模型，接口可用性尚未验证' : '尚未填写模型密钥');
  } catch (error) { add('model', '模型配置', 'error', error.message); }
  const state = report.runtime.state;
  add('runtime', '轮询进程', state === 'stale-lock' ? 'warn' : 'ok', {
    stopped: '已停止', running: '正在运行', stopping: '正在停止，等待在途步骤收尾', external: '外部 CLI 任务正在运行', 'stale-lock': '存在遗留执行锁，请先核实原进程状态',
  }[state] || state);
  add('relationships', '回复与 @ 关系', config.douyin.inboundSchemaConfirmed ? 'ok' : 'warn', config.douyin.inboundSchemaConfirmed ? '已按配置启用关系触发' : '尚未确认关系样本；文字提问与已启用的角色呼唤仍可触发');
  report.overall = report.checks.some(c => c.status === 'error') ? 'error' : report.checks.some(c => c.status === 'warn') ? 'warning' : 'ok';
  const secrets = [config.bridge.token, process.env[config.model.apiKeyEnv || (config.model.provider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY')],
    ...Object.entries(process.env).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH|CREDENTIAL/i.test(key)).map(([, value]) => value)];
  return redact(report, secrets);
}

module.exports = { diagnose };
