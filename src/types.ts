export type NodeType = 'router' | 'firewall' | 'switch' | 'host';

export interface Interface {
  name: string;
  ip: string; // CIDR format, e.g. "10.1.1.1/24"
  status: 'up' | 'down';
  natType?: 'inside' | 'outside' | 'static' | 'pat';
  mappedIp?: string; // NAT mapping translation
  vlan?: number; // optional VLAN id for IPAM grouping
}

export interface IpReservation {
  id: string;
  ip: string;
  note: string;
  createdAt: string;
}

// A read-only SSH connection to a real device. The password is stored ENCRYPTED
// server-side and is never sent to the frontend (the API returns hasPassword).
export interface DeviceConnection {
  id: string;
  name: string;
  host: string;             // management IP / hostname
  port: number;             // default 22
  vendor: string;           // Netmiko device_type, e.g. "cisco_ios"
  username: string;
  passwordEnc?: string;     // AES-GCM blob (server only; stripped in API responses)
  hasPassword?: boolean;    // API-facing flag
  targetNodeId?: string;    // optional: which twin node this maps to
  hostKey?: string;         // pinned SSH host key "keytype base64" (TOFU)
  hostKeyFingerprint?: string; // human-readable "SHA256:..." for display
  lastCollectedAt?: string;
  lastStatus?: 'ok' | 'error' | 'never';
  lastError?: string;
}

export interface Route {
  id: string;
  destination: string; // CIDR format, e.g. "10.0.0.0/8" or "0.0.0.0/0"
  nextHop: string; // IP address or egress interface name, e.g. "10.1.1.2" or "GigabitEthernet1"
  protocol: 'Connected' | 'Static' | 'OSPF' | 'BGP';
  metric: number;
  vrf: string;
  origin?: 'rib'; // read from the device's live routing table by SSH Sync; replaced on each sync
}

export interface FirewallRule {
  id: string;
  name: string;
  sourceVrf: string;
  destVrf: string;
  sourceIp: string; // CIDR or "any"
  destIp: string; // CIDR or "any"
  protocol: 'any' | 'tcp' | 'udp' | 'icmp';
  sourcePort: string; // Port number, range, or "any"
  destPort: string; // Port number, range, or "any"
  action: 'permit' | 'deny';
  description: string;
}

export interface VRF {
  name: string;
  interfaces: Interface[];
  routes: Route[];
  description: string;
}

export interface NetworkNode {
  id: string;
  name: string;
  type: NodeType;
  status: 'online' | 'offline';
  rev?: number; // server-maintained revision; detects concurrent edits
  vrfs: VRF[];
  firewallRules?: FirewallRule[];
  natMappings?: {
    id: string;
    type: 'Static NAT' | 'PAT / Dynamic';
    insideLocal: string;
    insideGlobal: string;
    outsideLocal?: string;
    outsideGlobal?: string;
    vrf: string;
  }[];
}

export interface NetworkLink {
  id: string;
  sourceNodeId: string;
  sourceInterface: string;
  destNodeId: string;
  destInterface: string;
}

export interface PathQuery {
  sourceNodeId: string;
  sourceVrf: string;
  sourceIp: string;
  destIp: string;
  protocol: 'tcp' | 'udp' | 'icmp';
  sourcePort: string;
  destPort: string;
  bypassPolicies?: boolean;
}

export interface SimulationHop {
  step: number;
  nodeId: string;
  nodeName: string;
  nodeType: NodeType;
  ingressVrf: string | null;
  ingressInterface: string | null;
  egressInterface: string | null;
  nextHopIp: string | null;
  routeMatched: Route | null;
  decision: 'Forwarded' | 'Firewall Permit' | 'Firewall Deny' | 'No Route' | 'Loop Detected' | 'Reached Destination';
  details: string;
  firewallRuleMatched?: FirewallRule;
  natApplied?: {
    type: string;
    before: string;
    after: string;
  };
}

export interface SimulationResult {
  query: PathQuery;
  hops: SimulationHop[];
  status: 'SUCCESS' | 'BLOCKED_BY_FIREWALL' | 'NO_ROUTE' | 'MAX_HOPS_EXCEEDED';
}

export interface ComplianceAudit {
  id: string;
  name: string;
  description: string;
  category: 'PCI-DSS' | 'Security Policy' | 'Routing';
  query: PathQuery;
  expectedResult: 'SUCCESS' | 'BLOCKED_BY_FIREWALL' | 'NO_ROUTE';
  status: 'passed' | 'failed' | 'untested';
  lastRunDetails?: string;
}

export interface SimulationSettings {
  maxHops: number;
  implicitDeny: boolean;
}

export interface ChangeRequest {
  id: string;
  title: string;
  description: string;
  requester: string;
  status: 'draft' | 'simulated' | 'applied';
  createdAt: string;
  proposedRules: FirewallRule[];
  nodeId: string; // The firewall node to apply this to
  simulationResults?: {
    beforeStatus: string;
    afterStatus: string;
    beforeHops: SimulationHop[];
    afterHops: SimulationHop[];
  };
}
