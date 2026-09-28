import { Route } from '../../src/types';

// Normalizers turn raw operational SSH output into the twin's data model.
// Fase 1 supports cisco_ios; more vendors slot in as new cases.

export interface NormalizedArp {
  ip: string;
  mac: string;
  iface: string;
}

export interface NormalizedNeighbor {
  localInterface: string;
  remoteDevice: string;
  remoteInterface: string;
}

// A parsed live routing table (RIB). `vrfs` lists the tables actually present
// in the output — possibly with zero routes — as opposed to a failed or
// unsupported command. Only those VRFs may have their learned routes replaced
// on the next sync; a table we didn't see must never be treated as empty.
export interface RibResult {
  routes: Route[];
  vrfs: string[];
}

let routeSeq = 0;
const routeId = () => `ssh_${Date.now()}_${routeSeq++}`;

// Cisco-style route codes (IOS, and FortiOS which prints the same layout).
const CISCO_PROTO: Record<string, Route['protocol']> = {
  C: 'Connected',
  S: 'Static',
  O: 'OSPF',
  B: 'BGP',
};

// ---- show ip route / get router info routing-table all ---------------------
function ciscoRoutes(output: string, vrf: string): Route[] {
  const routes: Route[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    // Match a leading route code followed by a CIDR destination.
    const m = line.match(/^([A-Za-z](?:\*|\s+[A-Za-z0-9*]{1,3})?)\s+(\d+\.\d+\.\d+\.\d+\/\d+)\s+(.*)$/);
    if (!m) continue;
    const code = m[1].trim().charAt(0).toUpperCase();
    if (code === 'L') continue; // local /32 of the router itself — not a useful route
    const protocol = CISCO_PROTO[code];
    if (!protocol) continue; // skip protocols the engine can't model (EIGRP/RIP/…)

    const dest = m[2];
    const rest = m[3];

    if (protocol === 'Connected') {
      const iface = rest.match(/directly connected,\s+([^\s,]+)/);
      if (!iface) continue;
      routes.push({ id: routeId(), destination: dest, nextHop: iface[1], protocol, metric: 0, vrf });
    } else {
      const via = rest.match(/\[(\d+)\/(\d+)\]\s+via\s+([\d.]+)/);
      if (!via) continue;
      routes.push({ id: routeId(), destination: dest, nextHop: via[3], protocol, metric: parseInt(via[2], 10) || 0, vrf });
    }
  }
  return routes;
}

const CISCO_TABLE_MARKERS = /Gateway of last resort|^Codes:/m;

// One headerless table (global `show ip route`): it counts as collected when it
// looks like a routing table, not an error such as "% Invalid input".
function ciscoGlobalRib(output: string, vrf: string): RibResult {
  const routes = ciscoRoutes(output, vrf);
  return { routes, vrfs: routes.length || CISCO_TABLE_MARKERS.test(output) ? [vrf] : [] };
}

// Output split into per-VRF sections by a header line, e.g. "Routing Table: X"
// (`show ip route vrf *`) or "Routing table for VRF=1" (FortiOS).
function splitSections(output: string, header: RegExp): { name: string; body: string }[] {
  const parts = output.split(header);
  const out: { name: string; body: string }[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) out.push({ name: parts[i], body: parts[i + 1] });
  return out;
}

function ciscoVrfRib(output: string): RibResult {
  const rib: RibResult = { routes: [], vrfs: [] };
  for (const { name, body } of splitSections(output, /^\s*Routing Table:\s*(\S+)\s*$/m)) {
    rib.vrfs.push(name);
    rib.routes.push(...ciscoRoutes(body, name));
  }
  return rib;
}

// ---- FortiOS: get router info routing-table all ----------------------------
// Same line format as IOS. FortiOS 7 prefixes each table with
// "Routing table for VRF=<n>"; VRF 0 is the default table.
function fortinetRib(output: string, vrf: string): RibResult {
  const sections = splitSections(output, /^\s*Routing table for VRF=(\d+)\s*$/m);
  if (!sections.length) return ciscoGlobalRib(output, vrf);
  const rib: RibResult = { routes: [], vrfs: [] };
  for (const { name, body } of sections) {
    const label = name === '0' ? vrf : `vrf${name}`;
    rib.vrfs.push(label);
    rib.routes.push(...ciscoRoutes(body, label));
  }
  return rib;
}

// ---- PAN-OS: show routing route --------------------------------------------
// "VIRTUAL ROUTER: <name> (id n)" then rows of
//   destination  nexthop  metric  flags...  [age]  interface  [next-AS]
// where flags are space-separated (e.g. "A S", "A Oi"); only active (A) rows count.
const PANOS_FLAG = /^(A|\?|C|H|S|~|R|O|Oi|Oo|O1|O2|B|E|M)$/;

function panosRib(output: string, vrf: string): RibResult {
  const rib: RibResult = { routes: [], vrfs: [] };
  let current: string | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const vr = line.match(/^VIRTUAL ROUTER:\s*(\S+)/i);
    if (vr) {
      current = vr[1] === 'default' ? vrf : vr[1];
      rib.vrfs.push(current);
      continue;
    }
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+\/\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const flags = new Set<string>();
    let iface = '';
    for (const tok of m[4].split(/\s+/)) {
      if (PANOS_FLAG.test(tok)) flags.add(tok);
      else if (!/^\d+$/.test(tok) && !iface) iface = tok; // skip age / next-AS numbers
    }
    if (!flags.has('A') || flags.has('H')) continue;
    const label = current ?? vrf;
    let protocol: Route['protocol'] | null = null;
    if (flags.has('C')) protocol = 'Connected';
    else if (flags.has('S')) protocol = 'Static';
    else if (flags.has('B')) protocol = 'BGP';
    else if ([...flags].some(f => f.startsWith('O'))) protocol = 'OSPF';
    if (!protocol) continue;
    // Connected routes resolve by interface name; the rest need a gateway IP
    // (drops e.g. "discard" next hops the engine can't forward to).
    const nextHop = protocol === 'Connected' ? iface : m[2];
    if (protocol === 'Connected' ? !iface : !/^\d+\.\d+\.\d+\.\d+$/.test(nextHop)) continue;
    rib.routes.push({ id: routeId(), destination: m[1], nextHop, protocol, metric: parseInt(m[3], 10) || 0, vrf: label });
  }
  if (!rib.vrfs.length && rib.routes.length) rib.vrfs.push(vrf);
  return rib;
}

// ---- ScreenOS: get route ---------------------------------------------------
// "IPv4 Dest-Routes for <trust-vr> (n entries)" then rows of
//   [*] ID  IP-Prefix  Interface  Gateway  P  Pref  Mtr  Vsys
// "*" marks the active route. trust-vr is ScreenOS's default virtual router.
const SCREENOS_PROTO: Record<string, Route['protocol']> = {
  C: 'Connected', S: 'Static', O: 'OSPF', E1: 'OSPF', E2: 'OSPF', iB: 'BGP', eB: 'BGP',
};

function screenosRib(output: string, vrf: string): RibResult {
  const rib: RibResult = { routes: [], vrfs: [] };
  let current: string | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const vr = line.match(/^IPv4 Dest-Routes for <([^>]+)>/i);
    if (vr) {
      current = vr[1] === 'trust-vr' ? vrf : vr[1];
      rib.vrfs.push(current);
      continue;
    }
    const m = line.match(/^(\*)?\s*\d+\s+(\d+\.\d+\.\d+\.\d+\/\d+)\s+(\S+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\S+)\s+\d+\s+(\d+)/);
    if (!m || !m[1]) continue; // inactive routes carry no "*"
    const protocol = Object.prototype.hasOwnProperty.call(SCREENOS_PROTO, m[5]) ? SCREENOS_PROTO[m[5]] : null;
    if (!protocol) continue;
    const nextHop = protocol === 'Connected' ? m[3] : m[4];
    rib.routes.push({ id: routeId(), destination: m[2], nextHop, protocol, metric: parseInt(m[6], 10) || 0, vrf: current ?? vrf });
  }
  if (!rib.vrfs.length && rib.routes.length) rib.vrfs.push(vrf);
  return rib;
}

// ---- show ip arp -----------------------------------------------------------
function ciscoArp(output: string): NormalizedArp[] {
  const out: NormalizedArp[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^Internet\s+(\d+\.\d+\.\d+\.\d+)\s+\S+\s+([0-9a-fA-F.:]+)\s+\S+\s+(\S+)/);
    if (!m) continue;
    out.push({ ip: m[1], mac: m[2], iface: m[3] });
  }
  return out;
}

// ---- show cdp neighbors detail ---------------------------------------------
function ciscoNeighbors(output: string): NormalizedNeighbor[] {
  const out: NormalizedNeighbor[] = [];
  // Split into per-neighbor blocks on the dashed separators.
  const blocks = output.split(/^-{3,}\s*$/m);
  for (const block of blocks) {
    const dev = block.match(/Device ID:\s*(\S+)/);
    const iface = block.match(/Interface:\s*([^,\n]+),\s*Port ID \(outgoing port\):\s*(\S+)/);
    if (dev && iface) {
      out.push({ localInterface: iface[1].trim(), remoteDevice: dev[1].trim(), remoteInterface: iface[2].trim() });
    }
  }
  return out;
}

// ---- Juniper Junos ---------------------------------------------------------
// Local (the router's own /32s) is skipped like IOS "L" routes.
const JUNOS_PROTO: Record<string, Route['protocol']> = {
  Static: 'Static', Direct: 'Connected', OSPF: 'OSPF', BGP: 'BGP',
};

const JUNOS_TABLE = /^(\S+):\s+\d+\s+destinations/;
const JUNOS_PREFIX = /^(\d+\.\d+\.\d+\.\d+\/\d+)\s+[*+-]*\[(\w+)\/\d+\]/;

// `show route` prints every table: inet.0 is the default IPv4 table and
// <instance>.inet.0 a routing instance (VRF). Other tables (inet.3, mpls.0,
// inet6.0, ...) are not IPv4 unicast forwarding and are skipped.
function junosRib(output: string, vrf: string): RibResult {
  const rib: RibResult = { routes: [], vrfs: [] };
  const lines = output.split(/\r?\n/);
  let current: string | null = vrf; // headerless output = one default table
  let sawHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const table = line.match(JUNOS_TABLE);
    if (table) {
      sawHeader = true;
      const name = table[1];
      current = name === 'inet.0' ? vrf : name.endsWith('.inet.0') ? name.slice(0, -'.inet.0'.length) : null;
      if (current) rib.vrfs.push(current);
      continue;
    }
    if (!current) continue;
    const m = line.match(JUNOS_PREFIX);
    if (!m) continue;
    const protocol = Object.prototype.hasOwnProperty.call(JUNOS_PROTO, m[2]) ? JUNOS_PROTO[m[2]] : null;
    if (!protocol) continue;
    const metric = line.match(/metric (\d+)/);
    // The next hops follow on continuation lines; ">" marks the one in use
    // (with ECMP it need not be the first).
    let nextHop = '';
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j].trim();
      if (!cont || JUNOS_PREFIX.test(cont) || JUNOS_TABLE.test(cont)) break;
      if (!cont.startsWith('>')) continue;
      const to = cont.match(/^>\s*to\s+([\d.]+)\s+via\s+(\S+)/);
      const via = cont.match(/^>\s*via\s+(\S+)/);
      nextHop = to ? to[1] : via ? via[1] : '';
      break;
    }
    if (!nextHop) continue;
    rib.routes.push({ id: routeId(), destination: m[1], nextHop, protocol, metric: metric ? parseInt(metric[1], 10) : 0, vrf: current });
  }
  if (!sawHeader && rib.routes.length) rib.vrfs.push(vrf);
  return rib;
}

function junosArp(output: string): NormalizedArp[] {
  const out: NormalizedArp[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = raw.trim().match(/^([0-9a-fA-F:]{17})\s+(\d+\.\d+\.\d+\.\d+)\s+\S+\s+(\S+)/);
    if (m) out.push({ ip: m[2], mac: m[1], iface: m[3] });
  }
  return out;
}

function junosNeighbors(output: string): NormalizedNeighbor[] {
  const out: NormalizedNeighbor[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Local Interface/i.test(line)) continue;
    // Local  Parent  ChassisId(mac)  PortInfo  SystemName
    const m = line.match(/^(\S+)\s+\S+\s+[0-9a-fA-F:]+\s+(\S+)\s+(\S+)$/);
    if (m) out.push({ localInterface: m[1], remoteInterface: m[2], remoteDevice: m[3] });
  }
  return out;
}

// ---- Generic ARP for firewall vendors (documented formats) -----------------
function fortinetArp(output: string): NormalizedArp[] {
  const out: NormalizedArp[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = raw.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+\d+\s+([0-9a-fA-F:]{17})\s+(\S+)/);
    if (m) out.push({ ip: m[1], mac: m[2], iface: m[3] });
  }
  return out;
}

function panosArp(output: string): NormalizedArp[] {
  const out: NormalizedArp[] = [];
  for (const raw of output.split(/\r?\n/)) {
    // interface  ip  mac  ...
    const m = raw.trim().match(/^(\S+)\s+(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F:]{17})/);
    if (m) out.push({ ip: m[2], mac: m[3], iface: m[1] });
  }
  return out;
}

function screenosArp(output: string): NormalizedArp[] {
  const out: NormalizedArp[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = raw.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F:.]+)\s+(\S+)/);
    if (!m || m[2].length < 12) continue;
    // ScreenOS shows "<vr>/<interface>"; the interface itself contains a slash
    // (ethernet0/1), so only strip a leading VR segment, not every slash.
    const parts = m[3].split('/');
    const iface = parts.length >= 3 ? parts.slice(1).join('/') : m[3];
    out.push({ ip: m[1], mac: m[2], iface });
  }
  return out;
}

// Parse one routing-table output. `vrf` labels the default table (and output
// without table headers).
export function normalizeRib(vendor: string, output: string, vrf = 'default'): RibResult {
  switch (vendor) {
    case 'cisco_ios': return ciscoGlobalRib(output, vrf);
    case 'juniper_junos': return junosRib(output, vrf);
    case 'fortinet': return fortinetRib(output, vrf);
    case 'paloalto_panos': return panosRib(output, vrf);
    case 'juniper_screenos': return screenosRib(output, vrf);
    default: return { routes: [], vrfs: [] };
  }
}

// Per-VRF tables collected by a separate command (IOS `show ip route vrf *`).
export function normalizeVrfRib(vendor: string, output: string): RibResult {
  return vendor === 'cisco_ios' ? ciscoVrfRib(output) : { routes: [], vrfs: [] };
}

export function normalizeRoutes(vendor: string, output: string, vrf: string): Route[] {
  return normalizeRib(vendor, output, vrf).routes;
}

export function normalizeArp(vendor: string, output: string): NormalizedArp[] {
  switch (vendor) {
    case 'cisco_ios': return ciscoArp(output);
    case 'juniper_junos': return junosArp(output);
    case 'fortinet': return fortinetArp(output);
    case 'paloalto_panos': return panosArp(output);
    case 'juniper_screenos': return screenosArp(output);
    default: return [];
  }
}

export function normalizeNeighbors(vendor: string, output: string): NormalizedNeighbor[] {
  if (vendor === 'cisco_ios') return ciscoNeighbors(output);
  if (vendor === 'juniper_junos') return junosNeighbors(output);
  return [];
}
