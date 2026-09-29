import { describe, test, expect } from 'vitest';
import { parseConfig, detectVendor } from './index';

// ---------------------------------------------------------------------------
// Fixtures: sanitized-but-realistic config snippets per vendor
// ---------------------------------------------------------------------------

const CISCO_CONFIG = `
hostname EDGE-R1
!
ip vrf PRODUCTION
!
interface GigabitEthernet0/0
 description WAN uplink
 ip address 203.0.113.2 255.255.255.248
 no shutdown
!
interface GigabitEthernet0/1
 ip vrf forwarding PRODUCTION
 ip address 10.10.1.1 255.255.255.0
!
interface GigabitEthernet0/2
 ip address 192.168.1.1 255.255.255.0
 shutdown
!
ip route 0.0.0.0 0.0.0.0 203.0.113.1
ip route vrf PRODUCTION 10.20.0.0 255.255.0.0 10.10.1.254 50
!
ip access-list extended ACL_WEB_IN
 permit tcp any host 10.10.1.10 eq 443
 deny ip any any
!
access-list 101 permit udp 10.10.0.0 0.0.255.255 any eq 53
!
ip nat inside source static 10.10.1.10 203.0.113.10
ip nat inside source list ACL_NAT interface GigabitEthernet0/0 overload
`;

const FORTIGATE_CONFIG = `
config system global
    set hostname FGT-EDGE
end
config system interface
    edit "port1"
        set ip 203.0.113.2 255.255.255.248
        set alias "wan"
    next
    edit "port2"
        set ip 10.10.1.1 255.255.255.0
    next
    edit "port3"
        set ip 172.16.1.1 255.255.255.0
        set status down
    next
end
config firewall address
    edit "SRV_WEB"
        set subnet 10.10.1.10 255.255.255.255
    next
    edit "NET_LAN"
        set subnet 10.10.0.0 255.255.0.0
    next
end
config firewall service custom
    edit "TCP-8443"
        set tcp-portrange 8443
    next
end
config firewall vip
    edit "VIP_WEB"
        set extip 203.0.113.10
        set mappedip "10.10.1.10"
    next
end
config router static
    edit 1
        set gateway 203.0.113.1
        set device "port1"
    next
    edit 2
        set dst 10.20.0.0 255.255.0.0
        set gateway 10.10.1.254
        set device "port2"
        set distance 50
    next
end
config firewall policy
    edit 1
        set name "LAN_to_WAN"
        set srcintf "port2"
        set dstintf "port1"
        set srcaddr "NET_LAN"
        set dstaddr "all"
        set service "HTTPS"
        set action accept
        set nat enable
    next
    edit 2
        set name "WAN_to_WEB"
        set srcintf "port1"
        set dstintf "port2"
        set srcaddr "all"
        set dstaddr "VIP_WEB"
        set service "TCP-8443"
        set action accept
    next
    edit 3
        set name "BLOCK_ALL"
        set srcintf "any"
        set dstintf "any"
        set srcaddr "all"
        set dstaddr "all"
        set service "ALL"
        set action deny
    next
end
`;

const JUNOS_CONFIG = `
set system host-name SRX-EDGE
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/29
set interfaces ge-0/0/1 unit 0 family inet address 10.10.1.1/24
set routing-options static route 0.0.0.0/0 next-hop 203.0.113.1
set routing-instances CORP instance-type virtual-router
set routing-instances CORP routing-options static route 10.20.0.0/16 next-hop 10.10.1.254
set security zones security-zone untrust interfaces ge-0/0/0.0
set security zones security-zone trust interfaces ge-0/0/1.0
set security address-book global address SRV_WEB 10.10.1.10/32
set security policies from-zone trust to-zone untrust policy ALLOW_WEB match source-address any
set security policies from-zone trust to-zone untrust policy ALLOW_WEB match destination-address any
set security policies from-zone trust to-zone untrust policy ALLOW_WEB match application junos-https
set security policies from-zone trust to-zone untrust policy ALLOW_WEB then permit
set security policies from-zone untrust to-zone trust policy IN_WEB match source-address any
set security policies from-zone untrust to-zone trust policy IN_WEB match destination-address SRV_WEB
set security policies from-zone untrust to-zone trust policy IN_WEB match application junos-https
set security policies from-zone untrust to-zone trust policy IN_WEB then deny
set security nat static rule-set RS1 from zone untrust
set security nat static rule-set RS1 rule R1 match destination-address 203.0.113.10/32
set security nat static rule-set RS1 rule R1 then static-nat prefix 10.10.1.10/32
set security nat source rule-set SNAT1 from zone trust
set security nat source rule-set SNAT1 to zone untrust
set security nat source rule-set SNAT1 rule S1 match source-address 10.10.0.0/16
set security nat source rule-set SNAT1 rule S1 then source-nat interface
`;

const PANOS_CONFIG = `
set deviceconfig system hostname PA-EDGE
set network interface ethernet ethernet1/1 layer3 ip 203.0.113.2/29
set network interface ethernet ethernet1/2 layer3 ip 10.10.1.1/24
set zone untrust network layer3 ethernet1/1
set zone trust network layer3 ethernet1/2
set network virtual-router default routing-table ip static-route DEFAULT destination 0.0.0.0/0 nexthop ip-address 203.0.113.1
set network virtual-router default routing-table ip static-route TO_CORP destination 10.20.0.0/16 nexthop ip-address 10.10.1.254 metric 50
set address SRV_WEB ip-netmask 10.10.1.10/32
set service TCP-8443 protocol tcp port 8443
set rulebase security rules ALLOW_WEB from trust
set rulebase security rules ALLOW_WEB to untrust
set rulebase security rules ALLOW_WEB source any
set rulebase security rules ALLOW_WEB destination any
set rulebase security rules ALLOW_WEB service service-https
set rulebase security rules ALLOW_WEB action allow
set rulebase security rules IN_WEB from untrust
set rulebase security rules IN_WEB to trust
set rulebase security rules IN_WEB source any
set rulebase security rules IN_WEB destination SRV_WEB
set rulebase security rules IN_WEB service TCP-8443
set rulebase security rules IN_WEB action deny
set rulebase nat rules OUTBOUND_PAT from trust
set rulebase nat rules OUTBOUND_PAT to untrust
set rulebase nat rules OUTBOUND_PAT source 10.10.0.0/16
set rulebase nat rules OUTBOUND_PAT source-translation dynamic-ip-and-port interface-address interface ethernet1/1
set rulebase nat rules INBOUND_WEB from untrust
set rulebase nat rules INBOUND_WEB destination 203.0.113.10
set rulebase nat rules INBOUND_WEB destination-translation translated-address 10.10.1.10
`;

// ---------------------------------------------------------------------------
// Vendor auto-detection
// ---------------------------------------------------------------------------
describe('detectVendor', () => {
  test('recognises each vendor from syntax', () => {
    expect(detectVendor(CISCO_CONFIG)).toBe('cisco-ios');
    expect(detectVendor(FORTIGATE_CONFIG)).toBe('fortigate');
    expect(detectVendor(JUNOS_CONFIG)).toBe('junos');
    expect(detectVendor(PANOS_CONFIG)).toBe('panos');
  });
});

// ---------------------------------------------------------------------------
// Cisco IOS / IOS-XE
// ---------------------------------------------------------------------------
describe('Cisco IOS parser', () => {
  const result = parseConfig(CISCO_CONFIG, 'cisco-ios');

  test('hostname and VRFs', () => {
    expect(result.hostname).toBe('EDGE-R1');
    expect(result.vrfs).toContain('PRODUCTION');
  });

  test('interfaces with mask conversion, VRF binding and shutdown status', () => {
    const gi0 = result.interfaces.find(i => i.name === 'GigabitEthernet0/0')!;
    expect(gi0.ip).toBe('203.0.113.2/29');
    expect(gi0.status).toBe('up');

    const gi1 = result.interfaces.find(i => i.name === 'GigabitEthernet0/1')!;
    expect(gi1.ip).toBe('10.10.1.1/24');
    expect(gi1.vrf).toBe('PRODUCTION');

    const gi2 = result.interfaces.find(i => i.name === 'GigabitEthernet0/2')!;
    expect(gi2.status).toBe('down');
  });

  test('static routes incl. VRF and metric', () => {
    const def = result.routes.find(r => r.destination === '0.0.0.0/0')!;
    expect(def.nextHop).toBe('203.0.113.1');
    expect(def.vrf).toBe('default');

    const corp = result.routes.find(r => r.destination === '10.20.0.0/16')!;
    expect(corp.nextHop).toBe('10.10.1.254');
    expect(corp.vrf).toBe('PRODUCTION');
    expect(corp.metric).toBe(50);
  });

  test('named and numbered ACLs with wildcard masks and ports', () => {
    const webIn = result.firewallRules.find(r => r.name.includes('ACL_WEB_IN') && r.action === 'permit')!;
    expect(webIn.protocol).toBe('tcp');
    expect(webIn.sourceIp).toBe('any');
    expect(webIn.destIp).toBe('10.10.1.10/32');
    expect(webIn.destPort).toBe('443');

    const denyAll = result.firewallRules.find(r => r.name.includes('ACL_WEB_IN') && r.action === 'deny')!;
    expect(denyAll.destIp).toBe('any');

    const acl101 = result.firewallRules.find(r => r.name.includes('101'))!;
    expect(acl101.protocol).toBe('udp');
    expect(acl101.sourceIp).toBe('10.10.0.0/16');
    expect(acl101.destPort).toBe('53');
  });

  test('static NAT and interface-overload PAT with resolved interface IP', () => {
    const staticNat = result.natMappings.find(n => n.type === 'Static NAT')!;
    expect(staticNat.insideLocal).toBe('10.10.1.10');
    expect(staticNat.insideGlobal).toBe('203.0.113.10');

    const pat = result.natMappings.find(n => n.type === 'PAT / Dynamic')!;
    expect(pat.insideGlobal).toBe('203.0.113.2'); // resolved from GigabitEthernet0/0
  });
});

// ---------------------------------------------------------------------------
// FortiGate FortiOS
// ---------------------------------------------------------------------------
describe('Cisco IOS-XE VRF syntax', () => {
  test('`vrf definition` and interface `vrf forwarding` bind interfaces to the VRF', () => {
    const r = parseConfig(`hostname XE1
!
vrf definition PROD
 rd 65000:1
 address-family ipv4
 exit-address-family
!
interface GigabitEthernet2
 vrf forwarding PROD
 ip address 10.100.1.1 255.255.255.0
!
interface GigabitEthernet3
 ip address 10.200.1.1 255.255.255.0
!`, 'cisco-ios');
    expect(r.vrfs).toContain('PROD');
    expect(r.interfaces.find(i => i.name === 'GigabitEthernet2')?.vrf).toBe('PROD');
    expect(r.interfaces.find(i => i.name === 'GigabitEthernet3')?.vrf).toBeUndefined();
  });
});

describe('FortiGate parser', () => {
  const result = parseConfig(FORTIGATE_CONFIG, 'fortigate');

  test('hostname and interfaces (each interface is its own zone/VRF)', () => {
    expect(result.hostname).toBe('FGT-EDGE');
    const p1 = result.interfaces.find(i => i.name === 'port1')!;
    expect(p1.ip).toBe('203.0.113.2/29');
    expect(p1.vrf).toBe('port1');
    const p3 = result.interfaces.find(i => i.name === 'port3')!;
    expect(p3.status).toBe('down');
  });

  test('static routes bound to egress device zone', () => {
    const def = result.routes.find(r => r.destination === '0.0.0.0/0')!;
    expect(def.nextHop).toBe('203.0.113.1');
    expect(def.vrf).toBe('port1');
    const corp = result.routes.find(r => r.destination === '10.20.0.0/16')!;
    expect(corp.metric).toBe(50);
  });

  test('policies resolve address objects, VIPs, and service ports', () => {
    const lanOut = result.firewallRules.find(r => r.name === 'LAN_to_WAN')!;
    expect(lanOut.sourceVrf).toBe('port2');
    expect(lanOut.destVrf).toBe('port1');
    expect(lanOut.sourceIp).toBe('10.10.0.0/16'); // NET_LAN resolved
    expect(lanOut.destPort).toBe('443');           // HTTPS builtin
    expect(lanOut.action).toBe('permit');

    const wanIn = result.firewallRules.find(r => r.name === 'WAN_to_WEB')!;
    expect(wanIn.destIp).toBe('10.10.1.10/32');    // VIP_WEB resolved to mapped (real) IP
    expect(wanIn.destPort).toBe('8443');           // custom service resolved

    const blockAll = result.firewallRules.find(r => r.name === 'BLOCK_ALL')!;
    expect(blockAll.action).toBe('deny');
    expect(blockAll.sourceVrf).toBe('any');
  });

  test('VIP becomes Static NAT; nat-enabled policy becomes PAT with egress IP', () => {
    const vip = result.natMappings.find(n => n.type === 'Static NAT')!;
    expect(vip.insideGlobal).toBe('203.0.113.10');
    expect(vip.insideLocal).toBe('10.10.1.10');

    const pat = result.natMappings.find(n => n.type === 'PAT / Dynamic')!;
    expect(pat.insideLocal).toBe('10.10.0.0/16');
    expect(pat.insideGlobal).toBe('203.0.113.2'); // port1 IP
  });
});

// ---------------------------------------------------------------------------
// Juniper Junos / SRX (display set format)
// ---------------------------------------------------------------------------
describe('Junos parser', () => {
  const result = parseConfig(JUNOS_CONFIG, 'junos');

  test('hostname, interfaces mapped into security zones', () => {
    expect(result.hostname).toBe('SRX-EDGE');
    const wan = result.interfaces.find(i => i.name === 'ge-0/0/0')!;
    expect(wan.ip).toBe('203.0.113.2/29');
    expect(wan.vrf).toBe('untrust');
    const lan = result.interfaces.find(i => i.name === 'ge-0/0/1')!;
    expect(lan.vrf).toBe('trust');
  });

  test('global and routing-instance static routes', () => {
    const def = result.routes.find(r => r.destination === '0.0.0.0/0')!;
    expect(def.nextHop).toBe('203.0.113.1');
    expect(def.vrf).toBe('default');
    const corp = result.routes.find(r => r.destination === '10.20.0.0/16')!;
    expect(corp.vrf).toBe('CORP');
  });

  test('zone policies with application mapping and address-book resolution', () => {
    const allow = result.firewallRules.find(r => r.name === 'ALLOW_WEB')!;
    expect(allow.sourceVrf).toBe('trust');
    expect(allow.destVrf).toBe('untrust');
    expect(allow.protocol).toBe('tcp');
    expect(allow.destPort).toBe('443'); // junos-https
    expect(allow.action).toBe('permit');

    const inWeb = result.firewallRules.find(r => r.name === 'IN_WEB')!;
    expect(inWeb.destIp).toBe('10.10.1.10/32'); // SRV_WEB from address book
    expect(inWeb.action).toBe('deny');
  });

  test('static NAT and interface source NAT', () => {
    const staticNat = result.natMappings.find(n => n.type === 'Static NAT')!;
    expect(staticNat.insideGlobal).toBe('203.0.113.10');
    expect(staticNat.insideLocal).toBe('10.10.1.10');

    const pat = result.natMappings.find(n => n.type === 'PAT / Dynamic')!;
    expect(pat.insideLocal).toBe('10.10.0.0/16');
    expect(pat.insideGlobal).toBe('203.0.113.2'); // untrust zone interface IP
  });
});

// ---------------------------------------------------------------------------
// Palo Alto PAN-OS (set format)
// ---------------------------------------------------------------------------
describe('PAN-OS parser', () => {
  const result = parseConfig(PANOS_CONFIG, 'panos');

  test('hostname, interfaces mapped into zones', () => {
    expect(result.hostname).toBe('PA-EDGE');
    const wan = result.interfaces.find(i => i.name === 'ethernet1/1')!;
    expect(wan.ip).toBe('203.0.113.2/29');
    expect(wan.vrf).toBe('untrust');
    const lan = result.interfaces.find(i => i.name === 'ethernet1/2')!;
    expect(lan.vrf).toBe('trust');
  });

  test('virtual-router static routes with metric', () => {
    const def = result.routes.find(r => r.destination === '0.0.0.0/0')!;
    expect(def.nextHop).toBe('203.0.113.1');
    const corp = result.routes.find(r => r.destination === '10.20.0.0/16')!;
    expect(corp.metric).toBe(50);
  });

  test('security rulebase with service and address object resolution', () => {
    const allow = result.firewallRules.find(r => r.name === 'ALLOW_WEB')!;
    expect(allow.sourceVrf).toBe('trust');
    expect(allow.destVrf).toBe('untrust');
    expect(allow.destPort).toBe('443'); // service-https
    expect(allow.action).toBe('permit');

    const inWeb = result.firewallRules.find(r => r.name === 'IN_WEB')!;
    expect(inWeb.destIp).toBe('10.10.1.10/32'); // SRV_WEB
    expect(inWeb.destPort).toBe('8443');        // custom service
    expect(inWeb.action).toBe('deny');
  });

  test('NAT rules: dynamic-ip-and-port becomes PAT, destination-translation becomes Static NAT', () => {
    const pat = result.natMappings.find(n => n.type === 'PAT / Dynamic')!;
    expect(pat.insideLocal).toBe('10.10.0.0/16');
    expect(pat.insideGlobal).toBe('203.0.113.2'); // ethernet1/1 IP

    const dnat = result.natMappings.find(n => n.type === 'Static NAT')!;
    expect(dnat.insideGlobal).toBe('203.0.113.10');
    expect(dnat.insideLocal).toBe('10.10.1.10');
  });
});
