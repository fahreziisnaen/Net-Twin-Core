// Read-only command whitelist. The sidecar may ONLY run commands listed here,
// keyed by Netmiko device_type + intent. This is the hard guarantee that the
// SSH collector can never modify a device — there is no free-form command path.

// vrfRoutes: per-VRF routing tables where the vendor keeps them behind a
// separate command. A fixed wildcard command keeps the whitelist static — VRF
// names from the device never become part of a command.
export type CollectIntent = 'config' | 'routes' | 'vrfRoutes' | 'arp' | 'neighbors';

export const COMMAND_WHITELIST: Record<string, Partial<Record<CollectIntent, string>>> = {
  cisco_ios: {
    config: 'show running-config',
    routes: 'show ip route',
    vrfRoutes: 'show ip route vrf *',
    arp: 'show ip arp',
    neighbors: 'show cdp neighbors detail',
  },
  juniper_junos: {
    config: 'show configuration | display set',
    routes: 'show route',
    arp: 'show arp',
    neighbors: 'show lldp neighbors',
  },
  juniper_screenos: {
    config: 'get config',
    routes: 'get route',
    arp: 'get arp',
  },
  fortinet: {
    config: 'show full-configuration',
    routes: 'get router info routing-table all',
    arp: 'get system arp',
  },
  paloalto_panos: {
    config: 'show config running',
    routes: 'show routing route',
    arp: 'show arp all',
  },
};

export const SUPPORTED_VENDORS = Object.keys(COMMAND_WHITELIST);
export const COLLECT_INTENTS: CollectIntent[] = ['config', 'routes', 'vrfRoutes', 'arp', 'neighbors'];

// Own-property checks only: `"constructor" in {}` is true, and inherited
// members must never count as a vendor or a command.
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function isVendorSupported(vendor: unknown): vendor is string {
  return typeof vendor === 'string' && hasOwn(COMMAND_WHITELIST, vendor);
}

export function isCollectIntent(intent: unknown): intent is CollectIntent {
  return typeof intent === 'string' && (COLLECT_INTENTS as string[]).includes(intent);
}

// The exact commands to run for a vendor + requested intents. Anything not in
// the whitelist is silently dropped — it can never reach the device.
export function commandsFor(vendor: string, intents: CollectIntent[]): { intent: CollectIntent; command: string }[] {
  if (!isVendorSupported(vendor)) return [];
  const map = COMMAND_WHITELIST[vendor];
  return intents
    .filter(i => isCollectIntent(i) && hasOwn(map, i))
    .map(i => ({ intent: i, command: map[i]! }));
}
