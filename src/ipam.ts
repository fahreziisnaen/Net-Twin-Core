import { NetworkNode, IpReservation } from './types';
import { parseCidr, matchCidr } from './engine';
import { numToIp } from './changeUtils';

export type { IpReservation } from './types';

// How many free addresses we materialise per subnet. Counts stay exact; only
// the enumerated list is capped so a /8 can't blow up the UI.
const FREE_CAP = 1024;

export type IpUsageKind = 'interface' | 'nat' | 'reserved';

export interface IpUsage {
  ip: string;
  kind: IpUsageKind;
  owner: string;   // device name, or "Reserved" for manual records
  detail: string;  // interface name / NAT type / reservation note
  vrf?: string;
}

export interface SubnetInfo {
  cidr: string;          // canonical network CIDR, e.g. "10.100.20.0/24"
  network: string;
  prefix: number;
  vrf: string;
  vlan?: number;
  gateway?: string;      // first interface IP seen on this subnet
  gatewayDevice?: string;
  totalUsable: number;
  usedCount: number;
  freeCount: number;
  utilization: number;   // 0..1
}

export interface SubnetUsage {
  info: SubnetInfo;
  used: IpUsage[];
  usedCount: number;     // exact
  free: string[];        // capped sample (see FREE_CAP)
  freeCount: number;     // exact
  freeCapped: boolean;
  nextFree: string | null;
}

// Usable host count per RFC: /32 = 1 host, /31 = 2 (RFC 3021), else minus
// network + broadcast.
export function usableHosts(prefix: number): number {
  if (prefix >= 32) return 1;
  if (prefix === 31) return 2;
  return Math.pow(2, 32 - prefix) - 2;
}

// Inclusive numeric range of assignable host addresses for a subnet.
function hostRange(networkNum: number, prefix: number): { first: number; last: number } {
  if (prefix >= 32) return { first: networkNum, last: networkNum };
  if (prefix === 31) return { first: networkNum, last: networkNum + 1 };
  const size = Math.pow(2, 32 - prefix);
  return { first: networkNum + 1, last: networkNum + size - 2 };
}

// parseCidr() returns the address as written (unmasked), so mask it here to get
// the true network address: 10.10.10.1/24 -> 10.10.10.0/24
function networkNumOf(ipCidr: string): number {
  const { network, mask } = parseCidr(ipCidr);
  return (network & mask) >>> 0;
}

function canonicalCidr(ipCidr: string): string | null {
  if (!ipCidr.includes('/')) return null;
  const { maskLength } = parseCidr(ipCidr);
  if (isNaN(maskLength)) return null;
  return `${numToIp(networkNumOf(ipCidr))}/${maskLength}`;
}

// Every address the twin already knows about inside `cidr`, plus manual
// reservations. Priority when an IP appears twice: interface > nat > reserved.
function usedIn(cidr: string, nodes: NetworkNode[], reservations: IpReservation[]): IpUsage[] {
  const byIp = new Map<string, IpUsage>();
  const rank: Record<IpUsageKind, number> = { interface: 3, nat: 2, reserved: 1 };
  const put = (u: IpUsage) => {
    const prev = byIp.get(u.ip);
    if (!prev || rank[u.kind] > rank[prev.kind]) byIp.set(u.ip, u);
  };

  for (const node of nodes) {
    for (const vrf of node.vrfs) {
      for (const intf of vrf.interfaces) {
        const ipOnly = intf.ip.split('/')[0];
        if (matchCidr(ipOnly, cidr)) {
          put({ ip: ipOnly, kind: 'interface', owner: node.name, detail: intf.name, vrf: vrf.name });
        }
      }
    }
    // Static NAT inside-local addresses occupy a real host address; PAT pools
    // are ranges (contain '/') and are not single occupants.
    for (const nat of node.natMappings || []) {
      if (!nat.insideLocal || nat.insideLocal.includes('/')) continue;
      if (matchCidr(nat.insideLocal, cidr)) {
        put({ ip: nat.insideLocal, kind: 'nat', owner: node.name, detail: nat.type, vrf: nat.vrf });
      }
    }
  }

  for (const r of reservations) {
    if (r.ip && matchCidr(r.ip, cidr)) {
      put({ ip: r.ip, kind: 'reserved', owner: 'Reserved', detail: r.note });
    }
  }

  return [...byIp.values()];
}

export function computeSubnetUsage(cidr: string, nodes: NetworkNode[], reservations: IpReservation[]): SubnetUsage {
  const { maskLength } = parseCidr(cidr);
  const network = networkNumOf(cidr);
  const totalUsable = usableHosts(maskLength);
  const used = usedIn(cidr, nodes, reservations);
  const usedSet = new Set(used.map(u => u.ip));

  const { first, last } = hostRange(network, maskLength);
  const free: string[] = [];
  let nextFree: string | null = null;
  for (let n = first; n <= last; n++) {
    const ip = numToIp(n >>> 0);
    if (usedSet.has(ip)) continue;
    if (!nextFree) nextFree = ip;
    if (free.length < FREE_CAP) free.push(ip);
    else if (nextFree) break; // counts come from arithmetic, not the loop
  }

  const usedCount = used.length;
  const freeCount = Math.max(0, totalUsable - usedCount);

  // Find the interface that best represents this subnet's gateway
  let gateway: string | undefined;
  let gatewayDevice: string | undefined;
  let vrf = 'default';
  let vlan: number | undefined;
  outer: for (const node of nodes) {
    for (const v of node.vrfs) {
      for (const intf of v.interfaces) {
        if (canonicalCidr(intf.ip) === cidr) {
          gateway = intf.ip.split('/')[0];
          gatewayDevice = node.name;
          vrf = v.name;
          vlan = intf.vlan;
          break outer;
        }
      }
    }
  }

  const info: SubnetInfo = {
    cidr,
    network: numToIp(network),
    prefix: maskLength,
    vrf,
    vlan,
    gateway,
    gatewayDevice,
    totalUsable,
    usedCount,
    freeCount,
    utilization: totalUsable > 0 ? usedCount / totalUsable : 0,
  };

  return { info, used, usedCount, free, freeCount, freeCapped: freeCount > free.length, nextFree };
}

// Every distinct subnet the twin models, derived from interface CIDRs.
export function enumerateSubnets(nodes: NetworkNode[], reservations: IpReservation[]): SubnetInfo[] {
  const seen = new Map<string, { vrf: string; vlan?: number; gateway: string; device: string }>();

  for (const node of nodes) {
    for (const vrf of node.vrfs) {
      for (const intf of vrf.interfaces) {
        const cidr = canonicalCidr(intf.ip);
        if (!cidr) continue;
        if (!seen.has(cidr)) {
          seen.set(cidr, { vrf: vrf.name, vlan: intf.vlan, gateway: intf.ip.split('/')[0], device: node.name });
        } else if (intf.vlan !== undefined && seen.get(cidr)!.vlan === undefined) {
          seen.get(cidr)!.vlan = intf.vlan; // pick up a VLAN tag from any interface on the subnet
        }
      }
    }
  }

  return [...seen.entries()].map(([cidr, meta]) => {
    const { maskLength } = parseCidr(cidr);
    const network = networkNumOf(cidr);
    const totalUsable = usableHosts(maskLength);
    const usedCount = usedIn(cidr, nodes, reservations).length;
    return {
      cidr,
      network: numToIp(network),
      prefix: maskLength,
      vrf: meta.vrf,
      vlan: meta.vlan,
      gateway: meta.gateway,
      gatewayDevice: meta.device,
      totalUsable,
      usedCount,
      freeCount: Math.max(0, totalUsable - usedCount),
      utilization: totalUsable > 0 ? usedCount / totalUsable : 0,
    };
  }).sort((a, b) => a.cidr.localeCompare(b.cidr));
}

export interface VlanGroup {
  vlan: number | null; // null = subnets without a VLAN tag
  subnets: SubnetInfo[];
}

export function groupByVlan(subnets: SubnetInfo[]): VlanGroup[] {
  const groups = new Map<number | null, SubnetInfo[]>();
  for (const s of subnets) {
    const key = s.vlan ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  return [...groups.entries()]
    .map(([vlan, list]) => ({ vlan, subnets: list }))
    .sort((a, b) => (a.vlan ?? Infinity) - (b.vlan ?? Infinity));
}
