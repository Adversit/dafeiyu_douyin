'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { readActivity } = require('../src/web/activity');

test('activity reads current-account history without requeueing unknown, with lossless cursor ties', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-web-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readActivity({ root, accountUid: '10001' }), { items: [], nextCursor: null });
  const store = new Store(path.join(root, 'runtime/agent.sqlite'));
  const event = cid => ({ videoId: '20001', cid, authorUid: '30001', text: `大肥鱼 ${cid}` });
  for (const cid of ['40001', '40002', '40003']) {
    const key = store.enqueue('10001', event(cid), { kinds: ['name_call'] });
    store.finish(key, cid === '40001' ? 'unknown' : 'skipped', { reason: cid === '40001' ? '待核查，不重发' : '未触发', result: { cid: '90001', authorization: 'must-not-return' } });
  }
  store.enqueue('90000', event('40004'), { kinds: [] });
  store.db.prepare('UPDATE jobs SET updated_at = ?').run(1700000000000);
  const before = store.db.prepare('SELECT job_key,status FROM jobs ORDER BY job_key').all();
  const first = readActivity({ root, accountUid: '10001', limit: 2 });
  const second = readActivity({ root, accountUid: '10001', limit: 2, before: first.nextCursor });
  assert.deepEqual([...first.items, ...second.items].map(item => item.targetCid), ['40003', '40002', '40001']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.items[0].status, 'unknown');
  assert.equal(second.items[0].hasDetailedLogs, false);
  assert.equal(JSON.stringify(second).includes('must-not-return'), false);
  const filtered = readActivity({ root, accountUid: '10001', query: '40001', status: 'unknown', logger: { list: () => ({ items: [{ videoId: '20001', targetCid: '40001' }] }) } });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].hasDetailedLogs, true);
  assert.deepEqual(readActivity({ root, accountUid: '10001', query: '%' }).items, []);
  assert.deepEqual(store.db.prepare('SELECT job_key,status FROM jobs ORDER BY job_key').all(), before);
  store.close();
});

test('activity rejects invalid filters and malformed cursors instead of interpolating SQL', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-web-activity-query-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'runtime/agent.sqlite')); store.close();
  for (const options of [{ limit: -1 }, { limit: 101 }, { status: "unknown' OR 1=1" }, { before: 'bad cursor' }, { before: Buffer.from('{"ts":1}').toString('base64url') }]) {
    assert.throws(() => readActivity({ root, accountUid: '10001', ...options }), error => error.statusCode === 400);
  }
});
