import { describe, test, expect } from 'vitest';
import { createThrottle } from './throttle';

describe('failure throttle', () => {
  test('blocks a key after max failures in the window, independently of other keys', () => {
    const now = 0;
    const th = createThrottle(3, 1000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(th.blocked(7)).toBe(false);
      th.fail(7);
    }
    expect(th.blocked(7)).toBe(true);
    expect(th.blocked(8)).toBe(false);
  });

  test("only clearing that key lifts the block (another key's success does not)", () => {
    const th = createThrottle(2, 1000, () => 0);
    th.fail(7);
    th.fail(7);
    th.clear(8);
    expect(th.blocked(7)).toBe(true);
    th.clear(7);
    expect(th.blocked(7)).toBe(false);
  });

  test('the window expires and a new one starts with the next failure', () => {
    let now = 0;
    const th = createThrottle(2, 1000, () => now);
    th.fail(7);
    th.fail(7);
    now = 1000;
    expect(th.blocked(7)).toBe(false);
    th.fail(7);
    expect(th.blocked(7)).toBe(false);
  });

  test('sweep forgets expired keys only', () => {
    let now = 0;
    const th = createThrottle(1, 1000, () => now);
    th.fail(7);
    now = 500;
    th.fail(8);
    now = 1200;
    th.sweep();
    expect(th.size).toBe(1);
  });
});
