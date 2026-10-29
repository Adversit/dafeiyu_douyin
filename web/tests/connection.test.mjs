import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventStream, createReadonlyRuntimePoll } from '../src/connection.mjs';

class FakeEventSource {
  static instances = [];
  constructor(url) { this.url = url; this.closed = false; this.listeners = {}; FakeEventSource.instances.push(this); }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  close() { this.closed = true; }
  send(type, value) { this.listeners[type]?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }); }
}

test('a renewed session replaces a permanently closed SSE stream using the latest log cursor', async () => {
  FakeEventSource.instances = [];
  let latestId = 'before-restart';
  const received = [], states = [], connections = [], calls = [];
  const stream = createEventStream({ EventSourceImpl: FakeEventSource, getLastId: () => latestId,
    onLog: item => { latestId = item.id; received.push(item.id); },
    onRuntime: state => states.push(state.state), onConnection: state => connections.push(state) });
  stream.connect();
  const old = FakeEventSource.instances[0];
  old.send('log', { id: 'last visible / id', message: 'before restart' });
  old.close(); // HTTP 401 can leave a browser EventSource permanently CLOSED.
  let authenticated = false;
  const poll = createReadonlyRuntimePoll({
    requestRuntime: async () => { calls.push('GET /api/runtime'); if (!authenticated) throw Object.assign(new Error('expired'), { status: 401 }); return { state: 'stopped' }; },
    renewSession: async () => { calls.push('GET /api/session'); authenticated = true; },
    reconnectStream: () => stream.connect(), onRuntime: state => states.push(state.state),
  });
  assert.equal(await poll(), true);
  assert.equal(FakeEventSource.instances.length, 2);
  const fresh = FakeEventSource.instances[1];
  assert.equal(old.closed, true);
  assert.equal(fresh.url, '/api/events?after=last%20visible%20%2F%20id');
  fresh.onopen();
  fresh.send('log', { id: 'after-restart' });
  old.send('log', { id: 'stale-dispatched-event' });
  assert.deepEqual(received, ['last visible / id', 'after-restart']);
  assert.deepEqual(calls, ['GET /api/runtime', 'GET /api/session', 'GET /api/runtime']);
  assert.deepEqual(states, ['stopped']);
  assert.deepEqual(connections, ['online']);
  stream.close();
});

test('unmount during session renewal never reopens streams or updates the page', async () => {
  let disposed = false, reconnects = 0, reads = 0, updates = 0;
  let finishRenew;
  const renewal = new Promise(resolve => { finishRenew = resolve; });
  const poll = createReadonlyRuntimePoll({
    requestRuntime: async () => { reads++; throw Object.assign(new Error('expired'), { status: 403 }); },
    renewSession: () => renewal, reconnectStream: () => { reconnects++; },
    onRuntime: () => { updates++; }, isDisposed: () => disposed,
  });
  const pending = poll();
  await Promise.resolve();
  assert.equal(await poll(), false, 'overlapping status polls are not queued');
  disposed = true;
  finishRenew();
  assert.equal(await pending, false);
  assert.equal(reconnects, 0);
  assert.equal(reads, 1);
  assert.equal(updates, 0);
});

test('network failures do not renew credentials or create duplicate connections', async () => {
  let renewals = 0, reconnects = 0;
  const poll = createReadonlyRuntimePoll({ requestRuntime: async () => { throw new Error('offline'); },
    renewSession: async () => { renewals++; }, reconnectStream: () => { reconnects++; } });
  assert.equal(await poll(), false);
  assert.equal(renewals, 0);
  assert.equal(reconnects, 0);
});

test('closed stream managers ignore queued old events and cannot reopen after disposal', () => {
  FakeEventSource.instances = [];
  const events = [];
  const manager = createEventStream({ EventSourceImpl: FakeEventSource, onLog: value => events.push(value), onRuntime: value => events.push(value) });
  manager.connect();
  const source = FakeEventSource.instances[0];
  source.send('log', 'invalid json');
  source.send('log', { message: 'missing event id' });
  manager.close();
  source.send('log', { id: 'late' });
  source.send('runtime', { state: 'running' });
  manager.connect();
  assert.equal(source.closed, true);
  assert.deepEqual(events, []);
  assert.equal(FakeEventSource.instances.length, 1);
});
