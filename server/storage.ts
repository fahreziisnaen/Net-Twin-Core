import fs from 'fs';
import path from 'path';
import mysql, { Pool } from 'mysql2/promise';
import { NetworkNode, NetworkLink, ComplianceAudit, ChangeRequest, SimulationSettings, IpReservation, DeviceConnection } from '../src/types';
import { Role } from '../src/rbac';
import { ParserProfile } from './parsers/types';

export interface TwinState {
  nodes: NetworkNode[];
  links: NetworkLink[];
  audits: ComplianceAudit[];
  changeRequests: ChangeRequest[];
  settings: SimulationSettings;
  ipReservations: IpReservation[];
}

export interface UserRecord {
  id: number;
  username: string;
  passwordHash: string;
  role: Role;
}

// Per-user 2FA state; server/twoFactor.ts owns its meaning.
export interface TwoFactorRecord {
  secretEnc: string;        // TOTP secret, AES-256-GCM encrypted
  enabled: boolean;         // false while enrollment awaits its first code
  recoveryHashes: string[]; // SHA-256 of the unused recovery codes
  lastStep: number;         // last accepted TOTP time step (replay guard)
}

export interface Storage {
  readonly kind: 'mysql' | 'file';
  init(): Promise<void>;
  loadState(): Promise<TwinState | null>;
  saveState(state: TwinState): Promise<void>;
  listUsers(): Promise<UserRecord[]>;
  getUserById(id: number): Promise<UserRecord | null>;
  getUserByUsername(username: string): Promise<UserRecord | null>;
  createUser(username: string, passwordHash: string, role: Role): Promise<UserRecord>;
  updateUser(id: number, fields: Partial<Pick<UserRecord, 'passwordHash' | 'role'>>): Promise<void>;
  deleteUser(id: number): Promise<void>;
  getTwoFactor(userId: number): Promise<TwoFactorRecord | null>;
  saveTwoFactor(userId: number, record: TwoFactorRecord | null): Promise<void>;
  listTwoFactorEnabled(): Promise<number[]>;
  loadProfiles(): Promise<ParserProfile[] | null>;
  saveProfiles(profiles: ParserProfile[]): Promise<void>;
  loadConnections(): Promise<DeviceConnection[]>;
  saveConnections(connections: DeviceConnection[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// File-based storage (default when no DB_HOST is configured). Keeps the twin
// runnable with plain `npm run dev` outside Docker.
// ---------------------------------------------------------------------------

// Write via a temp file + rename so a crash mid-write never leaves a truncated
// JSON file behind (rename replaces the target atomically).
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

// Read a JSON file; undefined when it doesn't exist. A file whose content is
// not valid JSON is moved aside (never silently overwritten by the next save)
// so it can be recovered by hand. I/O errors (a lock, EBUSY, permissions) are
// rethrown instead: the file itself is fine and must not be moved.
function readJsonFile(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, 'utf-8');
  try {
    return JSON.parse(text);
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, backup);
    console.error(`FileStorage: ${path.basename(file)} is not valid JSON; moved it to ${backup}.`, err);
    return undefined;
  }
}

export class FileStorage implements Storage {
  readonly kind = 'file' as const;
  private dataDir = path.join(process.cwd(), 'data');
  private stateFile = path.join(this.dataDir, 'twin-state.json');
  private usersFile = path.join(this.dataDir, 'users.json');
  private profilesFile = path.join(this.dataDir, 'parser-profiles.json');
  private connectionsFile = path.join(this.dataDir, 'device-connections.json');
  private twoFactorFile = path.join(this.dataDir, 'two-factor.json');

  async init(): Promise<void> {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  }

  async loadState(): Promise<TwinState | null> {
    const raw = readJsonFile(this.stateFile) as Partial<TwinState> | undefined;
    if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.links)) return null;
    return {
      nodes: raw.nodes,
      links: raw.links,
      audits: Array.isArray(raw.audits) ? raw.audits : [],
      changeRequests: Array.isArray(raw.changeRequests) ? raw.changeRequests : [],
      ipReservations: Array.isArray(raw.ipReservations) ? raw.ipReservations : [],
      settings: raw.settings as SimulationSettings,
    };
  }

  async saveState(state: TwinState): Promise<void> {
    writeJsonAtomic(this.stateFile, state);
  }

  private readUsers(): UserRecord[] {
    const raw = readJsonFile(this.usersFile);
    return Array.isArray(raw) ? raw : [];
  }

  private writeUsers(users: UserRecord[]): void {
    writeJsonAtomic(this.usersFile, users);
  }

  async listUsers(): Promise<UserRecord[]> {
    return this.readUsers();
  }

  async getUserById(id: number): Promise<UserRecord | null> {
    return this.readUsers().find(u => u.id === id) || null;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    return this.readUsers().find(u => u.username === username) || null;
  }

  async createUser(username: string, passwordHash: string, role: Role): Promise<UserRecord> {
    const users = this.readUsers();
    if (users.some(u => u.username === username)) {
      throw new Error(`User "${username}" already exists`);
    }
    const user: UserRecord = {
      id: users.length > 0 ? Math.max(...users.map(u => u.id)) + 1 : 1,
      username,
      passwordHash,
      role,
    };
    users.push(user);
    this.writeUsers(users);
    return user;
  }

  async updateUser(id: number, fields: Partial<Pick<UserRecord, 'passwordHash' | 'role'>>): Promise<void> {
    const users = this.readUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx < 0) throw new Error('User not found');
    users[idx] = { ...users[idx], ...fields };
    this.writeUsers(users);
  }

  async deleteUser(id: number): Promise<void> {
    this.writeUsers(this.readUsers().filter(u => u.id !== id));
    // Ids are reused (max + 1), so a later user must not inherit this 2FA.
    await this.saveTwoFactor(id, null);
  }

  private readTwoFactor(): Record<string, TwoFactorRecord> {
    const raw = readJsonFile(this.twoFactorFile);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, TwoFactorRecord>) : {};
  }

  async getTwoFactor(userId: number): Promise<TwoFactorRecord | null> {
    const all = this.readTwoFactor();
    return Object.prototype.hasOwnProperty.call(all, String(userId)) ? all[String(userId)] : null;
  }

  async saveTwoFactor(userId: number, record: TwoFactorRecord | null): Promise<void> {
    const all = this.readTwoFactor();
    if (record) all[String(userId)] = record;
    else delete all[String(userId)];
    writeJsonAtomic(this.twoFactorFile, all);
  }

  async listTwoFactorEnabled(): Promise<number[]> {
    return Object.entries(this.readTwoFactor()).filter(([, r]) => r.enabled).map(([id]) => Number(id));
  }

  async loadProfiles(): Promise<ParserProfile[] | null> {
    const raw = readJsonFile(this.profilesFile);
    return Array.isArray(raw) && raw.length ? raw : null;
  }

  async saveProfiles(profiles: ParserProfile[]): Promise<void> {
    writeJsonAtomic(this.profilesFile, profiles);
  }

  async loadConnections(): Promise<DeviceConnection[]> {
    const raw = readJsonFile(this.connectionsFile);
    return Array.isArray(raw) ? raw : [];
  }

  async saveConnections(connections: DeviceConnection[]): Promise<void> {
    writeJsonAtomic(this.connectionsFile, connections);
  }
}

// ---------------------------------------------------------------------------
// MySQL storage. Twin entities are stored one row per entity with the nested
// configuration in a JSON column; users are a fully relational table.
// ---------------------------------------------------------------------------
export class MySqlStorage implements Storage {
  readonly kind = 'mysql' as const;
  private pool: Pool;

  constructor() {
    this.pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER || 'nettwin',
      password: process.env.DB_PASSWORD || 'nettwin',
      database: process.env.DB_NAME || 'nettwin',
      waitForConnections: true,
      connectionLimit: 5,
    });
  }

  async init(): Promise<void> {
    // MySQL in docker-compose can need a moment even after the container is
    // "healthy"; retry before giving up.
    const maxAttempts = 15;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const conn = await this.pool.getConnection();
        conn.release();
        break;
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        console.log(`MySQL not ready (attempt ${attempt}/${maxAttempts}), retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const ddl = [
      `CREATE TABLE IF NOT EXISTS twin_nodes (
        id VARCHAR(128) PRIMARY KEY,
        data JSON NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS twin_links (
        id VARCHAR(128) PRIMARY KEY,
        data JSON NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS twin_audits (
        id VARCHAR(128) PRIMARY KEY,
        data JSON NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS twin_change_requests (
        id VARCHAR(128) PRIMARY KEY,
        data JSON NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS twin_settings (
        id TINYINT PRIMARY KEY,
        data JSON NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS twin_ip_reservations (
        id VARCHAR(128) PRIMARY KEY,
        data JSON NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin','operator','viewer') NOT NULL DEFAULT 'viewer',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS parser_profiles (
        id VARCHAR(64) PRIMARY KEY,
        data JSON NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS device_connections (
        id VARCHAR(128) PRIMARY KEY,
        data JSON NOT NULL
      )`,
      // Separate table so upgrading a live database never alters `users`.
      `CREATE TABLE IF NOT EXISTS user_two_factor (
        user_id INT PRIMARY KEY,
        data JSON NOT NULL,
        CONSTRAINT fk_user_two_factor_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
    ];
    for (const stmt of ddl) {
      await this.pool.query(stmt);
    }
  }

  private static parseData<T>(value: unknown): T {
    // mysql2 usually parses JSON columns already; be tolerant of strings
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  }

  async loadState(): Promise<TwinState | null> {
    // Every save writes the settings row, so its presence marks "state was
    // persisted before" — a twin whose nodes were all deleted must not be
    // re-seeded on restart.
    const [settingsRows] = await this.pool.query('SELECT data FROM twin_settings WHERE id = 1');
    const [nodeRows] = await this.pool.query('SELECT data FROM twin_nodes');
    const settingsRow = (settingsRows as { data: unknown }[])[0];
    if (!settingsRow && (nodeRows as unknown[]).length === 0) return null;

    const [linkRows] = await this.pool.query('SELECT data FROM twin_links');
    const [auditRows] = await this.pool.query('SELECT data FROM twin_audits');
    const [crRows] = await this.pool.query('SELECT data FROM twin_change_requests');
    const [resRows] = await this.pool.query('SELECT data FROM twin_ip_reservations');

    const rowsToData = <T>(rows: unknown): T[] =>
      (rows as { data: unknown }[]).map(r => MySqlStorage.parseData<T>(r.data));

    return {
      nodes: rowsToData<NetworkNode>(nodeRows),
      links: rowsToData<NetworkLink>(linkRows),
      audits: rowsToData<ComplianceAudit>(auditRows),
      changeRequests: rowsToData<ChangeRequest>(crRows),
      ipReservations: rowsToData<IpReservation>(resRows),
      settings: settingsRow
        ? MySqlStorage.parseData<SimulationSettings>(settingsRow.data)
        : { maxHops: 10, implicitDeny: true },
    };
  }

  async saveState(state: TwinState): Promise<void> {
    // Serialize everything before the first await: the live state keeps being
    // mutated by request handlers while the transaction runs, and the commit
    // must be one consistent snapshot.
    const rows = (list: { id: string }[]) => list.map(r => [r.id, JSON.stringify(r)]);
    const snapshot: [string, (string | unknown)[][]][] = [
      ['twin_nodes', rows(state.nodes)],
      ['twin_links', rows(state.links)],
      ['twin_audits', rows(state.audits)],
      ['twin_change_requests', rows(state.changeRequests)],
      ['twin_ip_reservations', rows(state.ipReservations || [])],
    ];
    const settingsJson = JSON.stringify(state.settings);

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [table, values] of snapshot) {
        await conn.query(`DELETE FROM ${table}`);
        if (values.length > 0) {
          await conn.query(`INSERT INTO ${table} (id, data) VALUES ?`, [values]);
        }
      }
      await conn.query('REPLACE INTO twin_settings (id, data) VALUES (1, ?)', [settingsJson]);

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  private static mapUserRow(row: any): UserRecord {
    return { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role };
  }

  async listUsers(): Promise<UserRecord[]> {
    const [rows] = await this.pool.query('SELECT id, username, password_hash, role FROM users ORDER BY id');
    return (rows as any[]).map(MySqlStorage.mapUserRow);
  }

  async getUserById(id: number): Promise<UserRecord | null> {
    const [rows] = await this.pool.query(
      'SELECT id, username, password_hash, role FROM users WHERE id = ? LIMIT 1',
      [id]
    );
    const row = (rows as any[])[0];
    return row ? MySqlStorage.mapUserRow(row) : null;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const [rows] = await this.pool.query(
      'SELECT id, username, password_hash, role FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    const row = (rows as any[])[0];
    return row ? MySqlStorage.mapUserRow(row) : null;
  }

  async createUser(username: string, passwordHash: string, role: Role): Promise<UserRecord> {
    const [result] = await this.pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, passwordHash, role]
    );
    return { id: (result as any).insertId, username, passwordHash, role };
  }

  async updateUser(id: number, fields: Partial<Pick<UserRecord, 'passwordHash' | 'role'>>): Promise<void> {
    if (fields.passwordHash !== undefined) {
      await this.pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [fields.passwordHash, id]);
    }
    if (fields.role !== undefined) {
      await this.pool.query('UPDATE users SET role = ? WHERE id = ?', [fields.role, id]);
    }
  }

  async deleteUser(id: number): Promise<void> {
    await this.pool.query('DELETE FROM users WHERE id = ?', [id]);
  }

  async getTwoFactor(userId: number): Promise<TwoFactorRecord | null> {
    const [rows] = await this.pool.query('SELECT data FROM user_two_factor WHERE user_id = ?', [userId]);
    const row = (rows as { data: unknown }[])[0];
    return row ? MySqlStorage.parseData<TwoFactorRecord>(row.data) : null;
  }

  async saveTwoFactor(userId: number, record: TwoFactorRecord | null): Promise<void> {
    if (!record) {
      await this.pool.query('DELETE FROM user_two_factor WHERE user_id = ?', [userId]);
      return;
    }
    await this.pool.query('REPLACE INTO user_two_factor (user_id, data) VALUES (?, ?)', [userId, JSON.stringify(record)]);
  }

  async listTwoFactorEnabled(): Promise<number[]> {
    const [rows] = await this.pool.query('SELECT user_id, data FROM user_two_factor');
    return (rows as { user_id: number; data: unknown }[])
      .filter(r => MySqlStorage.parseData<TwoFactorRecord>(r.data).enabled)
      .map(r => r.user_id);
  }

  async loadProfiles(): Promise<ParserProfile[] | null> {
    const [rows] = await this.pool.query('SELECT data FROM parser_profiles');
    const list = (rows as { data: unknown }[]).map(r => MySqlStorage.parseData<ParserProfile>(r.data));
    return list.length ? list : null;
  }

  async saveProfiles(profiles: ParserProfile[]): Promise<void> {
    const values = profiles.map(p => [p.id, JSON.stringify(p)]); // snapshot before any await
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM parser_profiles');
      if (values.length > 0) {
        await conn.query('INSERT INTO parser_profiles (id, data) VALUES ?', [values]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async loadConnections(): Promise<DeviceConnection[]> {
    const [rows] = await this.pool.query('SELECT data FROM device_connections');
    return (rows as { data: unknown }[]).map(r => MySqlStorage.parseData<DeviceConnection>(r.data));
  }

  async saveConnections(connections: DeviceConnection[]): Promise<void> {
    const values = connections.map(c => [c.id, JSON.stringify(c)]); // snapshot before any await
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('DELETE FROM device_connections');
      if (values.length > 0) {
        await conn.query('INSERT INTO device_connections (id, data) VALUES ?', [values]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}

// Pick the storage backend from environment: MySQL when DB_HOST is set
// (docker-compose), JSON files otherwise (bare `npm run dev`).
export function createStorage(): Storage {
  if (process.env.DB_HOST) {
    console.log(`Storage backend: MySQL @ ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}`);
    return new MySqlStorage();
  }
  console.log('Storage backend: JSON file (set DB_HOST to use MySQL)');
  return new FileStorage();
}
