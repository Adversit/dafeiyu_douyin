'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Worker } = require('../src/worker');
const { acquireLock } = require('../src/lock');
const { DouyinAdapter, normalizeComment } = require('../src/douyin/adapter');

test('启用直接呼唤后重新评估曾跳过的评论，不调用问句判断且成功后不重发', async t => {
  const observed = [];
  const { worker, config, agent, sent, store } = setup(t, [comment(40001, { text: '大肥鱼！', mentionUids: [], mentionsKnown: false })], { log: e => observed.push(e) });
  config.douyin.inboundSchemaConfirmed = false;
  config.triggers = { respondToNameCall: false };
  let decisions = 0;
  agent.decideAddressed = async () => { decisions++; return { addressed: false, reason: '只呼唤角色名' }; };
  assert.equal((await worker.runOnce()).skipped, 1);
  config.triggers.respondToNameCall = true;
  assert.equal((await worker.runOnce()).sent, 1);
  assert.equal(decisions, 1); assert.equal(sent.length, 1);
  assert.equal(store.get(`${ME}:${VIDEO}:40001`).status, 'succeeded');
  assert.equal((await worker.runOnce()).attempted, 0);
  assert.ok(observed.some(e => e.event === 'comment.skipped' && e.message === '只呼唤角色名'));
  assert.ok(observed.some(e => e.event === 'comment.succeeded' && e.data.commentText === '大肥鱼！'));
});

test('新增呼唤规则不会重新打开已经发送或待核查的相同目标', async t => {
  const { worker, config, store, sent } = setup(t, [comment(40001, { text: '大肥鱼', mentionUids: [] })]);
  const item = comment(40001, { text: '大肥鱼', mentionUids: [] });
  const key = store.enqueue(ME, item, { eligible: false, needsSemantic: true });
  store.finish(key, 'unknown', { reason: '历史回执未完整核验', result: { cid: '90001' } });
  config.triggers = { respondToNameCall: true };
  assert.equal((await worker.runOnce()).attempted, 0); assert.equal(sent.length, 0);
  assert.equal(store.get(key).status, 'unknown');
});

test('停止语义判断后不再生成回复，尚未发送的任务回到pending', async t => {
  const controller = new AbortController(); let generations = 0;
  const { worker, agent, store, sent } = setup(t, [comment(40001, { mentionUids: [], mentionsKnown: false })]);
  agent.decideAddressed = async () => { controller.abort(); return { addressed: true, reason: '向鱼提问' }; };
  agent.generate = async () => { generations++; return { text: '鱼来啦' }; };
  await assert.rejects(worker.runOnce({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(generations, 0); assert.equal(sent.length, 0);
  assert.equal(store.get(`${ME}:${VIDEO}:40001`).status, 'pending');
});

test('停止生成或表情检索后不进入新的付费与发送阶段', async t => {
  for (const phase of ['generation', 'search', 'choose', 'file', 'upload']) {
    const controller = new AbortController();
    const { worker, agent, config, store, sent, adapter } = setup(t, [comment(40001)]);
    config.stickers.enabled = true;
    const calls = [];
    agent.generate = async () => { calls.push('generation'); if (phase === 'generation') controller.abort(); return { text: '鱼来啦', stickerQuery: '开心' }; };
    worker.stickers = { search: async () => { calls.push('search'); if (phase === 'search') controller.abort(); return [{ id: 'fish' }]; },
      file: async () => { calls.push('file'); if (phase === 'file') controller.abort(); return { path: '/fake.gif', mime: 'image/gif' }; } };
    agent.chooseSticker = async () => { calls.push('choose'); if (phase === 'choose') controller.abort(); return 'fish'; };
    adapter.uploadImage = async () => { calls.push('upload'); controller.abort(); return { uri: 'tos/fake', format: 'gif', width: 1, height: 1 }; };
    await assert.rejects(worker.runOnce({ signal: controller.signal }), { name: 'AbortError' });
    assert.equal(sent.length, 0); assert.equal(calls.at(-1), phase);
    assert.equal(store.get(`${ME}:${VIDEO}:40001`).status, 'pending');
  }
});

test('停止到达已发请求时仍保存成功回执，之后同一目标不重发', async t => {
  const controller = new AbortController();
  const { worker, adapter, store, sent } = setup(t, [comment(40001)]);
  adapter.publishReply = async r => { sent.push(r); controller.abort(); return { cid: '90001', targetVerified: true, imageCount: 0 }; };
  await assert.rejects(worker.runOnce({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(store.get(`${ME}:${VIDEO}:40001`).status, 'succeeded');
  assert.equal((await worker.runOnce()).attempted, 0); assert.equal(sent.length, 1);
});

const ME = '10001', VIDEO = '20001';
function comment(cid, extra = {}) {
  return { videoId: VIDEO, cid: String(cid), authorUid: '30001', text: `大肥鱼你在吗${cid}`, rootCid: String(cid), mentionUids: [ME], mentionsKnown: true, replyRelationKnown: false, createdAt: Number(cid), ...extra };
}
function setup(t, events, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-worker-'));
  const filename = path.join(directory, 'test.sqlite');
  const store = new Store(filename);
  t.after(() => { if (store.db.open) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const config = { accountUid: ME, videos: [VIDEO], douyin: {},
    worker: { maxRepliesPerRound: 3, maxCandidatesPerRound: 30, sendIntervalMs: 1000 },
    stickers: { enabled: false, mode: 'optional', limit: 5, allowedMimeTypes: ['image/gif'] } };
  const sent = [], waits = [];
  const adapter = {
    async verifyVideo() {},
    async scanVideo() { return { comments: events, complete: true, warnings: [] }; },
    async readThread(_video, { targetCid, rootCid }) {
      const target = events.find(c => c.cid === targetCid) || store.getComment(ME, VIDEO, targetCid);
      if (!target) throw new Error('目标评论不存在');
      const comments = events.filter(c => (c.rootCid || c.cid) === rootCid);
      if (!comments.some(c => c.cid === targetCid)) comments.push(target);
      return { complete: true, target, comments };
    },
    async publishReply(reply) { sent.push(reply); return { cid: String(90000 + sent.length), imageCount: reply.images.length, targetVerified: true }; },
    async uploadImage() { return { uri: 'uploaded', width: 10, height: 10, format: 'gif' }; },
  };
  const agent = {
    async reviewInput() { return { safe: true, reason: '安全' }; },
    async reviewOutput() { return { safe: true, reason: '安全' }; },
    async decideAddressed() { return { addressed: true, reason: '正在问大肥鱼' }; },
    async generate(c) { return { text: `鱼收到${c.cid}啦` }; },
    async chooseSticker() { return null; },
  };
  const worker = new Worker({ config, store, adapter, agent, sleep: async ms => { waits.push(ms); }, ...overrides });
  return { worker, store, config, adapter, agent, sent, waits, directory, filename };
}

test('实时完整楼层的根评论和所有兄弟回复提供给审核与生成，保留各自身份', async t => {
  const root = comment(40001, { text: '根楼', authorUid: ME, mentionUids: [] });
  const sibling = comment(40002, { rootCid: root.cid, text: '一条回复', mentionUids: [] });
  const target = comment(40003, { rootCid: root.cid, text: '大肥鱼来看看', mentionUids: [ME] });
  const { worker, agent, sent, config } = setup(t, [root, sibling, target]);
  config.worker.maxCandidatesPerRound = 3;
  let observed;
  agent.reviewInput = async (c, context) => { if (c.cid === target.cid) observed = context; return { safe: true }; };
  await worker.runOnce();
  assert.ok(sent.some(r => r.targetCid === target.cid));
  assert.deepEqual(observed.thread.map(c => c.cid), [root.cid, sibling.cid]);
  assert.deepEqual(observed.thread.map(c => c.isOwn), [true, false]);
  assert.equal(observed.thread.some(c => c.cid === target.cid), false);
});

test('楼层读取失败或目标内容变化时不调用模型也不发送', async t => {
  for (const mode of ['failure', 'incomplete', 'changed']) {
    const { worker, adapter, agent, sent } = setup(t, [comment(40001)]);
    let modelCalls = 0;
    agent.reviewInput = async () => { modelCalls++; return { safe: true }; };
    adapter.readThread = async () => {
      if (mode === 'failure') throw new Error('不完整的楼层');
      const target = comment(40001, mode === 'changed' ? { text: '已改变' } : {});
      return { complete: mode !== 'incomplete', target, comments: [target] };
    };
    assert.equal((await worker.runOnce()).failed, 1);
    assert.equal(modelCalls, 0); assert.equal(sent.length, 0);
  }
});

test('输入或输出安全审核不通过、格式错误或异常时绝不发送', async t => {
  for (const phase of ['reviewInput', 'reviewOutput']) {
    for (const mode of ['reject', 'invalid', 'error']) {
      const { worker, agent, sent, store } = setup(t, [comment(40001)]);
      agent[phase] = async () => {
        if (mode === 'error') throw new Error('审核不可用');
        return mode === 'reject' ? { safe: false, reason: '提示词注入' } : {};
      };
      const summary = await worker.runOnce();
      assert.equal(sent.length, 0);
      assert.equal(summary.attempted, 0);
      assert.equal(summary[mode === 'error' ? 'failed' : 'skipped'], 1);
      assert.notEqual(store.get(`${ME}:${VIDEO}:40001`).status, 'succeeded');
    }
  }
});

test('启用表情时纯图可发送；无匹配素材时不发送空评论', async t => {
  for (const available of [true, false]) {
    const { worker, config, agent, sent } = setup(t, [comment(40001)]);
    config.stickers.enabled = true;
    agent.generate = async (_comment, context) => {
      assert.equal(context.allowImageOnly, true);
      return { text: '', stickerQuery: '打招呼' };
    };
    worker.stickers = { search: async () => available ? [{ id: '鱼' }] : [],
      file: async () => ({ path: '/fake/fish.gif', mime: 'image/gif' }) };
    agent.chooseSticker = async candidates => candidates[0]?.id || null;
    const summary = await worker.runOnce();
    assert.equal(summary.sent, available ? 1 : 0);
    assert.equal(sent.length, available ? 1 : 0);
    if (available) { assert.equal(sent[0].text, ''); assert.equal(sent[0].images.length, 1); }
    else assert.equal(summary.skipped, 1);
  }
});

test('历史评论分轮限量，同一目标不重复；新回复继续处理', async t => {
  const events = [1, 2, 3, 4, 5].map(n => comment(40000 + n));
  const { worker, sent } = setup(t, events);
  assert.equal((await worker.runOnce()).sent, 3);
  assert.equal((await worker.runOnce()).sent, 2);
  assert.equal((await worker.runOnce()).attempted, 0);
  assert.equal(sent.length, 5);
  events.push(comment(40006, { rootCid: '40001' }));
  assert.equal((await worker.runOnce()).sent, 1);
  assert.equal(sent.at(-1).targetCid, '40006');
});

test('旧父楼下的两个子回复各自去重，不能把整楼标为处理过', async t => {
  const own = comment(40001, { authorUid: ME, mentionUids: [] });
  const replies = ['40002', '40003'].map(cid => comment(cid, { rootCid: own.cid, mentionUids: [], mentionsKnown: false, replyToCid: own.cid, replyRelationKnown: true }));
  const { worker, sent } = setup(t, [own, ...replies]);
  assert.equal((await worker.runOnce()).sent, 2);
  assert.deepEqual(sent.map(s => s.targetCid), ['40002', '40003']);
  assert.ok(sent.every(s => s.rootCid === own.cid));
});

test('作品归属不符时不生成或发送', async t => {
  const { worker, adapter, sent } = setup(t, [comment(40001)]);
  adapter.verifyVideo = async () => { throw new Error('not owned'); };
  await assert.rejects(worker.runOnce(), /not owned/);
  assert.equal(sent.length, 0);
});

test('读回其他作品的评论时拒绝整个扫描结果', async t => {
  const { worker, sent } = setup(t, [comment(40001, { videoId: '77777' })]);
  await assert.rejects(worker.runOnce(), /作品不一致/);
  assert.equal(sent.length, 0);
});

test('未知发送结果不重试，重启恢复后依然隔离', async t => {
  const { worker, adapter, store, sent } = setup(t, [comment(40001), comment(40002)]);
  adapter.publishReply = async r => { sent.push(r); throw new Error('receipt lost'); };
  const first = await worker.runOnce();
  assert.equal(first.unknown, 1);
  assert.equal(first.attempted, 1);
  store.recoverInFlight();
  adapter.publishReply = async r => { sent.push(r); return { cid: '99999', imageCount: 0, targetVerified: true }; };
  assert.equal((await worker.runOnce()).sent, 1);
  assert.deepEqual(sent.map(s => s.targetCid), ['40001', '40002']);
});

test('持久化sending恢复为unknown，preparing可重新生成', t => {
  const { store } = setup(t, []);
  const a = store.enqueue(ME, comment(40001), { kinds: [], eligible: true });
  const b = store.enqueue(ME, comment(40002), { kinds: [], eligible: true });
  assert.equal(store.claim(ME, [VIDEO]).job_key, a);
  store.beginSend(a);
  assert.equal(store.claim(ME, [VIDEO]).job_key, b);
  store.recoverInFlight();
  assert.equal(store.get(a).status, 'unknown');
  assert.equal(store.get(b).status, 'pending');
});

test('模型判断普通观众对话时不发送；自己评论不进入模型', async t => {
  const events = [comment(40001, { authorUid: ME }), comment(40002, { mentionUids: [], mentionsKnown: true })];
  const { worker, agent, sent } = setup(t, events);
  let calls = 0;
  agent.decideAddressed = async () => { calls++; return { addressed: false, reason: '观众之间的对话' }; };
  assert.equal((await worker.runOnce()).skipped, 1);
  assert.equal(calls, 1);
  assert.equal(sent.length, 0);
});

test('确认关系字段后，之前语义跳过的评论可以重新评估', async t => {
  const events = [comment(40001, { mentionsKnown: false })];
  const { worker, agent, sent } = setup(t, events);
  agent.decideAddressed = async () => ({ addressed: false, reason: '无文字指向' });
  assert.equal((await worker.runOnce()).skipped, 1);
  events[0].mentionsKnown = true;
  assert.equal((await worker.runOnce()).sent, 1);
  assert.equal(sent.length, 1);
});

test('重复文字与显式跳过不占用发送次数', async t => {
  const { worker, agent, sent } = setup(t, [comment(40001), comment(40002), comment(40003)]);
  agent.generate = async c => c.cid === '40003' ? { text: '' } : { text: '鱼先来啦' };
  const result = await worker.runOnce();
  assert.equal(result.sent, 1); assert.equal(result.skipped, 2); assert.equal(sent.length, 1);
});

test('表情必须来自候选；禁止模型任意选择本地素材', async t => {
  const { worker, config, agent, sent } = setup(t, [comment(40001)]);
  config.stickers.enabled = true;
  worker.stickers = { search: async () => [{ id: '大肥鱼/开心' }], file: async () => { throw new Error('should not read'); } };
  agent.generate = async () => ({ text: '鱼开心啦', stickerQuery: '开心' });
  agent.chooseSticker = async () => '../../arbitrary';
  assert.equal((await worker.runOnce()).failed, 1);
  assert.equal(sent.length, 0);
});

test('图片未附上时结果不确定，不能宣称成功或自动再发', async t => {
  const { worker, config, agent, adapter, store } = setup(t, [comment(40001)]);
  config.stickers.enabled = true;
  worker.stickers = { search: async () => [{ id: '大肥鱼/开心' }], file: async () => ({ path: '/fake/approved.gif', mime: 'image/gif' }) };
  agent.generate = async () => ({ text: '鱼开心啦', stickerQuery: '开心' });
  agent.chooseSticker = async () => '大肥鱼/开心';
  adapter.publishReply = async () => ({ cid: '99999', imageCount: 0, targetVerified: true });
  assert.equal((await worker.runOnce()).unknown, 1);
  assert.equal(store.get(`${ME}:${VIDEO}:40001`).status, 'unknown');
  assert.equal(JSON.parse(store.get(`${ME}:${VIDEO}:40001`).result_json).cid, '99999');
  assert.equal((await worker.runOnce()).attempted, 0);
});

test('已移出手动列表的积压任务不会被领取', async t => {
  const { worker, store, config, sent } = setup(t, []);
  store.enqueue(ME, comment(40001), { eligible: true, kinds: ['mention_me'] });
  config.videos = ['77777'];
  assert.equal((await worker.runOnce()).attempted, 0);
  assert.equal(sent.length, 0);
});

test('任务与分页游标隔离到账号，并可持久恢复', t => {
  const { store, filename } = setup(t, []);
  const continuation = { rootCursor: '20', replies: [{ rootCid: '40001', cursor: '40' }] };
  store.recordScan(ME, VIDEO, { complete: false, warnings: ['limit'], continuation });
  const second = new Store(filename);
  try {
    assert.deepEqual(second.scanContinuation(ME, VIDEO), continuation);
    assert.equal(second.scanContinuation('99999', VIDEO), null);
  } finally { second.close(); }
});

test('线程上下文区分大肥鱼本人和观众，排除当前评论', t => {
  const { store } = setup(t, []);
  store.saveComments(ME, [comment(40001, { authorUid: ME }), comment(40002, { rootCid: '40001' })]);
  assert.deepEqual(store.thread(ME, comment(40002, { rootCid: '40001' })).map(c => c.isOwn), [true]);
});

test('同账号执行锁阻止两个worker并发，释放后可再次获取', t => {
  const { directory } = setup(t, []);
  const filename = path.join(directory, 'worker.lock');
  const release = acquireLock(filename);
  assert.throws(() => acquireLock(filename), /已有 worker/);
  release();
  acquireLock(filename)();
});

test('发送间隔记录跨轮生效', async t => {
  const { worker, waits } = setup(t, [comment(40001), comment(40002)]);
  await worker.runOnce();
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0 && waits[0] <= 1000);
});

test('回执目标未确认时不能记成功或继续发送', async t => {
  const { worker, adapter } = setup(t, [comment(40001), comment(40002)]);
  adapter.publishReply = async () => ({ cid: '99999', imageCount: 0, targetVerified: false });
  const result = await worker.runOnce();
  assert.equal(result.unknown, 1); assert.equal(result.sent, 0); assert.equal(result.attempted, 1);
});

test('死PID锁不会自动删除接管，避免多个进程争抢时删掉活锁', t => {
  const { directory } = setup(t, []);
  const filename = path.join(directory, 'worker.lock');
  // Find a PID known absent on this host, without assuming a universal PID ceiling.
  let absent = 999999;
  for (;;) { try { process.kill(absent, 0); absent++; } catch (e) { if (e.code === 'ESRCH') break; throw e; } }
  const original = JSON.stringify({ pid: absent, nonce: 'stale' });
  fs.writeFileSync(filename, original);
  assert.throws(() => acquireLock(filename), /手动删除/);
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
});

test('新扫描必须刷新pending触发快照，关闭关系证据后先走语义判断', async t => {
  const old = comment(40001, { text: '哈哈' });
  const fresh = { ...old, mentionsKnown: false };
  const { worker, store, agent, sent } = setup(t, [fresh]);
  store.enqueue(ME, old, { eligible: true, kinds: ['mention_me'], needsSemantic: false });
  let evaluated = 0;
  agent.decideAddressed = async () => { evaluated++; return { addressed: false, reason: '没有向鱼提问' }; };
  const result = await worker.runOnce();
  assert.equal(result.sent, 0); assert.equal(sent.length, 0); assert.equal(evaluated, 1);
  assert.equal(JSON.parse(store.get(`${ME}:${VIDEO}:40001`).event_json).mentionsKnown, false);
});

test('关闭关系开关后，续扫未再次返回的旧pending也不能沿用旧eligible', async t => {
  const old = comment(40001, { text: '哈哈' });
  const { worker, store, config, agent, sent } = setup(t, []);
  store.saveComments(ME, [old]);
  store.enqueue(ME, old, { eligible: true, kinds: ['mention_me'], needsSemantic: false });
  config.douyin.inboundSchemaConfirmed = false;
  agent.decideAddressed = async () => ({ addressed: false, reason: '没有文字问题' });
  assert.equal((await worker.runOnce()).sent, 0);
  assert.equal(sent.length, 0);
});

test('生成期间当前记录变化时重新排队核验，不发送基于旧记录的回复', async t => {
  const target = comment(40001, { text: '哈哈' });
  const { worker, store, config, agent, sent } = setup(t, [target]);
  config.worker.maxCandidatesPerRound = 1;
  agent.generate = async () => {
    store.saveComments(ME, [{ ...target, mentionsKnown: false }]);
    return { text: '旧证据生成的回复' };
  };
  assert.equal((await worker.runOnce()).sent, 0);
  assert.equal(sent.length, 0);
  assert.equal(store.get(`${ME}:${VIDEO}:40001`).status, 'pending');
});

test('首次补回只去重已有本人直接回复的具体目标，楼内其他评论仍处理', async t => {
  const root = comment(40001);
  const target = comment(40002, { rootCid: root.cid });
  const another = comment(40003, { rootCid: root.cid });
  const ownReply = normalizeComment({ cid: '50001', user: { uid: ME }, text: '以前已经接过这句话',
    reply_id: root.cid, reply_to_reply_id: target.cid, reply_to_uid: target.authorUid, text_extra: [],
    create_time: 1700000000 }, { videoId: VIDEO, rootCid: root.cid, inboundSchemaConfirmed: true });
  const { worker, store, config, sent } = setup(t, [root, target, another, ownReply]);
  config.douyin.inboundSchemaConfirmed = true;
  const result = await worker.runOnce();
  assert.equal(result.sent, 2);
  assert.deepEqual(sent.map(r => r.targetCid), [root.cid, another.cid]);
  const primed = store.get(`${ME}:${VIDEO}:${target.cid}`);
  assert.equal(primed.status, 'succeeded');
  assert.equal(JSON.parse(primed.result_json).cid, ownReply.cid);
  assert.equal((await worker.runOnce()).attempted, 0);
});

test('本人回复只有root位置、关系未确认或开关关闭时不能猜测已回复目标', async t => {
  for (const { confirmed, fields, enabled } of [
    { confirmed: false, fields: { reply_to_reply_id: '0', reply_id: '40001' }, enabled: true },
    { confirmed: true, fields: { reply_id: '40001' }, enabled: true },
    { confirmed: true, fields: { reply_to_reply_id: '0', reply_id: '49999' }, enabled: true },
    { confirmed: true, fields: { reply_to_reply_id: '0' }, enabled: true },
    { confirmed: true, fields: { reply_to_reply_id: '0', reply_id: '40001' }, enabled: false },
  ]) {
    const target = comment(40001);
    const ownReply = normalizeComment({ cid: '50001', user: { uid: ME }, text: '历史自己的回复', text_extra: [], ...fields },
      { videoId: VIDEO, rootCid: target.cid, inboundSchemaConfirmed: confirmed });
    const { worker, config, sent } = setup(t, [target, ownReply]);
    config.douyin.inboundSchemaConfirmed = enabled;
    assert.equal((await worker.runOnce()).sent, 1);
    assert.equal(sent[0].targetCid, target.cid);
  }
});

test('平台历史priming与enqueue均不覆盖unknown或已成功任务', async t => {
  const target = comment(40001);
  const ownReply = comment(50001, { authorUid: ME, rootCid: target.cid, replyToCid: target.cid,
    replyRelationKnown: true, mentionUids: [] });
  const { worker, store, config } = setup(t, [target, ownReply]);
  config.douyin.inboundSchemaConfirmed = true;
  const key = store.enqueue(ME, target, { eligible: true, kinds: ['mention_me'] });
  store.finish(key, 'unknown', { reason: '此前发送不确定', result: { cid: 'previous-receipt' } });
  const before = store.get(key);
  assert.equal((await worker.runOnce()).attempted, 0);
  assert.deepEqual(store.get(key), before);
  store.finish(key, 'succeeded', { result: { cid: 'confirmed-receipt' } });
  const succeeded = store.get(key);
  await worker.runOnce();
  assert.deepEqual(store.get(key), succeeded);
});

test('线程保留实际父链与root，不让大量兄弟回复挤掉目标父评论', t => {
  const { store } = setup(t, []);
  const root = comment(40001, { text: '根楼', authorUid: ME, createdAt: 1700000000000 });
  const parent = comment(40002, { rootCid: root.cid, text: '目标真正父评论', replyToCid: root.cid,
    replyToUid: ME, replyRelationKnown: true, createdAt: 1700000001000 });
  const target = comment(40003, { rootCid: root.cid, replyToCid: parent.cid, replyToUid: parent.authorUid,
    replyRelationKnown: true, text: '这能教教我吗', createdAt: 1700000002000 });
  const siblings = Array.from({ length: 20 }, (_, i) => comment(50000 + i, {
    rootCid: root.cid, authorUid: ME, text: '别的分支'+i, createdAt: 1800000000000+i,
  }));
  store.saveComments(ME, [root, parent, target, ...siblings]);
  const thread = store.thread(ME, target);
  assert.deepEqual(thread.map(c => c.cid), [root.cid, parent.cid]);
  assert.equal(thread[1].replyToCid, root.cid);
  assert.equal(thread[1].replyToUid, ME);
  assert.equal(thread[1].replyRelationKnown, true);
  assert.deepEqual(thread.map(c => c.isOwn), [true, false]);
});

test('发布前真实适配器身份拒绝时尚未调用publish，应failed并允许明确重试', async t => {
  const { worker, store, agent } = setup(t, []);
  let changed = false, publishCalls = 0;
  const bridge = { call: async command => {
    if (command === 'identity.get') return { uid: changed ? '99999' : ME };
    if (command === 'video.get') return { status_code: 0, aweme_detail: { author: { uid: ME } } };
    if (command === 'comments.list') return { status_code: 0, has_more: 0, comments: [
      { cid: '40001', user: { uid: '30001' }, text: '哈哈', text_extra: [{ type: 0, user_id: ME }], reply_comment_total: 0 },
    ] };
    if (command === 'comments.replies') return { status_code: 0, has_more: 0, comments: [], _bridge_reply_query: 'item_id-v1' };
    if (command === 'comments.publish') { publishCalls++; return { status_code: 0, comment: { cid: '90001', user: { uid: ME }, aweme_id: VIDEO, reply_id: '40001', reply_to_reply_id: '0', image_list: [] } }; }
    throw new Error('unexpected command');
  } };
  worker.adapter = new DouyinAdapter({ bridge, accountUid: ME, inboundSchemaConfirmed: true });
  agent.generate = async () => { changed = true; return { text: '鱼先来啦' }; };
  assert.equal((await worker.runOnce()).failed, 1);
  const key = `${ME}:${VIDEO}:40001`;
  assert.equal(store.get(key).status, 'failed');
  assert.equal(publishCalls, 0);
  changed = false;
  agent.generate = async () => ({ text: '鱼先来啦' });
  // Same condition used by the CLI's explicitly authorized retry command.
  store.retryFailed(key, ME);
  assert.equal((await worker.runOnce()).sent, 1);
  assert.equal(publishCalls, 1);
});

test('真实normalizer的显式根回复只prime根评论，不能封掉根下所有子评论', async t => {
  const root = normalizeComment({ cid: '40001', user: { uid: '30001' }, text: '@大肥鱼 在吗',
    text_extra: [{ type: 0, user_id: ME }], reply_comment_total: 1, create_time: 1700000000 },
  { videoId: VIDEO, inboundSchemaConfirmed: true });
  const target = comment(40002, { rootCid: root.cid });
  const ownReply = normalizeComment({ cid: '50001', user: { uid: ME }, text: '以前回复根评论',
    reply_id: root.cid, reply_to_reply_id: '0', reply_to_userid: root.authorUid, text_extra: [], create_time: 1700000001 },
  { videoId: VIDEO, rootCid: root.cid, inboundSchemaConfirmed: true });
  const { worker, store, config, sent } = setup(t, [root, target, ownReply]);
  config.douyin.inboundSchemaConfirmed = true;
  assert.equal(ownReply.replyRelationKnown, true);
  assert.equal(ownReply.replyToCid, root.cid);
  assert.equal((await worker.runOnce()).sent, 1);
  assert.equal(sent[0].targetCid, target.cid);
  assert.equal(store.get(`${ME}:${VIDEO}:${root.cid}`).status, 'succeeded');
});

test('平台历史事实持久化保留真实回复时间及作者，不视作刚发送', t => {
  const { store, filename } = setup(t, []);
  const target = comment(40001);
  const oldTime = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const ownReply = comment(50001, { authorUid: ME, rootCid: target.cid, replyToCid: target.cid,
    replyRelationKnown: true, createdAt: oldTime });
  store.saveComments(ME, [target, ownReply]);
  assert.equal(store.primeReplies(ME, [ownReply], { inboundSchemaConfirmed: true }), 1);
  assert.equal(store.lastSendAt(ME), oldTime);
  const other = new Store(filename);
  try {
    const saved = other.get(`${ME}:${VIDEO}:${target.cid}`);
    assert.equal(saved.updated_at, oldTime);
    assert.equal(saved.status, 'succeeded');
    assert.deepEqual(JSON.parse(saved.result_json), { cid: ownReply.cid, authorUid: ME, targetCid: target.cid, source: 'platform-history' });
  } finally { other.close(); }
});

test('评论、任务和续扫游标在同一事务提交，入队失败不提前跳页', async t => {
  const { worker, store, adapter } = setup(t, [comment(40001)]);
  const previous = { rootCursor: '20', replies: [] };
  store.recordScan(ME, VIDEO, { complete: false, continuation: previous });
  adapter.scanVideo = async () => ({ comments: [comment(40001)], complete: false,
    continuation: { rootCursor: '40', replies: [] }, warnings: [] });
  store.enqueue = () => { throw new Error('simulated queue write failure'); };
  await assert.rejects(worker.runOnce(), /queue write failure/);
  assert.deepEqual(store.scanContinuation(ME, VIDEO), previous);
  assert.equal(store.getComment(ME, VIDEO, '40001'), null);
});
