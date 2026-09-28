import { describe, test, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FileStorage, MySqlStorage, TwinState } from './storage';

const state = (nodes: unknown[] = []): TwinState => ({
  nodes: nodes as TwinState['nodes'],
  links: [],
  audits: [],
  changeRequests: [],
  ipReservations: [],
  settings: { maxHops: 7, implicitDeny: false },
});

afterEach(() => vi.restoreAllMocks());

describe('FileStorage', () => {
  function tempStorage() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nettwin-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    return { storage: new FileStorage(), dataDir: path.join(dir, 'data') };
  }

  test('round-trips state and leaves no temp files behind', async () => {
    const { storage, dataDir } = tempStorage();
    await storage.init();
    await storage.saveState(state([{ id: 'n1' }]));
    expect((await storage.loadState())?.nodes).toEqual([{ id: 'n1' }]);
    expect(fs.readdirSync(dataDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  test('an emptied twin stays empty (not re-seeded)', async () => {
    const { storage } = tempStorage();
    await storage.init();
    await storage.saveState(state([]));
    expect(await storage.loadState()).not.toBeNull();
  });

  test('a corrupt file is moved aside instead of being overwritten', async () => {
    const { storage, dataDir } = tempStorage();
    await storage.init();
    fs.writeFileSync(path.join(dataDir, 'users.json'), '[{"id":1,"username":"adm');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await storage.listUsers()).toEqual([]);
    const backups = fs.readdirSync(dataDir).filter(f => f.startsWith('users.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dataDir, backups[0]), 'utf-8')).toContain('"adm');
  });

  test('a transient read error is not mistaken for corruption', async () => {
    const { storage, dataDir } = tempStorage();
    await storage.init();
    await storage.createUser('admin', 'hash', 'admin');
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    await expect(storage.listUsers()).rejects.toThrow(/EBUSY/);
    spy.mockImplementation(real as any);
    expect((await storage.listUsers()).map(u => u.username)).toEqual(['admin']);
    expect(fs.readdirSync(dataDir).some(f => f.includes('.corrupt-'))).toBe(false);
  });

  test('users can be looked up by id', async () => {
    const { storage } = tempStorage();
    await storage.init();
    const u = await storage.createUser('alice', 'hash', 'viewer');
    expect((await storage.getUserById(u.id))?.username).toBe('alice');
    expect(await storage.getUserById(999)).toBeNull();
  });
});

describe('MySqlStorage.loadState', () => {
  // Fake pool answering the SELECTs loadState issues.
  function withRows(settings: unknown[], nodes: unknown[]) {
    const storage = new MySqlStorage();
    (storage as any).pool = {
      query: async (sql: string) => {
        if (sql.includes('twin_settings')) return [settings.map(data => ({ data }))];
        if (sql.includes('twin_nodes')) return [nodes.map(data => ({ data }))];
        return [[]];
      },
    };
    return storage;
  }

  test('fresh database -> null (seed on first boot)', async () => {
    expect(await withRows([], []).loadState()).toBeNull();
  });

  test('persisted twin with every node deleted is restored, not re-seeded', async () => {
    const restored = await withRows([{ maxHops: 7, implicitDeny: false }], []).loadState();
    expect(restored).not.toBeNull();
    expect(restored!.nodes).toEqual([]);
    expect(restored!.settings.maxHops).toBe(7);
  });

  test('JSON columns returned as strings are parsed', async () => {
    const restored = await withRows(['{"maxHops":5,"implicitDeny":true}'], ['{"id":"n1"}']).loadState();
    expect(restored!.nodes).toEqual([{ id: 'n1' }]);
    expect(restored!.settings.maxHops).toBe(5);
  });
});
