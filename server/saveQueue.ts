// Serialises and coalesces background saves. Mutations fire saves without
// awaiting them; running those concurrently lets an older snapshot commit after
// a newer one (and makes MySQL's delete-all/insert-all transactions deadlock).
// Here at most one save runs at a time, and any number of requests made while
// it runs collapse into a single follow-up save of the latest state.
//
// A failed save is retried with exponential backoff until one succeeds, so a
// storage outage (e.g. MySQL restarting) doesn't silently drop the changes
// made meanwhile; `healthy` reports whether the latest state is persisted.
export function createSaveQueue(
  save: () => Promise<void>,
  onError: (err: unknown) => void,
  opts: { retryMs?: number; maxRetryMs?: number } = {}
) {
  const baseDelay = opts.retryMs ?? 2000;
  const maxDelay = opts.maxRetryMs ?? 60_000;
  let running: Promise<void> | null = null;
  let dirty = false;
  let failed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = baseDelay;

  const scheduleRetry = () => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (failed) request();
    }, retryDelay);
    retryTimer.unref?.();
    retryDelay = Math.min(retryDelay * 2, maxDelay);
  };

  const drain = async () => {
    while (dirty) {
      dirty = false;
      try {
        await save();
        failed = false;
        retryDelay = baseDelay;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      } catch (err) {
        failed = true;
        onError(err);
      }
    }
    running = null;
    if (failed) scheduleRetry();
  };

  // Request a save; resolves once the state as of this call has been written
  // (or the attempt failed, was reported through onError and a retry queued).
  function request(): Promise<void> {
    dirty = true;
    if (!running) running = drain();
    return running;
  }

  return {
    request,
    // Graceful shutdown: wait for the running save and, if the last attempt
    // failed, make one more immediate attempt instead of waiting for the timer.
    async flush(): Promise<void> {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (running) await running;
      if (failed) await request();
    },
    get healthy(): boolean {
      return !failed;
    },
  };
}
