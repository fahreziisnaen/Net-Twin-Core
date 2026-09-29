import {
  NetworkNode,
  NetworkLink,
  Interface,
  PathQuery,
  SimulationHop,
  SimulationResult,
  Route,
  FirewallRule,
  SimulationSettings,
} from './types';

// Helper to convert IP to an unsigned 32-bit integer
export function ipToNum(ip: string): number {
  const parts = ip.trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return 0;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Parse CIDR string (e.g., "10.0.0.0/8" -> network, mask, maskLength)
export function parseCidr(cidr: string) {
  const clean = cidr.trim();
  if (!clean.includes('/')) {
    // Single IP host route
    return {
      network: ipToNum(clean),
      mask: 0xFFFFFFFF,
      maskLength: 32,
    };
  }
  const parts = clean.split('/');
  const networkStr = parts[0];
  const maskLength = parseInt(parts[1], 10);
  const network = ipToNum(networkStr);
  const mask = maskLength === 0 ? 0 : (0xFFFFFFFF << (32 - maskLength)) >>> 0;
  return { network, mask, maskLength };
}

// Check if IP matches CIDR
export function matchCidr(ip: string, cidr: string): boolean {
  if (cidr.toLowerCase() === 'any') return true;
  const targetNum = ipToNum(ip);
  const { network, mask } = parseCidr(cidr);
  return (targetNum & mask) === (network & mask);
}

// Match a rule port spec against a concrete port.
// Supports "any", exact ("443"), ranges ("1024-65535") and lists ("80,443,8080").
export function matchPort(spec: string, port: string): boolean {
  const cleanSpec = (spec || '').trim().toLowerCase();
  if (cleanSpec === 'any' || cleanSpec === '') return true;
  const target = parseInt((port || '').trim(), 10);
  if (isNaN(target)) return false;

  return cleanSpec.split(',').some(part => {
    const p = part.trim();
    if (p.includes('-')) {
      const [lo, hi] = p.split('-').map(x => parseInt(x.trim(), 10));
      return !isNaN(lo) && !isNaN(hi) && target >= lo && target <= hi;
    }
    return parseInt(p, 10) === target;
  });
}

// Administrative distance per protocol source (Cisco defaults)
const ADMIN_DISTANCE: Record<Route['protocol'], number> = {
  Connected: 0,
  Static: 1,
  BGP: 20,
  OSPF: 110,
};

export type { SimulationSettings } from './types';

export const DEFAULT_SETTINGS: SimulationSettings = {
  maxHops: 10,
  implicitDeny: true,
};

interface RouteSelection {
  route: Route;
  routeVrf: string;
}

// LPM route selection. Routers/hosts look up strictly within their own VRF.
// Firewalls act as multi-zone gateways: all VRFs are security zones of one
// device, so the lookup spans every VRF (longest prefix wins; on a tie the
// ingress VRF is preferred, then lowest administrative distance, then metric).
function selectRoute(node: NetworkNode, currentVrf: string, destIp: string): RouteSelection | null {
  const scopes = node.type === 'firewall'
    ? node.vrfs
    : node.vrfs.filter(v => v.name === currentVrf);

  let best: RouteSelection | null = null;
  let bestLen = -1;

  for (const vrf of scopes) {
    for (const route of vrf.routes) {
      if (!matchCidr(destIp, route.destination)) continue;
      const { maskLength } = parseCidr(route.destination);
      if (maskLength > bestLen) {
        best = { route, routeVrf: vrf.name };
        bestLen = maskLength;
        continue;
      }
      if (maskLength === bestLen && best) {
        const preferCurrent = vrf.name === currentVrf && best.routeVrf !== currentVrf;
        const sameVrfClass = (vrf.name === currentVrf) === (best.routeVrf === currentVrf);
        const betterAd = ADMIN_DISTANCE[route.protocol] < ADMIN_DISTANCE[best.route.protocol];
        const sameAd = ADMIN_DISTANCE[route.protocol] === ADMIN_DISTANCE[best.route.protocol];
        const betterMetric = route.metric < best.route.metric;
        if (preferCurrent || (sameVrfClass && (betterAd || (sameAd && betterMetric)))) {
          best = { route, routeVrf: vrf.name };
        }
      }
    }
  }
  return best;
}

interface EgressResolution {
  intf: Interface;
  intfName: string;
  zone: string; // VRF that owns the egress interface
}

// Resolve the egress interface for a chosen route. Connected routes name the
// interface directly; other routes are resolved recursively via the next hop's
// connected subnet. Firewalls may resolve across zones (e.g. a PRODUCTION
// default route whose next hop lives on the Internet-facing zone interface).
function resolveEgress(node: NetworkNode, selection: RouteSelection): EgressResolution | null {
  const routeVrfObj = node.vrfs.find(v => v.name === selection.routeVrf);
  if (!routeVrfObj) return null;
  const scopes = node.type === 'firewall'
    ? [routeVrfObj, ...node.vrfs.filter(v => v.name !== selection.routeVrf)]
    : [routeVrfObj];

  if (selection.route.protocol === 'Connected') {
    for (const scope of scopes) {
      const it = scope.interfaces.find(i => i.name === selection.route.nextHop);
      if (it) return { intf: it, intfName: it.name, zone: scope.name };
    }
    return null;
  }

  // A static can point straight at an interface (e.g. a tunnel); otherwise the
  // next-hop IP must sit in a connected subnet.
  for (const scope of scopes) {
    const it = scope.interfaces.find(i => i.name === selection.route.nextHop)
      || scope.interfaces.find(i => matchCidr(selection.route.nextHop, i.ip));
    if (it) return { intf: it, intfName: it.name, zone: scope.name };
  }
  return null;
}

const IMPLICIT_DENY_RULE: FirewallRule = {
  id: 'implicit_deny',
  name: 'Implicit Deny All',
  sourceVrf: 'any',
  destVrf: 'any',
  sourceIp: 'any',
  destIp: 'any',
  protocol: 'any',
  sourcePort: 'any',
  destPort: 'any',
  action: 'deny',
  description: 'Default implicit drop rule when no rule matches',
};

// Core Hop Engine Path Simulation Logic
export function executeSimulation(
  nodes: NetworkNode[],
  links: NetworkLink[],
  query: PathQuery,
  settings: SimulationSettings = DEFAULT_SETTINGS
): SimulationResult {
  const hops: SimulationHop[] = [];
  let step = 1;
  let currentNodeId = query.sourceNodeId;
  let currentVrf = query.sourceVrf;
  let currentSrcIp = query.sourceIp;
  let currentDestIp = query.destIp;
  const currentSrcPort = query.sourcePort;
  const currentDestPort = query.destPort;
  const currentProtocol = query.protocol;

  const visited = new Set<string>();
  const maxHops = Math.max(1, Number(settings.maxHops) || DEFAULT_SETTINGS.maxHops);
  let status: SimulationResult['status'] = 'SUCCESS';

  // Check if source IP is an implied client connected to an interface of the start node
  const startNode = nodes.find(n => n.id === currentNodeId);
  let initialGatewayInterfaceName = '';
  let initialGatewayInterfaceIp = '';

  if (startNode) {
    const vrf = startNode.vrfs.find(v => v.name === currentVrf);
    if (vrf) {
      const matchingIntf = vrf.interfaces.find(i => {
        const ipOnly = i.ip.split('/')[0];
        return matchCidr(currentSrcIp, i.ip) && ipOnly !== currentSrcIp;
      });
      if (matchingIntf) {
        initialGatewayInterfaceIp = matchingIntf.ip.split('/')[0];
        initialGatewayInterfaceName = matchingIntf.name;
      }
    }
  }

  if (initialGatewayInterfaceIp) {
    hops.push({
      step: 1,
      nodeId: 'implied-host',
      nodeName: `Client (${currentSrcIp})`,
      nodeType: 'host',
      ingressVrf: null,
      ingressInterface: null,
      egressInterface: 'uplink',
      nextHopIp: initialGatewayInterfaceIp,
      routeMatched: {
        id: 'default_gateway',
        destination: '0.0.0.0/0',
        nextHop: initialGatewayInterfaceIp,
        protocol: 'Connected',
        metric: 0,
        vrf: 'default',
      },
      decision: 'Forwarded',
      details: `Packet originates from client host ${currentSrcIp} and is sent to its default gateway ${initialGatewayInterfaceIp} on ${startNode!.name} (${initialGatewayInterfaceName}).`,
    });
    step = 2;
  }

  while (step <= maxHops) {
    const node = nodes.find(n => n.id === currentNodeId);
    if (!node) {
      hops.push({
        step,
        nodeId: currentNodeId,
        nodeName: 'Unknown',
        nodeType: 'host',
        ingressVrf: currentVrf,
        ingressInterface: null,
        egressInterface: null,
        nextHopIp: null,
        routeMatched: null,
        decision: 'No Route',
        details: `Node with ID "${currentNodeId}" not found in digital twin inventory.`,
      });
      status = 'NO_ROUTE';
      break;
    }

    // Check for routing loops
    const visitKey = `${currentNodeId}|${currentVrf}|${currentSrcIp}|${currentDestIp}`;
    if (visited.has(visitKey)) {
      hops.push({
        step,
        nodeId: currentNodeId,
        nodeName: node.name,
        nodeType: node.type,
        ingressVrf: currentVrf,
        ingressInterface: null,
        egressInterface: null,
        nextHopIp: null,
        routeMatched: null,
        decision: 'Loop Detected',
        details: 'Infinite routing loop detected at this node.',
      });
      status = 'NO_ROUTE';
      break;
    }
    visited.add(visitKey);

    // Ingress interface identification (if previous hop exists)
    let ingressInterface: string | null = null;
    if (hops.length > 0) {
      const prevHop = hops[hops.length - 1];
      if (prevHop.nodeId === 'implied-host') {
        ingressInterface = initialGatewayInterfaceName;
      } else {
        const link = links.find(l =>
          (l.sourceNodeId === prevHop.nodeId && l.sourceInterface === prevHop.egressInterface && l.destNodeId === node.id) ||
          (l.destNodeId === prevHop.nodeId && l.destInterface === prevHop.egressInterface && l.sourceNodeId === node.id)
        );
        if (link) {
          ingressInterface = link.sourceNodeId === node.id ? link.sourceInterface : link.destInterface;
        }
      }
    }

    // Security zone the packet entered on (pre-NAT). Firewall policies match
    // sourceVrf against this, never against post-lookup or post-NAT values.
    const ingressZone = currentVrf;

    const vrf = node.vrfs.find(v => v.name === currentVrf);
    if (!vrf) {
      hops.push({
        step,
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        ingressVrf: currentVrf,
        ingressInterface,
        egressInterface: null,
        nextHopIp: null,
        routeMatched: null,
        decision: 'No Route',
        details: `VRF "${currentVrf}" context not active or defined on ${node.name}.`,
      });
      status = 'NO_ROUTE';
      break;
    }

    // Destination IP terminates on this node? (firewalls own all their zones)
    const ownIntfScopes = node.type === 'firewall' ? node.vrfs : [vrf];
    let destinationInterface: Interface | undefined;
    for (const scope of ownIntfScopes) {
      destinationInterface = scope.interfaces.find(i => i.ip.split('/')[0] === currentDestIp);
      if (destinationInterface) break;
    }

    if (destinationInterface) {
      hops.push({
        step,
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        ingressVrf: currentVrf,
        ingressInterface,
        egressInterface: destinationInterface.name,
        nextHopIp: null,
        routeMatched: {
          id: 'local_interface',
          destination: destinationInterface.ip,
          nextHop: 'Directly Connected',
          protocol: 'Connected',
          metric: 0,
          vrf: currentVrf,
        },
        decision: 'Reached Destination',
        details: `Destination IP matches interface ${destinationInterface.name} on ${node.name}.`,
      });
      status = 'SUCCESS';
      break;
    }

    // NAT CHECKPOINT - Ingress DNAT (Static NAT). Only the destination header
    // mutates here; the routing lookup below finds the real zone via LPM.
    let natAppliedDetails: SimulationHop['natApplied'] | undefined;
    if (node.type === 'firewall' && node.natMappings) {
      const staticNatMatch = node.natMappings.find(n => n.type === 'Static NAT' && n.insideGlobal === currentDestIp);
      if (staticNatMatch) {
        const oldDest = currentDestIp;
        currentDestIp = staticNatMatch.insideLocal;
        natAppliedDetails = {
          type: 'Static Destination NAT',
          before: oldDest,
          after: `${currentDestIp} (${staticNatMatch.vrf})`,
        };
      }
    }

    // Longest Prefix Match route selection (zone-crossing on firewalls)
    const selection = selectRoute(node, currentVrf, currentDestIp);
    if (!selection) {
      hops.push({
        step,
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        ingressVrf: currentVrf,
        ingressInterface,
        egressInterface: null,
        nextHopIp: null,
        routeMatched: null,
        decision: 'No Route',
        details: `No route to destination ${currentDestIp} in routing table for VRF ${currentVrf}.`,
        natApplied: natAppliedDetails,
      });
      status = 'NO_ROUTE';
      break;
    }

    const bestRoute = selection.route;
    const egress = resolveEgress(node, selection);
    if (!egress) {
      hops.push({
        step,
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        ingressVrf: currentVrf,
        ingressInterface,
        egressInterface: null,
        nextHopIp: bestRoute.protocol === 'Connected' ? null : bestRoute.nextHop,
        routeMatched: bestRoute,
        decision: 'No Route',
        details: `Route ${bestRoute.destination} selected, but next hop "${bestRoute.nextHop}" is not reachable via any connected interface subnet in VRF ${selection.routeVrf}. Packet dropped.`,
        natApplied: natAppliedDetails,
      });
      status = 'NO_ROUTE';
      break;
    }

    const egressInterface = egress.intfName;
    const egressZone = egress.zone;
    const nextHopIp = bestRoute.protocol === 'Connected' ? null : bestRoute.nextHop;

    // Determine neighbor node and its VRF via the physical link
    let nextNodeId: string | null = null;
    let nextVrf = egressZone;

    const activeLink = links.find(l =>
      (l.sourceNodeId === node.id && l.sourceInterface === egressInterface) ||
      (l.destNodeId === node.id && l.destInterface === egressInterface)
    );

    if (activeLink) {
      nextNodeId = activeLink.sourceNodeId === node.id ? activeLink.destNodeId : activeLink.sourceNodeId;
      const targetNode = nodes.find(n => n.id === nextNodeId);
      if (targetNode) {
        // Crossing the link, VRF context is determined by the remote interface's VRF
        const targetIntName = activeLink.sourceNodeId === node.id ? activeLink.destInterface : activeLink.sourceInterface;
        const targetVrfMatch = targetNode.vrfs.find(v => v.interfaces.some(i => i.name === targetIntName));
        if (targetVrfMatch) {
          nextVrf = targetVrfMatch.name;
        }
      }
    }

    // FIREWALL CHECKPOINT: evaluate policies before SNAT so rules see the
    // original source IP and the post-DNAT (real) destination IP.
    let decision: SimulationHop['decision'] = 'Forwarded';
    let details = `Forwarded via ${bestRoute.protocol} route matching ${bestRoute.destination} egressing ${egressInterface}.`;
    let firewallRuleMatched: FirewallRule | undefined;
    let blocked = false;

    if (node.type === 'firewall') {
      if (query.bypassPolicies) {
        details = `Forwarded via ${bestRoute.protocol} route matching ${bestRoute.destination} egressing ${egressInterface}. (Security policy checks bypassed to focus purely on routing & NAT flow).`;
      } else if (node.firewallRules && node.firewallRules.length > 0) {
        let matchedRule: FirewallRule | undefined;

        for (const rule of node.firewallRules) {
          const vrfSrcOk = rule.sourceVrf === 'any' || rule.sourceVrf === ingressZone;
          const vrfDstOk = rule.destVrf === 'any' || rule.destVrf === egressZone;
          const ipSrcOk = matchCidr(currentSrcIp, rule.sourceIp);
          const ipDstOk = matchCidr(currentDestIp, rule.destIp);
          const protoOk = rule.protocol === 'any' || rule.protocol.toLowerCase() === currentProtocol.toLowerCase();
          const portsOk = currentProtocol === 'icmp' ||
            (matchPort(rule.sourcePort, currentSrcPort) && matchPort(rule.destPort, currentDestPort));

          if (vrfSrcOk && vrfDstOk && ipSrcOk && ipDstOk && protoOk && portsOk) {
            matchedRule = rule;
            break;
          }
        }

        if (matchedRule) {
          firewallRuleMatched = matchedRule;
          if (matchedRule.action === 'deny') {
            decision = 'Firewall Deny';
            details = `Denied by security policy: "${matchedRule.name}" (zone ${ingressZone} ➔ ${egressZone}).`;
            blocked = true;
          } else {
            decision = 'Firewall Permit';
            details = `Permitted by security policy: "${matchedRule.name}" (zone ${ingressZone} ➔ ${egressZone}). Routing to next node.`;
          }
        } else if (settings.implicitDeny) {
          firewallRuleMatched = IMPLICIT_DENY_RULE;
          decision = 'Firewall Deny';
          details = `Dropped by implicit firewall block (no matching policy rules for zone ${ingressZone} ➔ ${egressZone}).`;
          blocked = true;
        } else {
          details = `No security policy matched (zone ${ingressZone} ➔ ${egressZone}); implicit deny is disabled, traffic forwarded.`;
        }
      } else {
        details = `Forwarded via ${bestRoute.protocol} route matching ${bestRoute.destination} egressing ${egressInterface}. (No security policies defined, routing flow evaluated).`;
      }

      // NAT CHECKPOINT - Egress SNAT when leaving towards an outside zone.
      // Static NAT applies in reverse for its inside host; PAT covers the rest.
      const leavingOutside = egress.intf.natType === 'outside' || (egressZone === 'default' && ingressZone !== 'default');
      if (!blocked && !natAppliedDetails && node.natMappings && leavingOutside) {
        const staticSrc = node.natMappings.find(n => n.type === 'Static NAT' && n.insideLocal === currentSrcIp);
        const patMatch = node.natMappings.find(n =>
          n.type === 'PAT / Dynamic' && (n.vrf === ingressZone || matchCidr(currentSrcIp, n.insideLocal))
        );
        if (staticSrc) {
          natAppliedDetails = { type: 'Static Source NAT', before: currentSrcIp, after: staticSrc.insideGlobal };
          currentSrcIp = staticSrc.insideGlobal;
        } else if (patMatch) {
          natAppliedDetails = { type: 'Dynamic Source PAT', before: currentSrcIp, after: patMatch.insideGlobal };
          currentSrcIp = patMatch.insideGlobal;
        }
      }
    }

    hops.push({
      step,
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      ingressVrf: ingressZone,
      ingressInterface,
      egressInterface,
      nextHopIp,
      routeMatched: bestRoute,
      decision,
      details,
      firewallRuleMatched,
      natApplied: natAppliedDetails,
    });

    if (blocked) {
      status = 'BLOCKED_BY_FIREWALL';
      break;
    }

    // Move to next node or finish
    if (!nextNodeId) {
      // Destination inside the egress interface's connected subnet -> delivered
      if (matchCidr(currentDestIp, egress.intf.ip)) {
        hops.push({
          step: step + 1,
          nodeId: 'implied-dest',
          nodeName: `Destination Host (${currentDestIp})`,
          nodeType: 'host',
          ingressVrf: egressZone,
          ingressInterface: 'LAN',
          egressInterface: null,
          nextHopIp: null,
          routeMatched: null,
          decision: 'Reached Destination',
          details: `Packet successfully arrived at destination host ${currentDestIp} in connected subnet.`,
        });
        status = 'SUCCESS';
        break;
      }

      // Reached end of physical topology but not final destination host
      hops.push({
        step: step + 1,
        nodeId: 'outside',
        nodeName: 'External Sink',
        nodeType: 'host',
        ingressVrf: egressZone,
        ingressInterface: null,
        egressInterface: null,
        nextHopIp: null,
        routeMatched: null,
        decision: 'No Route',
        details: `Egress interface ${egressInterface} has no physical links configured. Packet dropped.`,
      });
      status = 'NO_ROUTE';
      break;
    }

    currentNodeId = nextNodeId;
    currentVrf = nextVrf;
    step++;
  }

  if (step > maxHops && status === 'SUCCESS' && hops[hops.length - 1]?.decision !== 'Reached Destination') {
    status = 'MAX_HOPS_EXCEEDED';
  }

  return { query, hops, status };
}
