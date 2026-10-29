'use strict';

// OpenAI-compatible transport implemented from the vendors' public API contracts.
// See prompts/README.md for the verified primary documentation and prompt provenance.
const PROVIDERS = Object.freeze({
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-sol', apiKeyEnv: 'OPENAI_API_KEY' },
});

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

// Local validation remains authoritative even with a provider's JSON output mode.
function validateSchema(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return;
  const invalid = () => { throw failure('LLM_SCHEMA_INVALID', `模型 JSON 不符合约定：${path}`); };
  if (schema.type && ![].concat(schema.type).some(type => matchesType(value, type))) invalid();
  if (schema.enum && !schema.enum.some(item => item === value)) invalid();
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if ((schema.minLength !== undefined && length < schema.minLength) ||
        (schema.maxLength !== undefined && length > schema.maxLength)) invalid();
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) invalid();
    for (const item of value) validateSchema(item, schema.items, `${path}[]`);
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) invalid();
    for (const key of Object.keys(value)) {
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties || {}, key)) invalid();
      validateSchema(value[key], schema.properties?.[key], `${path}.${key}`);
    }
  }
}

class ChatClient {
  constructor(config = {}, { fetchImpl = globalThis.fetch } = {}) {
    this.provider = config.provider || 'deepseek';
    const defaults = PROVIDERS[this.provider];
    if (!defaults) throw failure('LLM_PROVIDER_INVALID', '模型供应商只支持 deepseek 或 openai');
    if (Object.hasOwn(config, 'apiKey')) throw failure('LLM_CONFIG_INVALID', '密钥只能通过 apiKeyEnv 指定的环境变量提供');
    this.model = config.model || defaults.model;
    this.apiKeyEnv = config.apiKeyEnv || defaults.apiKeyEnv;
    if (typeof this.model !== 'string' || !this.model.trim() ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.apiKeyEnv)) {
      throw failure('LLM_CONFIG_INVALID', '模型名称或密钥环境变量名称无效');
    }
    let base;
    try { base = new URL(config.baseUrl || defaults.baseUrl); } catch {
      throw failure('LLM_CONFIG_INVALID', '模型 baseUrl 无效');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if ((base.protocol !== 'https:' && !(local && base.protocol === 'http:')) ||
        base.username || base.password || base.search || base.hash) {
      throw failure('LLM_CONFIG_INVALID', '模型 baseUrl 需要 HTTPS，且不能包含凭证、查询参数或片段');
    }
    this.endpoint = `${base.href.replace(/\/+$/, '')}/chat/completions`;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxTokens = config.maxTokens ?? 2048;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000 ||
        !Number.isInteger(this.maxTokens) || this.maxTokens < 1 || this.maxTokens > 32768 ||
        typeof fetchImpl !== 'function') {
      throw failure('LLM_CONFIG_INVALID', '模型请求的超时、输出上限或 fetch 实现无效');
    }
    this.fetchImpl = fetchImpl;
  }

  async completeJson(system, user, { schema } = {}) {
    const key = process.env[this.apiKeyEnv]?.trim();
    if (!key) throw failure('LLM_KEY_MISSING', `未配置模型密钥环境变量 ${this.apiKeyEnv}`);
    if (typeof system !== 'string' || !system.trim() || typeof user !== 'string') {
      throw failure('LLM_INPUT_INVALID', '模型消息必须是文本');
    }
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: `${system}\n只返回一个 JSON 对象，不要 Markdown 或解释。${schema ? `\nJSON 结构约定：${JSON.stringify(schema)}` : ''}` },
        { role: 'user', content: user },
      ],
      response_format: this.provider === 'openai' && schema
        ? { type: 'json_schema', json_schema: { name: 'agent_result', strict: true, schema } }
        : { type: 'json_object' },
      stream: false,
      ...(this.provider === 'openai'
        ? { max_completion_tokens: this.maxTokens }
        : { max_tokens: this.maxTokens, thinking: { type: 'disabled' } }),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch {
        throw failure(controller.signal.aborted ? 'LLM_TIMEOUT' : 'LLM_NETWORK_ERROR',
          controller.signal.aborted ? '模型请求超时' : '模型请求失败，请检查供应商地址和网络');
      }
      if (!response.ok) throw failure('LLM_HTTP_ERROR', `模型服务请求失败（HTTP ${Number(response.status) || 0}）`);
      let data;
      try { data = await response.json(); } catch {
        throw failure('LLM_RESPONSE_INVALID', '模型服务返回了无效响应');
      }
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') throw failure('LLM_TRUNCATED', '模型输出超出长度上限，本次不发送');
      if (choice?.finish_reason !== 'stop' || choice?.message?.refusal ||
          typeof choice?.message?.content !== 'string' || choice.message.content.length > 100_000) {
        throw failure('LLM_RESPONSE_INVALID', '模型未返回完整 JSON 内容，本次不发送');
      }
      let result;
      try { result = JSON.parse(choice.message.content); } catch {
        throw failure('LLM_JSON_INVALID', '模型返回的内容不是合法 JSON，本次不发送');
      }
      if (!matchesType(result, 'object')) throw failure('LLM_JSON_INVALID', '模型必须返回一个 JSON 对象');
      validateSchema(result, schema);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { ChatClient, validateSchema };
