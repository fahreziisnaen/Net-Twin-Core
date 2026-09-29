import { describe, test, expect } from 'vitest';
import { assemble, computeDrift } from './index';
import { SEED_PROFILES } from '../parsers';
import { getSeedNodes } from '../../src/seedData';

const GLOBAL_RIB = `Codes: L - local, C - connected, S - static, O - OSPF, B - BGP
Gateway of last resort is 203.0.113.1 to network 0.0.0.0

S*    0.0.0.0/0 [1/0] via 203.0.113.1
C        10.10.1.0/24 is directly connected, GigabitEthernet0/1
O        10.20.0.0/16 [110/2] via 10.10.1.254, 00:05:23, GigabitEthernet0/1`;

const VRF_RIB = `Routing Table: PRODUCTION
Codes: L - local, C - connected, S - static, O - OSPF, B - BGP
Gateway of last resort is not set

B        172.16.5.0/24 [20/0] via 10.100.1.2, 01:23:45`;

const CONFIG = `hostname EDGE-R1
!
ip route 10.50.0.0 255.255.0.0 192.0.2.1
`;

describe('assemble: live routing table vs config routes', () => {
  test('RIB routes are tagged as such and every table read is reported', () => {
    const data = assemble('cisco_ios', { config: CONFIG, routes: GLOBAL_RIB, vrfRoutes: VRF_RIB }, SEED_PROFILES);
    expect(data.ribVrfs).toEqual(['default', 'PRODUCTION']);
    expect(data.routes.every(r => r.origin === 'rib')).toBe(true);
    expect(data.routes.map(r => r.destination)).toContain('172.16.5.0/24');
    // The live table wins over the config's static routes.
    expect(data.routes.some(r => r.destination === '10.50.0.0/16')).toBe(false);
  });

  test('a VRF whose table could not be read keeps its config static routes', () => {
    const cfg = `${CONFIG}ip route vrf PRODUCTION 10.60.0.0 255.255.0.0 10.100.1.2\n`;
    const data = assemble('cisco_ios', { config: cfg, routes: GLOBAL_RIB, vrfRoutes: '% Invalid input detected' }, SEED_PROFILES);
    expect(data.ribVrfs).toEqual(['default']);
    const vrfStatic = data.routes.find(r => r.destination === '10.60.0.0/16');
    expect(vrfStatic).toMatchObject({ vrf: 'PRODUCTION', nextHop: '10.100.1.2' });
    expect(vrfStatic!.origin).toBeUndefined();
    expect(data.routes.some(r => r.destination === '10.50.0.0/16')).toBe(false); // default table was read
    expect(data.warnings.join(' ')).toMatch(/PRODUCTION/);
  });

  test('an unreadable routing table falls back to config routes and says so', () => {
    const data = assemble('cisco_ios', { config: CONFIG, routes: '% Invalid input detected' }, SEED_PROFILES);
    expect(data.ribVrfs).toEqual([]);
    expect(data.routes.map(r => r.destination)).toEqual(['10.50.0.0/16']);
    expect(data.routes[0].origin).toBeUndefined();
    expect(data.warnings.join(' ')).toMatch(/routing table could not be read/);
  });
});

describe('computeDrift: preview of what Apply will change', () => {
  // Core-R1 of the seed topology, as its own routing table reports it.
  const coreR1 = (withOspf200 = true) => `Routing Table: PRODUCTION
Codes: L - local, C - connected, S - static, O - OSPF, B - BGP
Gateway of last resort is 10.100.1.2 to network 0.0.0.0

S*    0.0.0.0/0 [1/0] via 10.100.1.2
C        10.100.1.0/30 is directly connected, GigabitEthernet1
C        10.100.10.0/24 is directly connected, GigabitEthernet3
C        10.100.20.0/24 is directly connected, GigabitEthernet2
O        192.168.50.0/24 [110/2] via 10.100.1.2, 00:10:00, GigabitEthernet1
${withOspf200 ? 'O        10.200.0.0/16 [110/2] via 10.100.1.2, 00:10:00, GigabitEthernet1' : ''}

Routing Table: PCI-ZONE
Codes: L - local, C - connected, S - static, O - OSPF, B - BGP
Gateway of last resort is 192.168.50.2 to network 0.0.0.0

S*    0.0.0.0/0 [1/0] via 192.168.50.2
C        192.168.50.0/24 is directly connected, GigabitEthernet4
`;
  const target = () => getSeedNodes().find(n => n.id === 'core-r1')!;

  test('a device matching the twin shows no route changes', () => {
    const data = assemble('cisco_ios', { vrfRoutes: coreR1() }, SEED_PROFILES);
    expect(computeDrift(data, target()).routes).toEqual({ added: 0, removed: 0 });
  });

  test('only changes Apply will actually make are counted', () => {
    const node = target();
    const prod = node.vrfs.find(v => v.name === 'PRODUCTION')!;
    // Connected route recorded in interface-address form (as merges create it),
    // plus a user-modelled static the device doesn't have (Apply keeps it).
    prod.routes = prod.routes.map(r => (r.destination === '10.100.10.0/24' ? { ...r, destination: '10.100.10.1/24' } : r));
    prod.routes.push({ id: 'm', destination: '10.99.0.0/16', nextHop: '10.100.1.2', protocol: 'Static', metric: 0, vrf: 'PRODUCTION' });
    const data = assemble('cisco_ios', { vrfRoutes: coreR1() }, SEED_PROFILES);
    expect(computeDrift(data, node).routes).toEqual({ added: 0, removed: 0 });
  });

  test('a route the device withdrew is reported as removed', () => {
    const data = assemble('cisco_ios', { vrfRoutes: coreR1(false) }, SEED_PROFILES);
    expect(computeDrift(data, target()).routes).toEqual({ added: 0, removed: 1 });
  });
});
