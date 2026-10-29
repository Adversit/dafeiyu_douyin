'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnose } = require('../src/services/diagnostics');
const { validateConfig } = require('../src/config');

const ACCOUNT = '10001';
const VIDEOS = ['20001', '20002'];
const KEY_ENV = 'DAFEIYU_DIAGNOSTICS_TEST_KEY';
const SECRET = 'diagnostics-private-fixture-key-do-not-display';

function setup(t, { connected = true, statusError, identityError, actualUid = ACCOUNT,
  videoAuthors = {}, accountUid = ACCOUNT, keyConfigured = true, runtimeState = 'stopped' } = {}) {
  const previousKey = process.env[KEY_ENV];
  const previousFetch = globalThis.fetch;
  if (keyConfigured) process.env[KEY_ENV] = SECRET;
  else delete process.env[KEY_ENV];
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('Status detection must not call a model or the network'); };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = previousKey;
  });
  const calls = [];
  const config = validateConfig({ accountUid, videos: VIDEOS, bridge: { token: 'ab'.repeat(24) },
    model: { provider: 'deepseek', apiKeyEnv: KEY_ENV }, douyin: { inboundSchemaConfirmed: true } });
  const bridge = {
    async status() {
      if (statusError) throw statusError;
      return { connected, accountUid: connected ? ACCOUNT : null, lastSeen: connected ? 1700000000000 : null, pending: 0 };
    },
    async call(command, args) {
      calls.push({ command, args });
      assert.ok(['identity.get', 'video.get'].includes(command), `Unexpected write or read command: ${command}`);
      if (command === 'identity.get') {
        if (identityError) throw identityError;
        return { uid: actualUid };
      }
      return { status_code: 0, aweme_detail: { author: { uid: videoAuthors[args.videoId] || ACCOUNT } } };
    },
  };
  const runtime = { snapshot: () => ({ state: runtimeState, mode: runtimeState === 'running' ? 'poll' : null }) };
  const run = async () => {
    const report = await diagnose({ config, bridge, runtime });
    assert.equal(fetchCalls, 0, 'No paid model or fetch request may be made by status detection');
    assert.ok(calls.every(call => ['identity.get', 'video.get'].includes(call.command)));
    assert.ok(!JSON.stringify(report).includes(SECRET), 'Reports must not return the configured secret');
    assert.ok(!JSON.stringify(report).includes(config.bridge.token), 'Reports must not return the Bridge token');
    return report;
  };
  return { config, bridge, calls, run };
}

const check = (report, key) => report.checks.find(item => item.key === key);

test('账号与作品检查异常在CLI共享结果中也不能泄露凭证', async t => {
  const f = setup(t); let phase = 'identity';
  const original = f.bridge.call;
  f.bridge.call = async (command, args) => {
    if ((phase === 'identity' && command === 'identity.get') || (phase === 'video' && command === 'video.get')) throw new Error(`Failed with ${SECRET} ${'ab'.repeat(24)}`);
    return original(command, args);
  };
  assert.equal((await f.run()).overall, 'error');
  phase = 'video';
  const report = await f.run();
  assert.equal(report.videos[0].status, 'error');
});

test('status detection confirms identity and each owned video using read-only commands without model calls', async t => {
  const f = setup(t);
  const report = await f.run();
  assert.equal(report.overall, 'ok');
  assert.equal(report.browser.connected, true);
  assert.equal(report.account.configuredUid, ACCOUNT);
  assert.equal(report.account.actualUid, ACCOUNT);
  assert.equal(report.account.matched, true);
  assert.equal(typeof report.checkedAt, 'number');
  assert.deepEqual(report.videos, VIDEOS.map(id => ({ id, owned: true, status: 'ok' })));
  assert.deepEqual(f.calls.filter(call => call.command === 'video.get').map(call => call.args.videoId), VIDEOS);
  assert.ok(f.calls.every(call => call.args.accountUid === ACCOUNT));
  assert.deepEqual(report.model, { provider: 'deepseek', model: 'deepseek-flash', keyConfigured: true, apiVerified: false });
  assert.equal(check(report, 'model').status, 'ok');
  assert.match(check(report, 'model').message, /未调用模型|尚未验证/);
});

test('disconnected browser skips account and videos but still reports model configuration and process status', async t => {
  const f = setup(t, { connected: false, runtimeState: 'external' });
  const report = await f.run();
  assert.equal(report.overall, 'warning');
  assert.equal(check(report, 'bridge').status, 'ok');
  assert.equal(check(report, 'browser').status, 'warn');
  assert.equal(check(report, 'account').status, 'skipped');
  assert.ok(report.videos.every(item => item.status === 'skipped'));
  assert.equal(check(report, 'model').status, 'ok');
  assert.equal(report.runtime.state, 'external');
  assert.match(check(report, 'runtime').message, /CLI/);
  assert.deepEqual(f.calls, []);
});

test('unreachable Bridge does not prevent independent model/runtime checks or expose its thrown credentials', async t => {
  const f = setup(t, { statusError: new Error(`Connection failed with ${SECRET}`) });
  const report = await f.run();
  assert.equal(report.overall, 'error');
  assert.equal(check(report, 'bridge').status, 'error');
  assert.equal(check(report, 'browser').status, 'skipped');
  assert.equal(check(report, 'model').status, 'ok');
  assert.equal(check(report, 'runtime').status, 'ok');
  assert.ok(report.videos.every(item => item.status === 'skipped'));
  assert.deepEqual(f.calls, []);
});

test('identity query errors are isolated and videos are skipped while model configuration remains visible', async t => {
  const f = setup(t, { identityError: new Error('identity query unavailable') });
  const report = await f.run();
  assert.equal(report.overall, 'error');
  assert.equal(check(report, 'account').status, 'error');
  assert.match(check(report, 'account').message, /identity query unavailable/);
  assert.equal(report.account.matched, false);
  assert.equal(check(report, 'model').status, 'ok');
  assert.ok(report.videos.every(item => item.status === 'skipped'));
  assert.deepEqual(f.calls.map(call => call.command), ['identity.get']);
});

test('account mismatch prevents all video requests and clearly reports configured and actual UIDs', async t => {
  const f = setup(t, { actualUid: '30001' });
  const report = await f.run();
  assert.equal(report.account.matched, false);
  assert.equal(report.account.configuredUid, ACCOUNT);
  assert.equal(report.account.actualUid, '30001');
  assert.equal(check(report, 'account').status, 'error');
  assert.ok(report.videos.every(item => item.status === 'skipped'));
  assert.deepEqual(f.calls.map(call => call.command), ['identity.get']);
  assert.equal(report.model.keyConfigured, true);
  assert.equal(report.model.apiVerified, false);
});

test('one video ownership failure does not hide another video result or the remaining checks', async t => {
  const f = setup(t, { videoAuthors: { [VIDEOS[0]]: '30001' } });
  const report = await f.run();
  assert.equal(report.overall, 'error');
  assert.equal(report.videos[0].id, VIDEOS[0]);
  assert.equal(report.videos[0].owned, false);
  assert.equal(report.videos[0].status, 'error');
  assert.equal(report.videos[1].id, VIDEOS[1]);
  assert.equal(report.videos[1].owned, true);
  assert.equal(report.videos[1].status, 'ok');
  assert.equal(check(report, 'model').status, 'ok');
  assert.equal(check(report, 'runtime').status, 'ok');
  assert.deepEqual(f.calls.filter(call => call.command === 'video.get').map(call => call.args.videoId), VIDEOS);
});

test('missing model key is a configuration warning rather than an attempted API test', async t => {
  const f = setup(t, { keyConfigured: false, runtimeState: 'stale-lock' });
  const report = await f.run();
  assert.equal(report.model.keyConfigured, false);
  assert.equal(report.model.apiVerified, false);
  assert.equal(check(report, 'model').status, 'warn');
  assert.equal(check(report, 'runtime').status, 'warn');
  assert.match(check(report, 'runtime').message, /遗留/);
  assert.ok(report.videos.every(item => item.owned));
});

test('unconfigured UID can still be discovered without querying any video', async t => {
  const f = setup(t, { accountUid: '' });
  const report = await f.run();
  assert.equal(report.account.configuredUid, null);
  assert.equal(report.account.actualUid, ACCOUNT);
  assert.equal(report.account.matched, false);
  assert.equal(check(report, 'account').status, 'warn');
  assert.ok(report.videos.every(item => item.status === 'skipped'));
  assert.deepEqual(f.calls.map(call => call.command), ['identity.get']);
});

test('invalid model metadata reports one independent error without dropping browser or runtime results', async t => {
  const f = setup(t, { runtimeState: 'stopping' });
  f.config.model = { provider: 'unsupported-provider' };
  const report = await f.run();
  assert.equal(report.model, null);
  assert.equal(check(report, 'model').status, 'error');
  assert.equal(report.account.matched, true);
  assert.equal(check(report, 'runtime').status, 'ok');
  assert.match(check(report, 'runtime').message, /正在停止/);
  assert.ok(report.videos.every(item => item.owned));
});
