// Fixed-window failure counter: a key (an IP, a user id) is blocked after
// `max` failures until its window ends. Only clear(key) — that key's own
// success — resets it early.
export function createThrottle(max: number, windowMs: number, now: () => number = Date.now) {
  const records = new Map<string | number, { count: number; resetAt: number }>();
  return {
    blocked(key: string | number): boolean {
      const rec = records.get(key);
      return !!rec && now() < rec.resetAt && rec.count >= max;
    },
    fail(key: string | number): void {
      const t = now();
      const rec = records.get(key);
      if (!rec || t >= rec.resetAt) records.set(key, { count: 1, resetAt: t + windowMs });
      else rec.count++;
    },
    clear(key: string | number): void {
      records.delete(key);
    },
    // Drop expired windows so the map can't grow without bound.
    sweep(): void {
      const t = now();
      for (const [key, rec] of records) if (t >= rec.resetAt) records.delete(key);
    },
    get size(): number {
      return records.size;
    },
  };
}
