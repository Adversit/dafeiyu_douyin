'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { initialize } = require('../src/config');
const { acquireLock } = require('../src/lock');
const { createConfigService } = require('../src/web/config-service');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-web-config-'));
  const previous = Object.fromEntries(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'].map(key => [key, process.env[key]]));
  initialize({ root });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  return { root, service: createConfigService({ root, ...options }) };
}

test('web settings show only key presence, preserve blank password inputs and retain unrelated local settings', t => {
  const { service } = fixture(t);
  const raw = JSON.parse(fs.readFileSync(service.configFile, 'utf8'));
  const token = raw.bridge.token;
  raw.extensionSetting = { retained: true };
  fs.writeFileSync(service.configFile, JSON.stringify(raw));
  fs.writeFileSync(service.envFile, 'DEEPSEEK_API_KEY="existing-fixture-key"\nOTHER_SETTING="keep-me"\n');
  const before = service.read();
  assert.equal(before.secrets.deepseekConfigured, true);
  assert.equal(before.config.bridge.tokenConfigured, true);
  assert.equal(JSON.stringify(before).includes(token), false);
  assert.equal(JSON.stringify(before).includes('existing-fixture-key'), false);
  const after = service.save({ revision: before.revision,
    config: { accountUid: '10001', videos: ['https://www.douyin.com/?modal_id=1234567890123456789'], triggers: { respondToNameCall: false } },
    secrets: { deepseek: '', openai: 'new-fixture-openai-key' } });
  assert.equal(after.config.accountUid, '10001');
  assert.deepEqual(after.config.videos, ['1234567890123456789']);
  assert.equal(after.config.triggers.respondToNameCall, false);
  assert.equal(after.secrets.openaiConfigured, true);
  assert.equal(JSON.stringify(after).includes('new-fixture-openai-key'), false);
  const env = parseEnv(fs.readFileSync(service.envFile, 'utf8'));
  assert.equal(env.DEEPSEEK_API_KEY, 'existing-fixture-key');
  assert.equal(env.OPENAI_API_KEY, 'new-fixture-openai-key');
  assert.equal(env.OTHER_SETTING, 'keep-me');
  const persisted = JSON.parse(fs.readFileSync(service.configFile, 'utf8'));
  assert.deepEqual(persisted.extensionSetting, { retained: true });
  assert.equal(persisted.bridge.token, token);
  if (process.platform !== 'win32') assert.equal(fs.statSync(service.envFile).mode & 0o777, 0o600);
});

test('invalid settings and stale revisions do not partially write keys or configuration', t => {
  const { service } = fixture(t);
  const originalConfig = fs.readFileSync(service.configFile, 'utf8');
  const originalEnv = fs.readFileSync(service.envFile, 'utf8');
  for (const config of [
    { accountUid: 1234567890123456789 },
    { accountUid: 'nickname' },
    { videos: [1234567890123456789] },
    { worker: { maxRepliesPerRound: 0 } },
    { model: { apiKey: 'not-allowed' } },
    { bridge: { token: 'not-allowed' } },
    { model: { baseUrl: 'https://user:password@example.test' } },
  ]) {
    assert.throws(() => service.save({ revision: service.read().revision, config, secrets: { deepseek: 'must-not-save-fixture' } }), error => error.statusCode === 400);
    assert.equal(fs.readFileSync(service.configFile, 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(service.envFile, 'utf8'), originalEnv);
  }
  const old = service.read().revision;
  fs.appendFileSync(service.envFile, '\n# edited elsewhere\n');
  assert.throws(() => service.save({ revision: old, config: { accountUid: '10001' } }), error => error.statusCode === 409 && error.code === 'CONFIG_CHANGED');
  assert.equal(fs.readFileSync(service.configFile, 'utf8'), originalConfig);
  assert.equal(fs.readdirSync(path.dirname(service.configFile)).some(name => name.endsWith('.tmp')), false);
});

test('saving during a run is rejected and unsafe secret characters cannot enter dotenv', t => {
  let busy = true;
  const { service } = fixture(t, { isBusy: () => busy });
  const body = { revision: service.read().revision, config: {} };
  assert.throws(() => service.save(body), error => error.statusCode === 409 && error.code === 'RUNTIME_BUSY');
  busy = false;
  for (const value of ['key\nINJECTED=yes', 'key with spaces', 'key\u0000bad']) {
    assert.throws(() => service.save({ ...body, secrets: { deepseek: value } }), error => error.statusCode === 400);
  }
  const after = service.save({ ...body, config: { model: { baseUrl: '', apiKeyEnv: '' } } });
  assert.equal(after.config.model.baseUrl, undefined);
  assert.equal(after.config.model.apiKeyEnv, undefined);
});

test('a CLI acquiring the worker lock after the busy check still blocks every configuration write', t => {
  let lockFile; let releaseWorker;
  const { service, root } = fixture(t, { isBusy: () => { releaseWorker = acquireLock(lockFile); return false; } });
  lockFile = path.join(root, 'runtime/worker.lock');
  t.after(() => releaseWorker?.());
  const beforeConfig = fs.readFileSync(service.configFile, 'utf8');
  const beforeEnv = fs.readFileSync(service.envFile, 'utf8');
  const body = { revision: service.read().revision, config: { accountUid: '10001' }, secrets: { deepseek: 'fixture-must-not-save-during-run' } };
  assert.throws(() => service.save(body), error => error.statusCode === 409 && error.code === 'RUNTIME_BUSY');
  assert.equal(fs.readFileSync(service.configFile, 'utf8'), beforeConfig);
  assert.equal(fs.readFileSync(service.envFile, 'utf8'), beforeEnv);
  assert.equal(fs.existsSync(lockFile), true, 'the CLI lock must never be removed by a failed save');
});

test('saving holds the shared worker lock while reading and committing, and releases it on success or validation failure', t => {
  const { service, root } = fixture(t);
  const lockFile = path.join(root, 'runtime/worker.lock');
  const before = service.read();
  const originalRead = fs.readFileSync; const originalRename = fs.renameSync;
  let saving = true; let guardedReads = 0; let guardedCommits = 0;
  fs.readFileSync = function (file, ...args) {
    if (saving && [service.configFile, service.envFile].includes(file)) {
      assert.equal(fs.existsSync(lockFile), true, 'revision and configuration reads must happen under the lock');
      guardedReads++;
    }
    return originalRead.call(this, file, ...args);
  };
  fs.renameSync = function (...args) {
    if (saving) {
      assert.equal(fs.existsSync(lockFile), true);
      assert.throws(() => acquireLock(lockFile));
      guardedCommits++;
    }
    return originalRename.apply(this, args);
  };
  t.after(() => { fs.readFileSync = originalRead; fs.renameSync = originalRename; });
  try {
    service.save({ revision: before.revision, config: { accountUid: '10001' }, secrets: { deepseek: 'fixture-key-committed-under-lock' } });
  } finally { saving = false; fs.readFileSync = originalRead; fs.renameSync = originalRename; }
  assert.ok(guardedReads > 0); assert.equal(guardedCommits, 2);
  assert.equal(fs.existsSync(lockFile), false);
  assert.throws(() => service.save({ revision: service.read().revision, config: { accountUid: 'invalid-uid' } }), error => error.statusCode === 400);
  assert.equal(fs.existsSync(lockFile), false);
  assert.throws(() => service.save({ revision: 'outdated', config: {} }), error => error.statusCode === 409);
  assert.equal(fs.existsSync(lockFile), false);
  const release = acquireLock(lockFile); release();
});

test('a stale worker lock blocks saving without being deleted or overwritten', t => {
  const { service, root } = fixture(t);
  const lockFile = path.join(root, 'runtime/worker.lock');
  const stale = JSON.stringify({ pid: 2147483647, nonce: 'stale-fixture' });
  fs.writeFileSync(lockFile, stale);
  const before = service.read();
  assert.throws(() => service.save({ revision: before.revision, config: { accountUid: '10001' } }), error => error.statusCode === 409);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), stale);
  assert.equal(service.read().revision, before.revision);
});

test('a filesystem commit error leaves configuration unchanged, removes temporary files and releases the lock', t => {
  const { service, root } = fixture(t);
  const lockFile = path.join(root, 'runtime/worker.lock');
  const beforeConfig = fs.readFileSync(service.configFile, 'utf8');
  const beforeEnv = fs.readFileSync(service.envFile, 'utf8');
  const body = { revision: service.read().revision, config: { accountUid: '10001' }, secrets: { deepseek: 'fixture-key-not-committed' } };
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('fixture-commit-denied'), { code: 'EACCES' }); };
  try { assert.throws(() => service.save(body), error => error.code === 'EACCES'); }
  finally { fs.renameSync = originalRename; }
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(fs.readFileSync(service.configFile, 'utf8'), beforeConfig);
  assert.equal(fs.readFileSync(service.envFile, 'utf8'), beforeEnv);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
});
