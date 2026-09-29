import { describe, test, expect } from 'vitest';
import { uniqueNodeId, mergeIntoNode, buildNode, IncomingConfig } from './nodeUtils';
import { getSeedNodes, getSeedLinks } from './seedData';
import { NetworkNode, Route, PathQuery } from './types';
import { executeSimulation } from './engine';

const empty: IncomingConfig = { interfaces: [], routes: [], firewallRules: [], natMappings: [] };

describe('uniqueNodeId', () => {
  test('never collides with an existing device', () => {
    const nodes = getSeedNodes();
    const existing = nodes[0];
    const id = uniqueNodeId(existing.id, nodes);
    expect(id).not.toBe(existing.id);
    expect(nodes.some(n => n.id === id)).toBe(false);
    expect(uniqueNodeId('Brand New Router', nodes)).toBe('brand-new-router');
    expect(uniqueNodeId('***', [])).toBe('device');
  });
});

describe('mergeIntoNode', () => {
  const fw = getSeedNodes().find(n => n.type === 'firewall')!;

  test('merging nothing changes nothing that matters', () => {
    const merged = mergeIntoNode(fw, empty);
    expect(merged.type).toBe('firewall');
    expect(merged.name).toBe(fw.name);
    expect(merged.firewallRules).toEqual(fw.firewallRules);
    expect(merged.natMappings).toEqual(fw.natMappings);
    expect(merged.vrfs.map(v => v.interfaces.length)).toEqual(fw.vrfs.map(v => v.interfaces.length));
  });

  test('updates interface IPs by name and adds new interfaces with connected routes', () => {
    const existingIf = fw.vrfs[0].interfaces[0];
    const merged = mergeIntoNode(fw, {
      ...empty,
      interfaces: [
        { name: existingIf.name, ip: '10.9.9.1/24', status: 'up' },
        { name: 'port99', ip: '172.31.0.1/24', status: 'up', vrf: 'LAB' },
      ],
    });
    expect(merged.vrfs[0].interfaces.find(i => i.name === existingIf.name)!.ip).toBe('10.9.9.1/24');
    const lab = merged.vrfs.find(v => v.name === 'LAB')!;
    expect(lab.interfaces.map(i => i.name)).toEqual(['port99']);
    expect(lab.routes.some(r => r.protocol === 'Connected' && r.nextHop === 'port99')).toBe(true);
  });

  test('re-applying the same data is idempotent and strips UI fields', () => {
    const incoming: IncomingConfig = {
      interfaces: [],
      routes: [{ id: 'x', destination: '10.77.0.0/16', nextHop: '10.0.0.1', protocol: 'Static', metric: 1, vrf: 'default', _include: true } as any],
      firewallRules: [{ id: 'r', name: 'n', sourceVrf: 'any', destVrf: 'any', sourceIp: 'any', destIp: '10.77.0.5/32', protocol: 'tcp', sourcePort: 'any', destPort: '22', action: 'permit', description: '', _key: 3 } as any],
      natMappings: [{ type: 'Static NAT', insideLocal: '10.77.0.5', insideGlobal: '198.51.100.77', vrf: 'default' }],
    };
    const once = mergeIntoNode(fw, incoming);
    const twice = mergeIntoNode(once, incoming);
    expect(twice.firewallRules!.length).toBe(fw.firewallRules!.length + 1);
    expect(twice.natMappings!.length).toBe(fw.natMappings!.length + 1);
    const allRoutes = twice.vrfs.flatMap(v => v.routes).filter(r => r.destination === '10.77.0.0/16');
    expect(allRoutes).toHaveLength(1);
    expect(JSON.stringify(twice)).not.toMatch(/"_include"|"_key"/);
  });
});

describe('mergeIntoNode with a live routing table', () => {
  const route = (over: Partial<Route>): Route => ({ id: 'x', destination: '0.0.0.0/0', nextHop: '10.0.0.1', protocol: 'Static', metric: 0, vrf: 'default', ...over });
  const router = (): NetworkNode => ({
    id: 'r1', name: 'R1', type: 'router', status: 'online', rev: 4,
    vrfs: [
      {
        name: 'default', description: '',
        interfaces: [{ name: 'Gi0', ip: '10.9.9.1/24', status: 'up' }],
        routes: [
          route({ id: 'c', destination: '10.9.9.1/24', nextHop: 'Gi0', protocol: 'Connected' }),
          route({ id: 'manual', destination: '10.50.0.0/16', nextHop: '10.9.9.254' }),
          route({ id: 'stale-ospf', destination: '10.60.0.0/16', nextHop: '10.9.9.2', protocol: 'OSPF' }),
          route({ id: 'stale-rib-static', destination: '10.70.0.0/16', nextHop: '10.9.9.3', origin: 'rib' }),
        ],
      },
      { name: 'OTHER', description: '', interfaces: [], routes: [route({ id: 'other-bgp', destination: '172.20.0.0/16', protocol: 'BGP', vrf: 'OTHER' })] },
    ],
  });
  const fresh: IncomingConfig = {
    ...empty,
    routes: [
      route({ destination: '10.9.9.0/24', nextHop: 'Gi0', protocol: 'Connected', origin: 'rib' }),
      route({ destination: '10.61.0.0/16', nextHop: '10.9.9.2', protocol: 'OSPF', origin: 'rib' }),
    ],
  };

  test('routes the device no longer has disappear; user-modelled routes stay', () => {
    const merged = mergeIntoNode(router(), fresh, { ribVrfs: ['default'] });
    const ids = merged.vrfs[0].routes.map(r => r.destination).sort();
    expect(ids).toEqual(['10.50.0.0/16', '10.61.0.0/16', '10.9.9.1/24']);
  });

  test('VRFs whose table was not read keep their learned routes', () => {
    const merged = mergeIntoNode(router(), fresh, { ribVrfs: ['default'] });
    expect(merged.vrfs[1].routes.map(r => r.destination)).toEqual(['172.20.0.0/16']);
  });

  test('the RIB form of an interface subnet does not duplicate its connected route', () => {
    const merged = mergeIntoNode(router(), fresh, { ribVrfs: ['default'] });
    expect(merged.vrfs[0].routes.filter(r => r.protocol === 'Connected')).toHaveLength(1);
  });

  test('syncing twice gives the same routes', () => {
    const once = mergeIntoNode(router(), fresh, { ribVrfs: ['default'] });
    const twice = mergeIntoNode(once, fresh, { ribVrfs: ['default'] });
    expect(twice.vrfs[0].routes.map(r => r.destination).sort()).toEqual(once.vrfs[0].routes.map(r => r.destination).sort());
  });

  test('without a routing table (config import) nothing is removed', () => {
    const merged = mergeIntoNode(router(), fresh);
    expect(merged.vrfs[0].routes.some(r => r.destination === '10.60.0.0/16')).toBe(true);
  });
});

describe('mergeIntoNode on a firewall (VRFs are security zones)', () => {
  const seedFw = () => getSeedNodes().find(n => n.id === 'edge-fw01')!;
  // The seed SRX's own routing table, as `show route` reports it: one table.
  const rib = (withCorporate = true): Route[] => [
    { destination: '198.51.100.0/29', nextHop: 'ge-0/0/0', protocol: 'Connected' },
    { destination: '10.100.1.0/30', nextHop: 'ge-0/0/1', protocol: 'Connected' },
    { destination: '10.200.1.0/30', nextHop: 'ge-0/0/2', protocol: 'Connected' },
    { destination: '192.168.50.0/24', nextHop: 'ge-0/0/3', protocol: 'Connected' },
    { destination: '10.100.0.0/16', nextHop: '10.100.1.1', protocol: 'OSPF' },
    ...(withCorporate ? [{ destination: '10.200.0.0/16', nextHop: '10.200.1.1', protocol: 'OSPF' as const }] : []),
    { destination: '0.0.0.0/0', nextHop: '198.51.100.1', protocol: 'Static' },
  ].map((r, i) => ({ id: `r${i}`, metric: 0, vrf: 'default', origin: 'rib' as const, ...r }) as Route);
  const syncFw = (withCorporate = true) => mergeIntoNode(seedFw(), { ...empty, routes: rib(withCorporate) }, { ribVrfs: ['default'] });
  const allRoutes = (n: NetworkNode) => n.vrfs.flatMap(v => v.routes.map(r => ({ ...r, zone: v.name })));

  test('each learned route lands in the zone that owns its egress interface, once', () => {
    const routes = allRoutes(syncFw());
    expect(routes.filter(r => r.destination === '10.100.0.0/16').map(r => r.zone)).toEqual(['PRODUCTION']);
    expect(routes.filter(r => r.destination === '10.200.0.0/16').map(r => r.zone)).toEqual(['CORPORATE']);
  });

  test('no zone gains duplicate connected routes and no VRF is added', () => {
    const before = seedFw();
    const after = syncFw();
    expect(after.vrfs.map(v => v.name)).toEqual(before.vrfs.map(v => v.name));
    for (const v of after.vrfs) {
      expect(v.routes.filter(r => r.protocol === 'Connected').length)
        .toBe(before.vrfs.find(b => b.name === v.name)!.routes.filter(r => r.protocol === 'Connected').length);
    }
  });

  test('a route the firewall withdrew disappears from every zone', () => {
    expect(allRoutes(syncFw(false)).some(r => r.destination === '10.200.0.0/16')).toBe(false);
  });

  test('syncing a routing table that matches the model changes no simulation outcome', () => {
    const nodes = getSeedNodes();
    const links = getSeedLinks();
    const synced = nodes.map(n => (n.id === 'edge-fw01' ? syncFw() : n));
    const flows: PathQuery[] = [
      { sourceNodeId: 'corp-pc-01', sourceVrf: 'CORPORATE', sourceIp: '10.200.15.42', destIp: '10.100.20.10', protocol: 'tcp', sourcePort: '40000', destPort: '443' },
      { sourceNodeId: 'corp-pc-01', sourceVrf: 'CORPORATE', sourceIp: '10.200.15.42', destIp: '192.168.50.10', protocol: 'tcp', sourcePort: '40000', destPort: '5432' },
      { sourceNodeId: 'internet', sourceVrf: 'default', sourceIp: '203.0.113.50', destIp: '198.51.100.10', protocol: 'tcp', sourcePort: '51112', destPort: '443' },
      { sourceNodeId: 'internet', sourceVrf: 'default', sourceIp: '203.0.113.50', destIp: '192.168.50.10', protocol: 'tcp', sourcePort: '51112', destPort: '5432' },
      { sourceNodeId: 'prod-web-01', sourceVrf: 'PRODUCTION', sourceIp: '10.100.20.10', destIp: '8.8.8.8', protocol: 'tcp', sourcePort: '1022', destPort: '53' },
    ];
    for (const f of flows) {
      expect(executeSimulation(synced, links, f).status).toBe(executeSimulation(nodes, links, f).status);
    }
  });

  test('a new firewall built from collected data places routes in its zones', () => {
    const node = buildNode('fw9', 'FW9', 'firewall', {
      ...empty,
      interfaces: [
        { name: 'ge-0/0/0', ip: '203.0.113.2/29', status: 'up', vrf: 'untrust' },
        { name: 'ge-0/0/1', ip: '10.1.1.1/24', status: 'up', vrf: 'trust' },
      ],
      routes: [
        { id: 'a', destination: '0.0.0.0/0', nextHop: '203.0.113.1', protocol: 'Static', metric: 0, vrf: 'default', origin: 'rib' },
        { id: 'b', destination: '10.50.0.0/16', nextHop: '10.1.1.254', protocol: 'OSPF', metric: 0, vrf: 'default', origin: 'rib' },
      ],
    }, { ribVrfs: ['default'] });
    expect(node.vrfs.map(v => v.name).sort()).toEqual(['trust', 'untrust']);
    expect(node.vrfs.find(v => v.name === 'untrust')!.routes.some(r => r.destination === '0.0.0.0/0')).toBe(true);
    expect(node.vrfs.find(v => v.name === 'trust')!.routes.some(r => r.destination === '10.50.0.0/16')).toBe(true);
  });
});

describe('buildNode', () => {
  test('always has at least one VRF', () => {
    const n = buildNode('x', 'X', 'router', empty);
    expect(n.vrfs).toHaveLength(1);
    expect(n.vrfs[0].name).toBe('default');
  });
});
