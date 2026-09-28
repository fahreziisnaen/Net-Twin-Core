import { NetworkNode, NetworkLink, ComplianceAudit, ChangeRequest } from './types';

// INITIAL STATE: Pre-populated High-Fidelity Enterprise Reference Digital Twin
const seedNodes: NetworkNode[] = [
  {
    id: 'core-r1',
    name: 'Core-R1',
    type: 'router',
    status: 'online',
    vrfs: [
      {
        name: 'PRODUCTION',
        description: 'L3 Context for Production application zone',
        interfaces: [
          { name: 'GigabitEthernet1', ip: '10.100.1.1/30', status: 'up' },
          { name: 'GigabitEthernet2', ip: '10.100.20.1/24', status: 'up' }, // Gateway to Web server
          { name: 'GigabitEthernet3', ip: '10.100.10.1/24', status: 'up' }, // Gateway to App servers
        ],
        routes: [
          { id: 'r1_p1', destination: '10.100.1.0/30', nextHop: 'GigabitEthernet1', protocol: 'Connected', metric: 0, vrf: 'PRODUCTION' },
          { id: 'r1_p2', destination: '10.100.20.0/24', nextHop: 'GigabitEthernet2', protocol: 'Connected', metric: 0, vrf: 'PRODUCTION' },
          { id: 'r1_p3', destination: '10.100.10.0/24', nextHop: 'GigabitEthernet3', protocol: 'Connected', metric: 0, vrf: 'PRODUCTION' },
          { id: 'r1_p4', destination: '192.168.50.0/24', nextHop: '10.100.1.2', protocol: 'OSPF', metric: 20, vrf: 'PRODUCTION' }, // route to PCI via Edge-FW
          { id: 'r1_p5', destination: '10.200.0.0/16', nextHop: '10.100.1.2', protocol: 'OSPF', metric: 20, vrf: 'PRODUCTION' }, // route to Corp via Edge-FW
          { id: 'r1_p_def', destination: '0.0.0.0/0', nextHop: '10.100.1.2', protocol: 'Static', metric: 1, vrf: 'PRODUCTION' },
        ],
      },
      {
        name: 'PCI-ZONE',
        description: 'PCI Cardholder Data Environment Zone',
        interfaces: [
          { name: 'GigabitEthernet4', ip: '192.168.50.1/24', status: 'up' }, // Gateway to PCI database
        ],
        routes: [
          { id: 'r1_pci1', destination: '192.168.50.0/24', nextHop: 'GigabitEthernet4', protocol: 'Connected', metric: 0, vrf: 'PCI-ZONE' },
          { id: 'r1_pci_def', destination: '0.0.0.0/0', nextHop: '192.168.50.2', protocol: 'Static', metric: 1, vrf: 'PCI-ZONE' },
        ],
      },
    ],
  },
  {
    id: 'core-r2',
    name: 'Core-R2',
    type: 'router',
    status: 'online',
    vrfs: [
      {
        name: 'CORPORATE',
        description: 'Corporate Network context (Employees, Wi-Fi)',
        interfaces: [
          { name: 'GigabitEthernet1', ip: '10.200.1.1/30', status: 'up' },
          { name: 'GigabitEthernet2', ip: '10.200.15.1/24', status: 'up' }, // Gateway to User PC
        ],
        routes: [
          { id: 'r2_c1', destination: '10.200.1.0/30', nextHop: 'GigabitEthernet1', protocol: 'Connected', metric: 0, vrf: 'CORPORATE' },
          { id: 'r2_c2', destination: '10.200.15.0/24', nextHop: 'GigabitEthernet2', protocol: 'Connected', metric: 0, vrf: 'CORPORATE' },
          { id: 'r2_c_def', destination: '0.0.0.0/0', nextHop: '10.200.1.2', protocol: 'Static', metric: 1, vrf: 'CORPORATE' },
        ],
      },
    ],
  },
  {
    id: 'edge-fw01',
    name: 'Edge-FW01',
    type: 'firewall',
    status: 'online',
    vrfs: [
      {
        name: 'PRODUCTION',
        description: 'Firewall Prod Security Context',
        interfaces: [
          { name: 'ge-0/0/1', ip: '10.100.1.2/30', status: 'up', natType: 'inside' },
        ],
        routes: [
          { id: 'fw_p1', destination: '10.100.1.0/30', nextHop: 'ge-0/0/1', protocol: 'Connected', metric: 0, vrf: 'PRODUCTION' },
          { id: 'fw_p2', destination: '10.100.0.0/16', nextHop: '10.100.1.1', protocol: 'OSPF', metric: 10, vrf: 'PRODUCTION' },
          { id: 'fw_p_def', destination: '0.0.0.0/0', nextHop: '198.51.100.1', protocol: 'Static', metric: 1, vrf: 'PRODUCTION' },
        ],
      },
      {
        name: 'CORPORATE',
        description: 'Firewall Corp Security Context',
        interfaces: [
          { name: 'ge-0/0/2', ip: '10.200.1.2/30', status: 'up', natType: 'inside' },
        ],
        routes: [
          { id: 'fw_c1', destination: '10.200.1.0/30', nextHop: 'ge-0/0/2', protocol: 'Connected', metric: 0, vrf: 'CORPORATE' },
          { id: 'fw_c2', destination: '10.200.0.0/16', nextHop: '10.200.1.1', protocol: 'OSPF', metric: 10, vrf: 'CORPORATE' },
          { id: 'fw_c_def', destination: '0.0.0.0/0', nextHop: '198.51.100.1', protocol: 'Static', metric: 1, vrf: 'CORPORATE' },
        ],
      },
      {
        name: 'PCI-ZONE',
        description: 'Firewall PCI Security Context',
        interfaces: [
          { name: 'ge-0/0/3', ip: '192.168.50.2/24', status: 'up', natType: 'inside' },
        ],
        routes: [
          { id: 'fw_pci1', destination: '192.168.50.0/24', nextHop: 'ge-0/0/3', protocol: 'Connected', metric: 0, vrf: 'PCI-ZONE' },
          { id: 'fw_pci_def', destination: '0.0.0.0/0', nextHop: '198.51.100.1', protocol: 'Static', metric: 1, vrf: 'PCI-ZONE' },
        ],
      },
      {
        name: 'default',
        description: 'Default / Internet routing context',
        interfaces: [
          { name: 'ge-0/0/0', ip: '198.51.100.2/29', status: 'up', natType: 'outside' },
        ],
        routes: [
          { id: 'fw_def1', destination: '198.51.100.0/29', nextHop: 'ge-0/0/0', protocol: 'Connected', metric: 0, vrf: 'default' },
          { id: 'fw_def_def', destination: '0.0.0.0/0', nextHop: '198.51.100.1', protocol: 'Static', metric: 1, vrf: 'default' },
        ],
      },
    ],
    firewallRules: [
      {
        id: 'rule_1',
        name: 'Corp to Prod HTTPS',
        sourceVrf: 'CORPORATE',
        destVrf: 'PRODUCTION',
        sourceIp: '10.200.0.0/16',
        destIp: '10.100.20.10/32',
        protocol: 'tcp',
        sourcePort: 'any',
        destPort: '443',
        action: 'permit',
        description: 'Allow corporate users to securely access Prod Web Server on HTTPS',
      },
      {
        id: 'rule_2',
        name: 'Prod App to PCI Database',
        sourceVrf: 'PRODUCTION',
        destVrf: 'PCI-ZONE',
        sourceIp: '10.100.10.0/24',
        destIp: '192.168.50.10/32',
        protocol: 'tcp',
        sourcePort: 'any',
        destPort: '5432',
        action: 'permit',
        description: 'Allow production backend application servers to query PCI DB',
      },
      {
        id: 'rule_3',
        name: 'Prod outbound Internet',
        sourceVrf: 'PRODUCTION',
        destVrf: 'default',
        sourceIp: '10.100.0.0/16',
        destIp: 'any',
        protocol: 'any',
        sourcePort: 'any',
        destPort: 'any',
        action: 'permit',
        description: 'Allow production updates and telemetry outbound access',
      },
      {
        id: 'rule_4',
        name: 'Corp outbound Internet',
        sourceVrf: 'CORPORATE',
        destVrf: 'default',
        sourceIp: '10.200.0.0/16',
        destIp: 'any',
        protocol: 'any',
        sourcePort: 'any',
        destPort: 'any',
        action: 'permit',
        description: 'Allow corporate users web browsing outbound access via PAT',
      },
      {
        id: 'rule_5',
        name: 'Internet to Public Web',
        sourceVrf: 'default',
        destVrf: 'PRODUCTION',
        sourceIp: 'any',
        destIp: '10.100.20.10/32',
        protocol: 'tcp',
        sourcePort: 'any',
        destPort: '443',
        action: 'permit',
        description: 'Allow public HTTPS traffic to NATed Web Server',
      },
      {
        id: 'rule_pci_deny_all',
        name: 'Block PCI Isolation Leaks',
        sourceVrf: 'any',
        destVrf: 'PCI-ZONE',
        sourceIp: 'any',
        destIp: 'any',
        protocol: 'any',
        sourcePort: 'any',
        destPort: 'any',
        action: 'deny',
        description: 'Strict PCI DSS regulatory isolation block',
      },
    ],
    natMappings: [
      {
        id: 'nat_static_1',
        type: 'Static NAT',
        insideLocal: '10.100.20.10',
        insideGlobal: '198.51.100.10',
        vrf: 'PRODUCTION',
      },
      {
        id: 'nat_pat_1',
        type: 'PAT / Dynamic',
        insideLocal: '10.200.0.0/16',
        insideGlobal: '198.51.100.2',
        vrf: 'CORPORATE',
      },
    ],
  },
  {
    id: 'internet',
    name: 'Internet',
    type: 'host',
    status: 'online',
    vrfs: [
      {
        name: 'default',
        description: 'Global Routing Context',
        interfaces: [
          // The Internet node acts as the upstream ISP router (198.51.100.1)
          // on the shared /29 transit subnet with Edge-FW01 (198.51.100.2).
          { name: 'WAN', ip: '198.51.100.1/29', status: 'up' },
          { name: 'GoogleDNS', ip: '8.8.8.8/32', status: 'up' },
          { name: 'Client_PC', ip: '203.0.113.50/32', status: 'up' },
        ],
        routes: [
          { id: 'int_0', destination: '198.51.100.0/29', nextHop: 'WAN', protocol: 'Connected', metric: 0, vrf: 'default' },
          { id: 'int_1', destination: '8.8.8.8/32', nextHop: 'GoogleDNS', protocol: 'Connected', metric: 0, vrf: 'default' },
          { id: 'int_2', destination: '203.0.113.50/32', nextHop: 'Client_PC', protocol: 'Connected', metric: 0, vrf: 'default' },
          { id: 'int_def', destination: '0.0.0.0/0', nextHop: '198.51.100.2', protocol: 'Static', metric: 1, vrf: 'default' },
        ],
      },
    ],
  },
  {
    id: 'pci-db-01',
    name: 'PCI-DB-01',
    type: 'host',
    status: 'online',
    vrfs: [
      {
        name: 'PCI-ZONE',
        description: 'Local host interface',
        interfaces: [
          { name: 'eth0', ip: '192.168.50.10/24', status: 'up' },
        ],
        routes: [
          { id: 'pci_h1', destination: '192.168.50.0/24', nextHop: 'eth0', protocol: 'Connected', metric: 0, vrf: 'PCI-ZONE' },
          { id: 'pci_h_def', destination: '0.0.0.0/0', nextHop: '192.168.50.1', protocol: 'Static', metric: 1, vrf: 'PCI-ZONE' },
        ],
      },
    ],
  },
  {
    id: 'corp-pc-01',
    name: 'Corp-PC-01',
    type: 'host',
    status: 'online',
    vrfs: [
      {
        name: 'CORPORATE',
        description: 'Local host interface',
        interfaces: [
          { name: 'en0', ip: '10.200.15.42/24', status: 'up' },
        ],
        routes: [
          { id: 'corp_h1', destination: '10.200.15.0/24', nextHop: 'en0', protocol: 'Connected', metric: 0, vrf: 'CORPORATE' },
          { id: 'corp_h_def', destination: '0.0.0.0/0', nextHop: '10.200.15.1', protocol: 'Static', metric: 1, vrf: 'CORPORATE' },
        ],
      },
    ],
  },
  {
    id: 'prod-web-01',
    name: 'Prod-Web-01',
    type: 'host',
    status: 'online',
    vrfs: [
      {
        name: 'PRODUCTION',
        description: 'Local host interface',
        interfaces: [
          { name: 'eth0', ip: '10.100.20.10/24', status: 'up' },
        ],
        routes: [
          { id: 'web_h1', destination: '10.100.20.0/24', nextHop: 'eth0', protocol: 'Connected', metric: 0, vrf: 'PRODUCTION' },
          { id: 'web_h_def', destination: '0.0.0.0/0', nextHop: '10.100.20.1', protocol: 'Static', metric: 1, vrf: 'PRODUCTION' },
        ],
      },
    ],
  },
];

const seedLinks: NetworkLink[] = [
  // Links connecting Core-R1
  { id: 'link_1', sourceNodeId: 'core-r1', sourceInterface: 'GigabitEthernet1', destNodeId: 'edge-fw01', destInterface: 'ge-0/0/1' },
  { id: 'link_2', sourceNodeId: 'core-r1', sourceInterface: 'GigabitEthernet2', destNodeId: 'prod-web-01', destInterface: 'eth0' },
  // Links connecting Core-R2
  { id: 'link_3', sourceNodeId: 'core-r2', sourceInterface: 'GigabitEthernet1', destNodeId: 'edge-fw01', destInterface: 'ge-0/0/2' },
  { id: 'link_4', sourceNodeId: 'core-r2', sourceInterface: 'GigabitEthernet2', destNodeId: 'corp-pc-01', destInterface: 'en0' },
  // Link between Core-R1 and PCI Database
  { id: 'link_5', sourceNodeId: 'core-r1', sourceInterface: 'GigabitEthernet4', destNodeId: 'pci-db-01', destInterface: 'eth0' },
  // Firewall to Internet Link
  { id: 'link_6', sourceNodeId: 'edge-fw01', sourceInterface: 'ge-0/0/0', destNodeId: 'internet', destInterface: 'WAN' },
];

// Compliance audit list
const seedAudits: ComplianceAudit[] = [
  {
    id: 'audit_1',
    name: 'PCI Zone Isolation from Corporate',
    description: 'Verify corporate users (10.200.15.42) CANNOT reach PCI database (192.168.50.10) on any protocol.',
    category: 'PCI-DSS',
    query: {
      sourceNodeId: 'corp-pc-01',
      sourceVrf: 'CORPORATE',
      sourceIp: '10.200.15.42',
      destIp: '192.168.50.10',
      protocol: 'tcp',
      sourcePort: '1024',
      destPort: '5432',
    },
    expectedResult: 'BLOCKED_BY_FIREWALL',
    status: 'untested',
  },
  {
    id: 'audit_2',
    name: 'Production Server Internet Outbound Access',
    description: 'Verify Prod Web Server (10.100.20.10) CAN reach the Internet (8.8.8.8) for updates.',
    category: 'Security Policy',
    query: {
      sourceNodeId: 'prod-web-01',
      sourceVrf: 'PRODUCTION',
      sourceIp: '10.100.20.10',
      destIp: '8.8.8.8',
      protocol: 'tcp',
      sourcePort: '1234',
      destPort: '443',
    },
    expectedResult: 'SUCCESS',
    status: 'untested',
  },
  {
    id: 'audit_3',
    name: 'Corp Users Access Prod Web Application',
    description: 'Verify corporate workstations (10.200.15.42) CAN reach Prod Web Server (10.100.20.10) over HTTPS.',
    category: 'Security Policy',
    query: {
      sourceNodeId: 'corp-pc-01',
      sourceVrf: 'CORPORATE',
      sourceIp: '10.200.15.42',
      destIp: '10.100.20.10',
      protocol: 'tcp',
      sourcePort: '1044',
      destPort: '443',
    },
    expectedResult: 'SUCCESS',
    status: 'untested',
  },
  {
    id: 'audit_4',
    name: 'Internet Public Access Blocked to PCI Zone',
    description: 'Verify outside Internet hosts (203.0.113.50) CANNOT access PCI Database (192.168.50.10) on port 5432.',
    category: 'PCI-DSS',
    query: {
      sourceNodeId: 'internet',
      sourceVrf: 'default',
      sourceIp: '203.0.113.50',
      destIp: '192.168.50.10',
      protocol: 'tcp',
      sourcePort: '3320',
      destPort: '5432',
    },
    expectedResult: 'BLOCKED_BY_FIREWALL',
    status: 'untested',
  },
];

const seedChangeRequests: ChangeRequest[] = [
  {
    id: 'cr_1',
    title: 'Enable Prod Backend sync to PCI Database',
    description: 'Requesting permission for PostgreSQL replication from Prod App subnet (10.100.10.0/24) to the cardholder DB (192.168.50.10) on port 5432.',
    requester: 'Network Security Lead',
    status: 'applied',
    createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
    nodeId: 'edge-fw01',
    proposedRules: [
      {
        id: 'rule_cr_1',
        name: 'Prod App replication to PCI DB',
        sourceVrf: 'PRODUCTION',
        destVrf: 'PCI-ZONE',
        sourceIp: '10.100.10.0/24',
        destIp: '192.168.50.10/32',
        protocol: 'tcp',
        sourcePort: 'any',
        destPort: '5432',
        action: 'permit',
        description: 'Auto-applied via change request approval'
      }
    ]
  }
];

const deepCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Fresh deep copies so callers can mutate state without corrupting the seed
export const getSeedNodes = (): NetworkNode[] => deepCopy(seedNodes);
export const getSeedLinks = (): NetworkLink[] => deepCopy(seedLinks);
export const getSeedAudits = (): ComplianceAudit[] => deepCopy(seedAudits);
export const getSeedChangeRequests = (): ChangeRequest[] => deepCopy(seedChangeRequests);
