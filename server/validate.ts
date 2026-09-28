import {
  NetworkNode,
  NetworkLink,
  VRF,
  Interface,
  Route,
  FirewallRule,
  PathQuery,
  ComplianceAudit,
  ChangeRequest,
  IpReservation,
  SimulationSettings,
} from '../src/types';
import { ParserProfile, ParserRule } from './parsers/types';

// Structural validation for twin entities arriving over the API (manual edits,
// SSH/config imports, snapshot restore). The simulation engine trusts these
// shapes, so one malformed node would otherwise crash every later simulation
// and audit run for all users. Each normaliser returns a cleaned copy: the
// fields the engine relies on are type-checked (enums matched
// case-insensitively, ports coerced to strings, defaults filled for missing
// optional fields) and any extra fields are kept as-is.

export class ValidationError extends Error {}

type Obj = Record<string, unknown>;

const MAX_ID = 128;
const MAX_TEXT = 2000;

function fail(path: string, msg: string): never {
  throw new ValidationError(`${path} ${msg}`);
}

// Keys that would reach Object.prototype machinery if copied around; dropped
// so they are never stored or exported.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function asObj(v: unknown, path: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path, 'must be an object');
  const out: Obj = {};
  for (const [k, val] of Object.entries(v as Obj)) if (!FORBIDDEN_KEYS.has(k)) out[k] = val;
  return out;
}

// Ids are primary keys in MySQL, whose default collation compares strings
// case- and accent-insensitively ("Core-R1" = "core-r1"). Uniqueness checks use
// the same notion of equality so a save can never fail on a duplicate key.
export function idKey(id: string): string {
  return id.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
export const sameId = (a: string, b: string) => idKey(a) === idKey(b);

function asArray(v: unknown, path: string, fallback?: unknown[]): unknown[] {
  if (v === undefined || v === null) {
    if (fallback) return fallback;
    fail(path, 'is required');
  }
  if (!Array.isArray(v)) fail(path, 'must be an array');
  return v;
}

function asString(v: unknown, path: string, opts: { fallback?: string; nonEmpty?: boolean; max?: number } = {}): string {
  if (v === undefined || v === null) {
    if (opts.fallback !== undefined) return opts.fallback;
    fail(path, 'is required');
  }
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') fail(path, 'must be a string');
  const s = v as string;
  if (opts.nonEmpty && !s.trim()) fail(path, 'must not be empty');
  if (s.length > (opts.max ?? MAX_TEXT)) fail(path, `must be at most ${opts.max ?? MAX_TEXT} characters`);
  return s;
}

function asId(v: unknown, path: string): string {
  return asString(v, path, { nonEmpty: true, max: MAX_ID }).trim();
}

function asEnum<T extends string>(v: unknown, path: string, values: readonly T[], fallback?: T): T {
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  const hit = values.find(x => x.toLowerCase() === s);
  if (!hit) fail(path, `must be one of: ${values.join(', ')}`);
  return hit;
}

function asNumber(v: unknown, path: string, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) fail(path, 'must be a number');
  return n;
}

let seq = 0;
const genId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

const NODE_TYPES = ['router', 'firewall', 'switch', 'host'] as const;
const ROUTE_PROTOCOLS = ['Connected', 'Static', 'OSPF', 'BGP'] as const;
const RULE_PROTOCOLS = ['any', 'tcp', 'udp', 'icmp'] as const;
const QUERY_PROTOCOLS = ['tcp', 'udp', 'icmp'] as const;
const NAT_TYPES = ['Static NAT', 'PAT / Dynamic'] as const;
const PATH_STATUSES = ['SUCCESS', 'BLOCKED_BY_FIREWALL', 'NO_ROUTE'] as const;
const AUDIT_CATEGORIES = ['PCI-DSS', 'Security Policy', 'Routing'] as const;

export function normalizeRule(input: unknown, path = 'rule'): FirewallRule {
  const o = asObj(input, path);
  return {
    ...o,
    id: o.id === undefined ? genId('fw') : asId(o.id, `${path}.id`),
    name: asString(o.name, `${path}.name`, { nonEmpty: true }),
    sourceVrf: asString(o.sourceVrf, `${path}.sourceVrf`, { fallback: 'any' }),
    destVrf: asString(o.destVrf, `${path}.destVrf`, { fallback: 'any' }),
    sourceIp: asString(o.sourceIp, `${path}.sourceIp`, { fallback: 'any' }),
    destIp: asString(o.destIp, `${path}.destIp`, { fallback: 'any' }),
    protocol: asEnum(o.protocol, `${path}.protocol`, RULE_PROTOCOLS, 'any'),
    sourcePort: asString(o.sourcePort, `${path}.sourcePort`, { fallback: 'any' }),
    destPort: asString(o.destPort, `${path}.destPort`, { fallback: 'any' }),
    action: asEnum(o.action, `${path}.action`, ['permit', 'deny'] as const),
    description: asString(o.description, `${path}.description`, { fallback: '' }),
  };
}

function normalizeInterface(input: unknown, path: string): Interface {
  const o = asObj(input, path);
  return {
    ...o,
    name: asString(o.name, `${path}.name`, { nonEmpty: true, max: MAX_ID }),
    ip: asString(o.ip, `${path}.ip`, { fallback: '', max: 64 }),
    status: asEnum(o.status, `${path}.status`, ['up', 'down'] as const, 'up'),
  };
}

function normalizeRoute(input: unknown, path: string, vrfName: string): Route {
  const o = asObj(input, path);
  return {
    ...o,
    id: o.id === undefined ? genId('r') : asId(o.id, `${path}.id`),
    destination: asString(o.destination, `${path}.destination`, { nonEmpty: true, max: 64 }),
    nextHop: asString(o.nextHop, `${path}.nextHop`, { fallback: '', max: MAX_ID }),
    protocol: asEnum(o.protocol, `${path}.protocol`, ROUTE_PROTOCOLS, 'Static'),
    metric: asNumber(o.metric, `${path}.metric`, 0),
    vrf: asString(o.vrf, `${path}.vrf`, { fallback: vrfName, max: MAX_ID }),
  };
}

function normalizeVrf(input: unknown, path: string): VRF {
  const o = asObj(input, path);
  const name = asString(o.name, `${path}.name`, { nonEmpty: true, max: MAX_ID });
  return {
    ...o,
    name,
    description: asString(o.description, `${path}.description`, { fallback: '' }),
    interfaces: asArray(o.interfaces, `${path}.interfaces`, []).map((x, i) => normalizeInterface(x, `${path}.interfaces[${i}]`)),
    routes: asArray(o.routes, `${path}.routes`, []).map((x, i) => normalizeRoute(x, `${path}.routes[${i}]`, name)),
  };
}

type NatMapping = NonNullable<NetworkNode['natMappings']>[number];

function normalizeNat(input: unknown, path: string): NatMapping {
  const o = asObj(input, path);
  return {
    ...o,
    id: o.id === undefined ? genId('nat') : asId(o.id, `${path}.id`),
    type: asEnum(o.type, `${path}.type`, NAT_TYPES),
    insideLocal: asString(o.insideLocal, `${path}.insideLocal`, { nonEmpty: true, max: 64 }),
    insideGlobal: asString(o.insideGlobal, `${path}.insideGlobal`, { nonEmpty: true, max: 64 }),
    vrf: asString(o.vrf, `${path}.vrf`, { fallback: 'default', max: MAX_ID }),
  };
}

export function normalizeNode(input: unknown, path = 'node'): NetworkNode {
  const o = asObj(input, path);
  const node: NetworkNode = {
    ...o,
    id: asId(o.id, `${path}.id`),
    name: asString(o.name, `${path}.name`, { nonEmpty: true, max: MAX_ID }),
    type: asEnum(o.type, `${path}.type`, NODE_TYPES),
    status: asEnum(o.status, `${path}.status`, ['online', 'offline'] as const, 'online'),
    rev: Number.isInteger(o.rev) ? (o.rev as number) : undefined,
    vrfs: asArray(o.vrfs, `${path}.vrfs`, []).map((x, i) => normalizeVrf(x, `${path}.vrfs[${i}]`)),
  };
  if (o.firewallRules !== undefined && o.firewallRules !== null) {
    node.firewallRules = asArray(o.firewallRules, `${path}.firewallRules`).map((x, i) => normalizeRule(x, `${path}.firewallRules[${i}]`));
  }
  if (o.natMappings !== undefined && o.natMappings !== null) {
    node.natMappings = asArray(o.natMappings, `${path}.natMappings`).map((x, i) => normalizeNat(x, `${path}.natMappings[${i}]`));
  }
  return node;
}

export function normalizeLink(input: unknown, path = 'link'): NetworkLink {
  const o = asObj(input, path);
  return {
    ...o,
    id: asId(o.id, `${path}.id`),
    sourceNodeId: asId(o.sourceNodeId, `${path}.sourceNodeId`),
    sourceInterface: asString(o.sourceInterface, `${path}.sourceInterface`, { nonEmpty: true, max: MAX_ID }),
    destNodeId: asId(o.destNodeId, `${path}.destNodeId`),
    destInterface: asString(o.destInterface, `${path}.destInterface`, { nonEmpty: true, max: MAX_ID }),
  };
}

// sourceVrf may be empty when the caller asks the server to auto-detect the
// source device (sourceNodeId === 'auto').
export function normalizeQuery(input: unknown, path = 'query'): PathQuery {
  const o = asObj(input, path);
  return {
    ...o,
    sourceNodeId: asId(o.sourceNodeId, `${path}.sourceNodeId`),
    sourceVrf: asString(o.sourceVrf, `${path}.sourceVrf`, { fallback: '', max: MAX_ID }),
    sourceIp: asString(o.sourceIp, `${path}.sourceIp`, { nonEmpty: true, max: 64 }).trim(),
    destIp: asString(o.destIp, `${path}.destIp`, { nonEmpty: true, max: 64 }).trim(),
    protocol: asEnum(o.protocol, `${path}.protocol`, QUERY_PROTOCOLS, 'tcp'),
    sourcePort: asString(o.sourcePort, `${path}.sourcePort`, { fallback: 'any', max: 64 }),
    destPort: asString(o.destPort, `${path}.destPort`, { fallback: 'any', max: 64 }),
    bypassPolicies: o.bypassPolicies === true,
  };
}

export function normalizeAudit(input: unknown, path = 'audit'): ComplianceAudit {
  const o = asObj(input, path);
  return {
    ...o,
    id: asId(o.id, `${path}.id`),
    name: asString(o.name, `${path}.name`, { nonEmpty: true }),
    description: asString(o.description, `${path}.description`, { fallback: '' }),
    category: asEnum(o.category, `${path}.category`, AUDIT_CATEGORIES, 'Security Policy'),
    query: normalizeQuery(o.query, `${path}.query`),
    expectedResult: asEnum(o.expectedResult, `${path}.expectedResult`, PATH_STATUSES),
    status: asEnum(o.status, `${path}.status`, ['passed', 'failed', 'untested'] as const, 'untested'),
  };
}

export function normalizeChangeRequest(input: unknown, path = 'changeRequest'): ChangeRequest {
  const o = asObj(input, path);
  return {
    ...o,
    id: asId(o.id, `${path}.id`),
    title: asString(o.title, `${path}.title`, { fallback: '' }),
    description: asString(o.description, `${path}.description`, { fallback: '' }),
    requester: asString(o.requester, `${path}.requester`, { fallback: '' }),
    status: asEnum(o.status, `${path}.status`, ['draft', 'simulated', 'applied'] as const, 'draft'),
    createdAt: asString(o.createdAt, `${path}.createdAt`, { fallback: new Date().toISOString() }),
    nodeId: asId(o.nodeId, `${path}.nodeId`),
    proposedRules: asArray(o.proposedRules, `${path}.proposedRules`).map((x, i) => normalizeRule(x, `${path}.proposedRules[${i}]`)),
  };
}

export function normalizeReservation(input: unknown, path = 'reservation'): IpReservation {
  const o = asObj(input, path);
  return {
    ...o,
    id: o.id === undefined ? genId('res') : asId(o.id, `${path}.id`),
    ip: asString(o.ip, `${path}.ip`, { nonEmpty: true, max: 64 }).trim(),
    note: asString(o.note, `${path}.note`, { fallback: '' }),
    createdAt: asString(o.createdAt, `${path}.createdAt`, { fallback: new Date().toISOString() }),
  };
}

function asRegex(v: unknown, path: string): string {
  const src = asString(v, path, { nonEmpty: true, max: 1000 });
  try {
    new RegExp(src);
  } catch {
    fail(path, `is not a valid regular expression: ${src}`);
  }
  return src;
}

const MAX_PROFILE_RULES = 500;

// Parser profiles are data interpreted by the parser engine; every stored
// profile runs on each config import, so a malformed one would break imports
// for everybody. Checks the parts the engine iterates or compiles.
export function normalizeProfile(input: unknown, path = 'profile'): ParserProfile {
  const o = asObj(input, path);
  const rules = asArray(o.rules, `${path}.rules`);
  if (rules.length > MAX_PROFILE_RULES) fail(`${path}.rules`, `must have at most ${MAX_PROFILE_RULES} entries`);
  if (o.statics !== undefined && o.statics !== null) {
    const statics = asObj(o.statics, `${path}.statics`);
    for (const [name, table] of Object.entries(statics)) {
      for (const [k, v] of Object.entries(asObj(table, `${path}.statics.${name}`))) {
        asString(v, `${path}.statics.${name}.${k}`);
      }
    }
  }
  return {
    ...o,
    id: asString(o.id, `${path}.id`, { nonEmpty: true, max: 64 }).trim(),
    name: asString(o.name, `${path}.name`, { nonEmpty: true, max: MAX_ID }),
    detect: asArray(o.detect, `${path}.detect`, []).map((x, i) => asRegex(x, `${path}.detect[${i}]`)),
    ...(o.boundary !== undefined && o.boundary !== null && o.boundary !== ''
      ? { boundary: asRegex(o.boundary, `${path}.boundary`) }
      : {}),
    rules: rules.map((r, i) => normalizeParserRule(r, `${path}.rules[${i}]`)),
  } as ParserProfile;
}

const COLLECTIONS = ['interfaces', 'routes', 'firewallRules', 'natMappings'] as const;

// The action parts the engine dereferences must have the right shape, or the
// engine throws mid-parse and every import for that vendor fails.
function normalizeParserRule(input: unknown, path: string): ParserRule {
  const rule = asObj(input, path);
  const optionalObj = (key: string) => (rule[key] === undefined || rule[key] === null ? undefined : asObj(rule[key], `${path}.${key}`));
  const push = optionalObj('push');
  if (push) asString(push.id, `${path}.push.id`, { nonEmpty: true, max: MAX_ID });
  if (rule.pop !== undefined) asString(rule.pop, `${path}.pop`, { nonEmpty: true, max: MAX_ID });
  const table = optionalObj('table');
  if (table) asString(table.name, `${path}.table.name`, { nonEmpty: true, max: MAX_ID });
  for (const key of ['accumulate', 'emit'] as const) {
    const action = optionalObj(key);
    if (!action) continue;
    const target = asString(action.target, `${path}.${key}.target`);
    if (!(COLLECTIONS as readonly string[]).includes(target)) fail(`${path}.${key}.target`, `must be one of: ${COLLECTIONS.join(', ')}`);
    asObj(action.fields, `${path}.${key}.fields`);
  }
  return { ...rule, match: asRegex(rule.match, `${path}.match`) } as ParserRule;
}

export const MAX_HOPS_LIMIT = 64;

export function normalizeSettings(input: unknown, base: SimulationSettings, path = 'settings'): SimulationSettings {
  const o = asObj(input, path);
  const maxHops = o.maxHops === undefined ? base.maxHops : parseInt(String(o.maxHops), 10);
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > MAX_HOPS_LIMIT) {
    fail(`${path}.maxHops`, `must be a number between 1 and ${MAX_HOPS_LIMIT}`);
  }
  const deny = o.implicitDeny;
  return {
    maxHops,
    // "false"/"0" from a hand-written snapshot must not read as true.
    implicitDeny: deny === undefined ? base.implicitDeny : !(deny === false || deny === 'false' || deny === 0 || deny === '0' || deny === null || deny === ''),
  };
}

// Reject duplicate ids inside one collection (e.g. a hand-edited snapshot):
// the twin looks entities up by id, and MySQL would refuse to store them.
export function assertUniqueIds(items: { id: string }[], path: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = idKey(item.id);
    if (seen.has(key)) fail(path, `contains duplicate id "${item.id}"`);
    seen.add(key);
  }
}
