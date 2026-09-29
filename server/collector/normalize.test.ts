import { describe, test, expect } from 'vitest';
import { normalizeRoutes, normalizeRib, normalizeVrfRib, normalizeArp, normalizeNeighbors } from './normalize';

const ROUTE_OUT = `Codes: L - local, C - connected, S - static, O - OSPF, B - BGP
Gateway of last resort is 203.0.113.1 to network 0.0.0.0

S*    0.0.0.0/0 [1/0] via 203.0.113.1
      10.0.0.0/8 is variably subnetted, 3 subnets, 2 masks
C        10.10.1.0/24 is directly connected, GigabitEthernet0/1
L        10.10.1.1/32 is directly connected, GigabitEthernet0/1
O        10.20.0.0/16 [110/2] via 10.10.1.254, 00:05:23, GigabitEthernet0/1
B        172.16.5.0/24 [20/0] via 10.10.1.253, 01:23:45`;

const ARP_OUT = `Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  10.10.1.1               -   aabb.cc00.1000  ARPA   GigabitEthernet0/1
Internet  10.10.1.10             12   aabb.cc00.2000  ARPA   GigabitEthernet0/1
Internet  10.10.1.25              4   aabb.cc00.3000  ARPA   GigabitEthernet0/1`;

const CDP_OUT = `-------------------------
Device ID: R2.lab.local
Entry address(es):
  IP address: 10.10.1.254
Platform: cisco C2900,  Capabilities: Router Switch
Interface: GigabitEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/2
Holdtime : 150 sec

-------------------------
Device ID: SW-ACCESS
Interface: GigabitEthernet0/2,  Port ID (outgoing port): GigabitEthernet1/0/24
Holdtime : 120 sec`;

describe('normalizeRoutes (cisco_ios)', () => {
  const routes = normalizeRoutes('cisco_ios', ROUTE_OUT, 'PRODUCTION');

  test('parses static default, connected, OSPF and BGP; skips local /32', () => {
    const byDest = Object.fromEntries(routes.map(r => [r.destination, r]));
    expect(byDest['0.0.0.0/0'].protocol).toBe('Static');
    expect(byDest['0.0.0.0/0'].nextHop).toBe('203.0.113.1');
    expect(byDest['10.10.1.0/24'].protocol).toBe('Connected');
    expect(byDest['10.10.1.0/24'].nextHop).toBe('GigabitEthernet0/1');
    expect(byDest['10.20.0.0/16'].protocol).toBe('OSPF');
    expect(byDest['10.20.0.0/16'].nextHop).toBe('10.10.1.254');
    expect(byDest['10.20.0.0/16'].metric).toBe(2);
    expect(byDest['172.16.5.0/24'].protocol).toBe('BGP');
    expect(byDest['10.10.1.1/32']).toBeUndefined(); // local route skipped
  });

  test('tags routes with the requested VRF', () => {
    expect(routes.every(r => r.vrf === 'PRODUCTION')).toBe(true);
  });
});

describe('normalizeArp (cisco_ios)', () => {
  test('extracts ip / mac / interface, skips header and incomplete', () => {
    const arp = normalizeArp('cisco_ios', ARP_OUT);
    expect(arp).toHaveLength(3);
    expect(arp[0]).toEqual({ ip: '10.10.1.1', mac: 'aabb.cc00.1000', iface: 'GigabitEthernet0/1' });
    expect(arp.map(a => a.ip)).toContain('10.10.1.25');
  });
});

describe('normalizeNeighbors (cisco_ios CDP detail)', () => {
  test('maps local interface -> remote device + remote interface', () => {
    const n = normalizeNeighbors('cisco_ios', CDP_OUT);
    expect(n).toHaveLength(2);
    expect(n[0]).toEqual({ localInterface: 'GigabitEthernet0/1', remoteDevice: 'R2.lab.local', remoteInterface: 'GigabitEthernet0/2' });
    expect(n[1].remoteDevice).toBe('SW-ACCESS');
    expect(n[1].remoteInterface).toBe('GigabitEthernet1/0/24');
  });
});

// ---- Juniper Junos -----------------------------------------------------------
const JUNOS_ROUTE = `inet.0: 5 destinations, 5 routes (5 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both

0.0.0.0/0          *[Static/5] 00:10:00
                    > to 203.0.113.1 via ge-0/0/0.0
10.10.1.0/24       *[Direct/0] 01:00:00
                    > via ge-0/0/1.0
10.20.0.0/16       *[OSPF/10] 00:05:00
                    > to 10.10.1.254 via ge-0/0/1.0
172.16.5.0/24      *[BGP/170] 00:02:00
                    > to 10.10.1.253 via ge-0/0/1.0`;

const JUNOS_ARP = `MAC Address       Address         Name                      Interface           Flags
aa:bb:cc:00:10:00 10.10.1.10      host1                     ge-0/0/1.0          none
aa:bb:cc:00:25:00 10.10.1.25      -                         ge-0/0/1.0          none`;

const JUNOS_LLDP = `Local Interface    Parent Interface    Chassis Id          Port info          System Name
ge-0/0/0.0         -                   aa:bb:cc:dd:ee:ff   ge-0/0/2           R2
ge-0/0/1.0         -                   aa:bb:cc:dd:ee:00   ge-1/0/24          SW-ACCESS`;

describe('normalizeRoutes (juniper_junos)', () => {
  const routes = normalizeRoutes('juniper_junos', JUNOS_ROUTE, 'default');
  test('parses two-line junos routes incl direct/ospf/bgp', () => {
    const by = Object.fromEntries(routes.map(r => [r.destination, r]));
    expect(by['0.0.0.0/0'].protocol).toBe('Static');
    expect(by['0.0.0.0/0'].nextHop).toBe('203.0.113.1');
    expect(by['10.10.1.0/24'].protocol).toBe('Connected');   // Direct -> Connected
    expect(by['10.20.0.0/16'].protocol).toBe('OSPF');
    expect(by['10.20.0.0/16'].nextHop).toBe('10.10.1.254');
    expect(by['172.16.5.0/24'].protocol).toBe('BGP');
  });
});

describe('normalizeArp (multi-vendor)', () => {
  test('junos', () => {
    const a = normalizeArp('juniper_junos', JUNOS_ARP);
    expect(a).toHaveLength(2);
    expect(a[0]).toEqual({ ip: '10.10.1.10', mac: 'aa:bb:cc:00:10:00', iface: 'ge-0/0/1.0' });
  });
  test('fortinet', () => {
    const out = `Address           Age(min)   Hardware Addr      Interface
10.10.1.10        0          aa:bb:cc:00:10:00  port2
10.10.1.25        3          aa:bb:cc:00:25:00  port2`;
    const a = normalizeArp('fortinet', out);
    expect(a).toHaveLength(2);
    expect(a[1]).toEqual({ ip: '10.10.1.25', mac: 'aa:bb:cc:00:25:00', iface: 'port2' });
  });
  test('panos', () => {
    const out = `interface       ip              mac               port            status
ethernet1/2     10.10.1.10      aa:bb:cc:00:10:00 ethernet1/2     c`;
    const a = normalizeArp('paloalto_panos', out);
    expect(a).toHaveLength(1);
    expect(a[0]).toEqual({ ip: '10.10.1.10', mac: 'aa:bb:cc:00:10:00', iface: 'ethernet1/2' });
  });
  test('screenos', () => {
    const out = `IP              Mac              VR/Interface          State
10.10.1.10      aabbcc001000     trust-vr/ethernet0/1  VLD`;
    const a = normalizeArp('juniper_screenos', out);
    expect(a).toHaveLength(1);
    expect(a[0].ip).toBe('10.10.1.10');
    expect(a[0].iface).toBe('ethernet0/1');
  });
});

describe('normalizeNeighbors (juniper_junos LLDP)', () => {
  test('local -> remote device/interface', () => {
    const n = normalizeNeighbors('juniper_junos', JUNOS_LLDP);
    expect(n).toHaveLength(2);
    expect(n[0]).toEqual({ localInterface: 'ge-0/0/0.0', remoteDevice: 'R2', remoteInterface: 'ge-0/0/2' });
    expect(n[1].remoteDevice).toBe('SW-ACCESS');
  });
});

// ---- Live routing tables (RIB) per vendor ----------------------------------
// Fixtures follow the vendors' documented output layouts.

const byDest = (routes: { destination: string }[]) => Object.fromEntries(routes.map(r => [r.destination, r])) as Record<string, any>;

describe('cisco_ios RIB', () => {
  const VRF_OUT = `Routing Table: PRODUCTION
Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       O - OSPF, IA - OSPF inter area
Gateway of last resort is not set

      10.0.0.0/8 is variably subnetted, 3 subnets, 2 masks
C        10.100.1.0/24 is directly connected, GigabitEthernet0/2
L        10.100.1.1/32 is directly connected, GigabitEthernet0/2
O IA     10.100.20.0/24 [110/3] via 10.100.1.2, 00:12:01, GigabitEthernet0/2

Routing Table: MGMT
Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
Gateway of last resort is not set
`;

  test('global table is labelled default and reported as read', () => {
    const rib = normalizeRib('cisco_ios', ROUTE_OUT);
    expect(rib.vrfs).toEqual(['default']);
    expect(rib.routes.every(r => r.vrf === 'default')).toBe(true);
  });

  test('`show ip route vrf *` yields one table per VRF, including empty ones', () => {
    const rib = normalizeVrfRib('cisco_ios', VRF_OUT);
    expect(rib.vrfs).toEqual(['PRODUCTION', 'MGMT']);
    const r = byDest(rib.routes);
    expect(r['10.100.20.0/24']).toMatchObject({ protocol: 'OSPF', nextHop: '10.100.1.2', metric: 3, vrf: 'PRODUCTION' });
    expect(r['10.100.1.0/24']).toMatchObject({ protocol: 'Connected', nextHop: 'GigabitEthernet0/2', vrf: 'PRODUCTION' });
    expect(r['10.100.1.1/32']).toBeUndefined();
  });

  test('an error instead of a table is not a (empty) table', () => {
    expect(normalizeRib('cisco_ios', "% Invalid input detected at '^' marker.")).toEqual({ routes: [], vrfs: [] });
    expect(normalizeVrfRib('cisco_ios', "% Invalid input detected at '^' marker.")).toEqual({ routes: [], vrfs: [] });
  });
});

describe('fortinet RIB (get router info routing-table all)', () => {
  const FORTI_OUT = `Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP
       O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2
       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area
       * - candidate default

Routing table for VRF=0
S*      0.0.0.0/0 [10/0] via 203.0.113.1, port1, [1/0]
C       10.10.1.0/24 is directly connected, port2
O       10.20.0.0/16 [110/2] via 10.10.1.254, port2, 00:05:23, [1/0]
O E2    10.99.0.0/16 [110/20] via 10.10.1.254, port2, 00:05:23, [1/0]
B       172.16.5.0/24 [20/0] via 10.10.1.253, port2, 01:23:45, [1/0]
`;

  test('parses static, connected, OSPF (incl. external) and BGP from VRF 0', () => {
    const rib = normalizeRib('fortinet', FORTI_OUT);
    expect(rib.vrfs).toEqual(['default']);
    const r = byDest(rib.routes);
    expect(r['0.0.0.0/0']).toMatchObject({ protocol: 'Static', nextHop: '203.0.113.1' });
    expect(r['10.10.1.0/24']).toMatchObject({ protocol: 'Connected', nextHop: 'port2' });
    expect(r['10.20.0.0/16']).toMatchObject({ protocol: 'OSPF', nextHop: '10.10.1.254', metric: 2 });
    expect(r['10.99.0.0/16'].protocol).toBe('OSPF');
    expect(r['172.16.5.0/24']).toMatchObject({ protocol: 'BGP', nextHop: '10.10.1.253' });
  });

  test('output without VRF headers (older FortiOS) is one default table', () => {
    const rib = normalizeRib('fortinet', FORTI_OUT.replace('Routing table for VRF=0\n', ''));
    expect(rib.vrfs).toEqual(['default']);
    expect(rib.routes).toHaveLength(5);
  });
});

describe('paloalto_panos RIB (show routing route)', () => {
  const PANOS_OUT = `flags: A:active, ?:loose, C:connect, H:host, S:static, ~:internal, R:rip, O:ospf, B:bgp,
       Oi:ospf intra-area, Oo:ospf inter-area, O1:ospf ext-type-1, O2:ospf ext-type-2, E:ecmp, M:multicast


VIRTUAL ROUTER: default (id 1)
  ==========
destination                                 nexthop                                 metric flags      age   interface          next-AS
0.0.0.0/0                                   203.0.113.1                             10     A S              ethernet1/1
10.10.1.0/24                                10.10.1.1                               0      A C              ethernet1/2
10.10.1.1/32                                0.0.0.0                                 0      A H
10.20.0.0/16                                10.10.1.254                             10     A Oi       1234  ethernet1/2
10.30.0.0/16                                10.10.1.250                             20       Oi       1234  ethernet1/2
172.16.5.0/24                               10.10.1.253                             0      A B        4321  ethernet1/2        65010
total routes shown: 6
`;

  test('active routes only; host routes skipped; connected resolves by interface', () => {
    const rib = normalizeRib('paloalto_panos', PANOS_OUT);
    expect(rib.vrfs).toEqual(['default']);
    const r = byDest(rib.routes);
    expect(Object.keys(r).sort()).toEqual(['0.0.0.0/0', '10.10.1.0/24', '10.20.0.0/16', '172.16.5.0/24']);
    expect(r['10.10.1.0/24']).toMatchObject({ protocol: 'Connected', nextHop: 'ethernet1/2' });
    expect(r['10.20.0.0/16']).toMatchObject({ protocol: 'OSPF', nextHop: '10.10.1.254', metric: 10 });
    expect(r['172.16.5.0/24']).toMatchObject({ protocol: 'BGP', nextHop: '10.10.1.253' });
  });
});

describe('juniper_screenos RIB (get route)', () => {
  const SCREENOS_OUT = `IPv4 Dest-Routes for <untrust-vr> (0 entries)
--------------------------------------------------------------------------------------
H: Host C: Connected S: Static A: Auto-Exported
I: Imported R: RIP P: Permanent D: Auto-Discovered
N: NHRP
iB: IBGP eB: EBGP O: OSPF E1: OSPF external type 1
E2: OSPF external type 2 trailing B: backup route

IPv4 Dest-Routes for <trust-vr> (6 entries)
--------------------------------------------------------------------------------------
         ID          IP-Prefix      Interface         Gateway   P Pref    Mtr     Vsys
--------------------------------------------------------------------------------------
*         4          0.0.0.0/0      ethernet0/0    203.0.113.1   S   20      1     Root
*         1       10.10.1.0/24      ethernet0/1        0.0.0.0   C    0      0     Root
*         2       10.10.1.1/32      ethernet0/1        0.0.0.0   H    0      0     Root
*         5       10.20.0.0/16      ethernet0/1    10.10.1.254   O   60      2     Root
          7       10.30.0.0/16      ethernet0/1    10.10.1.250   S   20      1     Root
*         6      172.16.5.0/24      ethernet0/1    10.10.1.253  eB   40      0     Root
`;

  test('trust-vr is the default table; inactive and host routes skipped', () => {
    const rib = normalizeRib('juniper_screenos', SCREENOS_OUT);
    expect(rib.vrfs).toEqual(['untrust-vr', 'default']);
    const r = byDest(rib.routes);
    expect(Object.keys(r).sort()).toEqual(['0.0.0.0/0', '10.10.1.0/24', '10.20.0.0/16', '172.16.5.0/24']);
    expect(r['10.10.1.0/24']).toMatchObject({ protocol: 'Connected', nextHop: 'ethernet0/1', vrf: 'default' });
    expect(r['10.20.0.0/16']).toMatchObject({ protocol: 'OSPF', nextHop: '10.10.1.254', metric: 2 });
    expect(r['172.16.5.0/24'].protocol).toBe('BGP');
  });
});

describe('juniper_junos RIB with routing instances', () => {
  const JUNOS_MULTI = `inet.0: 6 destinations, 7 routes (6 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both

0.0.0.0/0          *[Static/5] 00:10:00
                    > to 203.0.113.1 via ge-0/0/0.0
10.10.1.0/24       *[Direct/0] 01:00:00
                    > via ge-0/0/1.0
10.10.1.1/32       *[Local/0] 01:00:00
                      Local via ge-0/0/1.0
10.20.0.0/16       *[OSPF/10] 00:05:00, metric 3
                      to 10.10.1.250 via ge-0/0/1.0
                    > to 10.10.1.254 via ge-0/0/1.0

inet.3: 1 destinations, 1 routes (1 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both

10.255.0.1/32      *[OSPF/9] 00:30:00, metric 1
                    > to 10.10.1.254 via ge-0/0/1.0, Push 299776

PROD.inet.0: 2 destinations, 2 routes (2 active, 0 holddown, 0 hidden)
+ = Active Route, - = Last Active, * = Both

10.100.1.0/24      *[Direct/0] 02:00:00
                    > via ge-0/0/2.100
172.16.5.0/24      *[BGP/170] 00:02:00, localpref 100
                      AS path: 65010 I, validation-state: unverified
                    > to 10.100.1.2 via ge-0/0/2.100

inet6.0: 1 destinations, 1 routes (1 active, 0 holddown, 0 hidden)
`;

  test('inet.0 and <instance>.inet.0 become VRFs; inet.3 and inet6.0 are ignored', () => {
    const rib = normalizeRib('juniper_junos', JUNOS_MULTI);
    expect(rib.vrfs).toEqual(['default', 'PROD']);
    expect(rib.routes.some(r => r.destination === '10.255.0.1/32')).toBe(false);
    const r = byDest(rib.routes);
    expect(r['10.100.1.0/24']).toMatchObject({ protocol: 'Connected', nextHop: 'ge-0/0/2', vrf: 'PROD' });
    expect(r['172.16.5.0/24']).toMatchObject({ protocol: 'BGP', nextHop: '10.100.1.2', vrf: 'PROD' });
  });

  test('uses the active (>) next hop of an ECMP route and its metric; skips Local', () => {
    const r = byDest(normalizeRib('juniper_junos', JUNOS_MULTI).routes);
    expect(r['10.20.0.0/16']).toMatchObject({ nextHop: '10.10.1.254', metric: 3, vrf: 'default' });
    expect(r['10.10.1.1/32']).toBeUndefined();
  });
});

// ---- Layouts found on real devices (regressions from review) --------------

describe('cisco_ios RIB: common real-world layouts', () => {
  const IOS_EDGE = `Codes: L - local, C - connected, S - static, O - OSPF, B - BGP, o - ODR
Gateway of last resort is 10.1.1.2 to network 0.0.0.0

O*E2  0.0.0.0/0 [110/1] via 10.1.1.2, 00:00:10, GigabitEthernet0/0
      1.0.0.0/32 is subnetted, 2 subnets
O        1.1.1.1 [110/2] via 10.1.1.2, 00:00:05, GigabitEthernet0/0
O        1.1.1.2 [110/3] via 10.1.1.2, 00:00:05, GigabitEthernet0/0
      10.0.0.0/8 is variably subnetted, 2 subnets, 2 masks
C        10.1.1.0/24 is directly connected, GigabitEthernet0/0
L        10.1.1.1/32 is directly connected, GigabitEthernet0/0
O E2     192.168.100.0/24
           [110/20] via 10.1.1.2, 00:00:05, GigabitEthernet0/0
B        10.0.0.0/8 [200/0] via 0.0.0.0, 00:10:00, Null0
o        172.30.0.0/16 [160/1] via 10.1.1.9, 00:00:30, GigabitEthernet0/0
S        10.9.0.0/16 is directly connected, Tunnel0`;
  const r = byDest(normalizeRib('cisco_ios', IOS_EDGE).routes);

  test('OSPF default route with a starred compound code (O*E2)', () => {
    expect(r['0.0.0.0/0']).toMatchObject({ protocol: 'OSPF', nextHop: '10.1.1.2', metric: 1 });
  });
  test('children of an "is subnetted" header take the header mask', () => {
    expect(r['1.1.1.1/32']).toMatchObject({ protocol: 'OSPF', nextHop: '10.1.1.2', metric: 2 });
    expect(r['1.1.1.2/32']).toMatchObject({ protocol: 'OSPF', metric: 3 });
  });
  test('a next hop wrapped onto the following line', () => {
    expect(r['192.168.100.0/24']).toMatchObject({ protocol: 'OSPF', nextHop: '10.1.1.2', metric: 20 });
  });
  test('discard routes (via 0.0.0.0 / Null0) and ODR are not imported', () => {
    expect(r['10.0.0.0/8']).toBeUndefined();
    expect(r['172.30.0.0/16']).toBeUndefined();
  });
  test('a static route pointing at an interface keeps the interface as next hop', () => {
    expect(r['10.9.0.0/16']).toMatchObject({ protocol: 'Static', nextHop: 'Tunnel0' });
  });
});

describe('fortinet RIB: real-world layouts', () => {
  const FORTI_EDGE = `Routing table for VRF=0
O*E2    0.0.0.0/0 [110/10] via 10.10.1.254, port2, 00:05:23, [1/0]
S       10.9.0.0/16 [10/0] via VPN-HQ tunnel 203.0.113.9, [1/0]
S       10.8.0.0/16 [10/0] is directly connected, port3, [1/0]
C       10.10.1.0/24 is directly connected, port2
`;
  const r = byDest(normalizeRib('fortinet', FORTI_EDGE).routes);
  test('OSPF default, IPsec tunnel route and interface route', () => {
    expect(r['0.0.0.0/0']).toMatchObject({ protocol: 'OSPF', nextHop: '10.10.1.254' });
    expect(r['10.9.0.0/16']).toMatchObject({ protocol: 'Static', nextHop: 'VPN-HQ' });
    expect(r['10.8.0.0/16']).toMatchObject({ protocol: 'Static', nextHop: 'port3' });
    expect(r['10.10.1.0/24']).toMatchObject({ protocol: 'Connected', nextHop: 'port2' });
  });
});

describe('interface routes on PAN-OS / ScreenOS (gateway 0.0.0.0)', () => {
  test('PAN-OS static to a tunnel interface', () => {
    const out = `VIRTUAL ROUTER: default (id 1)
10.9.0.0/16          0.0.0.0          10     A S          tunnel.1`;
    expect(normalizeRib('paloalto_panos', out).routes[0]).toMatchObject({ protocol: 'Static', nextHop: 'tunnel.1' });
  });
  test('ScreenOS static to a tunnel interface', () => {
    const out = `IPv4 Dest-Routes for <trust-vr> (1 entries)
*         8       10.9.0.0/16         tunnel.1        0.0.0.0   S   20      1     Root`;
    expect(normalizeRib('juniper_screenos', out).routes[0]).toMatchObject({ protocol: 'Static', nextHop: 'tunnel.1' });
  });
});

describe('juniper_junos RIB: real-world layouts', () => {
  const JUNOS_EDGE = `inet.0: 3 destinations, 4 routes (3 active, 0 holddown, 0 hidden)
10.5.0.0/16        *[Static/5] 00:10:00
                      Discard
                    [OSPF/150] 00:05:00, metric 0, tag 0
                    > to 10.1.1.254 via ge-0/0/1.0
10.1.1.0/24        *[Direct/0] 01:00:00
                    > via ge-0/0/1.0
10.2.2.0/24        *[Direct/0] 01:00:00
                    > via ge-0/0/2.100

__juniper_private1__.inet.0: 1 destinations, 1 routes (1 active, 0 holddown, 0 hidden)
10.0.0.1/32        *[Direct/0] 01:00:00
                    > via lo0.16385
`;
  const rib = normalizeRib('juniper_junos', JUNOS_EDGE);
  const r = byDest(rib.routes);
  test('an active discard route does not borrow the next hop of an inactive route', () => {
    expect(r['10.5.0.0/16']).toBeUndefined();
  });
  test('internal (__...__) instances are not VRFs', () => {
    expect(rib.vrfs).toEqual(['default']);
  });
  test('interface names match the config parser (no .unit suffix)', () => {
    expect(r['10.1.1.0/24'].nextHop).toBe('ge-0/0/1');
    expect(r['10.2.2.0/24'].nextHop).toBe('ge-0/0/2');
  });
});

describe('unknown vendor', () => {
  test('returns empty arrays without throwing', () => {
    expect(normalizeRoutes('mystery', ROUTE_OUT, 'default')).toEqual([]);
    expect(normalizeArp('mystery', ARP_OUT)).toEqual([]);
    expect(normalizeNeighbors('mystery', CDP_OUT)).toEqual([]);
  });
});
