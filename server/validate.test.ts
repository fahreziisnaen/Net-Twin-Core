import { describe, test, expect } from 'vitest';
import {
  ValidationError,
  normalizeNode,
  normalizeLink,
  normalizeQuery,
  normalizeAudit,
  normalizeProfile,
  normalizeSettings,
  assertUniqueIds,
} from './validate';
import { getSeedNodes, getSeedLinks, getSeedAudits } from '../src/seedData';
import { SEED_PROFILES } from './parsers';
import { DEFAULT_SETTINGS } from '../src/engine';

describe('twin entity validation', () => {
  test('every seed entity passes unchanged in meaning', () => {
    for (const node of getSeedNodes()) {
      const out = normalizeNode(node);
      expect(out.id).toBe(node.id);
      expect(out.vrfs.length).toBe(node.vrfs.length);
      expect(out.firewallRules?.length).toBe(node.firewallRules?.length);
    }
    for (const link of getSeedLinks()) expect(normalizeLink(link)).toEqual(link);
    for (const audit of getSeedAudits()) expect(normalizeAudit(audit).query.destIp).toBe(audit.query.destIp);
  });

  test('rejects shapes that would crash the simulation engine', () => {
    expect(() => normalizeNode({ id: 'n1', name: 'R1', type: 'router', vrfs: 'nope' })).toThrow(ValidationError);
    expect(() => normalizeNode({ id: 'n1', name: 'R1', type: 'toaster', vrfs: [] })).toThrow(/type must be one of/);
    expect(() => normalizeNode({ name: 'R1', type: 'router', vrfs: [] })).toThrow(/node.id is required/);
    expect(() => normalizeNode({
      id: 'n1', name: 'R1', type: 'router',
      vrfs: [{ name: 'default', interfaces: [{ name: 'Gi0', ip: { bad: true } }], routes: [] }],
    })).toThrow(/vrfs\[0\]\.interfaces\[0\]\.ip must be a string/);
  });

  test('fills defaults, coerces ports/enums, keeps extra fields', () => {
    const node = normalizeNode({
      id: 'fw1', name: 'FW', type: 'FIREWALL', custom: 'kept',
      vrfs: [{ name: 'INSIDE', interfaces: [{ name: 'port1', ip: '10.0.0.1/24', vlan: 20 }], routes: [{ destination: '0.0.0.0/0', nextHop: '10.0.0.254', protocol: 'static' }] }],
      firewallRules: [{ name: 'web', protocol: 'TCP', destPort: 443, action: 'permit' }],
    });
    expect(node.type).toBe('firewall');
    expect(node.status).toBe('online');
    expect((node as any).custom).toBe('kept');
    expect(node.vrfs[0].interfaces[0]).toMatchObject({ status: 'up', vlan: 20 });
    expect(node.vrfs[0].routes[0]).toMatchObject({ protocol: 'Static', metric: 0, vrf: 'INSIDE' });
    expect(node.firewallRules![0]).toMatchObject({ protocol: 'tcp', destPort: '443', sourceIp: 'any', description: '' });
  });

  test('path queries are trimmed and typed', () => {
    const q = normalizeQuery({ sourceNodeId: 'auto', sourceIp: ' 10.1.1.1 ', destIp: '10.2.2.2', protocol: 'UDP', destPort: 53 });
    expect(q).toMatchObject({ sourceIp: '10.1.1.1', protocol: 'udp', destPort: '53', sourcePort: 'any', sourceVrf: '' });
    expect(() => normalizeQuery({ sourceNodeId: 'r1', sourceIp: 5, destIp: '' })).toThrow(ValidationError);
  });

  test('settings are range-checked', () => {
    expect(normalizeSettings({ maxHops: '12' }, DEFAULT_SETTINGS)).toEqual({ maxHops: 12, implicitDeny: true });
    expect(() => normalizeSettings({ maxHops: 1e9 }, DEFAULT_SETTINGS)).toThrow(/between 1 and 64/);
    expect(() => normalizeSettings({ maxHops: 0 }, DEFAULT_SETTINGS)).toThrow(ValidationError);
  });

  test('duplicate ids are rejected', () => {
    expect(() => assertUniqueIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }], 'nodes')).toThrow(/duplicate id "a"/);
  });

  test('ids that MySQL treats as equal count as duplicates', () => {
    expect(() => assertUniqueIds([{ id: 'Core-R1' }, { id: 'core-r1' }], 'nodes')).toThrow(/duplicate/);
    expect(() => assertUniqueIds([{ id: 'café' }, { id: 'cafe' }], 'nodes')).toThrow(/duplicate/);
  });

  test('"false" in a snapshot means false', () => {
    expect(normalizeSettings({ maxHops: 5, implicitDeny: 'false' }, DEFAULT_SETTINGS).implicitDeny).toBe(false);
    expect(normalizeSettings({ maxHops: 5, implicitDeny: 0 }, DEFAULT_SETTINGS).implicitDeny).toBe(false);
    expect(normalizeSettings({ maxHops: 5, implicitDeny: 'true' }, DEFAULT_SETTINGS).implicitDeny).toBe(true);
  });

  test('prototype-ish keys are dropped, never stored', () => {
    const input = JSON.parse('{"id":"n1","name":"N","type":"router","vrfs":[],"__proto__":{"polluted":1}}');
    const node = normalizeNode(input);
    expect(Object.prototype.hasOwnProperty.call(node, '__proto__')).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe('parser profile validation', () => {
  test('all built-in profiles are valid', () => {
    for (const p of SEED_PROFILES) expect(normalizeProfile(p).id).toBe(p.id);
  });

  test('rejects missing or invalid regexes', () => {
    const base = { id: 'x', name: 'X', detect: [], rules: [] as unknown[] };
    expect(() => normalizeProfile({ ...base, rules: [{ match: '(' }] })).toThrow(/not a valid regular expression/);
    expect(() => normalizeProfile({ ...base, rules: [{ setHostname: '$1' }] })).toThrow(/rules\[0\]\.match is required/);
    expect(() => normalizeProfile({ ...base, detect: 'hostname' })).toThrow(/detect must be an array/);
    expect(() => normalizeProfile({ ...base, statics: { svc: { http: 80 } } })).not.toThrow();
    expect(() => normalizeProfile({ ...base, statics: { svc: { http: {} } } })).toThrow(ValidationError);
  });

  test('rejects rule actions the engine would crash on', () => {
    const base = { id: 'x', name: 'X', detect: [] };
    expect(() => normalizeProfile({ ...base, rules: [{ match: 'a', emit: { target: 'interfaces' } }] })).toThrow(/emit\.fields must be an object/);
    expect(() => normalizeProfile({ ...base, rules: [{ match: 'a', accumulate: { target: 'bogus', fields: {} } }] })).toThrow(/target must be one of/);
    expect(() => normalizeProfile({ ...base, rules: [{ match: 'a', push: {} }] })).toThrow(/push\.id is required/);
    expect(() => normalizeProfile({ ...base, rules: [{ match: 'a', table: { value: '$1' } }] })).toThrow(/table\.name is required/);
  });
});
