export const STATUS = {
  pending: { label: '等待处理', tone: 'default' },
  preparing: { label: '正在生成', tone: 'processing' },
  sending: { label: '正在发送', tone: 'processing' },
  succeeded: { label: '已确认发送', tone: 'success' },
  skipped: { label: '已跳过', tone: 'default' },
  failed: { label: '发送前失败', tone: 'error' },
  unknown: { label: '待核查', tone: 'warning' },
};

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function formatTime(value, full = false) {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    ...(full ? { month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

export function isBusy(state) {
  return ['running', 'stopping', 'external'].includes(state);
}

export function toForm(config = {}) {
  return {
    ...config,
    videosText: (config.videos || []).join('\n'),
    worker: {
      ...config.worker,
      pollIntervalSeconds: (config.worker?.pollIntervalMs ?? 60000) / 1000,
      sendIntervalSeconds: (config.worker?.sendIntervalMs ?? 60000) / 1000,
    },
    model: {
      ...config.model,
      timeoutSeconds: (config.model?.timeoutMs ?? 30000) / 1000,
    },
    triggers: { respondToNameCall: true, ...config.triggers },
    secrets: { deepseek: '', openai: '' },
  };
}

export function toPayload(values, currentConfig, revision) {
  // Start with the loaded configuration so a compact form does not drop advanced settings.
  const config = structuredClone(currentConfig);
  delete config.bridge;
  config.accountUid = String(values.accountUid || '').trim();
  config.videos = String(values.videosText || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  config.model = { ...currentConfig.model, ...values.model, timeoutMs: Math.round(values.model.timeoutSeconds * 1000) };
  delete config.model.timeoutSeconds;
  if (!config.model.baseUrl?.trim()) delete config.model.baseUrl;
  config.worker = {
    ...currentConfig.worker, ...values.worker,
    pollIntervalMs: Math.round(values.worker.pollIntervalSeconds * 1000),
    sendIntervalMs: Math.round(values.worker.sendIntervalSeconds * 1000),
  };
  delete config.worker.pollIntervalSeconds;
  delete config.worker.sendIntervalSeconds;
  config.stickers = { ...currentConfig.stickers, ...values.stickers };
  config.triggers = { ...currentConfig.triggers, ...values.triggers };
  config.douyin = { ...currentConfig.douyin, ...values.douyin };
  const secrets = Object.fromEntries(Object.entries(values.secrets || {})
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => [key, value.trim()]));
  return { config, secrets, revision };
}

export function mergeUnique(previous, incoming, key, limit = 1000) {
  const records = new Map(previous.map(item => [item[key], item]));
  for (const item of incoming) records.set(item[key], item);
  return [...records.values()].slice(-limit);
}

export function filterLogs(logs, level, query) {
  const search = query.trim().toLocaleLowerCase();
  return logs.filter(entry => (LEVELS[entry.level] ?? LEVELS.info) >= (LEVELS[level] ?? LEVELS.debug)
    && (!search || [entry.message, entry.stage, entry.event, entry.videoId, entry.targetCid, JSON.stringify(entry.data || {})]
      .join(' ').toLocaleLowerCase().includes(search)));
}

export function filterActivities(records, level) {
  const severity = { pending: 'debug', preparing: 'debug', sending: 'info', succeeded: 'info', skipped: 'info', unknown: 'warn', failed: 'error' };
  return records.filter(record => LEVELS[severity[record.status] || 'info'] >= (LEVELS[level] ?? LEVELS.debug));
}

// A readback is independent evidence; it must not be described as an
// originally complete publishing receipt in either the UI or exports.
export function activityReason(item) {
  if (item.status === 'succeeded' && item.verificationSource === 'readback') return '只读核查确认发送，原始发布回执不完整。';
  return item.reason || (item.status === 'succeeded' ? '账号、目标楼层与发布回执已确认。' : '—');
}

export function serializeActivities(records, format = 'txt') {
  if (!['txt', 'jsonl'].includes(format)) throw new Error('只支持 TXT 或 JSONL 导出');
  if (format === 'jsonl') return records.map(item => JSON.stringify(item)).join('\n') + (records.length ? '\n' : '');
  return records.map(item => [
    `${formatTime(item.updatedAt, true)}　作品 ${item.videoId}　评论 ${item.targetCid}`,
    `观众：${item.commentText || '（无文字评论）'}`,
    `大肥鱼：${item.replyText || '（未生成回复）'}`,
    `结果：${STATUS[item.status]?.label || item.status}`,
    `原因：${activityReason(item)}`,
  ].join('\n')).join('\n\n') + (records.length ? '\n' : '');
}
