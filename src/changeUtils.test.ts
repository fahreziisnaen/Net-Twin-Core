import { describe, test, expect } from 'vitest';
import { deriveProbeQuery, numToIp } from './changeUtils';
import { getSeedNodes } from './seedData';
import { FirewallRule } from './types';

const fw = getSeedNodes().find(n => n.id === 'edge-fw01')!;

const baseRule: FirewallRule = {
  id: 'r1',
  name: 'Test rule',
  sourceVrf: 'PRODUCTION',
  destVrf: 'PCI-ZONE',
  sourceIp: '10.100.10.0/24',
  destIp: '192.168.50.10/32',
  protocol: 'tcp',
  sourcePort: 'any',
  destPort: '5432',
  action: 'permit',
  description: '',
};

describe('numToIp', () => {
  test('converts unsigned 32-bit integers back to dotted quads', () => {
    expect(numToIp(0x0A000001)).toBe('10.0.0.1');
    expect(numToIp(0xC0A80101)).toBe('192.168.1.1');
  });
});

describe('deriveProbeQuery', () => {
  test('samples first host from CIDR networks and uses exact host IPs', () => {
    const q = deriveProbeQuery(baseRule, fw);
    expect(q.sourceNodeId).toBe('edge-fw01');
    expect(q.sourceVrf).toBe('PRODUCTION');
    expect(q.sourceIp).toBe('10.100.10.1');
    expect(q.destIp).toBe('192.168.50.10');
    expect(q.protocol).toBe('tcp');
    expect(q.destPort).toBe('5432');
  });

  test('falls back sensibly when rule fields are "any"', () => {
    const q = deriveProbeQuery({
      ...baseRule,
      sourceVrf: 'any',
      sourceIp: 'any',
      destIp: 'any',
      protocol: 'any',
      destPort: 'any',
    }, fw);
    expect(q.sourceVrf).toBe(fw.vrfs[0].name);
    expect(q.sourceIp).toBeTruthy();
    expect(q.destIp).toBe('8.8.8.8');
    expect(q.protocol).toBe('tcp');
    expect(q.destPort).toBe('80');
  });

  test('uses the first port of a range or list spec', () => {
    expect(deriveProbeQuery({ ...baseRule, destPort: '8000-9000' }, fw).destPort).toBe('8000');
    expect(deriveProbeQuery({ ...baseRule, destPort: '80,443' }, fw).destPort).toBe('80');
  });
});
