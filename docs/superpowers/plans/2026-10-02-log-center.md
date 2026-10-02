# Pusat Log — Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Semua kejadian penting NetTwin (login, perubahan oleh user, error server, SSH Sync, kejadian sistem) tercatat terstruktur dan bisa dianalisa admin dari menu **Logs**.

**Architecture:** `createLogger` (`server/logging/logger.ts`) menerima entri, mencetaknya ke stdout, lalu menulisnya berkelompok ke `LogStore` — MySQL `app_logs` atau file JSONL per hari — yang disediakan `storage.logStore()`. Middleware `activityLogger` merekam setiap request yang mengubah data; rute auth, SSH, dan startup mencatat event khusus; `createErrorHandler` mencatat error 500 dengan stack. Router `/api/logs` (admin) melayani daftar, ringkasan, dan export CSV; frontend menambah `LogsTab`, badge error di sidebar, dan isian retensi di Settings.

**Tech Stack:** Express 4, mysql2, Node `fs`, React 19, Vitest, puppeteer-core + Edge headless (uji browser, di luar repo).

**Spec:** `docs/superpowers/specs/2026-09-30-log-center-design.md`

## Global Constraints

- Kategori: `auth` · `activity` · `system` · `ssh` · `backup`. Level: `info` · `warn` · `error`.
- Menu & API log **hanya admin**: aksi RBAC baru `view-logs`.
- Tidak pernah mencatat password, secret, token, atau isi request mentah. Redaksi lapis kedua: key yang **mengandung** `password`/`secret`/`token`/`credential`/`authorization`, atau **tepat** `code`/`challenge` (tanpa peduli huruf besar/kecil, di kedalaman mana pun) → `"[redacted]"`.
- `message` maks 1.000 karakter; `details` maks ±8 KB (stack dipotong lebih dulu).
- Penulisan berkelompok per **1 detik** atau **200 entri**; antrean maks **5.000** (yang tertua dibuang, lalu dicatat `system.log.dropped` saat pulih). Menulis log **tidak pernah** menggagalkan atau memperlambat request.
- Setiap entri juga dicetak ke stdout (`docker logs`).
- Retensi default **90 hari** (7–3650), field `logRetentionDays` di Settings; dipangkas saat start lalu tiap 24 jam. Factory Reset, Revert to Certified State, dan Import snapshot **tidak** menghapus log dan **tidak** mengubah nilai retensi.
- MySQL: tabel `app_logs` persis seperti spec, `ts` disimpan sebagai UTC `DATETIME(3)`. Mode file: `data/logs/app-YYYY-MM-DD.jsonl` (hari UTC).
- API: `GET /api/logs` (limit default 100, maks 200, terbaru dulu, `nextBefore`), `GET /api/logs/summary`, `GET /api/logs/export` (CSV, maks 50.000 baris).
- Pesan log berbahasa Inggris (seperti pesan error server); teks UI dua bahasa (`src/i18n.tsx`).
- **Request tanpa sesi tidak dicatat sebagai aktivitas**, dan login yang diblokir throttle dicatat **sekali** saat IP terblokir. Keduanya mencegah pengunjung anonim membanjiri database log.
- Password admin acak saat first boot tetap **hanya** dicetak ke stdout, tidak pernah masuk ke log.
- Tanpa dependency runtime baru. **Jangan commit** — user yang melakukan commit.

## Review Focus

1. Database sempat mati (MySQL restart) → aksi user tetap berhasil, entri log tertahan lalu masuk setelah pulih, tanpa duplikat. (Task 2: test retry.)
2. Penyerang mengirim ribuan request anonim atau login salah → log tidak membengkak tanpa batas. (Task 5: request anonim tidak dicatat; Task 6: throttle dicatat sekali per IP.)
3. Admin menjalankan Revert to Certified State atau mengimpor snapshot dari mesin lain → retensi log tidak berubah. (Task 6: smoke.)
4. Kotak cari diisi `%`, `_`, atau `\` → dicari sebagai teks biasa, bukan wildcard. (Task 1: `matchesLogFilter`; Task 3: escaping LIKE di MySQL.)
5. Rentang custom dengan "dari" setelah "sampai", atau tanggal rusak di URL → pesan 400 yang jelas, bukan error 500 atau daftar kosong yang membingungkan; UI menampilkan pesan itu di kotak error. (Task 1: `parseLogQuery`; Task 5: test "a bad filter is a 400 with the reason".)

---

### Task 1: Tipe bersama, parsing query, CSV

**Files:**
- Create: `src/logTypes.ts`, `server/logging/types.ts`, `server/logging/query.ts`, `server/logging/csv.ts`
- Test: `server/logging/query.test.ts`, `server/logging/csv.test.ts`

**Interfaces:**
- Consumes: `ValidationError` dari `server/validate.ts`
- Produces:
  - `src/logTypes.ts`: `LogCategory`, `LogLevel`, `LOG_CATEGORIES`, `LOG_LEVELS`, `DEFAULT_LOG_RETENTION_DAYS` (90), `MIN_LOG_RETENTION_DAYS` (7), `MAX_LOG_RETENTION_DAYS` (3650), `LogEntry { id; ts; category; level; event; message; actor: string|null; ip: string|null; target: string|null; details: Record<string, unknown>|null }`, `LogSummary { total; byCategory; byLevel; errorsLast24h }`, `LogPage { entries; nextBefore: number|null }`
  - `server/logging/types.ts`: semua di atas + `NewLogEntry = Omit<LogEntry,'id'>`, `LogFilter { categories; levels; from?; to?; actor?; q? }`, `LogQuery extends LogFilter { before?; limit }`, `LogStore { init(); append(entries: NewLogEntry[]); query(q: LogQuery): Promise<LogEntry[]>; summary(f: LogFilter, now: Date): Promise<LogSummary>; prune(before: Date): Promise<number> }`, `MAX_PAGE` (200), `DEFAULT_PAGE` (100), `MAX_EXPORT_ROWS` (50000)
  - `server/logging/query.ts`: `parseLogQuery(raw: Record<string, unknown>): LogQuery`, `matchesLogFilter(e: LogEntry, f: LogFilter & { before?: number }): boolean`, `emptySummary(): LogSummary`
  - `server/logging/csv.ts`: `logsToCsv(entries: LogEntry[]): string`

- [ ] **Step 1: Tulis test yang gagal**

`server/logging/query.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { parseLogQuery, matchesLogFilter, emptySummary } from './query';
import { ValidationError } from '../validate';
import { LogEntry, LogFilter } from './types';

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 10,
  ts: '2026-10-02T10:00:00.000Z',
  category: 'auth',
  level: 'warn',
  event: 'auth.login.failed',
  message: 'Login failed for "bob": wrong password',
  actor: null,
  ip: '10.0.0.5',
  target: 'bob',
  details: null,
  ...over,
});
const ALL: LogFilter = { categories: [], levels: [] };

describe('parseLogQuery', () => {
  test('defaults: every category and level, newest 100', () => {
    expect(parseLogQuery({})).toEqual({ categories: [], levels: [], limit: 100 });
  });

  test('comma lists are de-duplicated; "all" means no filter', () => {
    const q = parseLogQuery({ category: 'auth,system,auth', level: 'all' });
    expect(q.categories).toEqual(['auth', 'system']);
    expect(q.levels).toEqual([]);
  });

  test('an unknown category or level is a 400, not an empty result', () => {
    expect(() => parseLogQuery({ category: 'kernel' })).toThrow(ValidationError);
    expect(() => parseLogQuery({ level: 'debug' })).toThrow('level must be one of: info, warn, error');
  });

  test('dates are normalised to UTC ISO, must parse, and must be in order', () => {
    expect(parseLogQuery({ from: '2026-10-02T12:00:00+07:00' }).from).toBe('2026-10-02T05:00:00.000Z');
    expect(() => parseLogQuery({ from: 'yesterday' })).toThrow('from must be a date');
    expect(() => parseLogQuery({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' })).toThrow('from must be earlier than to');
  });

  test('limit is capped at 200; before and limit must be positive integers', () => {
    expect(parseLogQuery({ limit: '5000' }).limit).toBe(200);
    expect(parseLogQuery({ before: '42' }).before).toBe(42);
    expect(() => parseLogQuery({ before: '-1' })).toThrow(ValidationError);
    expect(() => parseLogQuery({ limit: 'abc' })).toThrow(ValidationError);
  });

  test('blank values are absent; text is trimmed and bounded; a repeated parameter uses the first', () => {
    const q = parseLogQuery({ actor: '  ', q: `  ${'x'.repeat(500)}  `, category: ['ssh', 'auth'] });
    expect(q.actor).toBeUndefined();
    expect(q.q).toHaveLength(200);
    expect(q.categories).toEqual(['ssh']);
  });
});

describe('matchesLogFilter', () => {
  test('category, level and actor', () => {
    expect(matchesLogFilter(entry(), { ...ALL, categories: ['auth'] })).toBe(true);
    expect(matchesLogFilter(entry(), { ...ALL, categories: ['system'] })).toBe(false);
    expect(matchesLogFilter(entry(), { ...ALL, levels: ['error'] })).toBe(false);
    expect(matchesLogFilter(entry({ actor: 'admin' }), { ...ALL, actor: 'admin' })).toBe(true);
    expect(matchesLogFilter(entry(), { ...ALL, actor: 'admin' })).toBe(false);
  });

  test('time window: from inclusive, to exclusive; paging keeps ids below "before"', () => {
    const e = entry();
    expect(matchesLogFilter(e, { ...ALL, from: e.ts })).toBe(true);
    expect(matchesLogFilter(e, { ...ALL, to: e.ts })).toBe(false);
    expect(matchesLogFilter(e, { ...ALL, before: 10 })).toBe(false);
    expect(matchesLogFilter(e, { ...ALL, before: 11 })).toBe(true);
  });

  test('search is case-insensitive over message, target, ip and event; wildcards are plain text', () => {
    expect(matchesLogFilter(entry(), { ...ALL, q: 'WRONG PASSWORD' })).toBe(true);
    expect(matchesLogFilter(entry(), { ...ALL, q: '10.0.0.5' })).toBe(true);
    expect(matchesLogFilter(entry(), { ...ALL, q: 'login.failed' })).toBe(true);
    expect(matchesLogFilter(entry(), { ...ALL, q: '%' })).toBe(false);
    expect(matchesLogFilter(entry({ message: '100% done' }), { ...ALL, q: '%' })).toBe(true);
  });

  test('emptySummary has a zero for every category and level', () => {
    expect(emptySummary()).toEqual({
      total: 0,
      byCategory: { auth: 0, activity: 0, system: 0, ssh: 0, backup: 0 },
      byLevel: { info: 0, warn: 0, error: 0 },
      errorsLast24h: 0,
    });
  });
});
```

`server/logging/csv.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { logsToCsv } from './csv';
import { LogEntry } from './types';

const base: LogEntry = {
  id: 1, ts: '2026-10-02T10:00:00.000Z', category: 'system', level: 'error', event: 'system.error',
  message: 'Server error', actor: null, ip: null, target: null, details: null,
};

describe('logsToCsv', () => {
  test('header row, CRLF line endings, empty cells for missing values', () => {
    expect(logsToCsv([base])).toBe(
      'time,level,category,event,user,ip,target,message,details\r\n' +
      '2026-10-02T10:00:00.000Z,error,system,system.error,,,,Server error,\r\n'
    );
  });

  test('commas, quotes and newlines are quoted; details are JSON', () => {
    const csv = logsToCsv([{ ...base, message: 'He said "no", then\nleft', details: { a: 1 } }]);
    expect(csv).toContain('"He said ""no"", then\nleft","{""a"":1}"');
  });

  test('cells a spreadsheet would run as a formula are neutralised', () => {
    const csv = logsToCsv([{ ...base, actor: '=HYPERLINK("http://x")', target: '+1', message: '@cmd' }]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(",'+1,'@cmd,");
  });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx vitest run server/logging`
Expected: FAIL — `Cannot find module './query'` dan `'./csv'`.

- [ ] **Step 3: Implementasi**

`src/logTypes.ts`:

```ts
// Shared by the server (writes and queries logs) and the Logs menu.
export type LogCategory = 'auth' | 'activity' | 'system' | 'ssh' | 'backup';
export type LogLevel = 'info' | 'warn' | 'error';

export const LOG_CATEGORIES: LogCategory[] = ['auth', 'activity', 'system', 'ssh', 'backup'];
export const LOG_LEVELS: LogLevel[] = ['info', 'warn', 'error'];

export const DEFAULT_LOG_RETENTION_DAYS = 90;
export const MIN_LOG_RETENTION_DAYS = 7;
export const MAX_LOG_RETENTION_DAYS = 3650;

export interface LogEntry {
  id: number;
  ts: string; // ISO 8601, UTC, milliseconds
  category: LogCategory;
  level: LogLevel;
  event: string; // machine code, e.g. "auth.login.failed"
  message: string;
  actor: string | null;
  ip: string | null;
  target: string | null;
  details: Record<string, unknown> | null;
}

export interface LogSummary {
  total: number;
  byCategory: Record<LogCategory, number>;
  byLevel: Record<LogLevel, number>;
  errorsLast24h: number;
}

export interface LogPage {
  entries: LogEntry[];
  nextBefore: number | null;
}
```

`server/logging/types.ts`:

```ts
import { LogCategory, LogLevel, LogEntry, LogSummary } from '../../src/logTypes';

export * from '../../src/logTypes';

export type NewLogEntry = Omit<LogEntry, 'id'>;

// Filters shared by listing, counting and export.
export interface LogFilter {
  categories: LogCategory[]; // empty = all
  levels: LogLevel[]; // empty = all
  from?: string; // ISO, inclusive
  to?: string; // ISO, exclusive
  actor?: string;
  q?: string; // case-insensitive text in message, target, ip or event
}

export interface LogQuery extends LogFilter {
  before?: number; // only entries with a smaller id (paging)
  limit: number;
}

export interface LogStore {
  init(): Promise<void>;
  append(entries: NewLogEntry[]): Promise<void>;
  query(q: LogQuery): Promise<LogEntry[]>; // newest first
  summary(f: LogFilter, now: Date): Promise<LogSummary>; // f.categories / f.levels are ignored
  prune(before: Date): Promise<number>; // entries removed
}

export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 100;
export const MAX_EXPORT_ROWS = 50_000;
```

`server/logging/query.ts`:

```ts
import { ValidationError } from '../validate';
import {
  LOG_CATEGORIES, LOG_LEVELS, LogCategory, LogLevel, LogEntry, LogFilter, LogQuery, LogSummary, MAX_PAGE, DEFAULT_PAGE,
} from './types';

// Express may hand a repeated parameter over as an array; the first one wins.
function one(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function list<T extends string>(raw: unknown, allowed: readonly T[], name: string): T[] {
  const s = one(raw);
  if (!s || s === 'all') return [];
  const items = [...new Set(s.split(',').map(x => x.trim()).filter(Boolean))];
  for (const item of items) {
    if (!(allowed as readonly string[]).includes(item)) {
      throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
    }
  }
  return items as T[];
}

function isoDate(raw: unknown, name: string): string | undefined {
  const s = one(raw);
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${name} must be a date (ISO 8601)`);
  return d.toISOString();
}

function positiveInt(raw: unknown, name: string): number | undefined {
  const s = one(raw);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError(`${name} must be a positive integer`);
  return n;
}

// The query string of GET /api/logs (and /summary, /export) as a filter.
export function parseLogQuery(raw: Record<string, unknown>): LogQuery {
  const q: LogQuery = {
    categories: list<LogCategory>(raw.category, LOG_CATEGORIES, 'category'),
    levels: list<LogLevel>(raw.level, LOG_LEVELS, 'level'),
    from: isoDate(raw.from, 'from'),
    to: isoDate(raw.to, 'to'),
    actor: one(raw.actor)?.slice(0, 64),
    q: one(raw.q)?.slice(0, 200),
    before: positiveInt(raw.before, 'before'),
    limit: Math.min(positiveInt(raw.limit, 'limit') ?? DEFAULT_PAGE, MAX_PAGE),
  };
  if (q.from && q.to && q.from >= q.to) throw new ValidationError('from must be earlier than to');
  return q;
}

// In-memory equivalent of the store's WHERE clause (file store).
export function matchesLogFilter(e: LogEntry, f: LogFilter & { before?: number }): boolean {
  if (f.categories.length && !f.categories.includes(e.category)) return false;
  if (f.levels.length && !f.levels.includes(e.level)) return false;
  if (f.from && e.ts < f.from) return false;
  if (f.to && e.ts >= f.to) return false;
  if (f.actor && e.actor !== f.actor) return false;
  if (f.before !== undefined && e.id >= f.before) return false;
  if (f.q) {
    const haystack = [e.message, e.target, e.ip, e.event].filter(Boolean).join('\n').toLowerCase();
    if (!haystack.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

export function emptySummary(): LogSummary {
  return {
    total: 0,
    byCategory: Object.fromEntries(LOG_CATEGORIES.map(c => [c, 0])) as LogSummary['byCategory'],
    byLevel: Object.fromEntries(LOG_LEVELS.map(l => [l, 0])) as LogSummary['byLevel'],
    errorsLast24h: 0,
  };
}
```

`server/logging/csv.ts`:

```ts
import { LogEntry } from './types';

const HEADER = ['time', 'level', 'category', 'event', 'user', 'ip', 'target', 'message', 'details'];

// A cell a spreadsheet would evaluate as a formula gets a leading ' (CSV injection).
function cell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function logsToCsv(entries: LogEntry[]): string {
  const rows = entries.map(e =>
    [e.ts, e.level, e.category, e.event, e.actor, e.ip, e.target, e.message, e.details ? JSON.stringify(e.details) : '']
      .map(cell)
      .join(',')
  );
  return [HEADER.join(','), ...rows].join('\r\n') + '\r\n';
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `npx vitest run server/logging && npx tsc --noEmit`
Expected: PASS (14 test); tsc 0 error.

---

### Task 2: Logger (antrean, cetak, redaksi)

**Files:**
- Create: `server/logging/logger.ts`
- Test: `server/logging/logger.test.ts`

**Interfaces:**
- Consumes: `LogStore`, `NewLogEntry`, `LogCategory`, `LogLevel` (Task 1)
- Produces:
  - `LogExtra { actor?; ip?; target?; details? }`, `LogInput extends LogExtra { category; level; event; message }`
  - `createLogger(opts?: { now?; flushMs?; batchSize?; maxBuffer?; maxRetryMs?; print? })` → `{ log(input); info(category, event, message, extra?); warn(...); error(...); attach(store): Promise<void>; flush(): Promise<void>; pending: number; dropped: number }`
  - `type Logger = ReturnType<typeof createLogger>`, `redact(value): unknown`, `formatLine(e: NewLogEntry): string`

- [ ] **Step 1: Tulis test yang gagal** — `server/logging/logger.test.ts`

```ts
import { describe, test, expect, vi, afterEach } from 'vitest';
import { createLogger, redact } from './logger';
import { LogStore, NewLogEntry } from './types';

function memoryStore() {
  const rows: NewLogEntry[] = [];
  let failing = false;
  const append = vi.fn(async (entries: NewLogEntry[]) => {
    if (failing) throw new Error('db down');
    rows.push(...entries);
  });
  const store = {
    init: async () => {},
    append,
    query: async () => [],
    summary: async () => { throw new Error('unused'); },
    prune: async () => 0,
  } as unknown as LogStore;
  return { store, rows, append, setFailing: (v: boolean) => { failing = v; } };
}

const quiet = () => {};
const T0 = new Date('2026-10-02T10:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('logger', () => {
  test('entries logged before storage is ready are written, in order, once it is attached', async () => {
    const logger = createLogger({ print: quiet, now: () => T0 });
    logger.info('system', 'system.storage.retry', 'MySQL not ready (1/15)');
    logger.warn('system', 'system.config', 'JWT_SECRET is not set');
    const { store, rows } = memoryStore();
    await logger.attach(store);
    expect(rows.map(r => r.event)).toEqual(['system.storage.retry', 'system.config']);
    expect(rows[0]).toMatchObject({ ts: '2026-10-02T10:00:00.000Z', category: 'system', level: 'info', actor: null, ip: null, target: null, details: null });
  });

  test('writes in batches after the batch window, not once per entry', async () => {
    vi.useFakeTimers();
    const { store, append } = memoryStore();
    const logger = createLogger({ print: quiet, flushMs: 1000 });
    await logger.attach(store);
    logger.info('activity', 'activity.request', 'a');
    logger.info('activity', 'activity.request', 'b');
    logger.info('activity', 'activity.request', 'c');
    expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toHaveLength(3);
  });

  test('a full batch is written straight away', async () => {
    const { store, append } = memoryStore();
    const logger = createLogger({ print: quiet, batchSize: 2, flushMs: 60_000 });
    await logger.attach(store);
    logger.info('activity', 'activity.request', 'a');
    logger.info('activity', 'activity.request', 'b');
    await logger.flush();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toHaveLength(2);
  });

  test('a failed write keeps the entries and retries later, without duplicates', async () => {
    vi.useFakeTimers();
    const { store, rows, setFailing } = memoryStore();
    const logger = createLogger({ print: quiet, flushMs: 1000 });
    await logger.attach(store);
    setFailing(true);
    logger.info('activity', 'activity.request', 'a');
    logger.info('activity', 'activity.request', 'b');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rows).toHaveLength(0);
    expect(logger.pending).toBe(2);
    setFailing(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(rows.map(r => r.message)).toEqual(['a', 'b']);
    expect(logger.pending).toBe(0);
  });

  test('while storage is down the buffer is capped; the loss is reported once storage is back', async () => {
    vi.useFakeTimers();
    const { store, rows, setFailing } = memoryStore();
    const logger = createLogger({ print: quiet, flushMs: 1000, maxBuffer: 3 });
    await logger.attach(store);
    setFailing(true);
    for (const m of ['a', 'b', 'c', 'd', 'e']) logger.info('activity', 'activity.request', m);
    expect(logger.pending).toBe(3);
    expect(logger.dropped).toBe(2);
    setFailing(false);
    await logger.flush();
    expect(rows.map(r => r.message)).toEqual(['c', 'd', 'e', '2 log entries were lost while the log storage was unavailable.']);
    expect(rows[3]).toMatchObject({ category: 'system', level: 'warn', event: 'system.log.dropped' });
  });

  test('every entry is printed for docker logs; errors include their stack', () => {
    const lines: string[] = [];
    const logger = createLogger({ print: line => lines.push(line) });
    logger.warn('auth', 'auth.login.failed', 'Login failed for "bob": wrong password', { ip: '10.0.0.5' });
    logger.error('system', 'system.error', 'Server error on POST /api/x: boom', { actor: 'admin', details: { stack: 'Error: boom\n    at x' } });
    expect(lines[0]).toBe('[WARN] [auth] Login failed for "bob": wrong password (from 10.0.0.5)');
    expect(lines[1]).toBe('[ERROR] [system] Server error on POST /api/x: boom (by admin)\nError: boom\n    at x');
  });

  test('secrets are masked at any depth; other fields are kept', () => {
    expect(redact({
      password: 'p', challenge: 'c', name: 'r1', statusCode: 500,
      nested: { apiToken: 't', list: [{ passwordHash: 'h', code: '123456' }] },
    })).toEqual({
      password: '[redacted]', challenge: '[redacted]', name: 'r1', statusCode: 500,
      nested: { apiToken: '[redacted]', list: [{ passwordHash: '[redacted]', code: '[redacted]' }] },
    });
  });

  test('message, actor, target and details are bounded', async () => {
    const { store, rows } = memoryStore();
    const logger = createLogger({ print: quiet });
    await logger.attach(store);
    logger.error('system', 'system.error', 'x'.repeat(5000), {
      actor: 'a'.repeat(100), target: 't'.repeat(400), details: { stack: 's'.repeat(20_000), path: '/api/x' },
    });
    await logger.flush();
    const [e] = rows;
    expect(e.message.length).toBeLessThanOrEqual(1000);
    expect(e.actor).toHaveLength(64);
    expect(e.target).toHaveLength(255);
    expect(JSON.stringify(e.details).length).toBeLessThanOrEqual(8192);
    expect(e.details).toMatchObject({ path: '/api/x' });
    expect(String(e.details!.stack)).toContain('[truncated]');
  });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx vitest run server/logging/logger.test.ts`
Expected: FAIL — `Cannot find module './logger'`.

- [ ] **Step 3: Implementasi** — `server/logging/logger.ts`

```ts
import { LogCategory, LogLevel, LogStore, NewLogEntry } from './types';

export interface LogExtra {
  actor?: string | null;
  ip?: string | null;
  target?: string | null;
  details?: Record<string, unknown>;
}

export interface LogInput extends LogExtra {
  category: LogCategory;
  level: LogLevel;
  event: string;
  message: string;
}

export interface LoggerOptions {
  now?: () => Date;
  flushMs?: number; // batch window
  batchSize?: number; // write early once this many entries wait
  maxBuffer?: number; // entries kept in memory while storage fails
  maxRetryMs?: number;
  print?: (line: string, level: LogLevel) => void;
}

const MAX_MESSAGE = 1000;
const MAX_DETAILS = 8192;
const SECRET_KEY = /password|secret|token|credential|authorization|^code$|^challenge$/i;

// Defence in depth: callers never pass secrets, but a field that looks like
// one is masked anyway, at any depth.
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

// Redacted and size-bounded; a long stack trace is cut first.
function boundDetails(details?: Record<string, unknown>): Record<string, unknown> | null {
  if (!details) return null;
  const clean = redact(details) as Record<string, unknown>;
  let json: string;
  try {
    json = JSON.stringify(clean);
  } catch {
    return { unserializable: true };
  }
  if (json.length <= MAX_DETAILS) return clean;
  if (typeof clean.stack === 'string') {
    const over = json.length - MAX_DETAILS;
    clean.stack = `${clean.stack.slice(0, Math.max(0, clean.stack.length - over - 40))}\n…[truncated]`;
    if (JSON.stringify(clean).length <= MAX_DETAILS) return clean;
  }
  return { truncated: true, preview: json.slice(0, MAX_DETAILS - 100) };
}

const clip = (s: string | null | undefined, n: number): string | null => (s ? String(s).slice(0, n) : null);

// One line per entry for `docker logs`; server errors carry their stack.
export function formatLine(e: NewLogEntry): string {
  const who = [e.actor && `by ${e.actor}`, e.ip && `from ${e.ip}`].filter(Boolean).join(' ');
  const stack = e.level === 'error' && typeof e.details?.stack === 'string' ? `\n${e.details.stack}` : '';
  return `[${e.level.toUpperCase()}] [${e.category}] ${e.message}${who ? ` (${who})` : ''}${stack}`;
}

function defaultPrint(line: string, level: LogLevel) {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// Collects log entries, prints each one, and writes them to the log store in
// batches. Entries logged before a store is attached (start-up) are kept and
// written once it is. A failing store never affects the caller: entries stay
// queued (up to maxBuffer, oldest dropped first) and are retried with backoff.
export function createLogger(opts: LoggerOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const flushMs = opts.flushMs ?? 1000;
  const batchSize = opts.batchSize ?? 200;
  const maxBuffer = opts.maxBuffer ?? 5000;
  const maxRetryMs = opts.maxRetryMs ?? 30_000;
  const print = opts.print ?? defaultPrint;

  let store: LogStore | null = null;
  const queue: NewLogEntry[] = [];
  let dropped = 0;
  let failing = false;
  let retryDelay = flushMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let draining: Promise<void> | null = null;

  const capBuffer = () => {
    const over = queue.length - maxBuffer;
    if (over > 0) {
      queue.splice(0, over);
      dropped += over;
    }
  };

  const schedule = (delay: number) => {
    if (timer || !store) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
    timer.unref?.();
  };

  function log(input: LogInput): void {
    const entry: NewLogEntry = {
      ts: now().toISOString(),
      category: input.category,
      level: input.level,
      event: input.event,
      message: input.message.length > MAX_MESSAGE ? `${input.message.slice(0, MAX_MESSAGE - 1)}…` : input.message,
      actor: clip(input.actor, 64),
      ip: clip(input.ip, 64),
      target: clip(input.target, 255),
      details: boundDetails(input.details),
    };
    try {
      print(formatLine(entry), entry.level);
    } catch {
      // printing must never break the caller
    }
    queue.push(entry);
    capBuffer();
    if (!failing && queue.length >= batchSize) void flush();
    else schedule(flushMs);
  }

  async function drain(): Promise<void> {
    while (store && queue.length) {
      const batch = queue.splice(0, batchSize);
      try {
        await store.append(batch);
      } catch (err) {
        queue.unshift(...batch);
        capBuffer();
        failing = true;
        try {
          print(`[WARN] [system] Writing logs failed (${err instanceof Error ? err.message : String(err)}); ${queue.length} entries kept in memory, retrying.`, 'warn');
        } catch {
          // ignore
        }
        const delay = retryDelay;
        retryDelay = Math.min(retryDelay * 2, maxRetryMs);
        schedule(delay);
        return;
      }
      failing = false;
      retryDelay = flushMs;
      if (dropped > 0) {
        const lost = dropped;
        dropped = 0;
        log({ category: 'system', level: 'warn', event: 'system.log.dropped', message: `${lost} log entries were lost while the log storage was unavailable.` });
      }
    }
  }

  // Write everything queued now (start-up, shutdown, tests).
  function flush(): Promise<void> {
    if (!store) return Promise.resolve();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!draining) draining = drain().finally(() => { draining = null; });
    return draining;
  }

  const at = (level: LogLevel) => (category: LogCategory, event: string, message: string, extra: LogExtra = {}) =>
    log({ ...extra, category, level, event, message });

  return {
    log,
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    // Storage is ready: write what was logged so far, then keep writing.
    attach(s: LogStore): Promise<void> {
      store = s;
      return flush();
    },
    flush,
    get pending(): number {
      return queue.length;
    },
    get dropped(): number {
      return dropped;
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `npx vitest run server/logging/logger.test.ts && npx tsc --noEmit`
Expected: PASS (8 test); tsc 0 error.

---

### Task 3: Penyimpanan log (file & MySQL) + `storage.logStore()`

**Files:**
- Create: `server/logging/fileStore.ts`, `server/logging/mysqlStore.ts`
- Modify: `server/storage.ts` (interface `Storage`, `FileStorage`, `MySqlStorage`)
- Test: `server/logging/fileStore.test.ts`, `server/logging/mysqlStore.test.ts`, `server/storage.test.ts`

**Interfaces:**
- Consumes: `LogStore`, `NewLogEntry`, `LogEntry`, `LogFilter`, `LogQuery`, `LogSummary`, `matchesLogFilter`, `emptySummary` (Task 1)
- Produces:
  - `class FileLogStore implements LogStore` — `constructor(dir: string)`
  - `class MySqlLogStore implements LogStore` — `constructor(pool: Pool)`
  - `interface StorageInitHooks { onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void }`
  - Pada `Storage`: `init(hooks?: StorageInitHooks): Promise<void>`, `logStore(): LogStore`

- [ ] **Step 1: Tulis test yang gagal**

`server/logging/fileStore.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FileLogStore } from './fileStore';
import { LogFilter, NewLogEntry } from './types';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nettwin-logs-'));
const e = (ts: string, over: Partial<NewLogEntry> = {}): NewLogEntry => ({
  ts, category: 'activity', level: 'info', event: 'activity.request', message: 'Update device "r1"',
  actor: 'admin', ip: '10.0.0.1', target: 'r1', details: null, ...over,
});
const ALL: LogFilter = { categories: [], levels: [] };

async function seeded() {
  const dir = tempDir();
  const store = new FileLogStore(dir);
  await store.init();
  await store.append([
    e('2026-09-30T23:59:59.000Z', { category: 'auth', level: 'warn', event: 'auth.login.failed', message: 'Login failed for "bob": wrong password', actor: null }),
    e('2026-10-01T08:00:00.000Z'),
    e('2026-10-02T09:00:00.000Z', { category: 'system', level: 'error', event: 'system.error', message: 'Server error', actor: null, details: { stack: 'Error: x' } }),
    e('2026-10-02T10:00:00.000Z', { category: 'ssh', message: 'SSH collect succeeded: core-1' }),
  ]);
  return { dir, store };
}

describe('FileLogStore', () => {
  test('one JSON line per entry, in a file per UTC day, with increasing ids', async () => {
    const { dir } = await seeded();
    expect(fs.readdirSync(dir).sort()).toEqual(['app-2026-09-30.jsonl', 'app-2026-10-01.jsonl', 'app-2026-10-02.jsonl']);
    const lines = fs.readFileSync(path.join(dir, 'app-2026-10-02.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.id)).toEqual([3, 4]);
    expect(lines[0]).toMatchObject({ category: 'system', details: { stack: 'Error: x' } });
  });

  test('ids continue after a restart', async () => {
    const { dir } = await seeded();
    const again = new FileLogStore(dir);
    await again.init();
    await again.append([e('2026-10-02T11:00:00.000Z')]);
    const [newest] = await again.query({ ...ALL, limit: 1 });
    expect(newest.id).toBe(5);
  });

  test('query returns newest first, filtered, and pages with "before"', async () => {
    const { store } = await seeded();
    expect((await store.query({ ...ALL, limit: 10 })).map(x => x.id)).toEqual([4, 3, 2, 1]);
    expect((await store.query({ ...ALL, categories: ['auth', 'system'], limit: 10 })).map(x => x.id)).toEqual([3, 1]);
    expect((await store.query({ ...ALL, from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T09:30:00.000Z', limit: 10 })).map(x => x.id)).toEqual([3, 2]);
    expect((await store.query({ ...ALL, q: 'CORE-1', limit: 10 })).map(x => x.id)).toEqual([4]);
    const page1 = await store.query({ ...ALL, limit: 2 });
    const page2 = await store.query({ ...ALL, limit: 2, before: page1[1].id });
    expect([...page1, ...page2].map(x => x.id)).toEqual([4, 3, 2, 1]);
  });

  test('summary counts within the filter; errorsLast24h ignores it', async () => {
    const { store } = await seeded();
    const s = await store.summary({ ...ALL, from: '2026-10-01T00:00:00.000Z' }, new Date('2026-10-02T12:00:00.000Z'));
    expect(s.total).toBe(3);
    expect(s.byCategory).toEqual({ auth: 0, activity: 1, system: 1, ssh: 1, backup: 0 });
    expect(s.byLevel).toEqual({ info: 2, warn: 0, error: 1 });
    expect(s.errorsLast24h).toBe(1);
  });

  test('prune removes whole days older than the cutoff and reports how many entries went', async () => {
    const { dir, store } = await seeded();
    expect(await store.prune(new Date('2026-10-01T12:00:00.000Z'))).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(['app-2026-10-01.jsonl', 'app-2026-10-02.jsonl']);
  });

  test('a torn last line (crash mid-write) is skipped, and the next entry starts on a fresh line', async () => {
    const { dir } = await seeded();
    fs.appendFileSync(path.join(dir, 'app-2026-10-02.jsonl'), '{"id":5,"ts":"2026-10');
    const again = new FileLogStore(dir);
    await again.init();
    await again.append([e('2026-10-02T11:00:00.000Z', { message: 'after the crash' })]);
    expect((await again.query({ ...ALL, limit: 10 })).map(x => x.message)).toEqual([
      'after the crash', 'SSH collect succeeded: core-1', 'Server error', 'Update device "r1"', 'Login failed for "bob": wrong password',
    ]);
  });
});
```

`server/logging/mysqlStore.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { MySqlLogStore } from './mysqlStore';
import { LogFilter, NewLogEntry } from './types';

// Fake pool: records every query and answers from canned results keyed by SQL fragment.
function recordingPool(answers: Record<string, unknown> = {}) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const key = Object.keys(answers).find(k => sql.includes(k));
      return [key ? answers[key] : []];
    },
  };
  return { calls, store: new MySqlLogStore(pool as any) };
}
const ALL: LogFilter = { categories: [], levels: [] };
const entry: NewLogEntry = {
  ts: '2026-10-02T10:00:00.123Z', category: 'auth', level: 'warn', event: 'auth.login.failed', message: 'Login failed',
  actor: null, ip: '10.0.0.5', target: 'bob', details: { reason: 'wrong password' },
};

describe('MySqlLogStore', () => {
  test('init creates app_logs with time, category and level indexes', async () => {
    const { calls, store } = recordingPool();
    await store.init();
    expect(calls[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS app_logs/);
    expect(calls[0].sql).toMatch(/ts DATETIME\(3\) NOT NULL/);
    for (const idx of ['INDEX idx_ts (ts)', 'INDEX idx_category_ts (category, ts)', 'INDEX idx_level_ts (level, ts)']) {
      expect(calls[0].sql).toContain(idx);
    }
  });

  test('append is one multi-row insert with UTC timestamps and JSON details', async () => {
    const { calls, store } = recordingPool();
    await store.append([entry, { ...entry, details: null }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe('INSERT INTO app_logs (ts, category, level, event, actor, ip, target, message, details) VALUES ?');
    expect(calls[0].params).toEqual([[
      ['2026-10-02 10:00:00.123', 'auth', 'warn', 'auth.login.failed', null, '10.0.0.5', 'bob', 'Login failed', '{"reason":"wrong password"}'],
      ['2026-10-02 10:00:00.123', 'auth', 'warn', 'auth.login.failed', null, '10.0.0.5', 'bob', 'Login failed', null],
    ]]);
    await store.append([]);
    expect(calls).toHaveLength(1);
  });

  test('query filters with parameters, escapes LIKE wildcards, and maps rows back', async () => {
    const { calls, store } = recordingPool({
      'FROM app_logs WHERE': [{
        id: 9, ts: '2026-10-02 10:00:00.123', category: 'auth', level: 'warn', event: 'auth.login.failed',
        actor: null, ip: '10.0.0.5', target: 'bob', message: 'Login failed', details: '{"reason":"wrong password"}',
      }],
    });
    const rows = await store.query({
      categories: ['auth'], levels: ['warn', 'error'], from: '2026-10-01T00:00:00.000Z', to: '2026-10-03T00:00:00.000Z',
      actor: 'admin', q: '50%_off\\', before: 100, limit: 50,
    });
    const { sql, params } = calls[0];
    expect(sql).toContain('WHERE category IN (?) AND level IN (?) AND ts >= ? AND ts < ? AND actor = ? AND id < ? AND (message LIKE ? OR target LIKE ? OR ip LIKE ? OR event LIKE ?)');
    expect(sql).toMatch(/ORDER BY id DESC LIMIT \?$/);
    const like = '%50\\%\\_off\\\\%';
    expect(params).toEqual([['auth'], ['warn', 'error'], '2026-10-01 00:00:00.000', '2026-10-03 00:00:00.000', 'admin', 100, like, like, like, like, 50]);
    expect(rows).toEqual([{
      id: 9, ts: '2026-10-02T10:00:00.123Z', category: 'auth', level: 'warn', event: 'auth.login.failed',
      actor: null, ip: '10.0.0.5', target: 'bob', message: 'Login failed', details: { reason: 'wrong password' },
    }]);
  });

  test('summary groups within the filter (ignoring category/level); errors of the last 24 h are counted separately', async () => {
    const { calls, store } = recordingPool({
      'GROUP BY category, level': [{ category: 'auth', level: 'warn', n: 3 }, { category: 'system', level: 'error', n: '2' }],
      "level = 'error' AND ts >= ?": [{ n: 5 }],
    });
    const s = await store.summary({ ...ALL, categories: ['ssh'], actor: 'admin' }, new Date('2026-10-02T12:00:00.000Z'));
    expect(calls[0].sql).not.toContain('category IN');
    expect(calls[0].params).toEqual(['admin']);
    expect(calls[1].params).toEqual(['2026-10-01 12:00:00.000']);
    expect(s).toEqual({
      total: 5,
      byCategory: { auth: 3, activity: 0, system: 2, ssh: 0, backup: 0 },
      byLevel: { info: 0, warn: 3, error: 2 },
      errorsLast24h: 5,
    });
  });

  test('prune deletes older rows and reports how many', async () => {
    const { calls, store } = recordingPool({ 'DELETE FROM app_logs': { affectedRows: 42 } });
    expect(await store.prune(new Date('2026-07-04T00:00:00.000Z'))).toBe(42);
    expect(calls[0]).toEqual({ sql: 'DELETE FROM app_logs WHERE ts < ?', params: ['2026-07-04 00:00:00.000'] });
  });
});
```

Di `server/storage.test.ts`: tambahkan `import { MySqlLogStore } from './logging/mysqlStore';` di bawah import yang ada, lalu tambahkan test ini **di dalam** `describe('FileStorage', ...)`:

```ts
  test('logs are kept under data/logs', async () => {
    const { storage, dataDir } = tempStorage();
    await storage.init();
    const logs = storage.logStore();
    await logs.init();
    await logs.append([{ ts: '2026-10-02T10:00:00.000Z', category: 'system', level: 'info', event: 'system.start', message: 'started', actor: null, ip: null, target: null, details: null }]);
    expect(fs.readdirSync(path.join(dataDir, 'logs'))).toEqual(['app-2026-10-02.jsonl']);
  });
```

dan blok baru di akhir file:

```ts
describe('MySqlStorage logs and start-up retries', () => {
  test('the log store writes through the storage pool', async () => {
    const storage = new MySqlStorage();
    const seen: string[] = [];
    (storage as any).pool = { query: async (sql: string) => { seen.push(sql); return [[]]; } };
    const logs = storage.logStore();
    expect(logs).toBeInstanceOf(MySqlLogStore);
    await logs.init();
    expect(seen[0]).toMatch(/CREATE TABLE IF NOT EXISTS app_logs/);
  });

  test('a database that is not ready yet is reported through onRetry', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MySqlStorage();
      let attempts = 0;
      (storage as any).pool = {
        getConnection: async () => {
          if (attempts++ === 0) throw new Error('ECONNREFUSED');
          return { release() {} };
        },
        query: async () => [[]],
      };
      const retries: [number, number, string][] = [];
      const done = storage.init({ onRetry: (attempt, max, err) => retries.push([attempt, max, (err as Error).message]) });
      await vi.advanceTimersByTimeAsync(2000);
      await done;
      expect(retries).toEqual([[1, 15, 'ECONNREFUSED']]);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx vitest run server/logging server/storage.test.ts`
Expected: FAIL — `Cannot find module './fileStore'` / `'./mysqlStore'`; `storage.logStore is not a function`.

- [ ] **Step 3: Implementasi**

`server/logging/fileStore.ts`:

```ts
import fs from 'fs';
import path from 'path';
import { LogEntry, LogFilter, LogQuery, LogStore, LogSummary, NewLogEntry } from './types';
import { matchesLogFilter, emptySummary } from './query';

const FILE_RE = /^app-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

// Log storage without MySQL (development): one JSON line per entry, one file
// per UTC day, so retention deletes whole files.
export class FileLogStore implements LogStore {
  private nextId = 1;

  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const newest = this.files()[0];
    if (!newest) return;
    // A crash mid-write can leave a torn last line: start the next entry on a new line.
    const text = fs.readFileSync(newest.file, 'utf8');
    if (text && !text.endsWith('\n')) fs.appendFileSync(newest.file, '\n');
    this.nextId = this.read(newest.file).reduce((max, e) => Math.max(max, e.id), 0) + 1;
  }

  // Newest day first.
  private files(): { day: string; file: string }[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .map(name => ({ name, m: FILE_RE.exec(name) }))
      .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
      .map(x => ({ day: x.m[1], file: path.join(this.dir, x.name) }))
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  }

  private read(file: string): LogEntry[] {
    const out: LogEntry[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a torn line from a crash is skipped
      }
    }
    return out;
  }

  // Could the day's file hold entries inside [from, to)?
  private dayInRange(day: string, f: LogFilter): boolean {
    if (f.from && day < f.from.slice(0, 10)) return false;
    if (f.to && day > f.to.slice(0, 10)) return false;
    return true;
  }

  async append(entries: NewLogEntry[]): Promise<void> {
    const byFile = new Map<string, string[]>();
    for (const e of entries) {
      const file = path.join(this.dir, `app-${e.ts.slice(0, 10)}.jsonl`);
      const lines = byFile.get(file) ?? [];
      lines.push(JSON.stringify({ id: this.nextId++, ...e }));
      byFile.set(file, lines);
    }
    for (const [file, lines] of byFile) fs.appendFileSync(file, lines.join('\n') + '\n');
  }

  async query(q: LogQuery): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    for (const { day, file } of this.files()) {
      if (!this.dayInRange(day, q)) continue;
      const hits = this.read(file).filter(e => matchesLogFilter(e, q)).sort((a, b) => b.id - a.id);
      for (const e of hits) {
        out.push(e);
        if (out.length >= q.limit) return out;
      }
    }
    return out;
  }

  async summary(f: LogFilter, now: Date): Promise<LogSummary> {
    const s = emptySummary();
    const filter: LogFilter = { ...f, categories: [], levels: [] };
    const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
    for (const { day, file } of this.files()) {
      const counted = this.dayInRange(day, filter);
      const recent = day >= dayAgo.slice(0, 10);
      if (!counted && !recent) continue;
      for (const e of this.read(file)) {
        if (recent && e.level === 'error' && e.ts >= dayAgo) s.errorsLast24h++;
        if (!counted || !matchesLogFilter(e, filter)) continue;
        if (!(e.category in s.byCategory) || !(e.level in s.byLevel)) continue;
        s.total++;
        s.byCategory[e.category]++;
        s.byLevel[e.level]++;
      }
    }
    return s;
  }

  async prune(before: Date): Promise<number> {
    const cutoff = before.toISOString().slice(0, 10);
    let removed = 0;
    for (const { day, file } of this.files()) {
      if (day >= cutoff) continue;
      removed += this.read(file).length;
      fs.unlinkSync(file);
    }
    return removed;
  }
}
```

`server/logging/mysqlStore.ts`:

```ts
import { Pool } from 'mysql2/promise';
import { LogCategory, LogEntry, LogFilter, LogLevel, LogQuery, LogStore, LogSummary, NewLogEntry } from './types';
import { emptySummary } from './query';

const DAY_MS = 86_400_000;

// Timestamps are stored as UTC DATETIME(3) strings, independent of the
// connection's time zone: '2026-10-02T10:00:00.123Z' <-> '2026-10-02 10:00:00.123'.
const toSql = (iso: string) => iso.replace('T', ' ').replace('Z', '');
const fromSql = (s: string) => `${s.replace(' ', 'T')}Z`;

// Search text is matched literally: %, _ and \ lose their LIKE meaning.
const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

function where(f: LogFilter & { before?: number }): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.categories.length) {
    conds.push('category IN (?)');
    params.push(f.categories);
  }
  if (f.levels.length) {
    conds.push('level IN (?)');
    params.push(f.levels);
  }
  if (f.from) {
    conds.push('ts >= ?');
    params.push(toSql(f.from));
  }
  if (f.to) {
    conds.push('ts < ?');
    params.push(toSql(f.to));
  }
  if (f.actor) {
    conds.push('actor = ?');
    params.push(f.actor);
  }
  if (f.before !== undefined) {
    conds.push('id < ?');
    params.push(f.before);
  }
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    conds.push('(message LIKE ? OR target LIKE ? OR ip LIKE ? OR event LIKE ?)');
    params.push(like, like, like, like);
  }
  return { sql: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

const parseDetails = (v: unknown): Record<string, unknown> | null =>
  v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : (v as Record<string, unknown>);

export class MySqlLogStore implements LogStore {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS app_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      ts DATETIME(3) NOT NULL,
      category VARCHAR(16) NOT NULL,
      level VARCHAR(8) NOT NULL,
      event VARCHAR(64) NOT NULL,
      actor VARCHAR(64) NULL,
      ip VARCHAR(64) NULL,
      target VARCHAR(255) NULL,
      message TEXT NOT NULL,
      details JSON NULL,
      INDEX idx_ts (ts),
      INDEX idx_category_ts (category, ts),
      INDEX idx_level_ts (level, ts)
    )`);
  }

  async append(entries: NewLogEntry[]): Promise<void> {
    if (!entries.length) return;
    const rows = entries.map(e => [
      toSql(e.ts), e.category, e.level, e.event, e.actor, e.ip, e.target, e.message,
      e.details ? JSON.stringify(e.details) : null,
    ]);
    await this.pool.query('INSERT INTO app_logs (ts, category, level, event, actor, ip, target, message, details) VALUES ?', [rows]);
  }

  async query(q: LogQuery): Promise<LogEntry[]> {
    const w = where(q);
    const [rows] = await this.pool.query(
      `SELECT id, CAST(ts AS CHAR) AS ts, category, level, event, actor, ip, target, message, details FROM app_logs ${w.sql} ORDER BY id DESC LIMIT ?`,
      [...w.params, q.limit]
    );
    return (rows as Record<string, unknown>[]).map(r => ({
      id: Number(r.id),
      ts: fromSql(String(r.ts)),
      category: r.category as LogCategory,
      level: r.level as LogLevel,
      event: String(r.event),
      actor: (r.actor as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
      target: (r.target as string | null) ?? null,
      message: String(r.message),
      details: parseDetails(r.details),
    }));
  }

  async summary(f: LogFilter, now: Date): Promise<LogSummary> {
    const w = where({ ...f, categories: [], levels: [] });
    const [rows] = await this.pool.query(`SELECT category, level, COUNT(*) AS n FROM app_logs ${w.sql} GROUP BY category, level`, w.params);
    const s = emptySummary();
    for (const r of rows as { category: string; level: string; n: unknown }[]) {
      if (!(r.category in s.byCategory) || !(r.level in s.byLevel)) continue;
      const n = Number(r.n);
      s.total += n;
      s.byCategory[r.category as LogCategory] += n;
      s.byLevel[r.level as LogLevel] += n;
    }
    const [errs] = await this.pool.query(
      `SELECT COUNT(*) AS n FROM app_logs WHERE level = 'error' AND ts >= ?`,
      [toSql(new Date(now.getTime() - DAY_MS).toISOString())]
    );
    s.errorsLast24h = Number((errs as { n: unknown }[])[0]?.n ?? 0);
    return s;
  }

  async prune(before: Date): Promise<number> {
    const [res] = await this.pool.query('DELETE FROM app_logs WHERE ts < ?', [toSql(before.toISOString())]);
    return Number((res as { affectedRows?: number }).affectedRows ?? 0);
  }
}
```

`server/storage.ts`:

1. Tambahkan import di atas:

```ts
import { LogStore } from './logging/types';
import { FileLogStore } from './logging/fileStore';
import { MySqlLogStore } from './logging/mysqlStore';
```

2. Sebelum `export interface Storage`, tambahkan:

```ts
// Start-up callbacks (e.g. to log "database not ready yet" retries).
export interface StorageInitHooks {
  onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void;
}
```

3. Di `interface Storage`: ganti `init(): Promise<void>;` dengan `init(hooks?: StorageInitHooks): Promise<void>;` dan tambahkan di akhir interface:

```ts
  // Where the application log lives (same backend as everything else).
  logStore(): LogStore;
```

4. `FileStorage`: ganti `async init(): Promise<void> {` dengan `async init(_hooks?: StorageInitHooks): Promise<void> {`, lalu tambahkan metode:

```ts
  logStore(): LogStore {
    return new FileLogStore(path.join(this.dataDir, 'logs'));
  }
```

5. `MySqlStorage`: ganti `async init(): Promise<void> {` dengan `async init(hooks: StorageInitHooks = {}): Promise<void> {`; di loop retry ganti

```ts
        console.log(`MySQL not ready (attempt ${attempt}/${maxAttempts}), retrying in 2s...`);
```

dengan

```ts
        if (hooks.onRetry) hooks.onRetry(attempt, maxAttempts, err);
        else console.log(`MySQL not ready (attempt ${attempt}/${maxAttempts}), retrying in 2s...`);
```

lalu tambahkan metode:

```ts
  logStore(): LogStore {
    return new MySqlLogStore(this.pool);
  }
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `npx vitest run server/logging server/storage.test.ts && npx tsc --noEmit`
Expected: PASS; tsc 0 error.

---

### Task 4: Hak akses `view-logs`, setting retensi, pemangkasan

**Files:**
- Modify: `src/rbac.ts`, `src/types.ts` (`SimulationSettings`), `server/validate.ts` (`normalizeSettings`)
- Create: `server/logging/retention.ts`
- Test: `src/rbac.test.ts`, `server/validate.test.ts`, `server/logging/retention.test.ts`

**Interfaces:**
- Consumes: `LogStore` (Task 1), `Logger` (Task 2), `MIN_/MAX_/DEFAULT_LOG_RETENTION_DAYS` (Task 1)
- Produces: aksi RBAC `'view-logs'` (admin saja); `SimulationSettings.logRetentionDays?: number`; `pruneLogs(store: LogStore, logger: Logger, days: number | undefined, now?: Date): Promise<number>`

- [ ] **Step 1: Tulis test yang gagal**

Di `src/rbac.test.ts`, tambahkan di dalam `describe('RBAC permission matrix', ...)`:

```ts
  test('only admins can read the application logs', () => {
    expect(canAccess('admin', 'view-logs')).toBe(true);
    expect(canAccess('operator', 'view-logs')).toBe(false);
    expect(canAccess('viewer', 'view-logs')).toBe(false);
  });
```

Di `server/validate.test.ts`, tambahkan blok baru di akhir file:

```ts
describe('log retention setting', () => {
  test('whole days between 7 and 3650; kept from the current settings when absent', () => {
    expect(normalizeSettings({ maxHops: 10, logRetentionDays: '30' }, DEFAULT_SETTINGS).logRetentionDays).toBe(30);
    expect(normalizeSettings({ maxHops: 10 }, { ...DEFAULT_SETTINGS, logRetentionDays: 45 }).logRetentionDays).toBe(45);
    expect(normalizeSettings({ maxHops: 10 }, DEFAULT_SETTINGS)).not.toHaveProperty('logRetentionDays');
  });

  test('anything else is refused with a clear message', () => {
    expect(() => normalizeSettings({ logRetentionDays: 3 }, DEFAULT_SETTINGS))
      .toThrow('settings.logRetentionDays must be a whole number of days between 7 and 3650');
    expect(() => normalizeSettings({ logRetentionDays: 'abc' }, DEFAULT_SETTINGS)).toThrow(ValidationError);
    expect(() => normalizeSettings({ logRetentionDays: 7.5 }, DEFAULT_SETTINGS)).toThrow(ValidationError);
    expect(() => normalizeSettings({ logRetentionDays: 5000 }, DEFAULT_SETTINGS)).toThrow(ValidationError);
  });
});
```

`server/logging/retention.test.ts`:

```ts
import { describe, test, expect, vi } from 'vitest';
import { pruneLogs } from './retention';
import { LogStore } from './types';
import { Logger } from './logger';

function fakes(removed: number) {
  const prune = vi.fn(async () => removed);
  const info = vi.fn();
  return { store: { prune } as unknown as LogStore, logger: { info } as unknown as Logger, prune, info };
}
const NOW = new Date('2026-10-02T00:00:00.000Z');

describe('pruneLogs', () => {
  test('deletes entries older than the retention window and logs how many went', async () => {
    const f = fakes(12);
    expect(await pruneLogs(f.store, f.logger, 30, NOW)).toBe(12);
    expect(f.prune).toHaveBeenCalledWith(new Date('2026-09-02T00:00:00.000Z'));
    expect(f.info).toHaveBeenCalledWith('system', 'system.log.pruned', 'Log retention: removed 12 entries older than 30 days.', {
      details: { removed: 12, retentionDays: 30 },
    });
  });

  test('defaults to 90 days and stays quiet when nothing was removed', async () => {
    const f = fakes(0);
    await pruneLogs(f.store, f.logger, undefined, NOW);
    expect(f.prune).toHaveBeenCalledWith(new Date('2026-07-04T00:00:00.000Z'));
    expect(f.info).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx vitest run src/rbac.test.ts server/validate.test.ts server/logging/retention.test.ts`
Expected: FAIL — `view-logs` false untuk admin; `logRetentionDays` tidak dikenal; `Cannot find module './retention'`.

- [ ] **Step 3: Implementasi**

`src/rbac.ts`: tambahkan anggota baru di union `Action` (setelah `'manage-users'`) dan beri ke admin:

```ts
  | 'manage-users'    // user administration
  | 'view-logs';      // read the application logs
```

```ts
  admin: new Set<Action>(['read', 'simulate', 'mutate-twin', 'apply-change', 'manage-settings', 'manage-users', 'view-logs']),
```

(`'manage-users';` lama menjadi `'manage-users'` tanpa titik koma.)

`src/types.ts`, di `interface SimulationSettings`, tambahkan:

```ts
  logRetentionDays?: number; // days of application logs to keep (server default 90)
```

`server/validate.ts`: tambahkan import

```ts
import { MIN_LOG_RETENTION_DAYS, MAX_LOG_RETENTION_DAYS } from '../src/logTypes';
```

lalu ganti blok `return { maxHops, ... };` di akhir `normalizeSettings` dengan:

```ts
  const rawRetention = o.logRetentionDays;
  const retention = rawRetention === undefined || rawRetention === null || rawRetention === ''
    ? base.logRetentionDays
    : Number(rawRetention);
  if (retention !== undefined && (!Number.isInteger(retention) || retention < MIN_LOG_RETENTION_DAYS || retention > MAX_LOG_RETENTION_DAYS)) {
    fail(`${path}.logRetentionDays`, `must be a whole number of days between ${MIN_LOG_RETENTION_DAYS} and ${MAX_LOG_RETENTION_DAYS}`);
  }
  return {
    maxHops,
    // "false"/"0" from a hand-written snapshot must not read as true.
    implicitDeny: deny === undefined ? base.implicitDeny : !(deny === false || deny === 'false' || deny === 0 || deny === '0' || deny === null || deny === ''),
    ...(retention !== undefined ? { logRetentionDays: retention } : {}),
  };
```

`server/logging/retention.ts`:

```ts
import { LogStore, DEFAULT_LOG_RETENTION_DAYS } from './types';
import { Logger } from './logger';

const DAY_MS = 86_400_000;

// Delete entries older than the retention window; the removal itself is logged.
export async function pruneLogs(store: LogStore, logger: Logger, days: number | undefined, now = new Date()): Promise<number> {
  const keep = days ?? DEFAULT_LOG_RETENTION_DAYS;
  const removed = await store.prune(new Date(now.getTime() - keep * DAY_MS));
  if (removed > 0) {
    logger.info('system', 'system.log.pruned', `Log retention: removed ${removed} entries older than ${keep} days.`, {
      details: { removed, retentionDays: keep },
    });
  }
  return removed;
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `npx vitest run && npx tsc --noEmit`
Expected: semua PASS (termasuk test settings lama `toEqual({ maxHops: 12, implicitDeny: true })`); tsc 0 error.

---

### Task 5: Lapisan HTTP — aktivitas, error handler, API log

**Files:**
- Create: `server/logging/activity.ts`, `server/errorHandler.ts`, `server/logging/routes.ts`
- Test: `server/logging/activity.test.ts`, `server/logging/routes.test.ts`

**Interfaces:**
- Consumes: `Logger`/`createLogger` (Task 2), `FileLogStore` (Task 3), `parseLogQuery` + `logsToCsv` (Task 1), `requireAction`/`AuthedRequest` (`server/auth.ts`), `'view-logs'` (Task 4), `ValidationError`, `TwoFactorError`
- Produces:
  - `ACTIVITY_LABELS: Record<string, string>` (kunci `"METHOD /pola/rute"`), `interface ActivityNote { message?; target?; details? }` (diisi rute lewat `res.locals.activity`), `activityLogger(logger: Logger)` — middleware Express
  - `createErrorHandler(logger: Logger)` — error middleware Express (pengganti `errorHandler` di `server.ts`)
  - `createLogRouter(getStore: () => LogStore | null, now?: () => Date)` — `express.Router` untuk `/api/logs`

- [ ] **Step 1: Tulis test yang gagal**

`server/logging/activity.test.ts`:

```ts
import { describe, test, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { AddressInfo } from 'net';
import { activityLogger, ACTIVITY_LABELS } from './activity';
import { createErrorHandler } from '../errorHandler';
import { requireAction } from '../auth';
import { ValidationError } from '../validate';
import { createLogger } from './logger';
import { LogStore, NewLogEntry } from './types';

function harness() {
  const rows: NewLogEntry[] = [];
  const logger = createLogger({ print: () => {} });
  void logger.attach({
    init: async () => {},
    append: async (batch: NewLogEntry[]) => { rows.push(...batch); },
    query: async () => [],
    summary: async () => { throw new Error('unused'); },
    prune: async () => 0,
  } as unknown as LogStore);

  const app = express();
  app.use(express.json());
  // Test sign-in: the x-user header carries "name:role".
  app.use((req: any, _res, next) => {
    const h = req.headers['x-user'];
    if (typeof h === 'string') {
      const [username, role] = h.split(':');
      req.user = { id: 1, username, role };
    }
    next();
  });
  app.use('/api', activityLogger(logger));
  app.put('/api/twin/nodes/:id', requireAction('mutate-twin'), (_req, res) => { res.json({ ok: true }); });
  app.post('/api/twin/factory-reset', requireAction('manage-settings'), (_req, res) => {
    res.locals.activity = { message: 'Factory reset: deleted 3 devices and 2 links', details: { devices: 3, links: 2 } };
    res.json({ ok: true });
  });
  app.get('/api/twin/topology', (_req, res) => { res.json({}); });
  app.post('/api/auth/logout', (_req, res) => { res.json({}); });
  app.post('/api/twin/parse-config', () => { throw new ValidationError('rawConfig is required'); });
  app.post('/api/boom', (_req, _res, next) => { next(new Error('database exploded')); });
  app.use(createErrorHandler(logger));

  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, p: string, user?: string, body?: string) =>
    fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}) },
      body,
    });
  // Entries are logged when the response finishes; give that a moment, then write.
  const settle = async () => {
    await new Promise(r => setTimeout(r, 30));
    await logger.flush();
  };
  return { rows, call, settle, close: () => new Promise<void>(r => server.close(() => r())) };
}

let h: ReturnType<typeof harness>;
afterEach(async () => {
  await h?.close();
});

describe('activity log', () => {
  test('a change is recorded with its label, target, user, status and duration — never the body', async () => {
    h = harness();
    await h.call('PUT', '/api/twin/nodes/core-1?x=1', 'otto:operator', JSON.stringify({ name: 'Core One' }));
    await h.settle();
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      category: 'activity', level: 'info', event: 'activity.request',
      message: 'Update device "core-1"', actor: 'otto', target: 'core-1',
    });
    expect(h.rows[0].ip).toBeTruthy();
    expect(h.rows[0].details).toMatchObject({ method: 'PUT', path: '/api/twin/nodes/core-1', status: 200 });
    expect(typeof h.rows[0].details!.durationMs).toBe('number');
    expect(JSON.stringify(h.rows[0])).not.toContain('Core One');
  });

  test('a refused change is a warning', async () => {
    h = harness();
    await h.call('PUT', '/api/twin/nodes/core-1', 'vic:viewer', '{}');
    await h.settle();
    expect(h.rows[0]).toMatchObject({ level: 'warn', actor: 'vic', message: 'Update device "core-1" — rejected (HTTP 403)' });
  });

  test('a route can describe its own entry', async () => {
    h = harness();
    await h.call('POST', '/api/twin/factory-reset', 'admin:admin', JSON.stringify({ confirm: 'RESET' }));
    await h.settle();
    expect(h.rows[0]).toMatchObject({
      message: 'Factory reset: deleted 3 devices and 2 links',
      details: { devices: 3, links: 2, status: 200 },
    });
  });

  test('reads, sign-in/out and anonymous requests are not activity', async () => {
    h = harness();
    await h.call('GET', '/api/twin/topology', 'admin:admin');
    await h.call('POST', '/api/auth/logout', 'admin:admin', '{}');
    await h.call('PUT', '/api/twin/nodes/core-1', undefined, '{}');
    await h.settle();
    expect(h.rows).toEqual([]);
  });

  test('every mutating route in server.ts has a label', () => {
    h = harness();
    const src = fs.readFileSync(path.join(process.cwd(), 'server.ts'), 'utf8');
    const routes = [...src.matchAll(/app\.(post|put|patch|delete)\('([^']+)'/g)]
      .map(m => `${m[1].toUpperCase()} ${m[2]}`)
      .filter(r => !r.includes(' /api/auth/'));
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.filter(r => !ACTIVITY_LABELS[r])).toEqual([]);
  });
});

describe('error handler', () => {
  test('a validation error is a 400 and not a server error', async () => {
    h = harness();
    const res = await h.call('POST', '/api/twin/parse-config', 'otto:operator', '{}');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'rawConfig is required' });
    await h.settle();
    expect(h.rows.filter(r => r.category === 'system')).toEqual([]);
  });

  test('malformed JSON is a 400 with a clear message', async () => {
    h = harness();
    const res = await h.call('POST', '/api/twin/parse-config', 'otto:operator', '{"broken":');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Malformed JSON request body' });
  });

  test('an unexpected error is a 500 for the client and a system error with stack in the log', async () => {
    h = harness();
    const res = await h.call('POST', '/api/boom?token=abc', 'admin:admin', '{}');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    await h.settle();
    const sys = h.rows.find(r => r.category === 'system')!;
    expect(sys).toMatchObject({ level: 'error', event: 'system.error', actor: 'admin', message: 'Server error on POST /api/boom: database exploded' });
    expect(String(sys.details!.stack)).toContain('database exploded');
    expect(JSON.stringify(sys)).not.toContain('token=abc');
    expect(h.rows.find(r => r.category === 'activity')).toMatchObject({ level: 'error', message: 'POST /api/boom — rejected (HTTP 500)' });
  });
});
```

`server/logging/routes.test.ts`:

```ts
import { describe, test, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { createLogRouter } from './routes';
import { createErrorHandler } from '../errorHandler';
import { createLogger } from './logger';
import { FileLogStore } from './fileStore';
import { LogStore, NewLogEntry } from './types';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const e = (ts: string, over: Partial<NewLogEntry> = {}): NewLogEntry => ({
  ts, category: 'activity', level: 'info', event: 'activity.request', message: 'Update device "r1"',
  actor: 'admin', ip: '10.0.0.1', target: 'r1', details: null, ...over,
});

async function harness(ready = true) {
  const store = new FileLogStore(fs.mkdtempSync(path.join(os.tmpdir(), 'nettwin-logapi-')));
  await store.init();
  await store.append([
    e('2026-10-02T09:00:00.000Z', { category: 'auth', level: 'warn', event: 'auth.login.failed', message: 'Login failed for "bob": wrong password', actor: null }),
    e('2026-10-02T10:00:00.000Z'),
    e('2026-10-02T11:00:00.000Z', { category: 'system', level: 'error', event: 'system.error', message: 'Server error, retrying', actor: null }),
  ]);
  const app = express();
  app.use((req: any, _res, next) => {
    const role = req.headers['x-role'];
    if (typeof role === 'string') req.user = { id: 1, username: 'u', role };
    next();
  });
  app.use('/api/logs', createLogRouter(() => (ready ? (store as LogStore) : null), () => NOW));
  app.use(createErrorHandler(createLogger({ print: () => {} })));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (p: string, role: string | null = 'admin') => fetch(base + p, { headers: role ? { 'x-role': role } : {} });
  return { get, close: () => new Promise<void>(r => server.close(() => r())) };
}

let h: Awaited<ReturnType<typeof harness>>;
afterEach(async () => {
  await h?.close();
});

describe('GET /api/logs', () => {
  test('admins only', async () => {
    h = await harness();
    expect((await h.get('/api/logs', null)).status).toBe(401);
    expect((await h.get('/api/logs', 'operator')).status).toBe(403);
    expect((await h.get('/api/logs', 'viewer')).status).toBe(403);
    expect((await h.get('/api/logs')).status).toBe(200);
  });

  test('newest first, filtered, with a cursor for the next page', async () => {
    h = await harness();
    const page1 = await (await h.get('/api/logs?limit=2')).json();
    expect(page1.entries.map((x: any) => x.id)).toEqual([3, 2]);
    expect(page1.nextBefore).toBe(2);
    const page2 = await (await h.get(`/api/logs?limit=2&before=${page1.nextBefore}`)).json();
    expect(page2.entries.map((x: any) => x.id)).toEqual([1]);
    expect(page2.nextBefore).toBeNull();
    const auth = await (await h.get('/api/logs?category=auth&q=WRONG')).json();
    expect(auth.entries.map((x: any) => x.event)).toEqual(['auth.login.failed']);
  });

  test('a bad filter is a 400 with the reason', async () => {
    h = await harness();
    const res = await h.get('/api/logs?category=kernel');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/category must be one of/);
  });

  test('503 while the log store is not ready yet', async () => {
    h = await harness(false);
    expect((await h.get('/api/logs')).status).toBe(503);
  });
});

describe('GET /api/logs/summary and /export', () => {
  test('summary: counts per category and level, plus errors of the last 24 h', async () => {
    h = await harness();
    const s = await (await h.get('/api/logs/summary')).json();
    expect(s).toEqual({
      total: 3,
      byCategory: { auth: 1, activity: 1, system: 1, ssh: 0, backup: 0 },
      byLevel: { info: 1, warn: 1, error: 1 },
      errorsLast24h: 1,
    });
  });

  test('export: a CSV attachment of the filtered entries, Excel-friendly UTF-8', async () => {
    h = await harness();
    const res = await h.get('/api/logs/export?level=error,warn');
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="nettwin-logs-202610021200.csv"');
    const text = await res.text();
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('time,level,category,event,user,ip,target,message,details');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Server error, retrying"');
  });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx vitest run server/logging/activity.test.ts server/logging/routes.test.ts`
Expected: FAIL — `Cannot find module './activity'`, `'../errorHandler'`, `'./routes'`.

- [ ] **Step 3: Implementasi**

`server/logging/activity.ts`:

```ts
import { Response, NextFunction } from 'express';
import { AuthedRequest } from '../auth';
import { Logger } from './logger';
import { LogLevel } from './types';

// Friendly names for what users do, keyed by "METHOD route-pattern".
// A test checks that every mutating route in server.ts has one.
export const ACTIVITY_LABELS: Record<string, string> = {
  'POST /api/users': 'Create user',
  'PUT /api/users/:id': 'Update user',
  'DELETE /api/users/:id': 'Delete user',
  'DELETE /api/users/:id/2fa': 'Reset two-factor authentication of user',
  'POST /api/twin/simulate': 'Run path simulation',
  'POST /api/twin/nodes': 'Create device',
  'PUT /api/twin/nodes/:id': 'Update device',
  'DELETE /api/twin/nodes/:id': 'Delete device',
  'POST /api/twin/links': 'Save link',
  'DELETE /api/twin/links/:id': 'Delete link',
  'POST /api/twin/audits/run': 'Run all compliance audits',
  'POST /api/twin/audits': 'Save compliance audit',
  'DELETE /api/twin/audits/:id': 'Delete compliance audit',
  'POST /api/twin/changes': 'Save change request',
  'POST /api/twin/changes/:id/apply': 'Apply change request',
  'POST /api/twin/ipam/reservations': 'Reserve IP address',
  'DELETE /api/twin/ipam/reservations/:id': 'Release IP reservation',
  'POST /api/twin/ssh/connections': 'Create SSH connection',
  'PUT /api/twin/ssh/connections/:id': 'Update SSH connection',
  'DELETE /api/twin/ssh/connections/:id': 'Delete SSH connection',
  'POST /api/twin/ssh/connections/:id/collect': 'Run SSH collect',
  'PUT /api/twin/settings': 'Update settings',
  'POST /api/twin/reset': 'Revert twin to certified state',
  'POST /api/twin/factory-reset': 'Factory reset',
  'POST /api/twin/import': 'Import twin snapshot',
  'POST /api/twin/parse-config': 'Parse configuration',
  'POST /api/twin/parser-profiles/test': 'Test parser profile',
  'POST /api/twin/parser-profiles': 'Save parser profile',
  'DELETE /api/twin/parser-profiles/:id': 'Delete parser profile',
  'POST /api/twin/parser-profiles/reset': 'Reset built-in parser profiles',
};

// What a route handler can add to its own activity entry, via res.locals.activity.
export interface ActivityNote {
  message?: string;
  target?: string;
  details?: Record<string, unknown>;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const levelFor = (status: number): LogLevel => (status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info');

// Records every request of a signed-in user that changes something. Mount on
// /api after authentication. Sign-in/out and 2FA are logged by the auth routes;
// anonymous requests are not logged, so strangers can't flood the log.
export function activityLogger(logger: Logger) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const path = req.originalUrl.split('?')[0];
    if (!MUTATING.has(req.method) || path.startsWith('/api/auth/')) return next();
    const started = Date.now();
    res.on('finish', () => {
      if (!req.user) return;
      const pattern = req.route?.path ? String(req.route.path) : null;
      const label = (pattern && ACTIVITY_LABELS[`${req.method} ${pattern}`]) || `${req.method} ${pattern ?? path}`;
      const note: ActivityNote = res.locals.activity ?? {};
      const target = note.target ?? (typeof req.params?.id === 'string' ? req.params.id : undefined);
      const status = res.statusCode;
      const outcome = status >= 400 ? ` — rejected (HTTP ${status})` : '';
      logger.log({
        category: 'activity',
        level: levelFor(status),
        event: 'activity.request',
        message: `${note.message ?? `${label}${target ? ` "${target}"` : ''}`}${outcome}`,
        actor: req.user.username,
        ip: req.ip ?? null,
        target: target ?? null,
        details: { method: req.method, path, status, durationMs: Date.now() - started, ...(note.details ?? {}) },
      });
    });
    next();
  };
}
```

`server/errorHandler.ts`:

```ts
import { Request, Response, NextFunction } from 'express';
import { ValidationError } from './validate';
import { TwoFactorError } from './twoFactor';
import { AuthedRequest } from './auth';
import { Logger } from './logging/logger';

// Errors thrown by handlers become JSON responses. Validation and client
// errors are answered as such; anything else is a 500 whose details (with
// stack trace) go to the log, never to the client.
export function createErrorHandler(logger: Logger) {
  return (err: any, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err instanceof TwoFactorError) return res.status(err.status).json({ error: err.message });
    const status = err?.status || err?.statusCode;
    if (status >= 400 && status < 500) {
      const message = err.type === 'entity.parse.failed' ? 'Malformed JSON request body' : (err.expose ? err.message : 'Bad request');
      return res.status(status).json({ error: message });
    }
    const path = req.originalUrl.split('?')[0];
    const reason = err?.message ? String(err.message) : String(err);
    logger.error('system', 'system.error', `Server error on ${req.method} ${path}: ${reason}`, {
      actor: (req as AuthedRequest).user?.username ?? null,
      ip: req.ip ?? null,
      details: { method: req.method, path, error: reason, stack: typeof err?.stack === 'string' ? err.stack : undefined },
    });
    res.status(500).json({ error: 'Internal server error' });
  };
}
```

`server/logging/routes.ts`:

```ts
import express, { Response, NextFunction } from 'express';
import { requireAction, AuthedRequest } from '../auth';
import { parseLogQuery } from './query';
import { logsToCsv } from './csv';
import { LogEntry, LogStore, MAX_EXPORT_ROWS } from './types';

type Handler = (req: AuthedRequest, res: Response, store: LogStore) => Promise<void>;

// GET /api/logs, /api/logs/summary and /api/logs/export — admins only.
export function createLogRouter(getStore: () => LogStore | null, now: () => Date = () => new Date()) {
  const router = express.Router();
  router.use(requireAction('view-logs'));

  const route = (fn: Handler) => (req: AuthedRequest, res: Response, next: NextFunction) => {
    const store = getStore();
    if (!store) {
      res.status(503).json({ error: 'Logs are not available yet; the server is still starting.' });
      return;
    }
    fn(req, res, store).catch(next);
  };

  router.get('/', route(async (req, res, store) => {
    const q = parseLogQuery(req.query as Record<string, unknown>);
    const entries = await store.query(q);
    res.json({ entries, nextBefore: entries.length === q.limit ? entries[entries.length - 1].id : null });
  }));

  router.get('/summary', route(async (req, res, store) => {
    res.json(await store.summary(parseLogQuery(req.query as Record<string, unknown>), now()));
  }));

  router.get('/export', route(async (req, res, store) => {
    const q = parseLogQuery(req.query as Record<string, unknown>);
    const rows: LogEntry[] = [];
    let before = q.before;
    while (rows.length < MAX_EXPORT_ROWS) {
      const limit = Math.min(1000, MAX_EXPORT_ROWS - rows.length);
      const page = await store.query({ ...q, before, limit });
      rows.push(...page);
      if (page.length < limit) break;
      before = page[page.length - 1].id;
    }
    const stamp = now().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nettwin-logs-${stamp}.csv"`);
    // The BOM makes Excel read the file as UTF-8.
    res.send(`\uFEFF${logsToCsv(rows)}`);
  }));

  return router;
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `npx vitest run server/logging && npx tsc --noEmit`
Expected: PASS; tsc 0 error.

---

### Task 6: Menyambungkan ke `server.ts`

**Files:**
- Modify: `server.ts`
- Test: skrip smoke HTTP `logs-smoke.sh` (di luar repo, scratchpad), plus regresi `smoke.sh` dan `2fa-smoke.sh`

**Interfaces:**
- Consumes: `createLogger`/`Logger` (Task 2); `storage.logStore()`, `StorageInitHooks` (Task 3); `pruneLogs` (Task 4); `activityLogger`, `createErrorHandler`, `createLogRouter`, `ActivityNote` (Task 5)
- Produces: event yang tercatat (dipakai UI & smoke):
  - `auth`: `auth.login.success`, `auth.login.failed` (`details.reason`: `wrong password` · `unknown user`), `auth.login.blocked` (sekali per IP saat mencapai batas), `auth.2fa.failed`, `auth.2fa.expired`, `auth.2fa.blocked`, `auth.2fa.enabled`, `auth.2fa.disabled`, `auth.2fa.reset`, `auth.2fa.recovery_used`, `auth.logout`
  - `system`: `system.start`, `system.stop`, `system.storage.retry`, `system.config`, `system.save.failed`, `system.save.recovered`, `system.error`, `system.crash`, `system.log.dropped`, `system.log.pruned`, `system.log.prune_failed`
  - `ssh`: `ssh.collect.started`, `ssh.collect.succeeded`, `ssh.collect.failed`, `ssh.hostkey.pinned`, `ssh.hostkey.repinned`, `ssh.hostkey.mismatch`
  - `activity`: `activity.request`

- [ ] **Step 1: Tulis smoke test** — simpan di scratchpad sebagai `logs-smoke.sh`, jalankan dari root repo

```bash
#!/usr/bin/env bash
# Log Center end-to-end over HTTP against the production bundle. Run from the repo root.
set -u
PROJ="$(pwd)"; WORK="$(mktemp -d)"; PORT=3994; BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1"; else FAIL=$((FAIL+1)); echo "  FAIL  $1 (got: $2)"; fi; }
code(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }
json(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)'"$1"';console.log(typeof v==="object"?JSON.stringify(v):v)})'; }
login(){ curl -s -c "$3" -X POST -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}" $BASE/api/auth/login; }
J='Content-Type: application/json'
start(){
  NODE_ENV=production JWT_SECRET=3f9c1a7be2d04c55a1e8b6d7c9f0a2b4 ADMIN_PASSWORD='Adm1n-pass!' PORT=$PORT \
  CRED_KEY=0123456789abcdef0123 COLLECTOR_URL=http://127.0.0.1:9 COLLECTOR_TOKEN=collector-token-123456 \
  node "$PROJ/dist-server/server.cjs" >> server.log 2>&1 &
  SRV=$!; for i in $(seq 1 40); do curl -s $BASE/api/health >/dev/null && break; sleep 0.5; done
}
logs(){ curl -s -b admin.jar "$BASE/api/logs?$1"; }
settle(){ sleep 1.5; }

cp -r "$PROJ/dist" "$WORK/dist"; cd "$WORK"; start
login admin 'Adm1n-pass!' admin.jar >/dev/null; A="-b admin.jar -c admin.jar"
login admin 'nope-nope' x.jar >/dev/null
login ghost 'whatever1' x.jar >/dev/null
curl -s $A -X POST -H "$J" -d '{"username":"otto","password":"otto-pass-1","role":"operator"}' $BASE/api/users >/dev/null
curl -s $A -X POST -H "$J" -d '{"username":"vic","password":"vic-pass-1","role":"viewer"}' $BASE/api/users >/dev/null
login otto otto-pass-1 o.jar >/dev/null; O="-b o.jar -c o.jar"
login vic vic-pass-1 v.jar >/dev/null; V="-b v.jar -c v.jar"
NODE='{"id":"lab-r1","name":"Lab R1","type":"router","vrfs":[{"name":"default","description":"","interfaces":[],"routes":[]}]}'
curl -s $O -X POST -H "$J" -d "$NODE" $BASE/api/twin/nodes >/dev/null
curl -s $O -X PUT -H "$J" -d '{"name":"Lab R1b"}' $BASE/api/twin/nodes/lab-r1 >/dev/null
curl -s $V -X DELETE $BASE/api/twin/nodes/lab-r1 >/dev/null
curl -s $O -X DELETE $BASE/api/twin/nodes/lab-r1 >/dev/null
CONN=$(curl -s $A -X POST -H "$J" -d '{"name":"edge","host":"192.0.2.1","port":22,"username":"netops","password":"ssh-secret-1","vendor":"cisco_ios"}' $BASE/api/twin/ssh/connections | json '.connection.id')
curl -s $A -X POST -H "$J" -d '{}' $BASE/api/twin/ssh/connections/$CONN/collect >/dev/null
curl -s $O -X POST $BASE/api/auth/logout >/dev/null
settle

echo "== auth"
AUTH=$(logs 'category=auth&limit=50')
check "login success logged" "$(echo "$AUTH" | json '.entries.some(e=>e.event==="auth.login.success"&&e.actor==="admin")')" true
check "wrong password logged with reason" "$(echo "$AUTH" | json '.entries.some(e=>e.event==="auth.login.failed"&&e.target==="admin"&&e.details.reason==="wrong password")')" true
check "unknown user logged with reason" "$(echo "$AUTH" | json '.entries.some(e=>e.event==="auth.login.failed"&&e.target==="ghost"&&e.details.reason==="unknown user")')" true
check "logout logged" "$(echo "$AUTH" | json '.entries.some(e=>e.event==="auth.logout"&&e.actor==="otto")')" true

echo "== activity"
ACT=$(logs 'category=activity&actor=otto&limit=50')
check "create device" "$(echo "$ACT" | json '.entries.some(e=>e.message==="Create device \"lab-r1\""&&e.target==="lab-r1")')" true
check "update device" "$(echo "$ACT" | json '.entries.some(e=>e.message==="Update device \"lab-r1\"")')" true
check "delete device" "$(echo "$ACT" | json '.entries.some(e=>e.message==="Delete device \"lab-r1\"")')" true
check "refused change is a warning" "$(logs 'category=activity&level=warn&actor=vic' | json '.entries.some(e=>/rejected \(HTTP 403\)/.test(e.message))')" true
check "user creation names the user" "$(logs 'category=activity&actor=admin&q=otto' | json '.entries.some(e=>e.message==="Create user \"otto\" (operator)")')" true

echo "== ssh + system"
check "failed SSH collect is an error" "$(logs 'category=ssh&level=error' | json '.entries.some(e=>e.event==="ssh.collect.failed"&&e.target==="edge")')" true
check "SSH collect start logged" "$(logs 'category=ssh' | json '.entries.some(e=>e.event==="ssh.collect.started")')" true
check "server start logged" "$(logs 'category=system' | json '.entries.some(e=>e.event==="system.start")')" true

echo "== API"
check "paging cursor" "$(logs 'limit=2' | json '.nextBefore!==null&&true')" true
P1=$(logs 'limit=2'); NB=$(echo "$P1" | json '.nextBefore')
check "second page continues below the cursor" "$(logs "limit=2&before=$NB" | json ".entries.every(e=>e.id<$NB)")" true
check "bad filter -> 400" "$(code -b admin.jar "$BASE/api/logs?category=kernel")" 400
check "operator -> 403" "$(code -b o.jar $BASE/api/logs)" 403
check "viewer -> 403" "$(code -b v.jar $BASE/api/logs)" 403
SUM=$(curl -s -b admin.jar $BASE/api/logs/summary)
check "summary counts errors of the last 24h" "$(echo "$SUM" | json '.errorsLast24h>=1')" true
check "summary counts auth entries" "$(echo "$SUM" | json '.byCategory.auth>=4')" true
check "export is CSV" "$(curl -s -o /dev/null -w '%{content_type}' -b admin.jar "$BASE/api/logs/export?category=auth" | cut -d';' -f1)" text/csv

echo "== retention setting survives revert/import"
check "set retention 30" "$(code $A -X PUT -H "$J" -d '{"maxHops":10,"implicitDeny":true,"logRetentionDays":30}' $BASE/api/twin/settings)" 200
check "retention 3 refused" "$(code $A -X PUT -H "$J" -d '{"logRetentionDays":3}' $BASE/api/twin/settings)" 400
curl -s $A -X POST $BASE/api/twin/reset >/dev/null
check "revert keeps retention" "$(curl -s -b admin.jar $BASE/api/twin/settings | json '.logRetentionDays')" 30
SNAP=$(curl -s -b admin.jar $BASE/api/twin/export | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);v.settings.logRetentionDays=365;console.log(JSON.stringify(v))})')
curl -s $A -X POST -H "$J" -d "$SNAP" $BASE/api/twin/import >/dev/null
check "import keeps retention" "$(curl -s -b admin.jar $BASE/api/twin/settings | json '.logRetentionDays')" 30
curl -s $A -X POST -H "$J" -d '{"confirm":"RESET"}' $BASE/api/twin/factory-reset >/dev/null
settle
check "factory reset is described" "$(logs 'category=activity&q=factory' | json '.entries.some(e=>/^Factory reset: deleted \d+ devices/.test(e.message))')" true
check "logs survive the factory reset" "$(logs 'category=auth' | json '.entries.length>0')" true

echo "== throttle is logged once per IP"
for i in $(seq 1 14); do login admin 'nope-nope' x.jar >/dev/null; done
settle
check "one 'blocked' entry" "$(logs 'category=auth&q=blocked' | json '.entries.filter(e=>e.event==="auth.login.blocked").length')" 1

echo "== secrets and storage"
check "log files exist" "$(ls data/logs | grep -c '^app-.*\.jsonl$' | awk '{print ($1>=1)?"yes":"no"}')" yes
check "no passwords in the log files" "$(cat data/logs/*.jsonl | grep -c -e 'Adm1n-pass!' -e 'otto-pass-1' -e 'ssh-secret-1' -e 'nope-nope')" 0
check "entries also go to stdout" "$(grep -c '\[WARN\] \[auth\] Sign-in failed' server.log | awk '{print ($1>0)?"yes":"no"}')" yes

echo "== shutdown flushes the log"
kill -TERM $SRV; wait $SRV 2>/dev/null
check "stop event written" "$(cat data/logs/*.jsonl | grep -c '"event":"system.stop"')" 1

echo; echo "RESULT: $PASS passed, $FAIL failed"
cd / && rm -rf "$WORK"
```

- [ ] **Step 2: Jalankan pada build sebelum perubahan, pastikan gagal**

Run: `npm run build && bash "<scratchpad>/logs-smoke.sh"`
Expected: banyak FAIL (mis. `GET /api/logs` → 404), `RESULT: … failed` > 0.

- [ ] **Step 3: Implementasi di `server.ts`**

Semua perubahan memakai penanda teks (bukan nomor baris).

**3a. Import** — tambahkan setelah import `./server/throttle`:

```ts
import fs from 'fs';
import { createLogger } from './server/logging/logger';
import { activityLogger, ActivityNote } from './server/logging/activity';
import { createLogRouter } from './server/logging/routes';
import { pruneLogs } from './server/logging/retention';
import { LogStore } from './server/logging/types';
import { createErrorHandler } from './server/errorHandler';
```

Di import `./server/collector`, `collectorConfigured` sudah ada; pastikan tetap diimpor.

**3b. Logger** — tepat setelah `const storage = createStorage();` tambahkan:

```ts
// Application log: printed to stdout and stored (in batches) once storage is up.
const logger = createLogger();
let logStore: LogStore | null = null;
const clientIp = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
```

**3c. Penyimpan dengan log gagal/pulih** — ganti tiga blok `createSaveQueue(...)` (stateSaver, connectionSaver, profileSaver) dengan:

```ts
// A save queue whose first failure and later recovery are logged (not every retry).
function loggedSaveQueue(what: string, save: () => Promise<void>) {
  let failing = false;
  return createSaveQueue(
    async () => {
      await save();
      if (failing) {
        failing = false;
        logger.info('system', 'system.save.recovered', `Saving ${what} works again; all changes are stored.`);
      }
    },
    err => {
      if (failing) return;
      failing = true;
      logger.error('system', 'system.save.failed', `Saving ${what} failed; retrying in the background: ${errorText(err)}`, {
        details: { error: errorText(err), stack: err instanceof Error ? err.stack : undefined },
      });
    }
  );
}
const stateSaver = loggedSaveQueue('the twin', () => storage.saveState({ nodes, links, audits, changeRequests, settings, ipReservations }));
const connectionSaver = loggedSaveQueue('SSH connections', () => storage.saveConnections(deviceConnections));
const profileSaver = loggedSaveQueue('parser profiles', () => storage.saveProfiles(parserProfiles));
```

**3d. Middleware aktivitas & router log** — tepat setelah `app.use('/api', authenticate(storage));` tambahkan:

```ts
app.use('/api', activityLogger(logger));
app.use('/api/logs', createLogRouter(() => logStore));
```

**3e. Throttle login dicatat sekali** — ganti fungsi `noteLoginFailure` dengan:

```ts
function noteLoginFailure(ip: string) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else rec.count++;
  // Logged once, when the IP hits the limit — not for every blocked attempt.
  if (loginAttempts.get(ip)!.count === LOGIN_MAX) {
    logger.warn('auth', 'auth.login.blocked', `Sign-in blocked for ${LOGIN_WINDOW_MS / 60000} minutes after ${LOGIN_MAX} failed attempts`, { ip });
  }
}
```

**3f. Login** — di rute `POST /api/auth/login`, ganti

```ts
  if (!(await verifyLogin(user, password)) || !user) {
    noteLoginFailure(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
```

dengan

```ts
  if (!(await verifyLogin(user, password)) || !user) {
    const reason = user ? 'wrong password' : 'unknown user';
    logger.warn('auth', 'auth.login.failed', `Sign-in failed for "${username.trim().slice(0, 64)}": ${reason}`, {
      ip, target: username.trim().slice(0, 64), details: { reason },
    });
    noteLoginFailure(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
```

dan ganti

```ts
  loginAttempts.delete(ip);
  res.cookie(AUTH_COOKIE, signToken(user), authCookieOptions(req));
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
}));
```

(yang di rute `/api/auth/login`, bukan `/login/2fa`) dengan

```ts
  loginAttempts.delete(ip);
  logger.info('auth', 'auth.login.success', `Signed in: ${user.username}`, { actor: user.username, ip, details: { method: 'password' } });
  res.cookie(AUTH_COOKIE, signToken(user), authCookieOptions(req));
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
}));
```

**3g. Logout** — ganti rute logout dengan:

```ts
app.post('/api/auth/logout', (req: AuthedRequest, res) => {
  if (req.user) logger.info('auth', 'auth.logout', `Signed out: ${req.user.username}`, { actor: req.user.username, ip: clientIp(req) });
  clearAuthCookie(req, res);
  res.json({ success: true });
});
```

**3h. Langkah kode 2FA** — di `POST /api/auth/login/2fa`:
- ganti `if (!user) return res.status(401).json({ error: 'Sign-in expired. Enter your password again.', restart: true });` dengan

```ts
  if (!user) {
    logger.warn('auth', 'auth.2fa.expired', 'Two-factor sign-in expired or invalid; asked to enter the password again', { ip });
    return res.status(401).json({ error: 'Sign-in expired. Enter your password again.', restart: true });
  }
```

- ganti `if (twoFactorFailures.blocked(user.id)) return res.status(429).json({ error: TOO_MANY_CODES });` (yang pertama, di rute ini) dengan

```ts
  if (twoFactorFailures.blocked(user.id)) {
    logger.warn('auth', 'auth.2fa.blocked', `Two-factor code refused for "${user.username}": too many wrong codes`, { ip, target: user.username });
    return res.status(429).json({ error: TOO_MANY_CODES });
  }
```

- ganti

```ts
  if (!result.ok) {
    noteLoginFailure(ip);
    twoFactorFailures.fail(user.id);
```

dengan

```ts
  if (!result.ok) {
    logger.warn('auth', 'auth.2fa.failed', `Wrong two-factor code for "${user.username}"`, {
      ip, target: user.username, details: { reason: result.unreadableSecret ? 'secret unreadable (server key changed)' : 'invalid code' },
    });
    noteLoginFailure(ip);
    twoFactorFailures.fail(user.id);
```

- ganti

```ts
  if (result.usedRecoveryCode) {
    console.log(`[AUDIT] 2FA recovery code used by "${user.username}" (${result.recoveryCodesLeft} left)`);
  }
```

dengan

```ts
  if (result.usedRecoveryCode) {
    logger.warn('auth', 'auth.2fa.recovery_used', `Recovery code used by "${user.username}" (${result.recoveryCodesLeft} left)`, {
      actor: user.username, ip, details: { recoveryCodesLeft: result.recoveryCodesLeft },
    });
  }
  logger.info('auth', 'auth.login.success', `Signed in: ${user.username}`, {
    actor: user.username, ip, details: { method: result.usedRecoveryCode ? 'recovery code' : 'authenticator' },
  });
```

**3i. Event 2FA lain** — ganti tiga baris `console.log` berikut:
- `  console.log(`[AUDIT] 2FA enabled by "${req.user!.username}"`);` → `  logger.info('auth', 'auth.2fa.enabled', `Two-factor authentication turned on by "${req.user!.username}"`, { actor: req.user!.username, ip: clientIp(req) });`
- `  console.log(`[AUDIT] 2FA disabled by "${user.username}"`);` → `  logger.info('auth', 'auth.2fa.disabled', `Two-factor authentication turned off by "${user.username}"`, { actor: user.username, ip: clientIp(req) });`
- `  console.log(`[AUDIT] 2FA reset for "${target.username}" by "${req.user!.username}"`);` → `  logger.warn('auth', 'auth.2fa.reset', `Two-factor authentication of "${target.username}" reset by "${req.user!.username}"`, { actor: req.user!.username, ip: clientIp(req), target: target.username });`

**3j. Pesan aktivitas yang lebih jelas** (`res.locals.activity`):
- `POST /api/users`: ganti `res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });` dengan

```ts
    res.locals.activity = { message: `Create user "${user.username}" (${user.role})`, target: user.username } satisfies ActivityNote;
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
```

- `PUT /api/users/:id`: tepat sebelum `  // A password change invalidates existing sessions; keep the admin who changed` tambahkan

```ts
  const changes = [
    role !== undefined && role !== target.role ? `role ${target.role} → ${role}` : null,
    password !== undefined ? 'password changed' : null,
  ].filter(Boolean).join(', ');
  res.locals.activity = { message: `Update user "${target.username}"${changes ? `: ${changes}` : ''}`, target: target.username } satisfies ActivityNote;
```

- `DELETE /api/users/:id`: ganti `  await storage.deleteUser(id);\n  res.json({ success: true });\n}));` dengan

```ts
  await storage.deleteUser(id);
  res.locals.activity = { message: `Delete user "${target.username}" (${target.role})`, target: target.username } satisfies ActivityNote;
  res.json({ success: true });
}));
```

- `DELETE /api/users/:id/2fa`: ganti `  await twoFactor.reset(id);` dengan

```ts
  await twoFactor.reset(id);
  res.locals.activity = { message: `Reset two-factor authentication of "${target.username}"`, target: target.username } satisfies ActivityNote;
```

- `POST /api/twin/nodes`: ganti `  newNode.rev = nextRev(maxRev());` dengan

```ts
  newNode.rev = nextRev(maxRev());
  res.locals.activity = { target: newNode.id } satisfies ActivityNote;
```

- `POST /api/twin/links`: ganti `  const newLink = normalizeLink(req.body);` dengan

```ts
  const newLink = normalizeLink(req.body);
  res.locals.activity = { target: newLink.id } satisfies ActivityNote;
```

- `POST /api/twin/changes/:id/apply`: ganti `  runAllAudits();\n  saveState();\n\n  res.json({ success: true, changeRequest: cr, audits });` dengan

```ts
  runAllAudits();
  saveState();
  res.locals.activity = {
    message: `Apply change request "${cr.title}" to "${nodes[fwNodeIdx].name}" (${cr.proposedRules.length} rules)`,
    target: cr.id,
  } satisfies ActivityNote;
  res.json({ success: true, changeRequest: cr, audits });
```

- `POST /api/twin/reset`: ganti `  settings = { ...DEFAULT_SETTINGS };` dengan

```ts
  // Log retention is not twin data: a revert keeps it.
  settings = { ...DEFAULT_SETTINGS, ...(settings.logRetentionDays !== undefined ? { logRetentionDays: settings.logRetentionDays } : {}) };
  res.locals.activity = { message: 'Revert twin to certified (seed) state' } satisfies ActivityNote;
```

- `POST /api/twin/factory-reset`: ganti

```ts
  nodes = [];
  links = [];
  audits = [];
  changeRequests = [];
  ipReservations = [];
  saveState();
  console.log(`[AUDIT] Factory reset by "${req.user?.username}"`);
```

dengan

```ts
  const removed = { devices: nodes.length, links: links.length, audits: audits.length, changeRequests: changeRequests.length, ipReservations: ipReservations.length };
  nodes = [];
  links = [];
  audits = [];
  changeRequests = [];
  ipReservations = [];
  saveState();
  res.locals.activity = {
    message: `Factory reset: deleted ${removed.devices} devices, ${removed.links} links, ${removed.audits} audits, ${removed.changeRequests} change requests and ${removed.ipReservations} IP reservations`,
    details: removed,
  } satisfies ActivityNote;
```

- `POST /api/twin/import`: ganti `    settings: body.settings ? normalizeSettings(body.settings, DEFAULT_SETTINGS) : settings,` dengan

```ts
    // Log retention belongs to this server, not to the snapshot.
    settings: {
      ...(body.settings ? normalizeSettings(body.settings, DEFAULT_SETTINGS) : settings),
      ...(settings.logRetentionDays !== undefined ? { logRetentionDays: settings.logRetentionDays } : {}),
    },
```

dan ganti `  ({ nodes, links, audits, changeRequests, ipReservations, settings } = snapshot);` dengan

```ts
  ({ nodes, links, audits, changeRequests, ipReservations, settings } = snapshot);
  res.locals.activity = {
    message: `Import twin snapshot (${nodes.length} devices, ${links.length} links)`,
    details: { devices: nodes.length, links: links.length },
  } satisfies ActivityNote;
```

Jika setelah import `settings.logRetentionDays` bernilai `undefined` sebagai properti eksplisit, tidak masalah (diabaikan saat JSON).

**3k. SSH collect** — di `POST /api/twin/ssh/connections/:id/collect`:
- ganti baris `console.log(`[AUDIT] SSH collect by ...`);` dengan

```ts
  const sshCtx = { actor: req.user?.username ?? null, ip: clientIp(req), target: conn.name };
  logger.info('ssh', 'ssh.collect.started', `SSH collect started: ${conn.name} (${conn.host}), intents ${intents.join(', ')}${repin ? ', re-pinning host key' : ''}`, {
    ...sshCtx, details: { host: conn.host, vendor: conn.vendor, intents, repin },
  });
  const started = Date.now();
```

- ganti

```ts
  if (!outcome.ok) {
    persistConnections();
```

dengan

```ts
  if (!outcome.ok) {
    persistConnections();
    if (outcome.hostKeyMismatch) {
      logger.error('ssh', 'ssh.hostkey.mismatch', `SSH host key of ${conn.name} (${conn.host}) does not match the pinned key — possible man-in-the-middle; collect refused`, {
        ...sshCtx, details: { host: conn.host, expectedFingerprint: conn.hostKeyFingerprint },
      });
    } else {
      logger.error('ssh', 'ssh.collect.failed', `SSH collect failed: ${conn.name} (${conn.host}): ${outcome.error}`, {
        ...sshCtx, details: { host: conn.host, error: outcome.error, durationMs: Date.now() - started },
      });
    }
```

- ganti

```ts
  if (outcome.hostKey && (!conn.hostKey || repin)) {
    conn.hostKey = outcome.hostKey;
```

dengan

```ts
  if (outcome.hostKey && (!conn.hostKey || repin)) {
    logger[repin ? 'warn' : 'info']('ssh', repin ? 'ssh.hostkey.repinned' : 'ssh.hostkey.pinned',
      `SSH host key ${repin ? 're-pinned' : 'pinned'} for ${conn.name}: ${outcome.fingerprint}`, { ...sshCtx, details: { fingerprint: outcome.fingerprint } });
    conn.hostKey = outcome.hostKey;
```

- ganti

```ts
  const drift = computeDrift(outcome.data!, target);
```

dengan

```ts
  const drift = computeDrift(outcome.data!, target);
  logger.info('ssh', 'ssh.collect.succeeded', `SSH collect succeeded: ${conn.name} — ${drift.summary}`, {
    ...sshCtx, details: { durationMs: Date.now() - started, targetNode: target?.id ?? null },
  });
```

**3l. Error handler** — hapus seluruh fungsi `function errorHandler(...) { ... }` dari `server.ts` dan di `startServer` ganti `  app.use(errorHandler);` dengan `  app.use(createErrorHandler(logger));`. Import `ValidationError`/`TwoFactorError` tetap dipakai rute lain; biarkan.

**3m. Startup, retensi, shutdown** — di `startServer`:
- ganti `  await storage.init();` dengan

```ts
  await storage.init({
    onRetry: (attempt, max, err) =>
      logger.warn('system', 'system.storage.retry', `MySQL not ready (attempt ${attempt}/${max}), retrying in 2s: ${errorText(err)}`),
  });
  logStore = storage.logStore();
  await logStore.init();
  await logger.attach(logStore);
```

- ganti blok peringatan CRED_KEY

```ts
  if (!credKeyConfigured()) {
    console.warn('WARNING: CRED_KEY is not set to a strong value — SSH Sync cannot store device credentials. Set CRED_KEY (16+ random chars) to enable it.');
  }
```

dengan

```ts
  if (!process.env.JWT_SECRET) {
    logger.warn('system', 'system.config', 'JWT_SECRET is not set — using an insecure development secret. Set JWT_SECRET in production.');
  }
  if (!credKeyConfigured()) {
    logger.warn('system', 'system.config', 'CRED_KEY is not set to a strong value — SSH Sync cannot store device credentials. Set CRED_KEY (16+ random chars) to enable it.');
  } else if (!collectorConfigured()) {
    logger.info('system', 'system.config', 'SSH Sync is off: COLLECTOR_URL / COLLECTOR_TOKEN are not set.');
  }
```

- ganti

```ts
  const server = app.listen(PORT, HOST, () => {
    console.log(`NetTwin Core Digital Twin server active on http://${HOST}:${PORT}`);
  });
```

dengan

```ts
  const server = app.listen(PORT, HOST, () => {
    logger.info('system', 'system.start', `NetTwin Core ${appVersion()} started on http://${HOST}:${PORT} (storage: ${storage.kind}, mode: ${process.env.NODE_ENV || 'development'})`, {
      details: { version: appVersion(), storage: storage.kind, mode: process.env.NODE_ENV || 'development' },
    });
  });

  // Log retention: now, then daily.
  const runRetention = () =>
    pruneLogs(logStore!, logger, settings.logRetentionDays).catch(err =>
      logger.warn('system', 'system.log.prune_failed', `Log retention failed: ${errorText(err)}`)
    );
  void runRetention();
  setInterval(runRetention, 24 * 60 * 60 * 1000).unref();
```

- di `shutdown`, ganti

```ts
    console.log(`${signal} received — flushing pending saves and shutting down...`);
    server.close();
    setTimeout(() => process.exit(1), 10_000).unref();
    Promise.all([stateSaver.flush(), connectionSaver.flush(), profileSaver.flush()])
      .finally(() => process.exit(0));
```

dengan

```ts
    logger.info('system', 'system.stop', `${signal} received — saving pending changes and shutting down`);
    server.close();
    setTimeout(() => process.exit(1), 10_000).unref();
    Promise.all([stateSaver.flush(), connectionSaver.flush(), profileSaver.flush()])
      .then(() => logger.flush())
      .finally(() => process.exit(0));
```

- tambahkan sebelum `startServer().catch(...)` di akhir file:

```ts
// Version from package.json (present next to the bundle in the Docker image).
function appVersion(): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version || 'unknown');
  } catch {
    return 'unknown';
  }
}

// A crash is logged (with stack) before the process exits, as it did before;
// Docker's restart policy brings the server back.
const crash = (kind: string) => (reason: unknown) => {
  logger.error('system', 'system.crash', `${kind}: ${errorText(reason)} — the server stops and is restarted`, {
    details: { stack: reason instanceof Error ? reason.stack : undefined },
  });
  setTimeout(() => process.exit(1), 3000).unref();
  void logger.flush().finally(() => process.exit(1));
};
process.on('unhandledRejection', crash('Unhandled promise rejection'));
process.on('uncaughtException', crash('Uncaught exception'));
```

Catatan: `ensureAdminSeed` (password admin acak) tetap memakai `console.log` — **jangan** dialihkan ke logger.

- [ ] **Step 4: Verifikasi**

Run: `npx tsc --noEmit && npx vitest run && npm run build && bash "<scratchpad>/logs-smoke.sh"`
Expected: tsc 0 error; semua test PASS (termasuk "every mutating route in server.ts has a label"); `RESULT: 31 passed, 0 failed`.

Regresi: `bash "<scratchpad>/smoke.sh"` → `63 passed, 0 failed`; `bash "<scratchpad>/2fa-smoke.sh"` → `31 passed, 0 failed`.

---

### Task 7: Menu Logs, badge error, isian retensi

**Files:**
- Create: `src/logs.ts`, `src/components/LogsTab.tsx`
- Modify: `src/App.tsx`, `src/components/SettingsTab.tsx`, `src/i18n.tsx`
- Test: `src/logs.test.ts`; uji browser `logs-ui.cjs` (scratchpad)

**Interfaces:**
- Consumes: `GET /api/logs`, `/summary`, `/export` (Task 5–6); `LogEntry`, `LogSummary`, `LOG_CATEGORIES`, `LOG_LEVELS`, `DEFAULT_LOG_RETENTION_DAYS` (Task 1); `canAccess(…, 'view-logs')` (Task 4); `copyText` (`src/clipboard.ts`)
- Produces: `RangePreset`, `RANGE_PRESETS`, `LogFilters`, `buildLogParams(f, now, extra?)`, `localToIso(value)`, `formatLogTime(iso)` (`src/logs.ts`); komponen `LogsTab`

- [ ] **Step 1: Tulis test yang gagal**

`src/logs.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { buildLogParams, localToIso, formatLogTime, LogFilters } from './logs';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const base: LogFilters = { category: 'all', levels: [], range: '24h', customFrom: '', customTo: '', actor: '', q: '' };

describe('buildLogParams', () => {
  test('relative ranges resolve against now; "all" sends no category', () => {
    expect(buildLogParams(base, NOW).toString()).toBe('from=2026-10-01T12%3A00%3A00.000Z');
    expect(buildLogParams({ ...base, range: '1h' }, NOW).get('from')).toBe('2026-10-02T11:00:00.000Z');
    expect(buildLogParams({ ...base, range: '30d' }, NOW).get('from')).toBe('2026-09-02T12:00:00.000Z');
  });

  test('category, levels, user, trimmed search and paging', () => {
    const p = buildLogParams({ ...base, category: 'auth', levels: ['warn', 'error'], actor: 'otto', q: '  failed ' }, NOW, { before: 42, limit: 100 });
    expect(p.get('category')).toBe('auth');
    expect(p.get('level')).toBe('warn,error');
    expect(p.get('actor')).toBe('otto');
    expect(p.get('q')).toBe('failed');
    expect(p.get('before')).toBe('42');
    expect(p.get('limit')).toBe('100');
  });

  test('a custom range sends the local times as UTC; empty bounds are left out', () => {
    const from = new Date(2026, 9, 1, 8, 30);
    const p = buildLogParams({ ...base, range: 'custom', customFrom: '2026-10-01T08:30', customTo: '' }, NOW);
    expect(p.get('from')).toBe(from.toISOString());
    expect(p.has('to')).toBe(false);
  });
});

describe('time helpers', () => {
  test('localToIso: datetime-local value to UTC ISO; blank or invalid → undefined', () => {
    expect(localToIso('2026-10-01T08:30')).toBe(new Date(2026, 9, 1, 8, 30).toISOString());
    expect(localToIso('')).toBeUndefined();
    expect(localToIso('not a date')).toBeUndefined();
  });

  test('formatLogTime shows local wall-clock time, sortable', () => {
    expect(formatLogTime(new Date(2026, 9, 2, 14, 3, 5).toISOString())).toBe('2026-10-02 14:03:05');
    expect(formatLogTime('garbage')).toBe('garbage');
  });
});
```

Uji browser `logs-ui.cjs` (scratchpad `browser/`, jalankan lewat `run-ui.sh`):

```js
// logs-ui.cjs — Logs menu: admin only, error badge, tabs + counts, filters, detail panel, export, retention input.
const puppeteer = require('puppeteer-core');
const BASE = 'http://127.0.0.1:3997';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, c, x = '') => { results.push(!!c); console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };

(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  let native = 0; const errors = [];
  page.on('dialog', d => { native++; d.accept(); });
  page.on('pageerror', e => errors.push(String(e)));
  const text = () => page.evaluate(() => document.body.innerText);
  const click = label => page.evaluate(l => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith(l) && !x.disabled); b?.click(); return !!b; }, label);
  const login = async (u, p) => {
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.type('input[autocomplete="username"]', u);
    await page.type('input[type="password"]', p);
    await page.click('button[type="submit"]');
    await sleep(900);
  };
  const logout = async () => { await page.evaluate(() => document.querySelector('button[title="Logout"]')?.click()); await sleep(800); };
  const api = (method, url, body) => page.evaluate(async (m, u, b) => (await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).status, method, url, body);

  // Produce entries: a failed login, a viewer, and a failing SSH collect (error).
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(() => fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'wrong-pass' }) }));
  await login('admin', process.env.ADMIN_PW);
  await api('POST', '/api/users', { username: 'vic', password: 'vic-pass-1', role: 'viewer' });
  const conn = await page.evaluate(async () => (await (await fetch('/api/twin/ssh/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'edge', host: '192.0.2.1', port: 22, username: 'netops', password: 'ssh-secret-1', vendor: 'cisco_ios' }) })).json()).connection.id);
  await api('POST', `/api/twin/ssh/connections/${conn}/collect`, {});
  await sleep(1500);
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(800);

  check('admin sees the Logs menu', await page.evaluate(() => [...document.querySelectorAll('nav button')].some(b => b.textContent.includes('Logs'))));
  check('error badge in the sidebar', await page.evaluate(() => !!document.querySelector('[data-testid="logs-error-badge"]')));
  await click('Logs'); await sleep(1000);
  check('category tabs with counts', /Login & Access\s*\d+/.test(await text()) && /User Activity\s*\d+/.test(await text()));
  check('rows are listed', await page.evaluate(() => document.querySelectorAll('[data-testid="log-row"]').length > 0));
  await click('Login & Access'); await sleep(800);
  check('tab filters to sign-in entries', await page.evaluate(() => [...document.querySelectorAll('[data-testid="log-row"]')].every(r => r.textContent.includes('Login & Access'))));
  await click('All'); await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.dataset.level === 'error')?.click()); await sleep(800);
  check('level filter: only errors', await page.evaluate(() => { const rows = [...document.querySelectorAll('[data-testid="log-row"]')]; return rows.length > 0 && rows.every(r => r.textContent.includes('Error')); }));
  await page.evaluate(() => [...document.querySelectorAll('[data-testid="log-row"]')].find(r => r.textContent.includes('SSH collect failed'))?.click()); await sleep(400);
  check('detail panel opens with the event and details', await page.evaluate(() => { const p = document.querySelector('[data-testid="log-detail"]'); return !!p && p.textContent.includes('ssh.collect.failed'); }));
  await page.keyboard.press('Escape'); await sleep(300);
  check('Esc closes the detail panel', await page.evaluate(() => !document.querySelector('[data-testid="log-detail"]')));
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.dataset.level === 'error')?.click()); await sleep(500);
  await page.type('input[data-testid="log-search"]', 'wrong password'); await sleep(1200);
  check('search narrows the list', await page.evaluate(() => { const rows = [...document.querySelectorAll('[data-testid="log-row"]')]; return rows.length >= 1 && rows.every(r => /wrong password/i.test(r.textContent)); }));
  check('export link carries the filters', await page.evaluate(() => /\/api\/logs\/export\?.*q=wrong\+password/.test(document.querySelector('a[data-testid="log-export"]')?.getAttribute('href') || '')));
  check('export downloads a CSV', await page.evaluate(async () => { const r = await fetch(document.querySelector('a[data-testid="log-export"]').getAttribute('href')); return r.ok && (r.headers.get('content-type') || '').startsWith('text/csv'); }));

  await click('Simulator Settings'); await sleep(600);
  check('retention input shows the default 90', await page.evaluate(() => document.querySelector('input[data-testid="log-retention"]')?.value === '90'));

  await logout();
  await login('vic', 'vic-pass-1');
  check('viewer has no Logs menu', await page.evaluate(() => ![...document.querySelectorAll('nav button')].some(b => b.textContent.includes('Logs'))));

  check('no native browser dialog appeared', native === 0, String(native));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r).length;
  console.log(`RESULT: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(2); });
```

Agar SSH collect gagal (dan menghasilkan error), uji ini butuh SSH Sync aktif dengan collector yang tidak bisa dihubungi. Ubah baris start server di `run-ui.sh` menjadi `env ${RUN_ENV:-} NODE_ENV=production … node …`, lalu jalankan uji ini dengan `RUN_ENV="CRED_KEY=0123456789abcdef0123 COLLECTOR_URL=http://127.0.0.1:9 COLLECTOR_TOKEN=collector-token-123456" bash run-ui.sh logs-ui.cjs` (uji browser lain tetap tanpa variabel tambahan).

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx vitest run src/logs.test.ts` → FAIL (`Cannot find module './logs'`). Lalu `npm run build && bash "<scratchpad>/run-ui.sh" logs-ui.cjs` → FAIL (`admin sees the Logs menu`).

- [ ] **Step 3: Implementasi**

`src/logs.ts`:

```ts
import { LogCategory, LogLevel } from './logTypes';

export type RangePreset = '1h' | '24h' | '7d' | '30d' | 'custom';
export const RANGE_PRESETS: RangePreset[] = ['1h', '24h', '7d', '30d', 'custom'];

const HOUR = 3_600_000;
const RANGE_MS: Record<Exclude<RangePreset, 'custom'>, number> = { '1h': HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };

export interface LogFilters {
  category: LogCategory | 'all';
  levels: LogLevel[];
  range: RangePreset;
  customFrom: string; // <input type="datetime-local"> value (local time)
  customTo: string;
  actor: string;
  q: string;
}

// "2026-10-01T08:30" (no zone = the browser's local time) → UTC ISO.
export function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Query string for /api/logs, /summary and /export.
export function buildLogParams(f: LogFilters, now: Date, extra: { before?: number; limit?: number } = {}): URLSearchParams {
  const p = new URLSearchParams();
  if (f.category !== 'all') p.set('category', f.category);
  if (f.levels.length) p.set('level', f.levels.join(','));
  if (f.range === 'custom') {
    const from = localToIso(f.customFrom);
    const to = localToIso(f.customTo);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
  } else {
    p.set('from', new Date(now.getTime() - RANGE_MS[f.range]).toISOString());
  }
  if (f.actor) p.set('actor', f.actor);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (extra.before) p.set('before', String(extra.before));
  if (extra.limit) p.set('limit', String(extra.limit));
  return p;
}

// Local wall-clock time, sortable: 2026-10-02 14:03:05
export function formatLogTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
```

`src/components/LogsTab.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { ScrollText, RefreshCw, Download, Search, X, Copy, Radio, AlertCircle } from 'lucide-react';
import { useLang } from '../i18n';
import { copyText } from '../clipboard';
import { LOG_CATEGORIES, LOG_LEVELS, LogCategory, LogEntry, LogLevel, LogSummary } from '../logTypes';
import { LogFilters, RangePreset, RANGE_PRESETS, buildLogParams, formatLogTime } from '../logs';

const CATEGORY_LABEL: Record<LogCategory, string> = {
  auth: 'Login & Access', activity: 'User Activity', system: 'System', ssh: 'SSH Sync', backup: 'Config Backup',
};
const LEVEL_LABEL: Record<LogLevel, string> = { info: 'Info', warn: 'Warning', error: 'Error' };
const LEVEL_STYLE: Record<LogLevel, string> = {
  info: 'bg-sky-50 text-sky-700 border-sky-100',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  error: 'bg-rose-50 text-rose-700 border-rose-200',
};
const RANGE_LABEL: Record<RangePreset, string> = {
  '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', custom: 'Custom range',
};
const LIVE_MS = 10_000;

// Admin view of the application log: who did what, when, from where.
export default function LogsTab() {
  const { t } = useLang();
  const [category, setCategory] = useState<LogCategory | 'all'>('all');
  const [levels, setLevels] = useState<LogLevel[]>([]);
  const [range, setRange] = useState<RangePreset>('24h');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [actor, setActor] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState(''); // debounced search
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [summary, setSummary] = useState<LogSummary | null>(null);
  const [users, setUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [copied, setCopied] = useState(false);
  const seq = useRef(0);

  const filters: LogFilters = { category, levels, range, customFrom, customTo, actor, q };
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    fetch('/api/users')
      .then(r => (r.ok ? r.json() : []))
      .then((list: { username: string }[]) => setUsers(list.map(u => u.username)))
      .catch(() => setUsers([]));
  }, []);

  const load = async (more: boolean) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const params = buildLogParams(filters, now, more && nextBefore ? { before: nextBefore } : {});
      const [listRes, sumRes] = await Promise.all([
        fetch(`/api/logs?${params}`),
        more ? Promise.resolve(null) : fetch(`/api/logs/summary?${buildLogParams({ ...filters, category: 'all', levels: [] }, now)}`),
      ]);
      const data = await listRes.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!listRes.ok) throw new Error(data.error || t('Request failed (HTTP {status}).', { status: listRes.status }));
      setEntries(prev => (more ? [...prev, ...data.entries] : data.entries));
      setNextBefore(data.nextBefore);
      if (sumRes?.ok) setSummary(await sumRes.json());
    } catch (err: any) {
      if (mine === seq.current) setError(err?.message || t('Cannot reach the server. Check your connection and try again.'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void load(false), LIVE_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, filterKey]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const toggleLevel = (l: LogLevel) => setLevels(prev => (prev.includes(l) ? prev.filter(x => x !== l) : [...prev, l]));
  const exportHref = `/api/logs/export?${buildLogParams(filters, new Date())}`;
  const copySelected = async () => {
    if (selected && (await copyText(JSON.stringify(selected, null, 2)))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const tabs: (LogCategory | 'all')[] = ['all', ...LOG_CATEGORIES];
  const countFor = (c: LogCategory | 'all') => (summary ? (c === 'all' ? summary.total : summary.byCategory[c]) : null);
  const { stack, ...otherDetails } = (selected?.details ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-4 text-xs">
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display font-bold text-slate-800 text-sm flex items-center gap-1.5">
              <ScrollText size={16} className="text-blue-500" /> {t('Application Logs')}
            </h2>
            <p className="text-slate-500 text-[11px] mt-0.5">{t('Who did what, when and from where — sign-ins, changes, server errors and SSH Sync.')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setLive(v => !v)} aria-pressed={live}
              className={`px-3 py-2 rounded-lg border font-semibold flex items-center gap-1.5 transition ${live ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
              <Radio size={13} className={live ? 'animate-pulse' : ''} /> {t('Live')}
            </button>
            <button onClick={() => void load(false)} className="px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 font-semibold flex items-center gap-1.5">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> {t('Refresh')}
            </button>
            <a href={exportHref} data-testid="log-export" className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white font-semibold flex items-center gap-1.5">
              <Download size={13} /> {t('Export CSV')}
            </a>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 pb-3">
          {tabs.map(c => (
            <button key={c} onClick={() => setCategory(c)}
              className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition ${category === c ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
              {c === 'all' ? t('All') : t(CATEGORY_LABEL[c])}
              {countFor(c) !== null && (
                <span className={`text-[10px] px-1.5 rounded-full ${category === c ? 'bg-blue-500/60' : 'bg-slate-100 text-slate-500'}`}>{countFor(c)}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex gap-1.5">
            {LOG_LEVELS.map(l => (
              <button key={l} data-level={l} onClick={() => toggleLevel(l)} aria-pressed={levels.includes(l)}
                className={`px-2.5 py-1.5 rounded-lg border font-semibold transition ${levels.includes(l) ? LEVEL_STYLE[l] : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                {t(LEVEL_LABEL[l])}{summary ? ` · ${summary.byLevel[l]}` : ''}
              </button>
            ))}
          </div>
          <select value={range} onChange={e => setRange(e.target.value as RangePreset)} aria-label={t('Time range')}
            className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white text-slate-700">
            {RANGE_PRESETS.map(r => <option key={r} value={r}>{t(RANGE_LABEL[r])}</option>)}
          </select>
          {range === 'custom' && (
            <>
              <label className="flex items-center gap-1 text-slate-500">{t('From')}
                <input type="datetime-local" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="px-2 py-1 border border-slate-200 rounded-lg" />
              </label>
              <label className="flex items-center gap-1 text-slate-500">{t('To')}
                <input type="datetime-local" value={customTo} onChange={e => setCustomTo(e.target.value)} className="px-2 py-1 border border-slate-200 rounded-lg" />
              </label>
            </>
          )}
          <select value={actor} onChange={e => setActor(e.target.value)} aria-label={t('User')}
            className="px-2.5 py-1.5 border border-slate-200 rounded-lg bg-white text-slate-700">
            <option value="">{t('All users')}</option>
            {users.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <div className="relative flex-1 min-w-[200px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input data-testid="log-search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('Search message, target, IP or event')}
              className="w-full pl-8 pr-3 py-1.5 border border-slate-200 rounded-lg bg-slate-50 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
        </div>

        {error && (
          <div className="p-2.5 bg-rose-50 border border-rose-100 text-rose-800 rounded-lg font-semibold flex items-center gap-2">
            <AlertCircle size={14} /> {error}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[9px] font-bold">
            <tr>
              <th className="py-2.5 px-4 w-40">{t('Time')}</th>
              <th className="py-2.5 px-3 w-24">{t('Level')}</th>
              <th className="py-2.5 px-3 w-32">{t('Category')}</th>
              <th className="py-2.5 px-3 w-28">{t('User')}</th>
              <th className="py-2.5 px-3 w-32">{t('IP')}</th>
              <th className="py-2.5 px-3">{t('Message')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {entries.map(e => (
              <tr key={e.id} data-testid="log-row" onClick={() => setSelected(e)} className="hover:bg-blue-50/40 cursor-pointer">
                <td className="py-2 px-4 font-mono text-slate-600 whitespace-nowrap">{formatLogTime(e.ts)}</td>
                <td className="py-2 px-3">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border font-bold ${LEVEL_STYLE[e.level]}`}>{t(LEVEL_LABEL[e.level])}</span>
                </td>
                <td className="py-2 px-3 text-slate-600">{t(CATEGORY_LABEL[e.category])}</td>
                <td className="py-2 px-3 font-semibold text-slate-700">{e.actor || '—'}</td>
                <td className="py-2 px-3 font-mono text-slate-500">{e.ip || '—'}</td>
                <td className="py-2 px-3 text-slate-800 truncate max-w-0">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!entries.length && !loading && (
          <p className="text-center text-slate-400 py-10">{t('No log entries match these filters.')}</p>
        )}
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-slate-500">
          <span>{t('Showing {n} entries', { n: entries.length })}</span>
          {nextBefore !== null && (
            <button onClick={() => void load(true)} disabled={loading} className="px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 font-semibold">
              {t('Load more')}
            </button>
          )}
        </div>
      </div>

      {selected && (
        <>
          <div className="fixed inset-0 bg-slate-900/30 z-30" onClick={() => setSelected(null)} />
          <aside data-testid="log-detail" role="dialog" aria-label={t('Log entry')}
            className="fixed inset-y-0 right-0 w-full max-w-xl bg-white shadow-2xl z-40 flex flex-col text-xs">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <span className={`text-[10px] px-2 py-0.5 rounded-full border font-bold ${LEVEL_STYLE[selected.level]}`}>{t(LEVEL_LABEL[selected.level])}</span>
              <div className="flex gap-2">
                <button onClick={copySelected} className="px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 font-semibold flex items-center gap-1.5">
                  <Copy size={13} /> {copied ? t('Copied') : t('Copy JSON')}
                </button>
                <button onClick={() => setSelected(null)} aria-label={t('Close')} className="p-1.5 rounded-lg hover:bg-slate-100"><X size={16} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <p className="text-sm font-semibold text-slate-800 break-words">{selected.message}</p>
              <dl className="grid grid-cols-[110px_1fr] gap-y-1.5">
                {([
                  ['Time', `${formatLogTime(selected.ts)}  (${selected.ts})`],
                  ['Category', t(CATEGORY_LABEL[selected.category])],
                  ['Event', selected.event],
                  ['User', selected.actor || '—'],
                  ['IP', selected.ip || '—'],
                  ['Target', selected.target || '—'],
                ] as [string, string][]).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt className="text-slate-500 font-semibold">{t(k)}</dt>
                    <dd className="font-mono text-slate-800 break-all">{v}</dd>
                  </React.Fragment>
                ))}
              </dl>
              {Object.keys(otherDetails).length > 0 && (
                <div>
                  <h4 className="font-bold text-slate-500 uppercase tracking-wider text-[9px] mb-1">{t('Details')}</h4>
                  <pre className="bg-slate-50 border border-slate-200 rounded-lg p-3 font-mono text-[11px] whitespace-pre-wrap break-all">{JSON.stringify(otherDetails, null, 2)}</pre>
                </div>
              )}
              {typeof stack === 'string' && (
                <div>
                  <h4 className="font-bold text-slate-500 uppercase tracking-wider text-[9px] mb-1">{t('Stack trace')}</h4>
                  <pre className="bg-slate-900 text-slate-100 rounded-lg p-3 font-mono text-[11px] whitespace-pre-wrap break-all">{stack}</pre>
                </div>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
```

`src/App.tsx`:
1. Import: `import LogsTab from './components/LogsTab';` dan tambahkan `ScrollText` ke import `lucide-react`.
2. Ganti tipe `activeTab` dengan menambahkan `| 'logs'` sebelum `>('simulator')`.
3. Tepat setelah `const can = (action: Action) => ...;` tambahkan:

```tsx
  const canViewLogs = can('view-logs');
  // Server errors of the last 24 hours, for the badge on the Logs menu.
  const [logErrors, setLogErrors] = useState(0);
  useEffect(() => {
    if (!canViewLogs) return;
    const poll = () => {
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      fetch(`/api/logs/summary?from=${encodeURIComponent(from)}`)
        .then(r => (r.ok ? r.json() : null))
        .then(s => setLogErrors(s?.errorsLast24h ?? 0))
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 60_000);
    return () => clearInterval(id);
  }, [canViewLogs]);
```

4. Di `secondaryTabs`, setelah entri `settings` tambahkan:

```tsx
    ...(canViewLogs ? [{ id: 'logs', label: 'Logs', icon: <ScrollText size={16} /> }] : []),
```

5. Di render tombol `secondaryTabs.map(tab => ( ... ))`, ganti `{t(tab.label)}` (di blok secondaryTabs) dengan:

```tsx
              {t(tab.label)}
              {tab.id === 'logs' && logErrors > 0 && (
                <span data-testid="logs-error-badge" title={t('{n} errors in the last 24 hours', { n: logErrors })}
                  className="ml-auto min-w-[18px] px-1.5 py-0.5 rounded-full bg-rose-600 text-white text-[10px] font-bold text-center">
                  {logErrors > 99 ? '99+' : logErrors}
                </span>
              )}
```

6. Setelah blok `{activeTab === 'settings' && ( ... )}` tambahkan:

```tsx
          {activeTab === 'logs' && canViewLogs && <LogsTab />}
```

`src/components/SettingsTab.tsx`:
1. Import `DEFAULT_LOG_RETENTION_DAYS` dari `'../logTypes'`.
2. Setelah `const [implicitDeny, setImplicitDeny] = useState(true);` tambahkan `const [logRetentionDays, setLogRetentionDays] = useState(String(DEFAULT_LOG_RETENTION_DAYS));`.
3. Di loader settings, setelah `setImplicitDeny(Boolean(s.implicitDeny));` tambahkan `setLogRetentionDays(String(s.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS));`.
4. Di `handleSaveSettings`, ganti body menjadi `JSON.stringify({ maxHops: parseInt(maxHops, 10), implicitDeny, logRetentionDays: parseInt(logRetentionDays, 10) })`.
5. Tepat sebelum tombol `onClick={handleSaveSettings}` tambahkan:

```tsx
            <div>
              <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px] font-sans">
                {t('Keep application logs for (days)')}
              </label>
              <input
                type="number"
                min="7"
                max="3650"
                data-testid="log-retention"
                value={logRetentionDays}
                onChange={e => setLogRetentionDays(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-bold"
              />
            </div>
```

`src/i18n.tsx` — tambahkan ke map `ID` (sebelum `};` pertama). Jika tsc melaporkan `TS1117`, hapus baris baru yang duplikat:

```ts
  // --- logs ---
  'Logs': 'Log',
  'Application Logs': 'Log Aplikasi',
  'Who did what, when and from where — sign-ins, changes, server errors and SSH Sync.': 'Siapa melakukan apa, kapan, dan dari mana — login, perubahan, error server, dan SSH Sync.',
  'Login & Access': 'Login & Akses',
  'User Activity': 'Aktivitas User',
  'Config Backup': 'Backup Config',
  'Warning': 'Peringatan',
  'Live': 'Live',
  'Export CSV': 'Ekspor CSV',
  'Time range': 'Rentang waktu',
  'Last hour': '1 jam terakhir',
  'Last 24 hours': '24 jam terakhir',
  'Last 7 days': '7 hari terakhir',
  'Last 30 days': '30 hari terakhir',
  'Custom range': 'Rentang custom',
  'All users': 'Semua user',
  'Search message, target, IP or event': 'Cari pesan, target, IP, atau event',
  'No log entries match these filters.': 'Tidak ada entri log yang cocok dengan filter ini.',
  'Showing {n} entries': 'Menampilkan {n} entri',
  'Load more': 'Muat lebih banyak',
  'Log entry': 'Entri log',
  'Copy JSON': 'Salin JSON',
  'Stack trace': 'Stack trace',
  'Event': 'Event',
  '{n} errors in the last 24 hours': '{n} error dalam 24 jam terakhir',
  'Keep application logs for (days)': 'Simpan log aplikasi selama (hari)',
```

Kunci umum yang dipakai `LogsTab` tetapi tidak ada di daftar di atas (`All`, `System`, `Info`, `Error`, `Refresh`, `User`, `Time`, `Level`, `Category`, `Message`, `Target`, `IP`, `Details`, `Close`, `Copied`, `From`, `To`, `SSH Sync`) diasumsikan sudah ada. Setelah `npx tsc --noEmit` bersih, cek tiap kunci itu dengan `grep -c "^  'Kunci':" src/i18n.tsx`, lalu tambahkan terjemahan untuk yang hasilnya 0.

- [ ] **Step 4: Verifikasi**

Run: `npx tsc --noEmit && npx vitest run && npm run build && RUN_ENV="CRED_KEY=0123456789abcdef0123 COLLECTOR_URL=http://127.0.0.1:9 COLLECTOR_TOKEN=collector-token-123456" bash "<scratchpad>/run-ui.sh" logs-ui.cjs`
Expected: tsc 0 error; semua PASS (termasuk `src/noNativeDialogs.test.ts`); `RESULT: 15 passed, 0 failed`.

---

### Task 8: Dokumentasi & verifikasi menyeluruh

**Files:**
- Modify: `README.md`, `TUTORIAL.md`

- [ ] **Step 1: README**
- Di "Fitur utama", tambahkan poin: `- **Logs (admin)** — log aplikasi terstruktur: login & akses, aktivitas user (setiap perubahan, otomatis), sistem (start/stop, gagal simpan, error server dengan stack trace), SSH Sync. Filter kategori/level/waktu/user/teks, panel detail, Live, export CSV, badge error 24 jam. Disimpan di MySQL (`app_logs`) atau `data/logs/`, retensi default 90 hari (Settings).`
- Di "Upgrade dari versi sebelumnya", tambahkan: `- **Logs**: tabel `app_logs` dibuat otomatis saat start; tidak ada langkah manual. Baris `[AUDIT]` di `docker logs` kini berformat `[INFO] [kategori] pesan`.`
- Di daftar perintah Development, tambahkan `logging` ke keterangan `npm test`.

- [ ] **Step 2: TUTORIAL**
- Tambahkan bagian baru sebelum "Troubleshooting" (dan perbarui daftar isi): **Logs (admin)** — cara membaca tab kategori, filter level/waktu/user, pencarian, panel detail (stack trace error server), tombol Live, Export CSV, arti badge merah, dan pengaturan retensi di Settings.
- Di tabel Troubleshooting tambahkan: `| Menu Logs tidak muncul | Hanya role admin yang melihat Logs. |` dan `| Badge merah di menu Logs | Ada error dalam 24 jam terakhir: buka Logs → filter Error, klik baris untuk melihat detail/stack trace. |`

- [ ] **Step 3: Verifikasi menyeluruh**
1. `npx tsc --noEmit` → 0 error
2. `npx vitest run` → semua PASS
3. `npm audit` → 0 vulnerabilities
4. `npm run build` → sukses
5. `logs-smoke.sh` → `31 passed, 0 failed`; `smoke.sh` → `63 passed`; `2fa-smoke.sh` → `31 passed`
6. `RUN_ENV=… run-ui.sh logs-ui.cjs` → `15 passed`; `run-ui.sh 2fa-ui.cjs` → `14 passed`; `run-ui.sh ui-test.cjs` → `67 passed`
