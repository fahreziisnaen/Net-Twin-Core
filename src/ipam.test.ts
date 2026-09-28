import { describe, test, expect } from 'vitest';
import { enumerateSubnets, computeSubnetUsage, groupByVlan, IpReservation } from './ipam';
import { getSeedNodes } from './seedData';
import { NetworkNode } from './types';

const nodes = getSeedNodes();

describe('enumerateSubnets', () => {
  test('lists unique subnets derived from interface CIDRs with VRF', () => {
    const subnets = enumerateSubnets(nodes, []);
    const cidrs = subnets.map(s => s.cidr);
    expect(cidrs).toContain('10.100.20.0/24');
    expect(cidrs).toContain('10.100.1.0/30');
    expect(cidrs).toContain('192.168.50.0/24');
    // deduped: 10.100.20.0/24 appears once even though several interfaces reference it
    expect(cidrs.filter(c => c === '10.100.20.0/24').length).toBe(1);
    const prod = subnets.find(s => s.cidr === '10.100.20.0/24')!;
    expect(prod.vrf).toBe('PRODUCTION');
  });

  test('reports usage counts per subnet', () => {
    const subnets = enumerateSubnets(nodes, []);
    const prod = subnets.find(s => s.cidr === '10.100.20.0/24')!;
    expect(prod.totalUsable).toBe(254);
    expect(prod.usedCount).toBe(2);     // .1 gateway + .10 web
    expect(prod.freeCount).toBe(252);
  });
});

describe('computeSubnetUsage', () => {
  test('/24: used shows interface owners, free lists the rest, nextFree is first gap', () => {
    const r = computeSubnetUsage('10.100.20.0/24', nodes, []);
    expect(r.info.totalUsable).toBe(254);
    const usedIps = r.used.map(u => u.ip).sort();
    expect(usedIps).toEqual(['10.100.20.1', '10.100.20.10']);
    expect(r.used.find(u => u.ip === '10.100.20.1')!.owner).toBe('Core-R1');
    expect(r.used.find(u => u.ip === '10.100.20.10')!.owner).toBe('Prod-Web-01');
    expect(r.freeCount).toBe(252);
    expect(r.free).not.toContain('10.100.20.1');
    expect(r.free).toContain('10.100.20.2');
    expect(r.nextFree).toBe('10.100.20.2');
  });

  test('/30 point-to-point: 2 usable, both used, no free', () => {
    const r = computeSubnetUsage('10.100.1.0/30', nodes, []);
    expect(r.info.totalUsable).toBe(2);
    expect(r.used.map(u => u.ip).sort()).toEqual(['10.100.1.1', '10.100.1.2']);
    expect(r.freeCount).toBe(0);
    expect(r.nextFree).toBeNull();
  });

  test('manual reservation counts as used and carries its note', () => {
    const res: IpReservation[] = [{ id: 'r1', ip: '10.100.20.50', note: 'Printer Floor 3', createdAt: '' }];
    const r = computeSubnetUsage('10.100.20.0/24', nodes, res);
    expect(r.usedCount).toBe(3);
    const printer = r.used.find(u => u.ip === '10.100.20.50')!;
    expect(printer.kind).toBe('reserved');
    expect(printer.detail).toBe('Printer Floor 3');
    expect(r.free).not.toContain('10.100.20.50');
  });

  test('network and broadcast addresses are never offered as free', () => {
    const r = computeSubnetUsage('10.100.20.0/24', nodes, []);
    expect(r.free).not.toContain('10.100.20.0');    // network
    expect(r.free).not.toContain('10.100.20.255');  // broadcast
  });

  test('large subnets are capped: free list is sampled but counts stay exact', () => {
    // a /16 device: 65534 usable, only enumerate a sample
    const big: NetworkNode[] = [{
      id: 'big', name: 'Big', type: 'router', status: 'online',
      vrfs: [{ name: 'default', description: '', interfaces: [{ name: 'e0', ip: '172.16.0.1/16', status: 'up' }], routes: [] }],
    }];
    const r = computeSubnetUsage('172.16.0.0/16', big, []);
    expect(r.info.totalUsable).toBe(65534);
    expect(r.freeCount).toBe(65533);
    expect(r.freeCapped).toBe(true);
    expect(r.free.length).toBeLessThanOrEqual(1024);
    expect(r.nextFree).toBe('172.16.0.2');
  });
});

describe('groupByVlan', () => {
  test('groups subnets by their interface VLAN id when present', () => {
    const vnodes: NetworkNode[] = [{
      id: 'sw', name: 'SW', type: 'switch', status: 'online',
      vrfs: [{
        name: 'default', description: '', interfaces: [
          { name: 'vlan10', ip: '10.10.10.1/24', status: 'up', vlan: 10 },
          { name: 'vlan20', ip: '10.10.20.1/24', status: 'up', vlan: 20 },
        ], routes: [],
      }],
    }];
    const groups = groupByVlan(enumerateSubnets(vnodes, []));
    const vlan10 = groups.find(g => g.vlan === 10)!;
    expect(vlan10.subnets.map(s => s.cidr)).toContain('10.10.10.0/24');
    expect(groups.find(g => g.vlan === 20)!.subnets[0].cidr).toBe('10.10.20.0/24');
  });
});
