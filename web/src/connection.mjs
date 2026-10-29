export function createEventStream({
  getLastId = () => null,
  onConnection = () => {},
  onLog = () => {},
  onRuntime = () => {},
  EventSourceImpl = globalThis.EventSource,
} = {}) {
  let source = null;
  let disposed = false;
  function connect() {
    if (disposed) return;
    source?.close();
    const after = getLastId();
    const current = new EventSourceImpl(`/api/events${after ? `?after=${encodeURIComponent(after)}` : ''}`);
    source = current;
    const active = () => !disposed && source === current;
    current.onopen = () => { if (active()) onConnection('online'); };
    current.onerror = () => { if (active()) onConnection('reconnecting'); };
    current.addEventListener('log', event => {
      if (!active()) return;
      try {
        const value = JSON.parse(event.data);
        if (value && typeof value === 'object' && typeof value.id === 'string') onLog(value);
      } catch { /* An invalid event must not terminate the remaining live stream. */ }
    });
    current.addEventListener('runtime', event => {
      if (!active()) return;
      try {
        const value = JSON.parse(event.data);
        if (value && typeof value === 'object' && !Array.isArray(value)) onRuntime(value);
      } catch { /* The next readonly status poll can recover runtime state. */ }
    });
  }
  function close() {
    disposed = true;
    source?.close();
    source = null;
  }
  return { connect, close };
}

export function createReadonlyRuntimePoll({ requestRuntime, renewSession, reconnectStream,
  onRuntime = () => {}, onConnection = () => {}, isDisposed = () => false } = {}) {
  let pending = false;
  return async function poll() {
    if (pending || isDisposed()) return false;
    pending = true;
    try {
      const state = await requestRuntime();
      if (isDisposed()) return false;
      onRuntime(state);
      return true;
    } catch (error) {
      if (isDisposed()) return false;
      onConnection('reconnecting');
      if (![401, 403].includes(error.status)) return false;
      try {
        // Only readonly polling is resumed here. POST/PUT actions have no retry path.
        await renewSession();
        if (isDisposed()) return false;
        // A 401/403 can leave EventSource CLOSED: a new cookie alone cannot
        // revive it. Explicitly replace the stream and replay from the cursor.
        reconnectStream();
        const state = await requestRuntime();
        if (isDisposed()) return false;
        onRuntime(state);
        return true;
      } catch { return false; }
    } finally { pending = false; }
  };
}
