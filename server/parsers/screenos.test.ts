import { describe, test, expect } from 'vitest';
import { parseConfig, detectVendor } from './index';

const SCREENOS = `set hostname SSG-01
set interface ethernet0/0 zone Untrust
set interface ethernet0/0 ip 203.0.113.2/29
set interface ethernet0/1 zone Trust
set interface ethernet0/1 ip 10.10.1.1/24
set interface ethernet0/0 mip 203.0.113.10 host 10.10.1.10
set route 0.0.0.0/0 interface ethernet0/0 gateway 203.0.113.1
set route 10.20.0.0/16 interface ethernet0/1 gateway 10.10.1.254
set address Trust "srv-web" 10.10.1.10/32
set service "TCP-8443" protocol tcp src-port 0-65535 dst-port 8443-8443
set policy id 1 from Trust to Untrust "Any" "Any" "HTTPS" permit
set policy id 2 from Untrust to Trust "Any" "srv-web" "TCP-8443" deny`;

describe('detectVendor ScreenOS', () => {
  test('recognises ScreenOS over Junos', () => {
    expect(detectVendor(SCREENOS)).toBe('screenos');
  });
});

describe('ScreenOS (Juniper SSG) parser', () => {
  const r = parseConfig(SCREENOS, 'screenos');

  test('hostname and zone-bound interfaces', () => {
    expect(r.hostname).toBe('SSG-01');
    const wan = r.interfaces.find(i => i.name === 'ethernet0/0')!;
    expect(wan.ip).toBe('203.0.113.2/29');
    expect(wan.vrf).toBe('Untrust');
    expect(r.interfaces.find(i => i.name === 'ethernet0/1')!.vrf).toBe('Trust');
  });

  test('static routes via gateway', () => {
    const def = r.routes.find(x => x.destination === '0.0.0.0/0')!;
    expect(def.nextHop).toBe('203.0.113.1');
    const corp = r.routes.find(x => x.destination === '10.20.0.0/16')!;
    expect(corp.nextHop).toBe('10.10.1.254');
  });

  test('policies resolve address book + service, zones as src/dst', () => {
    const p1 = r.firewallRules.find(x => x.name === 'policy 1')!;
    expect(p1.sourceVrf).toBe('Trust');
    expect(p1.destVrf).toBe('Untrust');
    expect(p1.destPort).toBe('443'); // HTTPS builtin
    expect(p1.action).toBe('permit');

    const p2 = r.firewallRules.find(x => x.name === 'policy 2')!;
    expect(p2.destIp).toBe('10.10.1.10/32'); // srv-web from address book
    expect(p2.destPort).toBe('8443');        // custom service
    expect(p2.action).toBe('deny');
  });

  test('MIP becomes Static NAT', () => {
    const nat = r.natMappings.find(n => n.type === 'Static NAT')!;
    expect(nat.insideGlobal).toBe('203.0.113.10');
    expect(nat.insideLocal).toBe('10.10.1.10');
  });
});
