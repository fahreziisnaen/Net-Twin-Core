import { ParserProfile } from './types';

// ===========================================================================
// SEED PARSER PROFILES (data, not code).
//
// These are the built-in vendor profiles. They are stored in the DB on first
// boot and can be edited / extended / added-to from the web UI. The engine in
// engine.ts interprets them; nothing here is vendor-specific logic in code.
// ===========================================================================

const CISCO_IOS: ParserProfile = {
  id: 'cisco-ios',
  name: 'Cisco IOS / IOS-XE',
  builtin: true,
  detect: ['^ip route ', '^interface \\S', '^ip access-list', '^ip nat inside'],
  boundary: '^!',
  rules: [
    { match: '^hostname (\\S+)', setHostname: '$1' },
    { match: '^ip vrf (\\S+)$', addVrf: '$1' },
    { match: '^vrf definition (\\S+)$', addVrf: '$1' }, // IOS-XE syntax

    // Interface block
    { match: '^interface (\\S+)', push: { id: 'interface', keyGroup: 1 } },
    { match: '^interface (\\S+)', context: 'interface',
      accumulate: { context: 'interface', target: 'interfaces', fields: { name: { ctx: 'interface' }, status: { lit: 'up' } } } },
    { match: '^ip address (\\S+) (\\S+)', context: 'interface',
      accumulate: { context: 'interface', target: 'interfaces', fields: { ip: { transform: 'maskToCidr', arg: { concat: [{ group: 1 }, { group: 2 }] } } } } },
    { match: '^(?:ip )?vrf forwarding (\\S+)', context: 'interface', // classic IOS / IOS-XE
      accumulate: { context: 'interface', target: 'interfaces', fields: { vrf: '$1' } } },
    { match: '^shutdown$', context: 'interface',
      accumulate: { context: 'interface', target: 'interfaces', fields: { status: { lit: 'down' } } } },

    // Static routes
    { match: '^ip route vrf (\\S+) (\\S+) (\\S+) (\\S+)(?: (\\d+))?$',
      emit: { target: 'routes', fields: { destination: { transform: 'maskToCidr', arg: { concat: [{ group: 2 }, { group: 3 }] } }, nextHop: '$4', vrf: '$1', metric: '$5', protocol: { lit: 'Static' } } } },
    { match: '^ip route (?!vrf )(\\S+) (\\S+) (\\S+)(?: (\\d+))?$',
      emit: { target: 'routes', fields: { destination: { transform: 'maskToCidr', arg: { concat: [{ group: 1 }, { group: 2 }] } }, nextHop: '$3', vrf: { lit: 'default' }, metric: '$4', protocol: { lit: 'Static' } } } },

    // Named ACL block
    { match: '^ip access-list \\w+ (\\S+)', push: { id: 'acl', keyGroup: 1 } },
    { match: '^(permit|deny) (ip|tcp|udp|icmp) (any|host \\S+|[\\d.]+ [\\d.]+) (any|host \\S+|[\\d.]+ [\\d.]+)(?: eq (\\S+))?$', context: 'acl',
      emit: { target: 'firewallRules', fields: {
        name: { concat: [{ lit: 'ACL ' }, { ctx: 'acl' }], sep: '' },
        action: '$1', protocol: { transform: 'protoName', arg: { group: 2 } },
        sourceIp: { transform: 'ciscoAddr', arg: { group: 3 } },
        destIp: { transform: 'ciscoAddr', arg: { group: 4 } },
        destPort: '$5',
      } } },

    // Numbered ACL (top-level)
    { match: '^access-list (\\d+) (permit|deny) (ip|tcp|udp|icmp) (any|host \\S+|[\\d.]+ [\\d.]+) (any|host \\S+|[\\d.]+ [\\d.]+)(?: eq (\\S+))?$',
      emit: { target: 'firewallRules', fields: {
        name: { concat: [{ lit: 'ACL ' }, { group: 1 }], sep: '' },
        action: '$2', protocol: { transform: 'protoName', arg: { group: 3 } },
        sourceIp: { transform: 'ciscoAddr', arg: { group: 4 } },
        destIp: { transform: 'ciscoAddr', arg: { group: 5 } },
        destPort: '$6',
      } } },

    // NAT
    { match: '^ip nat inside source static (\\S+) (\\S+)',
      emit: { target: 'natMappings', fields: { type: { lit: 'Static NAT' }, insideLocal: '$1', insideGlobal: '$2', vrf: { lit: 'default' } } } },
    { match: '^ip nat inside source list (\\S+) interface (\\S+) overload',
      emit: { target: 'natMappings', fields: { type: { lit: 'PAT / Dynamic' }, insideLocal: '$1', insideGlobal: { resolve: '__if', arg: { group: 2 } }, vrf: { lit: 'default' } } } },
  ],
};

const FORTIGATE: ParserProfile = {
  id: 'fortigate',
  name: 'FortiGate FortiOS',
  builtin: true,
  detect: ['^config \\w+ \\w', '^\\s*edit ', '^\\s*next$', '^\\s*end$'],
  boundary: '^(next|end)$',
  statics: {
    aliases: { all: 'any', any: 'any' },
    svcBuiltin: { HTTPS: '443', HTTP: '80', DNS: '53', SSH: '22', PING: 'any', ALL: 'any' },
  },
  rules: [
    { match: '^set hostname (\\S+)', setHostname: '$1' },

    // Interfaces: config system interface / edit "portX"
    { match: '^config system interface', push: { id: 'cfg-if' } },
    { match: '^edit "?([^"]+)"?$', context: 'cfg-if', push: { id: 'if', keyGroup: 1 } },
    { match: '^edit "?([^"]+)"?$', context: 'if',
      accumulate: { context: 'if', target: 'interfaces', fields: { name: { ctx: 'if' }, vrf: { ctx: 'if' }, status: { lit: 'up' } } } },
    { match: '^set ip (\\S+) (\\S+)', context: 'if',
      accumulate: { context: 'if', target: 'interfaces', fields: { ip: { transform: 'maskToCidr', arg: { concat: [{ group: 1 }, { group: 2 }] } } } } },
    { match: '^set status down', context: 'if',
      accumulate: { context: 'if', target: 'interfaces', fields: { status: { lit: 'down' } } } },

    // Address objects -> addr table
    { match: '^config firewall address', push: { id: 'cfg-addr' } },
    { match: '^edit "?([^"]+)"?$', context: 'cfg-addr', push: { id: 'addr', keyGroup: 1 } },
    { match: '^set subnet (\\S+) (\\S+)', context: 'addr',
      table: { name: 'addr', keyCtx: 'addr', value: { transform: 'maskToCidr', arg: { concat: [{ group: 1 }, { group: 2 }] } } } },

    // Custom services -> svc table
    { match: '^config firewall service', push: { id: 'cfg-svc' } },
    { match: '^edit "?([^"]+)"?$', context: 'cfg-svc', push: { id: 'svc', keyGroup: 1 } },
    { match: '^set (?:tcp-portrange|udp-portrange) (\\d+)', context: 'svc',
      table: { name: 'svc', keyCtx: 'svc', value: '$1' } },

    // VIP -> addr table (mapped ip) + a Static NAT record
    { match: '^config firewall vip', push: { id: 'cfg-vip' } },
    { match: '^edit "?([^"]+)"?$', context: 'cfg-vip', push: { id: 'vip', keyGroup: 1 } },
    { match: '^set extip (\\S+)', context: 'vip',
      accumulate: { context: 'vip', target: 'natMappings', fields: { type: { lit: 'Static NAT' }, insideGlobal: '$1', vrf: { lit: 'default' } } } },
    { match: '^set mappedip "?([^"]+)"?', context: 'vip',
      accumulate: { context: 'vip', target: 'natMappings', fields: { insideLocal: '$1' } } },
    { match: '^set mappedip "?([^"]+)"?', context: 'vip',
      table: { name: 'addr', keyCtx: 'vip', value: { transform: 'toCidr32', arg: { group: 1 } } } },

    // Static routes
    { match: '^config router static', push: { id: 'cfg-rt' } },
    { match: '^edit (\\d+)', context: 'cfg-rt', push: { id: 'rt', keyGroup: 1 } },
    { match: '^edit (\\d+)', context: 'rt',
      accumulate: { context: 'rt', target: 'routes', fields: { destination: { lit: '0.0.0.0/0' }, protocol: { lit: 'Static' }, metric: { lit: '0' }, vrf: { lit: 'default' } } } },
    { match: '^set dst (\\S+) (\\S+)', context: 'rt',
      accumulate: { context: 'rt', target: 'routes', fields: { destination: { transform: 'maskToCidr', arg: { concat: [{ group: 1 }, { group: 2 }] } } } } },
    { match: '^set gateway (\\S+)', context: 'rt',
      accumulate: { context: 'rt', target: 'routes', fields: { nextHop: '$1' } } },
    { match: '^set device "?([^"]+)"?', context: 'rt',
      accumulate: { context: 'rt', target: 'routes', fields: { vrf: '$1' } } },
    { match: '^set distance (\\d+)', context: 'rt',
      accumulate: { context: 'rt', target: 'routes', fields: { metric: '$1' } } },

    // Firewall policies
    { match: '^config firewall policy', push: { id: 'cfg-pol' } },
    { match: '^edit (\\d+)', context: 'cfg-pol', push: { id: 'pol', keyGroup: 1 } },
    { match: '^set name "?([^"]+)"?', context: 'pol',
      accumulate: { context: 'pol', target: 'firewallRules', fields: { name: '$1', protocol: { lit: 'tcp' } } } },
    { match: '^set srcintf "?([^"]+)"?', context: 'pol',
      accumulate: { context: 'pol', target: 'firewallRules', fields: { sourceVrf: '$1' } } },
    { match: '^set dstintf "?([^"]+)"?', context: 'pol',
      accumulate: { context: 'pol', target: 'firewallRules', fields: { destVrf: '$1' } } },
    { match: '^set srcaddr "?([^"]+)"?', context: 'pol',
      accumulate: { context: 'pol', target: 'firewallRules', fields: { sourceIp: { resolve: 'addr', arg: { group: 1 }, fallback: { resolve: 'aliases', arg: { group: 1 }, fallback: { group: 1 } } } } } },
    { match: '^set dstaddr "?([^"]+)"?', context: 'pol',
      accumulate: { context: 'pol', target: 'firewallRules', fields: { destIp: { resolve: 'addr', arg: { group: 1 }, fallback: { resolve: 'aliases', arg: { group: 1 }, fallback: { group: 1 } } } } } },
    { match: '^set service "?([^"]+)"?', context: 'pol',
      accumulate: { context: 'pol', target: 'firewallRules', fields: { destPort: { resolve: 'svc', arg: { group: 1 }, fallback: { resolve: 'svcBuiltin', arg: { group: 1 }, fallback: { lit: 'any' } } } } } },
    { match: '^set action (\\S+)', context: 'pol',
      accumulate: { context: 'pol', target: 'firewallRules', fields: { action: { resolve: 'actionMap', arg: { group: 1 }, fallback: { lit: 'permit' } } } } },
    // NAT from policy (only activated when `set nat enable` is present)
    { match: '^set srcintf "?([^"]+)"?', context: 'pol',
      accumulate: { context: 'pol', target: 'natMappings', activate: false, fields: { vrf: '$1' } } },
    { match: '^set srcaddr "?([^"]+)"?', context: 'pol',
      accumulate: { context: 'pol', target: 'natMappings', activate: false, fields: { insideLocal: { resolve: 'addr', arg: { group: 1 }, fallback: { resolve: 'aliases', arg: { group: 1 }, fallback: { group: 1 } } } } } },
    { match: '^set dstintf "?([^"]+)"?', context: 'pol',
      accumulate: { context: 'pol', target: 'natMappings', activate: false, fields: { insideGlobal: { resolve: '__if', arg: { group: 1 } } } } },
    { match: '^set nat enable', context: 'pol',
      accumulate: { context: 'pol', target: 'natMappings', fields: { type: { lit: 'PAT / Dynamic' } } } },
  ],
};
// action mapping is a static table (accept->permit); deny stays deny
FORTIGATE.statics!.actionMap = { accept: 'permit', deny: 'deny' };

const JUNOS: ParserProfile = {
  id: 'junos',
  name: 'Juniper Junos / SRX (set format)',
  builtin: true,
  detect: ['^set interfaces \\S+ unit', '^set routing-options', '^set security zones', '^set security policies from-zone'],
  statics: {
    aliases: { any: 'any', 'any-ipv4': 'any' },
    appPort: { 'junos-https': '443', 'junos-http': '80', 'junos-ssh': '22', 'junos-dns': '53', 'junos-ping': 'any' },
    appProto: { 'junos-https': 'tcp', 'junos-http': 'tcp', 'junos-ssh': 'tcp', 'junos-dns': 'udp', 'junos-ping': 'icmp' },
  },
  rules: [
    { match: '^set system host-name (\\S+)', setHostname: '$1' },
    { match: '^set routing-instances (\\S+) instance-type', addVrf: '$1' },

    // zone -> interface map (built first, used when emitting interfaces)
    { match: '^set security zones security-zone (\\S+) interfaces (\\S+)\\.\\d+',
      table: { name: 'zoneByIf', keyGroup: 2, value: '$1' } },
    // address book
    { match: '^set security address-book global address (\\S+) (\\S+)',
      table: { name: 'addr', keyGroup: 1, value: '$2' } },

    // interfaces
    { match: '^set interfaces (\\S+) unit \\d+ family inet address (\\S+)',
      emit: { target: 'interfaces', fields: { name: '$1', ip: '$2', status: { lit: 'up' }, vrf: { resolve: 'zoneByIf', arg: { group: 1 }, fallback: { lit: 'default' } } } } },

    // routes
    { match: '^set routing-options static route (\\S+) next-hop (\\S+)',
      emit: { target: 'routes', fields: { destination: '$1', nextHop: '$2', vrf: { lit: 'default' }, protocol: { lit: 'Static' }, metric: { lit: '0' } } } },
    { match: '^set routing-instances (\\S+) routing-options static route (\\S+) next-hop (\\S+)',
      emit: { target: 'routes', fields: { destination: '$2', nextHop: '$3', vrf: '$1', protocol: { lit: 'Static' }, metric: { lit: '0' } } } },

    // zone policies (multi-line, keyed by from|to|policy)
    { match: '^set security policies from-zone (\\S+) to-zone (\\S+) policy (\\S+) match source-address (\\S+)',
      accumulate: { key: { concat: [{ group: 1 }, { group: 2 }, { group: 3 }], sep: '|' }, target: 'firewallRules',
        fields: { name: '$3', sourceVrf: '$1', destVrf: '$2', protocol: { lit: 'tcp' },
          sourceIp: { resolve: 'addr', arg: { group: 4 }, fallback: { resolve: 'aliases', arg: { group: 4 }, fallback: { group: 4 } } } } } },
    { match: '^set security policies from-zone (\\S+) to-zone (\\S+) policy (\\S+) match destination-address (\\S+)',
      accumulate: { key: { concat: [{ group: 1 }, { group: 2 }, { group: 3 }], sep: '|' }, target: 'firewallRules',
        fields: { destIp: { resolve: 'addr', arg: { group: 4 }, fallback: { resolve: 'aliases', arg: { group: 4 }, fallback: { group: 4 } } } } } },
    { match: '^set security policies from-zone (\\S+) to-zone (\\S+) policy (\\S+) match application (\\S+)',
      accumulate: { key: { concat: [{ group: 1 }, { group: 2 }, { group: 3 }], sep: '|' }, target: 'firewallRules',
        fields: { destPort: { resolve: 'appPort', arg: { group: 4 }, fallback: { lit: 'any' } }, protocol: { resolve: 'appProto', arg: { group: 4 }, fallback: { lit: 'tcp' } } } } },
    { match: '^set security policies from-zone (\\S+) to-zone (\\S+) policy (\\S+) then (permit|deny)',
      accumulate: { key: { concat: [{ group: 1 }, { group: 2 }, { group: 3 }], sep: '|' }, target: 'firewallRules', fields: { action: '$4' } } },

    // static (destination) NAT
    { match: '^set security nat static rule-set (\\S+) rule (\\S+) match destination-address ([\\d.]+)',
      accumulate: { key: { concat: [{ group: 1 }, { group: 2 }], sep: '|' }, target: 'natMappings', fields: { type: { lit: 'Static NAT' }, insideGlobal: '$3', vrf: { lit: 'default' } } } },
    { match: '^set security nat static rule-set (\\S+) rule (\\S+) then static-nat prefix ([\\d.]+)',
      accumulate: { key: { concat: [{ group: 1 }, { group: 2 }], sep: '|' }, target: 'natMappings', fields: { insideLocal: '$3' } } },

    // source NAT (PAT) — insideGlobal resolves via rule-set 'to zone' -> zone IP
    { match: '^set security nat source rule-set (\\S+) to zone (\\S+)',
      table: { name: 'rsToZone', keyGroup: 1, value: '$2' } },
    { match: '^set security nat source rule-set (\\S+) rule (\\S+) match source-address (\\S+)',
      accumulate: { key: { concat: [{ group: 1 }, { group: 2 }], sep: '|' }, target: 'natMappings', fields: { type: { lit: 'PAT / Dynamic' }, insideLocal: '$3', vrf: { lit: 'default' } } } },
    { match: '^set security nat source rule-set (\\S+) rule (\\S+) then source-nat interface',
      accumulate: { key: { concat: [{ group: 1 }, { group: 2 }], sep: '|' }, target: 'natMappings',
        fields: { insideGlobal: { resolve: '__zoneip', arg: { resolve: 'rsToZone', arg: { group: 1 } } } } } },
  ],
};

const PANOS: ParserProfile = {
  id: 'panos',
  name: 'Palo Alto PAN-OS (set format)',
  builtin: true,
  detect: ['^set rulebase', '^set network virtual-router', '^set network interface ethernet', '^set deviceconfig'],
  statics: {
    aliases: { any: 'any' },
    svcBuiltin: { 'service-https': '443', 'service-http': '80', 'application-default': 'any' },
    actionMap: { allow: 'permit', deny: 'deny', drop: 'deny', 'reset-client': 'deny', 'reset-server': 'deny', 'reset-both': 'deny' },
  },
  rules: [
    { match: '^set deviceconfig system hostname (\\S+)', setHostname: '$1' },

    // zone -> interface, address & service objects
    { match: '^set zone (\\S+) network layer3 (\\S+)', table: { name: 'zoneByIf', keyGroup: 2, value: '$1' } },
    { match: '^set address (\\S+) ip-netmask (\\S+)', table: { name: 'addr', keyGroup: 1, value: '$2' } },
    { match: '^set service (\\S+) protocol \\S+ port (\\S+)', table: { name: 'svc', keyGroup: 1, value: '$2' } },

    // interfaces
    { match: '^set network interface ethernet (\\S+) layer3 ip (\\S+)',
      emit: { target: 'interfaces', fields: { name: '$1', ip: '$2', status: { lit: 'up' }, vrf: { resolve: 'zoneByIf', arg: { group: 1 }, fallback: { lit: 'default' } } } } },

    // routes
    { match: '^set network virtual-router (\\S+) routing-table ip static-route (\\S+) destination (\\S+) nexthop ip-address (\\S+)(?: metric (\\d+))?',
      emit: { target: 'routes', fields: { destination: '$3', nextHop: '$4', metric: '$5', vrf: { lit: 'default' }, protocol: { lit: 'Static' } } } },

    // security rulebase (multi-line keyed by rule name)
    { match: '^set rulebase security rules (\\S+) from (\\S+)',
      accumulate: { key: '$1', target: 'firewallRules', fields: { name: '$1', sourceVrf: '$2', protocol: { lit: 'tcp' } } } },
    { match: '^set rulebase security rules (\\S+) to (\\S+)',
      accumulate: { key: '$1', target: 'firewallRules', fields: { destVrf: '$2' } } },
    { match: '^set rulebase security rules (\\S+) source (\\S+)',
      accumulate: { key: '$1', target: 'firewallRules', fields: { sourceIp: { resolve: 'addr', arg: { group: 2 }, fallback: { resolve: 'aliases', arg: { group: 2 }, fallback: { group: 2 } } } } } },
    { match: '^set rulebase security rules (\\S+) destination (\\S+)',
      accumulate: { key: '$1', target: 'firewallRules', fields: { destIp: { resolve: 'addr', arg: { group: 2 }, fallback: { resolve: 'aliases', arg: { group: 2 }, fallback: { group: 2 } } } } } },
    { match: '^set rulebase security rules (\\S+) service (\\S+)',
      accumulate: { key: '$1', target: 'firewallRules', fields: { destPort: { resolve: 'svc', arg: { group: 2 }, fallback: { resolve: 'svcBuiltin', arg: { group: 2 }, fallback: { lit: 'any' } } } } } },
    { match: '^set rulebase security rules (\\S+) action (\\S+)',
      accumulate: { key: '$1', target: 'firewallRules', fields: { action: { resolve: 'actionMap', arg: { group: 2 }, fallback: { lit: 'permit' } } } } },

    // NAT rulebase
    { match: '^set rulebase nat rules (\\S+) source (\\S+)',
      accumulate: { key: '$1', target: 'natMappings', activate: false, fields: { insideLocal: '$2', vrf: { lit: 'default' } } } },
    { match: '^set rulebase nat rules (\\S+) source-translation dynamic-ip-and-port interface-address interface (\\S+)',
      accumulate: { key: '$1', target: 'natMappings', fields: { type: { lit: 'PAT / Dynamic' }, insideGlobal: { resolve: '__if', arg: { group: 2 } } } } },
    { match: '^set rulebase nat rules (\\S+) destination ([\\d.]+)',
      accumulate: { key: '$1', target: 'natMappings', activate: false, fields: { insideGlobal: '$2', vrf: { lit: 'default' } } } },
    { match: '^set rulebase nat rules (\\S+) destination-translation translated-address ([\\d.]+)',
      accumulate: { key: '$1', target: 'natMappings', fields: { type: { lit: 'Static NAT' }, insideLocal: '$2' } } },
  ],
};

const SCREENOS: ParserProfile = {
  id: 'screenos',
  name: 'Juniper ScreenOS (SSG / NetScreen)',
  builtin: true,
  detect: ['^set interface \\S+ zone ', '^set policy id \\d+ from ', '^set route \\S+ interface '],
  statics: {
    aliases: { Any: 'any', any: 'any' },
    svcBuiltin: { HTTPS: '443', HTTP: '80', DNS: '53', SSH: '22', PING: 'any', ANY: 'any', Any: 'any' },
    actionMap: { permit: 'permit', deny: 'deny', reject: 'deny' },
  },
  rules: [
    { match: '^set hostname (\\S+)', setHostname: '$1' },
    // zone assignment -> table, used when emitting interfaces
    { match: '^set interface (\\S+) zone (\\S+)', table: { name: 'zoneByIf', keyGroup: 1, value: '$2' } },
    // address book & custom services
    { match: '^set address \\S+ "([^"]+)" (\\S+)', table: { name: 'addr', keyGroup: 1, value: '$2' } },
    { match: '^set service "([^"]+)" protocol \\S+ src-port \\S+ dst-port (\\d+)', table: { name: 'svc', keyGroup: 1, value: '$2' } },

    // interfaces
    { match: '^set interface (\\S+) ip (\\S+)',
      emit: { target: 'interfaces', fields: { name: '$1', ip: '$2', status: { lit: 'up' }, vrf: { resolve: 'zoneByIf', arg: { group: 1 }, fallback: { lit: 'default' } } } } },

    // MIP (static NAT)
    { match: '^set interface \\S+ mip (\\S+) host (\\S+)',
      emit: { target: 'natMappings', fields: { type: { lit: 'Static NAT' }, insideGlobal: '$1', insideLocal: '$2', vrf: { lit: 'default' } } } },

    // static routes
    { match: '^set route (\\S+) interface \\S+ gateway (\\S+)',
      emit: { target: 'routes', fields: { destination: '$1', nextHop: '$2', vrf: { lit: 'default' }, protocol: { lit: 'Static' }, metric: { lit: '0' } } } },
    { match: '^set route (\\S+) gateway (\\S+)$',
      emit: { target: 'routes', fields: { destination: '$1', nextHop: '$2', vrf: { lit: 'default' }, protocol: { lit: 'Static' }, metric: { lit: '0' } } } },

    // policies: from <zone> to <zone> "src" "dst" "service" permit|deny
    { match: '^set policy id (\\d+) from (\\S+) to (\\S+) "([^"]+)" "([^"]+)" "([^"]+)" (permit|deny|reject)',
      emit: { target: 'firewallRules', fields: {
        name: { concat: [{ lit: 'policy ' }, { group: 1 }], sep: '' },
        sourceVrf: '$2', destVrf: '$3',
        sourceIp: { resolve: 'addr', arg: { group: 4 }, fallback: { resolve: 'aliases', arg: { group: 4 }, fallback: { group: 4 } } },
        destIp: { resolve: 'addr', arg: { group: 5 }, fallback: { resolve: 'aliases', arg: { group: 5 }, fallback: { group: 5 } } },
        destPort: { resolve: 'svc', arg: { group: 6 }, fallback: { resolve: 'svcBuiltin', arg: { group: 6 }, fallback: { lit: 'any' } } },
        protocol: { lit: 'tcp' },
        action: { resolve: 'actionMap', arg: { group: 7 }, fallback: { lit: 'permit' } },
      } } },
  ],
};

export const SEED_PROFILES: ParserProfile[] = [CISCO_IOS, FORTIGATE, JUNOS, PANOS, SCREENOS];
