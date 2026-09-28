import { FirewallRule, NetworkNode, PathQuery } from './types';
import { parseCidr } from './engine';

export function numToIp(num: number): string {
  return [(num >>> 24) & 0xFF, (num >>> 16) & 0xFF, (num >>> 8) & 0xFF, num & 0xFF].join('.');
}

// Pick a representative host IP from a rule's CIDR spec ("any" -> null)
function sampleIp(cidr: string): string | null {
  const clean = (cidr || '').trim();
  if (!clean || clean.toLowerCase() === 'any') return null;
  if (!clean.includes('/')) return clean;
  const { network, maskLength } = parseCidr(clean);
  if (maskLength >= 31) return clean.split('/')[0];
  return numToIp(network + 1);
}

// First concrete port from a spec ("any" -> null, "8000-9000" -> "8000", "80,443" -> "80")
function firstPort(spec: string): string | null {
  const clean = (spec || '').trim().toLowerCase();
  if (!clean || clean === 'any') return null;
  const first = clean.split(',')[0].split('-')[0].trim();
  return /^\d+$/.test(first) ? first : null;
}

// Build a deterministic what-if probe for a proposed firewall rule, starting
// the trace at the firewall itself so its policy set is always evaluated.
export function deriveProbeQuery(rule: FirewallRule, fwNode: NetworkNode): PathQuery {
  const sourceVrf = rule.sourceVrf !== 'any'
    ? rule.sourceVrf
    : fwNode.vrfs[0]?.name || 'default';

  let sourceIp = sampleIp(rule.sourceIp);
  if (!sourceIp) {
    const vrf = fwNode.vrfs.find(v => v.name === sourceVrf) || fwNode.vrfs[0];
    const intf = vrf?.interfaces[0];
    if (intf) {
      const { network } = parseCidr(intf.ip);
      sourceIp = numToIp(network + 1);
    } else {
      sourceIp = '198.18.0.1'; // benchmark test range as last resort
    }
  }

  return {
    sourceNodeId: fwNode.id,
    sourceVrf,
    sourceIp,
    destIp: sampleIp(rule.destIp) || '8.8.8.8',
    protocol: rule.protocol === 'any' ? 'tcp' : rule.protocol,
    sourcePort: '40000',
    destPort: firstPort(rule.destPort) || '80',
  };
}
