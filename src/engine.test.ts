import { describe, test, expect } from 'vitest';
import { executeSimulation, matchCidr, matchPort, DEFAULT_SETTINGS } from './engine';
import { getSeedNodes, getSeedLinks } from './seedData';
import { NetworkNode, NetworkLink, PathQuery } from './types';

const nodes = getSeedNodes();
const links = getSeedLinks();

const q = (over: Partial<PathQuery>): PathQuery => ({
  sourceNodeId: 'corp-pc-01',
  sourceVrf: 'CORPORATE',
  sourceIp: '10.200.15.42',
  destIp: '10.100.20.10',
  protocol: 'tcp',
  sourcePort: '40000',
  destPort: '443',
  ...over,
});

const fwHop = (result: ReturnType<typeof executeSimulation>) =>
  result.hops.find(h => h.nodeId === 'edge-fw01');

describe('seed topology reference flows', () => {
  test('corp PC reaches prod web server over HTTPS via firewall rule_1 (inter-VRF forwarding)', () => {
    const result = executeSimulation(nodes, links, q({}));
    expect(result.status).toBe('SUCCESS');
    expect(fwHop(result)?.firewallRuleMatched?.id).toBe('rule_1');
    expect(result.hops[result.hops.length - 1].decision).toBe('Reached Destination');
  });

  test('prod web server reaches internet 8.8.8.8 via rule_3 with static source NAT applied', () => {
    const result = executeSimulation(nodes, links, q({
      sourceNodeId: 'prod-web-01',
      sourceVrf: 'PRODUCTION',
      sourceIp: '10.100.20.10',
      destIp: '8.8.8.8',
      destPort: '443',
    }));
    expect(result.status).toBe('SUCCESS');
    expect(fwHop(result)?.firewallRuleMatched?.id).toBe('rule_3');
    expect(fwHop(result)?.natApplied?.after).toContain('198.51.100.10');
  });

  test('corp PC to PCI database is blocked by the explicit PCI isolation rule, not implicit deny', () => {
    const result = executeSimulation(nodes, links, q({ destIp: '192.168.50.10', destPort: '5432' }));
    expect(result.status).toBe('BLOCKED_BY_FIREWALL');
    expect(fwHop(result)?.firewallRuleMatched?.id).toBe('rule_pci_deny_all');
  });

  test('internet host to PCI database is blocked by the explicit PCI isolation rule', () => {
    const result = executeSimulation(nodes, links, q({
      sourceNodeId: 'internet',
      sourceVrf: 'default',
      sourceIp: '203.0.113.50',
      destIp: '192.168.50.10',
      destPort: '5432',
    }));
    expect(result.status).toBe('BLOCKED_BY_FIREWALL');
    expect(fwHop(result)?.firewallRuleMatched?.id).toBe('rule_pci_deny_all');
  });

  test('inbound static NAT: internet client reaches prod web via public IP 198.51.100.10', () => {
    const result = executeSimulation(nodes, links, q({
      sourceNodeId: 'internet',
      sourceVrf: 'default',
      sourceIp: '203.0.113.50',
      destIp: '198.51.100.10',
      destPort: '443',
    }));
    expect(result.status).toBe('SUCCESS');
    expect(fwHop(result)?.natApplied?.type).toContain('NAT');
    expect(fwHop(result)?.firewallRuleMatched?.id).toBe('rule_5');
    expect(result.hops[result.hops.length - 1].nodeId).toBe('prod-web-01');
  });

  test('corp PC outbound to internet gets PAT source translation to 198.51.100.2', () => {
    const result = executeSimulation(nodes, links, q({ destIp: '8.8.8.8', destPort: '53' }));
    expect(result.status).toBe('SUCCESS');
    expect(fwHop(result)?.firewallRuleMatched?.id).toBe('rule_4');
    expect(fwHop(result)?.natApplied?.after).toBe('198.51.100.2');
  });

  test('prod app subnet reaches PCI database on 5432 via rule_2 (implied client host)', () => {
    const result = executeSimulation(nodes, links, q({
      sourceNodeId: 'core-r1',
      sourceVrf: 'PRODUCTION',
      sourceIp: '10.100.10.15',
      destIp: '192.168.50.10',
      destPort: '5432',
    }));
    expect(result.status).toBe('SUCCESS');
    expect(fwHop(result)?.firewallRuleMatched?.id).toBe('rule_2');
  });
});

// Minimal LAN -> firewall -> WAN fixture for focused rule-matching tests
function miniTopology(rules: NetworkNode['firewallRules']): { nodes: NetworkNode[]; links: NetworkLink[] } {
  const miniNodes: NetworkNode[] = [
    {
      id: 'host-a', name: 'Host-A', type: 'host', status: 'online',
      vrfs: [{
        name: 'LAN', description: '', interfaces: [{ name: 'eth0', ip: '10.0.0.10/24', status: 'up' }],
        routes: [
          { id: 'a1', destination: '10.0.0.0/24', nextHop: 'eth0', protocol: 'Connected', metric: 0, vrf: 'LAN' },
          { id: 'a2', destination: '0.0.0.0/0', nextHop: '10.0.0.1', protocol: 'Static', metric: 1, vrf: 'LAN' },
        ],
      }],
    },
    {
      id: 'mini-fw', name: 'Mini-FW', type: 'firewall', status: 'online',
      vrfs: [
        {
          name: 'LAN', description: '', interfaces: [{ name: 'ge0', ip: '10.0.0.1/24', status: 'up' }],
          routes: [{ id: 'f1', destination: '10.0.0.0/24', nextHop: 'ge0', protocol: 'Connected', metric: 0, vrf: 'LAN' }],
        },
        {
          name: 'WAN', description: '', interfaces: [{ name: 'ge1', ip: '203.0.113.1/24', status: 'up' }],
          routes: [{ id: 'f2', destination: '203.0.113.0/24', nextHop: 'ge1', protocol: 'Connected', metric: 0, vrf: 'WAN' }],
        },
      ],
      firewallRules: rules,
    },
    {
      id: 'host-b', name: 'Host-B', type: 'host', status: 'online',
      vrfs: [{
        name: 'WAN', description: '', interfaces: [{ name: 'eth0', ip: '203.0.113.80/24', status: 'up' }],
        routes: [
          { id: 'b1', destination: '203.0.113.0/24', nextHop: 'eth0', protocol: 'Connected', metric: 0, vrf: 'WAN' },
          { id: 'b2', destination: '0.0.0.0/0', nextHop: '203.0.113.1', protocol: 'Static', metric: 1, vrf: 'WAN' },
        ],
      }],
    },
  ];
  const miniLinks: NetworkLink[] = [
    { id: 'ml1', sourceNodeId: 'host-a', sourceInterface: 'eth0', destNodeId: 'mini-fw', destInterface: 'ge0' },
    { id: 'ml2', sourceNodeId: 'mini-fw', sourceInterface: 'ge1', destNodeId: 'host-b', destInterface: 'eth0' },
  ];
  return { nodes: miniNodes, links: miniLinks };
}

const miniQuery = (over: Partial<PathQuery> = {}): PathQuery => ({
  sourceNodeId: 'host-a',
  sourceVrf: 'LAN',
  sourceIp: '10.0.0.10',
  destIp: '203.0.113.80',
  protocol: 'tcp',
  sourcePort: '50123',
  destPort: '8443',
  ...over,
});

describe('firewall port matching', () => {
  const rangeRule = {
    id: 'r_range', name: 'Range rule', sourceVrf: 'LAN', destVrf: 'WAN',
    sourceIp: 'any', destIp: 'any', protocol: 'tcp' as const,
    sourcePort: 'any', destPort: '8000-9000', action: 'permit' as const, description: '',
  };

  test('destination port range 8000-9000 matches port 8443', () => {
    const { nodes: n, links: l } = miniTopology([rangeRule]);
    const result = executeSimulation(n, l, miniQuery({ destPort: '8443' }));
    expect(result.status).toBe('SUCCESS');
  });

  test('destination port range 8000-9000 does not match port 9500', () => {
    const { nodes: n, links: l } = miniTopology([rangeRule]);
    const result = executeSimulation(n, l, miniQuery({ destPort: '9500' }));
    expect(result.status).toBe('BLOCKED_BY_FIREWALL');
  });

  test('destination port list 80,443 matches port 443', () => {
    const { nodes: n, links: l } = miniTopology([{ ...rangeRule, destPort: '80,443' }]);
    const result = executeSimulation(n, l, miniQuery({ destPort: '443' }));
    expect(result.status).toBe('SUCCESS');
  });

  test('icmp traffic ignores port fields in rules', () => {
    const { nodes: n, links: l } = miniTopology([{ ...rangeRule, protocol: 'icmp' as const }]);
    const result = executeSimulation(n, l, miniQuery({ protocol: 'icmp', sourcePort: '', destPort: '' }));
    expect(result.status).toBe('SUCCESS');
  });
});

describe('routing behaviour', () => {
  test('administrative distance: static route preferred over OSPF at equal prefix length', () => {
    const router: NetworkNode = {
      id: 'r1', name: 'R1', type: 'router', status: 'online',
      vrfs: [{
        name: 'default', description: '', interfaces: [{ name: 'eth0', ip: '10.0.0.1/24', status: 'up' }],
        routes: [
          { id: 'ospf', destination: '172.16.5.0/24', nextHop: '10.0.0.3', protocol: 'OSPF', metric: 1, vrf: 'default' },
          { id: 'static', destination: '172.16.5.0/24', nextHop: '10.0.0.2', protocol: 'Static', metric: 5, vrf: 'default' },
        ],
      }],
    };
    const result = executeSimulation([router], [], {
      sourceNodeId: 'r1', sourceVrf: 'default', sourceIp: '10.0.0.1',
      destIp: '172.16.5.5', protocol: 'tcp', sourcePort: '1', destPort: '80',
    });
    expect(result.hops[0].routeMatched?.protocol).toBe('Static');
  });

  test('unresolvable next hop reports No Route instead of guessing an egress interface', () => {
    const router: NetworkNode = {
      id: 'r1', name: 'R1', type: 'router', status: 'online',
      vrfs: [{
        name: 'default', description: '', interfaces: [{ name: 'eth0', ip: '10.0.0.1/24', status: 'up' }],
        routes: [
          { id: 'bad', destination: '0.0.0.0/0', nextHop: '192.168.99.1', protocol: 'Static', metric: 1, vrf: 'default' },
        ],
      }],
    };
    const result = executeSimulation([router], [], {
      sourceNodeId: 'r1', sourceVrf: 'default', sourceIp: '10.0.0.1',
      destIp: '8.8.8.8', protocol: 'tcp', sourcePort: '1', destPort: '80',
    });
    expect(result.status).toBe('NO_ROUTE');
    expect(result.hops[0].decision).toBe('No Route');
    expect(result.hops[0].egressInterface).toBeNull();
  });

  test('routers do NOT leak between VRFs (isolation preserved)', () => {
    const router: NetworkNode = {
      id: 'r1', name: 'R1', type: 'router', status: 'online',
      vrfs: [
        {
          name: 'BLUE', description: '', interfaces: [{ name: 'eth0', ip: '10.1.0.1/24', status: 'up' }],
          routes: [{ id: 'b1', destination: '10.1.0.0/24', nextHop: 'eth0', protocol: 'Connected', metric: 0, vrf: 'BLUE' }],
        },
        {
          name: 'RED', description: '', interfaces: [{ name: 'eth1', ip: '10.2.0.1/24', status: 'up' }],
          routes: [{ id: 'rr1', destination: '10.2.0.0/24', nextHop: 'eth1', protocol: 'Connected', metric: 0, vrf: 'RED' }],
        },
      ],
    };
    const result = executeSimulation([router], [], {
      sourceNodeId: 'r1', sourceVrf: 'BLUE', sourceIp: '10.1.0.1',
      destIp: '10.2.0.99', protocol: 'tcp', sourcePort: '1', destPort: '80',
    });
    expect(result.status).toBe('NO_ROUTE');
  });

  test('routing loops are detected', () => {
    const mk = (id: string, ip: string, peer: string): NetworkNode => ({
      id, name: id, type: 'router', status: 'online',
      vrfs: [{
        name: 'default', description: '', interfaces: [{ name: 'eth0', ip, status: 'up' }],
        routes: [
          { id: `${id}_c`, destination: '10.9.9.0/30', nextHop: 'eth0', protocol: 'Connected', metric: 0, vrf: 'default' },
          { id: `${id}_d`, destination: '0.0.0.0/0', nextHop: peer, protocol: 'Static', metric: 1, vrf: 'default' },
        ],
      }],
    });
    const loopNodes = [mk('ra', '10.9.9.1/30', '10.9.9.2'), mk('rb', '10.9.9.2/30', '10.9.9.1')];
    const loopLinks: NetworkLink[] = [
      { id: 'll', sourceNodeId: 'ra', sourceInterface: 'eth0', destNodeId: 'rb', destInterface: 'eth0' },
    ];
    const result = executeSimulation(loopNodes, loopLinks, {
      sourceNodeId: 'ra', sourceVrf: 'default', sourceIp: '10.9.9.1',
      destIp: '8.8.8.8', protocol: 'tcp', sourcePort: '1', destPort: '80',
    });
    expect(result.hops.some(h => h.decision === 'Loop Detected')).toBe(true);
  });
});

describe('simulation settings', () => {
  test('implicitDeny=false forwards unmatched firewall traffic', () => {
    const { nodes: n, links: l } = miniTopology([{
      id: 'nomatch', name: 'No match', sourceVrf: 'LAN', destVrf: 'WAN',
      sourceIp: '172.31.0.0/16', destIp: 'any', protocol: 'tcp',
      sourcePort: 'any', destPort: 'any', action: 'permit', description: '',
    }]);
    const blocked = executeSimulation(n, l, miniQuery());
    expect(blocked.status).toBe('BLOCKED_BY_FIREWALL');

    const allowed = executeSimulation(n, l, miniQuery(), { ...DEFAULT_SETTINGS, implicitDeny: false });
    expect(allowed.status).toBe('SUCCESS');
  });

  test('maxHops setting caps the trace', () => {
    const result = executeSimulation(nodes, links, q({ destIp: '8.8.8.8' }), { ...DEFAULT_SETTINGS, maxHops: 2 });
    expect(result.status).toBe('MAX_HOPS_EXCEEDED');
  });
});

describe('matchers', () => {
  test('matchCidr basics', () => {
    expect(matchCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(matchCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(matchCidr('1.2.3.4', 'any')).toBe(true);
    expect(matchCidr('192.168.1.5', '192.168.1.5')).toBe(true);
  });

  test('matchPort supports any, exact, range and list', () => {
    expect(matchPort('any', '443')).toBe(true);
    expect(matchPort('443', '443')).toBe(true);
    expect(matchPort('443', '80')).toBe(false);
    expect(matchPort('1024-65535', '2000')).toBe(true);
    expect(matchPort('1024-65535', '80')).toBe(false);
    expect(matchPort('80,443,8080', '8080')).toBe(true);
    expect(matchPort('80,443,8080', '8081')).toBe(false);
  });
});
