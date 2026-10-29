import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert, App as AntApp, Button, Checkbox, Collapse, ConfigProvider, Descriptions,
  Drawer, Empty, Form, Input, InputNumber, Select, Skeleton, Space, Switch,
  Tag, Tooltip,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {
  CheckCircleOutlined, CheckOutlined, CloudDownloadOutlined, CopyOutlined,
  DownOutlined, ExportOutlined, LoadingOutlined,
  PlayCircleOutlined, ReloadOutlined, SearchOutlined, SettingOutlined,
  StopOutlined, ThunderboltOutlined, WarningOutlined,
} from '@ant-design/icons';
import { STATUS, activityReason, filterActivities, filterLogs, formatTime, isBusy, mergeUnique, serializeActivities, toForm, toPayload } from './helpers.mjs';
import { createEventStream, createReadonlyRuntimePoll } from './connection.mjs';
import 'antd/dist/reset.css';
import './styles.css';

let csrfToken = '';
async function session() {
  const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '无法连接本地控制台');
  csrfToken = value.csrfToken;
}

async function api(path, { method = 'GET', body, signal, blob = false } = {}) {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store', signal,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(!['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    let value;
    try { value = await response.json(); } catch { /* A stopped server may return no JSON. */ }
    const error = new Error(value?.error || `请求失败（HTTP ${response.status}）`);
    error.code = value?.code;
    error.status = response.status;
    throw error;
  }
  return blob ? response.blob() : response.json();
}

const stateLabels = {
  stopped: '已停止', running: '运行中', stopping: '停止中', external: 'CLI 运行中', 'stale-lock': '遗留执行锁',
};
const levelLabels = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };
const stageLabels = { starting: '准备运行', scan: '读取评论', trigger: '规则判断', semantic: '语义判断', generate: '生成回复', model: '调用模型', dedup: '检查重复', throttle: '等待发送间隔', sticker: '选择表情', publish: '发布回复', receipt: '核对回执', waiting: '等待下一轮', complete: '本轮完成', stopped: '已停止', error: '异常', diagnostics: '状态检测', config: '配置', console: '控制台' };
const triggerLabels = { reply_to_me: '回复本账号', mention_me: '@ 本账号', question_to_fish: '向大肥鱼提问', name_call: '直接呼唤', call_name: '直接呼唤', name_call_to_fish: '直接呼唤' };

function FishMark() {
  return <svg viewBox="0 0 60 48" aria-hidden="true"><path d="M43 25 56 13v25L43 29" fill="#65bcc8" /><path d="M7 25C7 12 18 5 30 7c11 1 17 9 16 19-1 12-12 18-24 15C12 38 7 32 7 25Z" fill="#11738a" /><path d="m25 8 7-5 3 8M24 39l8 6 3-9" fill="#11738a" /><circle cx="18" cy="22" r="3" fill="white" /><circle cx="18" cy="22" r="1.4" fill="#193650" /><path d="M11 29c3 2 6 2 8 0" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" /><circle cx="5" cy="10" r="3" fill="#b8e1e7" /></svg>;
}

function StatusPill({ label, text, tone = 'neutral' }) {
  return <div className={`status-pill status-${tone}`}><span className="status-dot" /><div><small>{label}</small><strong>{text}</strong></div></div>;
}

function Console() {
  const { message, modal } = AntApp.useApp();
  const [form] = Form.useForm();
  const [configData, setConfigData] = useState(null);
  const [runtime, setRuntime] = useState({ state: 'stopped', round: 0 });
  const [health, setHealth] = useState(null);
  const [healthOpen, setHealthOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [booting, setBooting] = useState(true);
  const [fatalError, setFatalError] = useState('');
  const [connection, setConnection] = useState('connecting');
  const [dirty, setDirty] = useState(false);
  const [configConflict, setConfigConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState('');
  const [tab, setTab] = useState('activity');
  const [activities, setActivities] = useState([]);
  const [activityCursor, setActivityCursor] = useState(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState('');
  const [activityStatus, setActivityStatus] = useState('');
  const [recalling, setRecalling] = useState(null);
  const recallInFlightRef = useRef(new Set());
  const [resending, setResending] = useState(null);
  const resendInFlightRef = useRef(new Set());
  const [checkingRecord, setCheckingRecord] = useState(null);
  const recordCheckInFlightRef = useRef(new Set());
  const [logs, setLogs] = useState([]);
  const [minimumLevel, setMinimumLevel] = useState('debug');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const [detail, setDetail] = useState(null);
  const [now, setNow] = useState(Date.now());
  const scrollRef = useRef(null);
  const readyRef = useRef(false);
  const latestLogRef = useRef(null);
  const activityRequestRef = useRef(0);
  const loadedOlderRef = useRef(false);
  const scheduleRef = useRef(null);
  const provider = Form.useWatch(['model', 'provider'], form) || configData?.config.model.provider || 'deepseek';
  const stickersEnabled = Form.useWatch(['stickers', 'enabled'], form);
  const busy = isBusy(runtime.state);
  const visibleLogs = filterLogs(logs, minimumLevel, search);
  const visibleActivities = filterActivities(activities, minimumLevel);

  const refreshActivity = useCallback(async ({ older = false, cursor, replace = false } = {}) => {
    const generation = ++activityRequestRef.current;
    setActivityLoading(true);
    const params = new URLSearchParams({ limit: '50' });
    if (search) params.set('query', search);
    if (activityStatus) params.set('status', activityStatus);
    if (older && cursor) params.set('before', cursor);
    try {
      const response = await api(`/api/activity?${params}`);
      if (generation !== activityRequestRef.current) return;
      setActivities(previous => older ? mergeUnique(previous, response.items || [], 'jobKey', 2000)
        : replace || !loadedOlderRef.current ? response.items || []
          : mergeUnique(previous, response.items || [], 'jobKey', 2000).sort((a, b) => b.updatedAt - a.updatedAt));
      if (older) loadedOlderRef.current = true;
      if (older || replace || !loadedOlderRef.current) setActivityCursor(response.nextCursor || null);
      setActivityError('');
    } catch (error) {
      if (generation === activityRequestRef.current) setActivityError(error.message);
    } finally { if (generation === activityRequestRef.current) setActivityLoading(false); }
  }, [search, activityStatus]);
  const refreshActivityRef = useRef(refreshActivity);
  useEffect(() => { refreshActivityRef.current = refreshActivity; }, [refreshActivity]);

  const loadConfiguration = useCallback(async () => {
    const data = await api('/api/config');
    setConfigData(data);
    form.setFieldsValue(toForm(data.config));
    setDirty(false);
    setConfigConflict(false);
    return data;
  }, [form]);

  useEffect(() => {
    let disposed = false;
    let runtimePoll;
    let activityPoll;
    const stream = createEventStream({
      getLastId: () => latestLogRef.current,
      onConnection: state => { if (!disposed) setConnection(state); },
      onLog: item => {
        latestLogRef.current = item.id;
        setLogs(previous => mergeUnique(previous, [item], 'id'));
        if (!scheduleRef.current) scheduleRef.current = setTimeout(() => {
          scheduleRef.current = null;
          if (!disposed) refreshActivityRef.current();
        }, 700);
      },
      onRuntime: state => { if (!disposed) setRuntime(state); },
    });
    const pollRuntime = createReadonlyRuntimePoll({
      requestRuntime: () => api('/api/runtime'),
      renewSession: session,
      reconnectStream: () => stream.connect(),
      onRuntime: state => setRuntime(state),
      onConnection: state => setConnection(state),
      isDisposed: () => disposed,
    });
    const start = async () => {
      try {
        await session();
        const [, state, history] = await Promise.all([loadConfiguration(), api('/api/runtime'), api('/api/logs?level=debug&limit=200')]);
        if (disposed) return;
        setRuntime(state);
        setLogs(history.items || []);
        latestLogRef.current = history.items?.at(-1)?.id || null;
        readyRef.current = true;
        setFatalError('');
        setBooting(false);
        await refreshActivityRef.current();
        if (disposed) return;
        stream.connect();
        runtimePoll = setInterval(pollRuntime, 5000);
        activityPoll = setInterval(() => { if (!disposed) refreshActivityRef.current(); }, 15000);
      } catch (error) {
        if (!disposed) { setFatalError(error.message); setBooting(false); }
      }
    };
    start();
    return () => { disposed = true; stream.close(); clearInterval(runtimePoll); clearInterval(activityPoll); clearTimeout(scheduleRef.current); readyRef.current = false; };
  }, [loadConfiguration]);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  useEffect(() => {
    loadedOlderRef.current = false;
    if (readyRef.current) refreshActivity({ replace: true });
  }, [refreshActivity]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (follow && tab === 'logs' && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleLogs.length, tab, follow]);
  useEffect(() => {
    const preventLoss = event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [dirty]);

  const saveConfiguration = async () => {
    if (busy || recordCheckInFlightRef.current.size) return;
    let values;
    try {
      await form.validateFields();
      // Collapsed sections are mounted lazily. Keep their loaded values as well
      // as mounted field values, otherwise saving a simple UID edit drops them.
      values = form.getFieldsValue(true);
    } catch { message.warning('请检查标出的配置项'); return; }
    setSaving(true);
    try {
      await api('/api/config', { method: 'PUT', body: toPayload(values, configData.config, configData.revision) });
      await loadConfiguration();
      setHealth(null);
      message.success('配置已保存，下次启动使用新配置');
    } catch (error) {
      if (error.code === 'CONFIG_CHANGED') setConfigConflict(true);
      message.error(error.message);
    }
    finally { setSaving(false); }
  };

  const checkHealth = async () => {
    setChecking(true);
    setHealthOpen(true);
    try { setHealth(await api('/api/check', { method: 'POST' })); }
    catch (error) { message.error(error.message); }
    finally { setChecking(false); }
  };

  const run = async command => {
    if (recallInFlightRef.current.size || resendInFlightRef.current.size || recordCheckInFlightRef.current.size) return;
    setAction(command);
    try {
      setRuntime(await api(`/api/runtime/${command}`, { method: 'POST' }));
      if (command === 'stop') message.info('已请求停止，正在等待当前操作收尾');
      else message.success(command === 'once' ? '已开始执行一轮' : '已开始持续轮询');
    } catch (error) { message.error(error.message); }
    finally { setAction(''); }
  };

  const recallReply = async item => {
    if (runtime.state !== 'stopped' || !item.canRecall || recallInFlightRef.current.size || resendInFlightRef.current.size || recordCheckInFlightRef.current.size) return;
    recallInFlightRef.current.add(item.jobKey);
    setRecalling(item.jobKey);
    // A lost response is ambiguous: keep the button disabled until a fresh
    // activity read proves that the operation was rejected before dispatch.
    setActivities(previous => previous.map(record => record.jobKey === item.jobKey
      ? { ...record, recallStatus: 'requesting', canRecall: false } : record));
    try {
      const result = await api('/api/activity/recall', { method: 'POST', body: { jobKey: item.jobKey } });
      const status = ['confirmed', 'unknown', 'failed'].includes(result.status) ? result.status : 'unknown';
      setActivities(previous => previous.map(record => record.jobKey === item.jobKey
        ? { ...record, recallStatus: status, canRecall: status === 'failed' } : record));
      if (status === 'confirmed') message.success('回复已撤回并核验');
      else if (status === 'failed') message.error(result.reason || '撤回请求未发送，可以手动重试');
      else message.warning('撤回结果待核查，请到抖音确认；不会自动重试');
    } catch (error) {
      setActivities(previous => previous.map(record => record.jobKey === item.jobKey
        ? { ...record, recallStatus: 'unknown', canRecall: false } : record));
      message.error(`${error.message}；请刷新记录核查撤回状态`);
    } finally {
      recallInFlightRef.current.delete(item.jobKey);
      setRecalling(null);
      await refreshActivity();
    }
  };

  const resendReply = async item => {
    if (runtime.state !== 'stopped' || dirty || action || !item.canResend || recallInFlightRef.current.size || resendInFlightRef.current.size || recordCheckInFlightRef.current.size) return;
    resendInFlightRef.current.add(item.jobKey);
    setResending(item.jobKey);
    setActivities(previous => previous.map(record => record.jobKey === item.jobKey
      ? { ...record, canResend: false } : record));
    try {
      const state = await api('/api/activity/resend', { method: 'POST', body: { jobKey: item.jobKey } });
      setRuntime(state);
      message.info('已核验并开始重新生成，请在对话记录查看结果');
    } catch (error) {
      message.warning(`${error.message}；请刷新记录核查状态后再操作`);
    } finally {
      resendInFlightRef.current.delete(item.jobKey);
      setResending(null);
      await refreshActivity();
    }
  };

  const checkReply = async item => {
    if (runtime.state !== 'stopped' || dirty || saving || action || !item.canCheck || recallInFlightRef.current.size || resendInFlightRef.current.size || recordCheckInFlightRef.current.size) return;
    recordCheckInFlightRef.current.add(item.jobKey);
    setCheckingRecord(item.jobKey);
    try {
      const result = await api('/api/activity/check', { method: 'POST', body: { jobKey: item.jobKey } });
      const status = ['present', 'absent', 'inconclusive'].includes(result.status) ? result.status : 'inconclusive';
      setActivities(previous => previous.map(record => record.jobKey === item.jobKey
        ? { ...record, checkStatus: status, checkReason: result.reason || '', checkAt: result.checkedAt || null } : record));
      if (status === 'present') message.success('只读核查完成：当前楼层中找到该回复');
      else if (status === 'absent') message.info('只读核查完成：当前楼层未找到该回复');
      else message.warning(result.reason || '只读核查不完整，请稍后重试');
    } catch (error) {
      message.warning(`${error.message}；请刷新记录查看核查状态`);
    } finally {
      recordCheckInFlightRef.current.delete(item.jobKey);
      setCheckingRecord(null);
      await refreshActivity();
    }
  };

  const copyToken = async () => {
    try {
      const { token } = await api('/api/bridge/token', { method: 'POST' });
      try { await navigator.clipboard.writeText(token); message.success('配对 Token 已复制，请在油猴菜单中粘贴'); }
      catch {
        modal.info({ title: '本机配对 Token', content: <><p>复制后，粘贴到抖音页面油猴菜单的「配置本地 Bridge Token」。</p><Input.TextArea value={token} readOnly autoSize onFocus={event => event.target.select()} /></>, okText: '完成' });
      }
    } catch (error) { message.error(error.message); }
  };

  const exportLogs = async format => {
    try {
      let data;
      if (tab === 'activity') {
        data = new Blob([serializeActivities(visibleActivities, format)], { type: 'text/plain;charset=utf-8' });
      } else {
        const params = new URLSearchParams({ format, level: minimumLevel });
        if (search) params.set('query', search);
        data = await api(`/api/logs/export?${params}`, { blob: true });
      }
      const url = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = url;
      link.download = `dafeiyu-${tab === 'activity' ? 'conversations' : 'logs'}-${new Date().toISOString().replace(/[:.]/g, '-')}.${format === 'txt' ? 'txt' : 'jsonl'}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message.success(tab === 'activity' ? `已导出当前已加载的 ${visibleActivities.length} 条对话` : '已导出当前筛选的运行日志');
    } catch (error) { message.error(error.message); }
  };

  const keyConfigured = provider === 'openai' ? configData?.secrets.openaiConfigured : configData?.secrets.deepseekConfigured;
  const configItems = configData ? [
    { key: 'account', label: '账号与作品', children: <>
      <Form.Item name="accountUid" label="账号 UID" rules={[{ pattern: /^\d{5,30}$/, message: '请填写检测结果中的数字 UID，勿填写昵称或抖音号' }]} extra="填写状态检测返回的数字 UID。">
        <Input placeholder="先检测状态，确认当前登录账号" inputMode="numeric" autoComplete="off" />
      </Form.Item>
      <Form.Item name="videosText" label="要回复的视频" extra="每行一个作品 ID 或完整链接，仅处理属于此账号的作品。">
        <Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} placeholder={'https://www.douyin.com/video/作品ID\n也支持包含 modal_id 的链接'} />
      </Form.Item>
      <div className="connection-tools"><Button size="small" icon={<CopyOutlined />} onClick={copyToken}>复制配对 Token</Button><a href="/api/userscript" download>下载油猴脚本</a></div>
      <p className="field-note">本地连接 {configData.config.bridge?.host}:{configData.config.bridge?.port}。油猴需要在已登录的抖音页面运行。</p>
    </> },
    { key: 'model', label: '模型服务', children: <>
      <Form.Item name={['model', 'provider']} label="服务商"><Select options={[{ value: 'deepseek', label: 'DeepSeek' }, { value: 'openai', label: 'OpenAI' }]} /></Form.Item>
      <Form.Item name={['model', 'model']} label="模型名称" extra="留空使用服务商适配器的默认模型。"><Input placeholder="使用默认模型" autoComplete="off" /></Form.Item>
      <Form.Item key={provider} name={['secrets', provider]} label={<span>{provider === 'openai' ? 'OpenAI' : 'DeepSeek'} API 密钥 <Tag color={keyConfigured ? 'success' : 'default'}>{keyConfigured ? '已配置' : '未配置'}</Tag></span>} extra="只保存到本机；留空保留已有密钥，原值不会回显。">
        <Input.Password placeholder={keyConfigured ? '留空保留现有密钥' : '输入 API 密钥'} autoComplete="new-password" />
      </Form.Item>
    </> },
    { key: 'poll', label: '轮询与发送', children: <>
      <div className="form-pair"><Form.Item name={['worker', 'pollIntervalSeconds']} label="轮询间隔（秒）" rules={[{ required: true, message: '请填写间隔' }]}><InputNumber min={1} max={86400} /></Form.Item>
        <Form.Item name={['worker', 'sendIntervalSeconds']} label="发送间隔（秒）" rules={[{ required: true, message: '请填写间隔' }]}><InputNumber min={1} max={86400} /></Form.Item></div>
      <Form.Item name={['worker', 'maxRepliesPerRound']} label="每轮最多尝试发送" rules={[{ required: true, message: '请填写上限' }]} extra="所有指定作品合计；历史符合规则的评论也会处理。"><InputNumber min={1} max={100} addonAfter="条" /></Form.Item>
      <Form.Item name={['triggers', 'respondToNameCall']} valuePropName="checked" label="回应直接呼唤"><Switch checkedChildren="开启" unCheckedChildren="关闭" /></Form.Item>
      <p className="field-note">单独喊「大肥鱼」「大肥鱼！」也可触发；普通句子中提到名字仍按语义判断。</p>
    </> },
    { key: 'sticker', label: '大肥鱼表情包', children: <>
      <Form.Item name={['stickers', 'enabled']} valuePropName="checked" label="回复附带表情"><Switch checkedChildren="开启" unCheckedChildren="关闭" /></Form.Item>
      <Form.Item name={['stickers', 'mode']} label="发送方式"><Select disabled={!stickersEnabled} options={[{ value: 'optional', label: '可选：没有合适表情就只发文字' }, { value: 'required', label: '必须附图：没有合适表情则不发' }]} /></Form.Item>
      <Form.Item name={['stickers', 'autoSync']} label="素材获取"><Select disabled={!stickersEnabled} options={[{ value: 'lazy', label: '按需下载原表情' }, { value: 'off', label: '仅使用本地缓存' }]} /></Form.Item>
      <p className="field-note">使用 nekowhale 原表情，GIF 动画及图片评论权限需要账号实际验证。</p>
    </> },
    { key: 'advanced', label: '高级设置', children: <>
      <Form.Item name={['model', 'baseUrl']} label="模型 API 地址" extra="留空使用服务商默认地址。"><Input placeholder="https://…" autoComplete="off" /></Form.Item>
      <div className="form-pair"><Form.Item name={['model', 'timeoutSeconds']} label="模型超时（秒）" rules={[{ required: true, message: '请填写超时' }]}><InputNumber min={1} max={300} /></Form.Item><Form.Item name={['worker', 'maxCandidatesPerRound']} label="每轮评估上限" rules={[{ required: true, message: '请填写上限' }]}><InputNumber min={1} max={1000} /></Form.Item></div>
      <Form.Item name={['stickers', 'limit']} label="表情候选数量"><InputNumber min={1} max={20} /></Form.Item>
      <div className="form-pair"><Form.Item name={['douyin', 'maxPages']} label="评论分页上限"><InputNumber min={1} max={1000} /></Form.Item><Form.Item name={['douyin', 'maxReplyPages']} label="回复分页上限"><InputNumber min={1} max={1000} /></Form.Item></div>
      <Form.Item name={['douyin', 'inboundSchemaConfirmed']} valuePropName="checked"><Checkbox>已核对真实回复／@ 的关系字段</Checkbox></Form.Item>
      <p className="field-note">只有用真实样本确认「回复本人、@ 本人、观众互聊」的正反例后才能勾选。未勾选时仍可处理明确向大肥鱼提问或直接呼唤的文字。</p>
      {configData.config.model.apiKeyEnv && <p className="field-note">当前密钥环境变量：{configData.config.model.apiKeyEnv}。此处密钥输入只更新对应服务的默认变量。</p>}
    </> },
  ] : [];

  const summary = runtime.lastSummary;
  const waitingSeconds = runtime.nextScanAt ? Math.max(0, Math.ceil((runtime.nextScanAt - now) / 1000)) : null;
  const accountMatched = health?.account?.matched;
  const ownedCount = health?.videos?.filter(item => item.owned).length || 0;

  return <div className="console-shell">
    <header className="page-header">
      <div className="brand"><div className="fish-mark"><FishMark /></div><div><h1>大肥鱼评论助手</h1><p>自己的作品，认真接住每一句话。</p></div></div>
      <div className="header-actions"><span className={`live-connection live-${connection}`}><span />{connection === 'online' ? '日志实时连接' : connection === 'reconnecting' ? '连接恢复中' : '正在连接'}</span><Button size="large" icon={checking ? <LoadingOutlined /> : <ReloadOutlined />} onClick={checkHealth} loading={checking} disabled={booting || Boolean(fatalError)}>检测状态</Button></div>
    </header>

    {fatalError ? <div className="fatal-panel"><WarningOutlined /><h2>暂时无法连接本地控制台</h2><p>{fatalError}</p><Button type="primary" onClick={() => location.reload()}>重新连接</Button></div> : <>
      <section className="operations-panel" aria-label="连接状态与运行控制">
        <div className="status-strip">
          <StatusPill label="浏览器" text={health ? health.browser?.connected ? '已连接' : '未连接' : '尚未检测'} tone={health ? health.browser?.connected ? 'ok' : 'warn' : 'neutral'} />
          <StatusPill label="账号" text={health ? accountMatched === true ? '登录账号一致' : health.account?.actualUid ? '需要核对' : '尚未读取' : '尚未检测'} tone={health ? accountMatched === true ? 'ok' : 'warn' : 'neutral'} />
          <StatusPill label="作品归属" text={health ? `${ownedCount} / ${health.videos?.length || 0} 已核验` : `${configData?.config.videos.length || 0} 个待核验`} tone={health?.videos?.length ? ownedCount === health.videos.length ? 'ok' : 'warn' : 'neutral'} />
          <StatusPill label="轮询" text={stateLabels[runtime.state] || runtime.state} tone={runtime.state === 'running' ? 'active' : runtime.state === 'stopping' || runtime.state === 'external' || runtime.state === 'stale-lock' ? 'warn' : 'neutral'} />
          <div className="status-more">{health ? <button onClick={() => setHealthOpen(true)}>查看检测详情 <DownOutlined /></button> : <span>点击「检测状态」核验运行条件</span>}<small>上次检测 {formatTime(health?.checkedAt)}</small></div>
        </div>
        <div className="run-toolbar"><Space size={10} wrap><Button icon={<ThunderboltOutlined />} onClick={() => run('once')} disabled={booting || busy || dirty || Boolean(action) || Boolean(recalling || resending || checkingRecord) || runtime.state === 'stale-lock'} loading={action === 'once'}>执行一轮</Button><Button type="primary" icon={<PlayCircleOutlined />} onClick={() => run('start')} disabled={booting || busy || dirty || Boolean(action) || Boolean(recalling || resending || checkingRecord) || runtime.state === 'stale-lock'} loading={action === 'start'}>开始轮询</Button><Button danger icon={runtime.state === 'stopping' ? <LoadingOutlined /> : <StopOutlined />} onClick={() => run('stop')} disabled={runtime.state !== 'running' || Boolean(action)} loading={action === 'stop' || runtime.state === 'stopping'}>{runtime.state === 'stopping' ? '停止中' : '停止'}</Button></Space>
          <div className="round-state">{runtime.state === 'running' ? <><span className="pulsing-dot" />第 {runtime.round || 1} 轮{waitingSeconds != null ? `，${waitingSeconds} 秒后继续扫描` : runtime.stage ? ` · ${stageLabels[runtime.stage] || runtime.stage}` : '，正在处理'}</> : summary ? `上轮读取 ${summary.scanned || 0} · 已确认发送 ${summary.sent || 0} · 跳过 ${summary.skipped || 0} · 待核查 ${summary.unknown || 0}` : '准备好后，从一轮文字回复开始'}</div>
        </div>
        <div className="operation-note"><span>执行一轮或开始轮询会真实发布评论，仅处理已指定且归属核验通过的本人作品。</span>{dirty && <strong>有未保存配置，请先保存。</strong>}</div>
      </section>

      {runtime.state === 'external' && <Alert className="page-alert" type="warning" showIcon message={`另一个 CLI 正在运行${runtime.externalPid ? `（PID ${runtime.externalPid}）` : ''}，请先在对应终端停止。网页不会启动第二个发送进程。`} />}
      {runtime.state === 'stale-lock' && <Alert className="page-alert" type="warning" showIcon message="检测到遗留执行锁。确认没有其他 worker 运行后，再按说明处理执行锁。控制台不会自动删除它。" />}
      {runtime.error && <Alert className="page-alert" type="error" showIcon message={runtime.error} />}
      {configConflict && <Alert className="page-alert" type="warning" showIcon message="配置已在其他位置修改，本页草稿仍保留。" action={<Button size="small" onClick={async () => { try { await loadConfiguration(); message.info('已重新读取配置'); } catch (error) { message.error(error.message); } }}>丢弃草稿并重新读取</Button>} />}

      <main className="workspace">
        <aside className="configuration-pane">
          <div className="pane-heading"><div><SettingOutlined /><h2>配置</h2></div>{dirty ? <Tag color="gold">未保存</Tag> : <span className="saved-mark"><CheckOutlined /> 已保存</span>}</div>
          {booting ? <div className="pane-loading"><Skeleton active paragraph={{ rows: 9 }} /></div> : <Form form={form} layout="vertical" className="configuration-form" disabled={busy || saving} onValuesChange={() => setDirty(true)} preserve>
            <Collapse ghost defaultActiveKey={['account', 'model']} items={configItems} expandIconPosition="end" />
          </Form>}
          <div className="config-footer"><Button type="primary" block icon={<CheckOutlined />} onClick={saveConfiguration} loading={saving} disabled={booting || busy || Boolean(checkingRecord) || !dirty}>保存配置</Button><p>{busy ? '运行中配置已锁定，请先停止再修改。' : '保存不会发送评论，下次启动使用新配置。'}</p></div>
        </aside>

        <section className="activity-pane" aria-label="处理日志">
          <div className="activity-heading"><div className="view-switch" role="tablist" aria-label="日志视图"><button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'selected' : ''} onClick={() => setTab('activity')}>对话记录</button><button role="tab" aria-selected={tab === 'logs'} className={tab === 'logs' ? 'selected' : ''} onClick={() => setTab('logs')}>完整日志</button></div><Tooltip title={tab === 'activity' ? '导出当前已加载且筛选后的对话记录；更早记录需先点击加载。' : '按当前级别和搜索条件导出已保存的完整日志'}><Space size={3}><Button type="text" icon={<ExportOutlined />} onClick={() => exportLogs('txt')}>文字</Button><Button type="text" icon={<CloudDownloadOutlined />} onClick={() => exportLogs('jsonl')}>JSONL</Button></Space></Tooltip></div>
          <div className="log-filters"><Input prefix={<SearchOutlined />} placeholder={tab === 'activity' ? '搜索评论、回复或处理原因' : '搜索消息、作品 ID 或诊断字段'} value={searchInput} onChange={event => setSearchInput(event.target.value)} allowClear />
            {tab === 'activity' && <Select aria-label="处理结果筛选" value={activityStatus} onChange={setActivityStatus} options={[{ value: '', label: '全部结果' }, ...Object.entries(STATUS).map(([value, status]) => ({ value, label: status.label }))]} />}
            <Tooltip title={tab === 'activity' ? '待核查为 WARN，发送前失败为 ERROR，已发送和跳过为 INFO。' : '显示所选级别及更严重的事件。'}><Select aria-label="最低日志级别" value={minimumLevel} onChange={setMinimumLevel} options={[{ value: 'debug', label: '全部级别' }, { value: 'info', label: 'INFO 及以上' }, { value: 'warn', label: 'WARN 及以上' }, { value: 'error', label: '仅 ERROR' }]} /></Tooltip>
          </div>
          <div className="view-description">{tab === 'activity' ? <span>评论原文、最终回复和处理结果。轮询时会定期核查，停止后也可手动只读核查。</span> : <><span>包含扫描、判断、生成与回执的完整过程。</span><Checkbox checked={follow} onChange={event => setFollow(event.target.checked)}>跟随最新</Checkbox></>}</div>
          <div className={`records-scroll ${tab === 'logs' ? 'technical-scroll' : ''}`} ref={scrollRef}>
            {tab === 'activity' ? <>
              {activityError && <Alert type="error" showIcon message={activityError} action={<Button size="small" onClick={() => refreshActivity()}>重试</Button>} />}
              {booting || activityLoading && activities.length === 0 ? <Skeleton active paragraph={{ rows: 8 }} /> : visibleActivities.length === 0 ? <EmptyState type="activity" filtered={Boolean(search || activityStatus || minimumLevel !== 'debug')} /> : visibleActivities.map(item => <ConversationRecord key={item.jobKey} item={item} runtimeState={runtime.state} configDirty={dirty} recalling={recalling === item.jobKey} resending={resending === item.jobKey} checkingRecord={checkingRecord === item.jobKey} operationBusy={Boolean(recalling || resending || checkingRecord || action || saving)} onRecall={() => recallReply(item)} onResend={() => resendReply(item)} onCheck={() => checkReply(item)} onDetail={() => setDetail({ type: 'activity', value: item })} />)}
              {activityCursor && <div className="load-more"><Button onClick={() => refreshActivity({ older: true, cursor: activityCursor })} loading={activityLoading}>加载更早记录</Button></div>}
            </> : visibleLogs.length === 0 ? <EmptyState type="logs" filtered={Boolean(search || minimumLevel !== 'debug')} /> : visibleLogs.map(item => <LogRecord key={item.id} item={item} onDetail={() => setDetail({ type: 'log', value: item })} />)}
          </div>
          <footer className="records-footer"><span>{tab === 'activity' ? `显示 ${visibleActivities.length} 条处理记录` : `显示 ${visibleLogs.length} 条日志，页面最多保留最近 1000 条`}</span><Button size="small" type="text" icon={<ReloadOutlined />} loading={activityLoading} onClick={async () => {
            if (tab === 'activity') await refreshActivity();
            else try { const value = await api('/api/logs?level=debug&limit=1000'); setLogs(value.items || []); } catch (error) { message.error(error.message); }
          }}>刷新</Button></footer>
        </section>
      </main>
      <footer className="page-footer">本机运行 · 配置与日志保存在本机 <span>结果不确定的评论会保留待核查状态，不自动重发。</span></footer>
    </>}

    <Drawer title="状态检测" open={healthOpen} onClose={() => setHealthOpen(false)} width={520} extra={<Button icon={<ReloadOutlined />} onClick={checkHealth} loading={checking}>重新检测</Button>}>
      <p className="drawer-note">只读核验连接、账号和作品归属，不调用模型，也不发送评论。</p>
      {checking && !health ? <Skeleton active paragraph={{ rows: 7 }} /> : !health ? <Empty description="尚未取得检测结果" /> : <>
        <div className="check-timestamp">检测时间 {formatTime(health.checkedAt, true)}</div>
        <div className="health-list">{(health.checks || []).map((check, index) => <div className={`health-check health-${check.status}`} key={`${check.key}-${index}`}><div className="check-icon">{check.status === 'ok' ? <CheckCircleOutlined /> : check.status === 'error' ? <WarningOutlined /> : <span>·</span>}</div><div><strong>{check.label}</strong><p>{check.message}</p></div><Tag color={check.status === 'ok' ? 'success' : check.status === 'error' ? 'error' : check.status === 'warn' ? 'warning' : 'default'}>{{ ok: '通过', error: '异常', warn: '需关注', skipped: '未检测' }[check.status] || check.status}</Tag></div>)}</div>
        <Descriptions column={1} size="small" title="当前身份" items={[{ key: 'configured', label: '配置 UID', children: health.account?.configuredUid || '未填写' }, { key: 'actual', label: '登录 UID', children: <Space size={8} wrap><span>{health.account?.actualUid || '未读取'}</span>{health.account?.actualUid && <Button size="small" type="link" disabled={busy} onClick={() => { form.setFieldValue('accountUid', String(health.account.actualUid)); setDirty(true); message.info('已填入登录 UID，请保存配置后使用'); }}>填入配置</Button>}</Space> }, { key: 'model', label: '模型', children: `${health.model?.provider || '—'} / ${health.model?.model || '默认'}` }, { key: 'key', label: '密钥', children: health.model?.keyConfigured ? '已配置；接口尚未调用验证' : '未配置' }]} />
        {!health.relationshipTriggersReady && <Alert type="info" showIcon message="回复／@ 的关系字段尚未确认" description={`当前仍可处理明确向大肥鱼提问${configData?.config.triggers?.respondToNameCall !== false ? '或直接呼唤' : ''}的文字。核验真实样本后再启用关系开关。`} />}
      </>}
    </Drawer>
    <Drawer title={detail?.type === 'activity' ? '这条评论的处理记录' : '日志详情'} open={Boolean(detail)} onClose={() => setDetail(null)} width={620}>
      {detail && (detail.type === 'activity' ? <>
        <Descriptions column={1} size="small" items={[{ key: 'video', label: '作品 ID', children: detail.value.videoId }, { key: 'target', label: '目标评论 ID', children: detail.value.targetCid }, { key: 'job', label: '任务', children: detail.value.jobKey }, { key: 'created', label: '创建时间', children: formatTime(detail.value.createdAt, true) }, { key: 'updated', label: '更新时间', children: formatTime(detail.value.updatedAt, true) }, { key: 'reason', label: '处理依据', children: detail.value.verificationSource === 'readback' ? activityReason(detail.value) : detail.value.reason || '—' }, ...(detail.value.verificationSource === 'readback' ? [{ key: 'verified', label: '只读核查确认时间', children: formatTime(detail.value.verificationCheckedAt, true) }] : [])]} />
        <h3>触发类型</h3><p>{detail.value.triggerKinds?.map(kind => triggerLabels[kind] || kind).join('、') || '文字语义判断'}</p>
        <h3>发布回执</h3><pre className="json-detail">{JSON.stringify(detail.value.result || { note: '尚无发布回执' }, null, 2)}</pre>
        {!detail.value.hasDetailedLogs && <p className="field-note">此记录只保留已有的最终结果，过去未采集的过程日志不会补造。</p>}
      </> : <><Descriptions column={1} size="small" items={[{ key: 'time', label: '时间', children: formatTime(detail.value.ts, true) }, { key: 'level', label: '级别', children: levelLabels[detail.value.level] || detail.value.level }, { key: 'stage', label: '阶段', children: detail.value.stage || '—' }, { key: 'message', label: '事件', children: detail.value.message }]} /><pre className="json-detail">{JSON.stringify(detail.value, null, 2)}</pre></>)}
    </Drawer>
  </div>;
}

function ConversationRecord({ item, onDetail, runtimeState, configDirty, recalling, resending, checkingRecord, operationBusy, onRecall, onResend, onCheck }) {
  const status = STATUS[item.status] || { label: item.status, tone: 'default' };
  const recall = {
    requesting: { text: '正在撤回，等待平台核验', color: 'processing' },
    confirmed: { text: '已撤回', color: 'success' },
    unknown: { text: '撤回结果待核查，请到抖音确认；不会自动重试', color: 'warning' },
    failed: { text: '撤回请求未发送，可手动重试', color: 'error' },
  }[item.recallStatus];
  const check = {
    present: { text: '当前找到', color: 'success' },
    absent: { text: '当前未找到', color: 'warning' },
    inconclusive: { text: '只读核查不完整', color: 'warning' },
  }[item.checkStatus];
  return <article className={`conversation-record result-${item.status}`}>
    <header><Space size={8} wrap><span className="video-label">作品 {item.videoId}</span><Tag color={status.tone}>{status.label}</Tag>{recall && <Tag color={recall.color}>{recall.text}</Tag>}{check && <Tooltip title={`${item.checkReason || '只读检查当前楼层'}；核查时间 ${formatTime(item.checkAt, true)}。当前观察不等同于抖音删除回执。`}><Tag color={check.color}>{check.text}</Tag></Tooltip>}{!item.hasDetailedLogs && <span className="history-label">历史记录</span>}</Space><time>{formatTime(item.updatedAt)}</time></header>
    <div className="conversation-line viewer-line"><span className="speaker-label">观众</span><p>{item.commentText || <span className="muted">无文字评论</span>}</p></div>
    {item.replyText && <div className="conversation-line fish-line"><span className="speaker-label">大肥鱼</span><p>{item.replyText}</p></div>}
    <div className={`decision-line decision-${item.status}`}><span>{item.status === 'unknown' ? <WarningOutlined /> : item.status === 'succeeded' ? <CheckOutlined /> : <span className="decision-dot" />}</span><p>{item.status === 'succeeded' ? activityReason(item) : item.reason || (item.status === 'preparing' ? '正在判断并生成回复。' : item.status === 'sending' ? '正在提交，等待平台回执。' : '等待处理。')}</p><button onClick={onDetail}>详情</button></div>
    <Space size={8} wrap>
      {(item.canCheck || checkingRecord) && <Tooltip title={runtimeState !== 'stopped' ? '请先停止轮询，再手动核查' : configDirty ? '请先保存配置' : '只读检查当前楼层，不发送评论'}><Button size="small" disabled={runtimeState !== 'stopped' || configDirty || !item.canCheck || operationBusy} loading={checkingRecord} onClick={onCheck}>只读核查</Button></Tooltip>}
      {(item.canRecall || recalling) && <Tooltip title={runtimeState !== 'stopped' ? '请先停止轮询，再撤回回复' : '撤回这条由 Agent 发送的回复'}><Button size="small" danger disabled={runtimeState !== 'stopped' || !item.canRecall || operationBusy} loading={recalling} onClick={onRecall}>撤回回复</Button></Tooltip>}
      {(item.canResend || resending) && <Tooltip title={runtimeState !== 'stopped' ? '请先停止轮询，再重新发送' : configDirty ? '请先保存配置' : '先核验原回复已消失，再仅针对这条评论重新生成并发送'}><Button size="small" disabled={runtimeState !== 'stopped' || configDirty || !item.canResend || operationBusy} loading={resending} onClick={onResend}>重新生成并发送</Button></Tooltip>}
    </Space>
  </article>;
}

function LogRecord({ item, onDetail }) {
  return <article className={`log-record level-${item.level}`}>
    <time>{formatTime(item.ts)}</time><span className="level-label">{levelLabels[item.level] || item.level}</span><div className="log-message"><p>{item.message || item.event}</p><div>{item.stage && <span>{stageLabels[item.stage] || item.stage}</span>}{item.roundId && <span>轮次 {item.roundId}</span>}{item.videoId && <span>作品 {item.videoId}</span>}</div></div><button aria-label={`查看日志详情：${item.message || item.event}`} onClick={onDetail}>详情</button>
  </article>;
}

function EmptyState({ type, filtered }) {
  return <div className="empty-state"><div className="empty-fish"><FishMark /></div><h3>{filtered ? '没有符合筛选条件的记录' : type === 'activity' ? '还没有处理记录' : '等待新的运行日志'}</h3><p>{filtered ? '试试其他关键词，或放宽筛选条件。' : type === 'activity' ? '先检测状态，配置完成后执行一轮。每条评论的回复与跳过原因都会出现在这里。' : '开始检测或运行后，这里会记录每一步处理过程。'}</p></div>;
}

createRoot(document.getElementById('root')).render(<ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#13788c', colorInfo: '#13788c', colorSuccess: '#34875f', colorWarning: '#bd7a1f', colorError: '#bf4c52', colorText: '#20384a', colorTextSecondary: '#718291', colorBorder: '#dce6ed', borderRadius: 8, fontFamily: '"PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif', controlHeight: 36 }, components: { Button: { fontWeight: 500 }, Collapse: { headerPadding: '17px 20px', contentPadding: '0 20px 16px' }, Input: { activeShadow: '0 0 0 2px rgba(19,120,140,.08)' } } }}><AntApp><Console /></AntApp></ConfigProvider>);
