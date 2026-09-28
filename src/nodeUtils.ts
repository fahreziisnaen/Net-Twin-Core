import { NetworkNode, Interface, Route, FirewallRule, VRF } from './types';
import { parseCidr } from './engine';

type NatMapping = NonNullable<NetworkNode['natMappings']>[number];

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Node id derived from a display name that doesn't collide with an existing
// device ("core-r1" -> "core-r1-2"). Creating must never replace a device.
export function uniqueNodeId(name: string, nodes: NetworkNode[]): string {
  const base = slugify(name) || 'device';
  const taken = new Set(nodes.map(n => n.id));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

let idSeq = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(idSeq++).toString(36)}`;

// Drop UI-only bookkeeping (e.g. the importer's `_include` / `_key` columns)
// so it never ends up stored in the twin.
function stripUiFields<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('_')) out[k] = v;
  return out as T;
}

const ruleSignature = (r: FirewallRule) =>
  [r.action, r.sourceVrf, r.destVrf, r.sourceIp, r.destIp, r.protocol, r.sourcePort, r.destPort].join('|');
const natSignature = (n: Pick<NatMapping, 'type' | 'insideLocal' | 'insideGlobal'>) =>
  [n.type, n.insideLocal, n.insideGlobal].join('|');

// Two routes describe the same path. A connected route is identified by its
// interface and subnet, however the prefix is written: the twin records the
// interface address ("10.1.1.1/24") where a device RIB shows the network
// ("10.1.1.0/24").
function sameRoute(a: Route, b: Route): boolean {
  if (a.protocol === 'Connected' && b.protocol === 'Connected') {
    if (a.nextHop !== b.nextHop) return false;
    const x = parseCidr(a.destination);
    const y = parseCidr(b.destination);
    return x.maskLength === y.maskLength && ((x.network & x.mask) >>> 0) === ((y.network & y.mask) >>> 0);
  }
  return a.destination === b.destination && a.nextHop === b.nextHop;
}

// Routes a device learns at runtime; a fresh routing table supersedes them.
const isLearned = (r: Route) => r.origin === 'rib' || r.protocol === 'OSPF' || r.protocol === 'BGP';

export interface IncomingConfig {
  interfaces: (Interface & { vrf?: string })[];
  routes: Route[];
  firewallRules: FirewallRule[];
  natMappings: Omit<NatMapping, 'id'>[];
}

// Merge parsed/collected data into an existing device without destroying what
// is already modelled. Keeps the device's identity, type, links and anything
// not present in the incoming data; updates interface IPs/status by name; adds
// routes, rules and NAT entries that aren't there yet (so repeating the same
// import is idempotent). New rules go on top, as an imported policy would.
//
// `ribVrfs`: VRFs whose incoming routes are the device's live routing table.
// In those VRFs, previously learned routes (OSPF/BGP, or anything an earlier
// sync read from the RIB) are replaced rather than accumulated, so a route the
// device withdrew disappears from the twin. Static routes the user modelled
// stay, as do all routes in VRFs whose table wasn't read.
export function mergeIntoNode(existing: NetworkNode, incoming: IncomingConfig, opts: { ribVrfs?: string[] } = {}): NetworkNode {
  const ribVrfs = new Set(opts.ribVrfs || []);
  const vrfs: VRF[] = existing.vrfs.map(v => ({
    ...v,
    interfaces: [...v.interfaces],
    routes: ribVrfs.has(v.name) ? v.routes.filter(r => !isLearned(r)) : [...v.routes],
  }));
  const ensureVrf = (name: string): VRF => {
    const key = name || 'default';
    let vrf = vrfs.find(v => v.name === key);
    if (!vrf) {
      vrf = { name: key, description: `Imported context ${key}`, interfaces: [], routes: [] };
      vrfs.push(vrf);
    }
    return vrf;
  };

  for (const raw of incoming.interfaces) {
    const { vrf: vrfName, ...intf } = stripUiFields(raw);
    const owner = vrfs.find(v => v.interfaces.some(i => i.name === intf.name));
    if (owner) {
      owner.interfaces = owner.interfaces.map(i => (i.name === intf.name ? { ...i, ip: intf.ip, status: intf.status } : i));
      continue;
    }
    const vrf = ensureVrf(vrfName || 'default');
    vrf.interfaces.push(intf);
    if (intf.ip.includes('/') && !vrf.routes.some(r => r.protocol === 'Connected' && r.nextHop === intf.name)) {
      vrf.routes.push({ id: newId('imp_c'), destination: intf.ip, nextHop: intf.name, protocol: 'Connected', metric: 0, vrf: vrf.name });
    }
  }

  for (const raw of incoming.routes) {
    const route = stripUiFields(raw);
    const vrf = ensureVrf(route.vrf || 'default');
    if (!vrf.routes.some(r => sameRoute(r, route))) {
      vrf.routes.push({ ...route, id: newId('imp_r'), vrf: vrf.name });
    }
  }

  const existingRules = existing.firewallRules || [];
  const knownRules = new Set(existingRules.map(ruleSignature));
  const newRules = incoming.firewallRules
    .map(r => ({ ...stripUiFields(r), id: newId('imp_fw') }))
    .filter(r => !knownRules.has(ruleSignature(r)));

  const existingNat = existing.natMappings || [];
  const knownNat = new Set(existingNat.map(natSignature));
  const newNat = incoming.natMappings
    .map(n => ({ ...stripUiFields(n), id: newId('imp_nat') }))
    .filter(n => !knownNat.has(natSignature(n)));

  return {
    ...existing,
    vrfs,
    firewallRules: [...newRules, ...existingRules],
    natMappings: [...newNat, ...existingNat],
  };
}

// Build a brand-new device from parsed/collected data.
export function buildNode(id: string, name: string, type: NetworkNode['type'], incoming: IncomingConfig): NetworkNode {
  const shell: NetworkNode = { id, name, type, status: 'online', vrfs: [], firewallRules: [], natMappings: [] };
  const node = mergeIntoNode(shell, incoming);
  if (!node.vrfs.length) node.vrfs = [{ name: 'default', description: 'default', interfaces: [], routes: [] }];
  return node;
}
