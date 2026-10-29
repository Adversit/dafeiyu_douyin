'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatClient } = require('../src/agent/llm');
const { Agent } = require('../src/agent/reply');

const keyEnv = 'DAFEIYU_UNIT_TEST_LLM_KEY';
const fakeKey = 'unit-test-key-never-sent-to-network';
const schema = {
  type: 'object', additionalProperties: false, required: ['ok'],
  properties: { ok: { type: 'boolean' } },
};
function response(content, patch = {}) {
  return { ok: true, status: 200, async json() {
    return { choices: [{ finish_reason: 'stop', message: { content }, ...patch }] };
  } };
}

test('缺少密钥时明确失败，绝不调用fetch', async t => {
  const saved = process.env[keyEnv];
  delete process.env[keyEnv];
  t.after(() => { if (saved === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = saved; });
  let count = 0;
  const client = new ChatClient({ apiKeyEnv: keyEnv }, { fetchImpl: async () => { count++; } });
  await assert.rejects(client.completeJson('system', '{}'), { code: 'LLM_KEY_MISSING' });
  assert.equal(count, 0);
});

test('DeepSeek请求使用官方端点和JSON模式，配置中不接受明文key', async t => {
  process.env[keyEnv] = fakeKey;
  t.after(() => { delete process.env[keyEnv]; });
  let request;
  const client = new ChatClient({ provider: 'deepseek', apiKeyEnv: keyEnv }, {
    fetchImpl: async (url, options) => { request = { url, options }; return response('{"ok":true}'); },
  });
  assert.deepEqual(await client.completeJson('固定规则', '{"data":"评论"}', { schema }), { ok: true });
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.options.headers.Authorization, `Bearer ${fakeKey}`);
  assert.equal(request.options.redirect, 'error');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.match(body.messages[0].content, /JSON/);
  assert.equal(body.messages[1].role, 'user');
  assert.throws(() => new ChatClient({ apiKey: fakeKey }), { code: 'LLM_CONFIG_INVALID' });
});

test('OpenAI保留v1前缀并使用schema及max_completion_tokens', async t => {
  process.env[keyEnv] = fakeKey;
  t.after(() => { delete process.env[keyEnv]; });
  let request;
  const client = new ChatClient({ provider: 'openai', baseUrl: 'https://api.openai.com/v1/', model: 'configured-model', apiKeyEnv: keyEnv }, {
    fetchImpl: async (url, options) => { request = { url, options }; return response('{"ok":false}'); },
  });
  assert.deepEqual(await client.completeJson('规则', '{}', { schema }), { ok: false });
  assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'configured-model');
  assert.equal(body.max_completion_tokens, 2048);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
});

test('非法JSON、截断、非对象、类型错误和拒绝响应均不返回可发送对象', async t => {
  process.env[keyEnv] = fakeKey;
  t.after(() => { delete process.env[keyEnv]; });
  const responses = [
    response('```json\n{"ok":true}\n```'), response('{"ok":'), response('[]'),
    response('{"ok":"yes"}'), response('{"ok":true,"cid":"other"}'),
    response('{"ok":true}', { finish_reason: 'length' }),
    response('', { message: { content: '', refusal: 'no' } }),
  ];
  for (const result of responses) {
    const client = new ChatClient({ apiKeyEnv: keyEnv }, { fetchImpl: async () => result });
    await assert.rejects(client.completeJson('规则', '{}', { schema }));
  }
});

test('真实客户端处理合法长回复后由 Agent 截断，长度截断和未完整 JSON 仍不发送', async t => {
  process.env[keyEnv] = fakeKey;
  t.after(() => { delete process.env[keyEnv]; });
  const outputs = [
    response(JSON.stringify({ text: '鱼'.repeat(151), stickerQuery: null })),
    response(JSON.stringify({ text: '鱼'.repeat(151), stickerQuery: null }), { finish_reason: 'length' }),
    response('{"text":"鱼'),
  ];
  const client = new ChatClient({ apiKeyEnv: keyEnv }, { fetchImpl: async () => outputs.shift() });
  const agent = new Agent({ llm: client });
  assert.equal((await agent.generate({ text: '大肥鱼' })).text, '鱼'.repeat(150));
  await assert.rejects(agent.generate({ text: '大肥鱼' }), { code: 'LLM_TRUNCATED' });
  await assert.rejects(agent.generate({ text: '大肥鱼' }), { code: 'LLM_JSON_INVALID' });
});

test('模型响应体超限时停止读取并拒绝，避免解析无限响应', async t => {
  process.env[keyEnv] = fakeKey;
  t.after(() => { delete process.env[keyEnv]; });
  let canceled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { canceled = true; },
  });
  const client = new ChatClient({ apiKeyEnv: keyEnv }, { fetchImpl: async () => ({ ok: true, body }) });
  await assert.rejects(client.completeJson('规则', '{}'), { code: 'LLM_RESPONSE_TOO_LARGE' });
  assert.equal(canceled, true);
});

test('供应商/网络报错不回显响应体、底层错误或key，且没有自动重试', async t => {
  process.env[keyEnv] = fakeKey;
  t.after(() => { delete process.env[keyEnv]; });
  for (const mock of [
    async () => ({ ok: false, status: 401, async json() { throw new Error(fakeKey); } }),
    async () => { throw new Error(`network error containing ${fakeKey}`); },
  ]) {
    let count = 0;
    const client = new ChatClient({ apiKeyEnv: keyEnv }, { fetchImpl: async (...args) => { count++; return mock(...args); } });
    await assert.rejects(client.completeJson('规则', '{}'), error => {
      assert.equal(error.message.includes(fakeKey), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(count, 1);
  }
});

test('超时中止请求；不安全baseUrl被拒绝', async t => {
  process.env[keyEnv] = fakeKey;
  t.after(() => { delete process.env[keyEnv]; });
  const client = new ChatClient({ apiKeyEnv: keyEnv, timeoutMs: 5 }, {
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  await assert.rejects(client.completeJson('规则', '{}'), { code: 'LLM_TIMEOUT' });
  for (const baseUrl of ['http://remote.example', 'https://name:secret@example.com', 'https://example.com?key=secret']) {
    assert.throws(() => new ChatClient({ baseUrl }), { code: 'LLM_CONFIG_INVALID' });
  }
});
