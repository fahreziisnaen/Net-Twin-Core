import { describe, test, expect, vi } from 'vitest';
import { createSaveQueue } from './saveQueue';

const tick = () => new Promise(r => setTimeout(r, 0));

describe('save queue', () => {
  test('never runs two saves at once and coalesces requests made meanwhile', async () => {
    let active = 0;
    let maxActive = 0;
    let state = 0;
    const written: number[] = [];
    const release: (() => void)[] = [];
    const save = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const snapshot = state;
      await new Promise<void>(r => release.push(r));
      written.push(snapshot);
      active--;
    };
    const q = createSaveQueue(save, () => {});

    state = 1; const first = q.request();
    state = 2; q.request();
    state = 3; const last = q.request();
    await tick();
    release.shift()!();          // finish save of state 1
    await tick();
    release.shift()!();          // the single follow-up save sees state 3
    await Promise.all([first, last]);

    expect(maxActive).toBe(1);
    expect(written).toEqual([1, 3]);
  });

  test('a failed save is retried on its own until it succeeds', async () => {
    const onError = vi.fn();
    let calls = 0;
    const q = createSaveQueue(async () => {
      calls++;
      if (calls < 3) throw new Error('db restarting');
    }, onError, { retryMs: 5 });

    await q.request();
    expect(q.healthy).toBe(false);
    await vi.waitFor(() => expect(q.healthy).toBe(true), { timeout: 2000 });
    expect(calls).toBe(3);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  test('flush makes a final attempt for a failed save', async () => {
    let fail = true;
    let saved = 0;
    const q = createSaveQueue(async () => {
      if (fail) throw new Error('down');
      saved++;
    }, () => {}, { retryMs: 60_000 });

    await q.request();
    expect(q.healthy).toBe(false);
    fail = false;
    await q.flush();
    expect(saved).toBe(1);
    expect(q.healthy).toBe(true);
  });

  test('a failing save is reported and does not wedge the queue', async () => {
    const onError = vi.fn();
    let calls = 0;
    const q = createSaveQueue(async () => {
      calls++;
      if (calls === 1) throw new Error('db down');
    }, onError);

    await q.request();
    await q.request();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    await expect(q.flush()).resolves.toBeUndefined();
  });
});
