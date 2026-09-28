import { describe, test, expect } from 'vitest';
import { assemble } from './index';
import { SEED_PROFILES } from '../parsers';

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

  test('an unreadable routing table falls back to config routes and says so', () => {
    const data = assemble('cisco_ios', { config: CONFIG, routes: '% Invalid input detected' }, SEED_PROFILES);
    expect(data.ribVrfs).toEqual([]);
    expect(data.routes.map(r => r.destination)).toEqual(['10.50.0.0/16']);
    expect(data.routes[0].origin).toBeUndefined();
    expect(data.warnings.join(' ')).toMatch(/routing table could not be read/);
  });
});
