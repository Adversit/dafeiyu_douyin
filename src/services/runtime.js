'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { ROOT, loadConfig, loadLocalEnv } = require('../config');
const { acquireLock } = require('../lock');
const { BridgeClient } = require('../bridge/client');
const { DouyinAdapter } = require('../douyin/adapter');
const { ChatClient } = require('../agent/llm');
const { Agent } = require('../agent/reply');
const { StickerService } = require('../stickers/service');
const { Store } = require('../store');
const { Worker } = require('../worker');
const { createDeletionCheckService } = require('./deletion-check');

function lockState(filename) {
  if (!fs.existsSync(filename)) return { state: 'stopped', externalPid: null };
  try {
    const { pid } = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) return { state: 'stale-lock', externalPid: null };
    try { process.kill(pid, 0); return { state: 'external', externalPid: pid }; }
    catch (error) { return { state: error.code === 'ESRCH' ? 'stale-lock' : 'external', externalPid: pid }; }
  } catch { return { state: 'stale-lock', externalPid: null }; }
}

function defaultWorker(config, log, { manualJobKey = null } = {}) {
  const store = new Store(path.join(config.runtimeDir, 'agent.sqlite'));
  try {
    store.recoverInFlight({ preserveManualJobKey: manualJobKey });
    const bridge = new BridgeClient({ ...config.bridge, timeout: config.bridge.requestTimeout + 5000 });
    const adapter = new DouyinAdapter({ bridge, accountUid: config.accountUid, inboundSchemaConfirmed: config.douyin.inboundSchemaConfirmed });
    const llm = new ChatClient(config.model, { log });
    const stickers = new StickerService({ enabled: config.stickers.enabled, cacheDir: path.join(config.runtimeDir, 'stickers'), autoSync: config.stickers.autoSync, mode: 'original' });
    return { worker: new Worker({ config, adapter, store, agent: new Agent({ llm }), stickers, log }), close: () => store.close() };
  } catch (error) { store.close(); throw error; }
}

class RuntimeController extends EventEmitter {
  constructor({ root = ROOT, configFile = path.join(root, 'config.local.json'), logger,
    createWorker = defaultWorker, sleepImpl = sleep, validateReady, bridgeClient } = {}) {
    super();
    Object.assign(this, { root, configFile, logger, createWorker, sleepImpl, validateReady, bridgeClient });
    this.lockFile = path.join(root, 'runtime/worker.lock');
    this.state = { state: 'stopped', mode: null, runId: null, round: 0, stage: null,
      nextScanAt: null, startedAt: null, lastSummary: null, error: null };
    this.task = null; this.controller = null; this.starting = false;
  }
  snapshot() {
    const state = { ...this.state };
    if (state.state === 'stopped') Object.assign(state, lockState(this.lockFile));
    return state;
  }
  isBusy() { return this.starting || ['running', 'stopping', 'external'].includes(this.snapshot().state); }
  update(patch) {
    Object.assign(this.state, patch);
    for (const listener of this.rawListeners('change')) { try { listener.call(this, this.snapshot()); } catch { /* disconnected viewers do not control execution */ } }
  }
  log(entry) {
    const event = { runId: this.state.runId, roundId: this.state.round ? `${this.state.runId}:${this.state.round}` : null, ...entry };
    let saved;
    try { saved = this.logger?.write(event); }
    catch { this.reportLogFailure(); return null; }
    if (entry.stage && this.state.stage !== entry.stage) this.update({ stage: entry.stage });
    return saved;
  }
  reportLogFailure() {
    this.controller?.abort();
    this.update({ state: this.state.state === 'running' ? 'stopping' : this.state.state,
      error: '日志写入失败，请检查磁盘空间和目录权限；任务已停止', nextScanAt: null });
  }
  async start({ once = false, resendJobKey = null } = {}) {
    if (this.task || this.isBusy()) throw Object.assign(new Error('已有任务运行中，请先停止；外部 CLI 任务需要在原终端停止'), { statusCode: 409 });
    let release;
    try { release = acquireLock(this.lockFile); } catch (error) { error.statusCode = 409; throw error; }
    this.starting = true;
    let config;
    try {
      loadLocalEnv({ root: this.root, override: true });
      config = loadConfig(this.configFile, { root: this.root, requireAccount: true });
      if (!config.videos.length) throw new Error('请先添加至少一个本人的作品');
      const llm = new ChatClient(config.model);
      if (this.validateReady) await this.validateReady(config);
      else if (!process.env[llm.apiKeyEnv]?.trim()) throw new Error(`尚未填写 ${llm.apiKeyEnv}`);
      if (resendJobKey !== null) {
        const bridge = this.bridgeClient || new BridgeClient({ ...config.bridge, timeout: config.bridge.requestTimeout + 5000 });
        await require('./resend').reserveManualResend({ root: this.root, config, bridge, jobKey: resendJobKey });
        once = true;
      }
    } catch (error) {
      this.starting = false; release();
      if (error instanceof SyntaxError) throw Object.assign(new Error('本地配置 JSON 格式有误，请检查配置文件'), { statusCode: 400 });
      if (!error.statusCode) error.statusCode = 400; throw error;
    }
    this.starting = false;
    this.controller = new AbortController();
    this.update({ state: 'running', mode: resendJobKey ? 'resend' : once ? 'once' : 'poll', runId: randomUUID(), round: 0,
      stage: 'starting', nextScanAt: null, startedAt: Date.now(), lastSummary: null, error: null });
    this.task = this.run(config, once, release, resendJobKey);
    return this.snapshot();
  }
  async run(config, once, release, resendJobKey = null) {
    await Promise.resolve(); // Install this.task before even a synchronous setup failure.
    let resource;
    try {
      resource = this.createWorker(config, entry => this.log(entry), { manualJobKey: resendJobKey });
      this.log({ level: 'info', event: 'runtime.started', stage: 'starting', message: resendJobKey ? '开始重新生成并发送指定回复' : once ? '开始执行一轮，将按规则自动发送' : '开始持续轮询，将按规则自动发送' });
      do {
        this.controller.signal.throwIfAborted();
        this.update({ round: this.state.round + 1, stage: 'scan', nextScanAt: null });
        this.log({ level: 'info', event: 'round.started', stage: 'scan', message: `开始第 ${this.state.round} 轮扫描` });
        const summary = await resource.worker.runOnce({ signal: this.controller.signal, onlyJobKey: resendJobKey });
        this.update({ lastSummary: summary });
        this.log({ level: summary.unknown || summary.failed ? 'warn' : 'info', event: 'round.completed', stage: 'complete', message: `本轮读取 ${summary.scanned} 条，确认发送 ${summary.sent} 条，跳过 ${summary.skipped} 条，待核查 ${summary.unknown} 条`, data: summary });
        if (!resendJobKey && !this.controller.signal.aborted) {
          try {
            const bridge = this.bridgeClient && !(this.bridgeClient instanceof BridgeClient)
              ? this.bridgeClient : new BridgeClient({ ...config.bridge, timeout: 5000 });
            const checks = createDeletionCheckService({ root: this.root, bridge, log: entry => this.log(entry) });
            await checks.checkBatchWhileLocked(config, { signal: this.controller.signal, limit: 3 });
          } catch (error) {
            if (this.controller.signal.aborted) throw error;
            this.log({ level: 'warn', event: 'reply_check.batch_failed', stage: 'check', message: '本轮只读核查未完成，将在后续轮次继续检查' });
          }
        }
        if (once || this.controller.signal.aborted) break;
        this.update({ stage: 'waiting', nextScanAt: Date.now() + config.worker.pollIntervalMs });
        await this.sleepImpl(config.worker.pollIntervalMs, undefined, { signal: this.controller.signal });
      } while (!this.controller.signal.aborted);
    } catch (error) {
      if (error.name !== 'AbortError') {
        this.update({ error: error.message });
        this.log({ level: 'error', event: 'runtime.error', stage: 'error', message: error.message, data: { code: error.code } });
      }
    } finally {
      if (resendJobKey) {
        try {
          const store = resource?.worker?.store || new Store(path.join(config.runtimeDir, 'agent.sqlite'));
          try { store.failUnclaimedManual(resendJobKey); } finally { if (store !== resource?.worker?.store) store.close(); }
        } catch (error) { this.update({ error: '手动重发状态清理失败，请查看日志' }); this.log({ level: 'error', event: 'runtime.cleanup_error', message: '手动重发状态清理失败' }); }
      }
      try { resource?.close?.(); } catch (error) {
        this.update({ error: error.message });
        this.log({ level: 'error', event: 'runtime.cleanup_error', message: error.message });
      } finally {
        release();
        this.log({ level: 'info', event: 'runtime.stopped', stage: 'stopped', message: '任务已停止，执行锁已释放' });
        this.task = null; this.controller = null;
        this.update({ state: 'stopped', stage: null, nextScanAt: null });
      }
    }
  }
  stop() {
    if (this.controller && ['running', 'stopping'].includes(this.state.state)) {
      this.controller.abort();
      this.update({ state: 'stopping', nextScanAt: null });
    }
    return this.snapshot();
  }
  async wait() { await this.task; return this.snapshot(); }
}

module.exports = { RuntimeController, lockState };
