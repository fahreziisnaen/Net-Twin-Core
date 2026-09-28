import { NetworkNode, Interface, Route, FirewallRule, DeviceConnection } from '../../src/types';
import { parseConfig } from '../parsers';
import { ParserProfile } from '../parsers/types';
import { decryptSecret } from '../crypto';
import { commandsFor, CollectIntent, isVendorSupported } from './whitelist';
import { normalizeRib, normalizeVrfRib, normalizeArp, normalizeNeighbors, NormalizedArp, NormalizedNeighbor } from './normalize';

const COLLECT_TIMEOUT_MS = 45_000;

// The sidecar refuses every request without a shared token, so both are needed.
export function collectorConfigured(): boolean {
  return !!process.env.COLLECTOR_URL && !!process.env.COLLECTOR_TOKEN;
}

// Netmiko device_type -> parser profile id (for the running-config parse)
const PROFILE_FOR_VENDOR: Record<string, string> = {
  cisco_ios: 'cisco-ios',
  cisco_xe: 'cisco-ios',
  cisco_nxos: 'cisco-ios',
  fortinet: 'fortigate',
  juniper_junos: 'junos',
  juniper_screenos: 'screenos',
  paloalto_panos: 'panos',
};

export interface CollectedData {
  hostname: string;
  vendor: string;
  interfaces: (Interface & { vrf?: string })[];
  vrfs: string[];
  routes: Route[];
  // VRFs whose live routing table was read. Their routes are authoritative:
  // applying them replaces the learned routes of those VRFs in the twin.
  // Empty when routes came from the config parse instead.
  ribVrfs: string[];
  firewallRules: FirewallRule[];
  natMappings: { type: 'Static NAT' | 'PAT / Dynamic'; insideLocal: string; insideGlobal: string; vrf: string }[];
  arp: NormalizedArp[];
  neighbors: NormalizedNeighbor[];
  warnings: string[];
}

export interface CollectOutcome {
  ok: boolean;
  error?: string;
  hostKeyMismatch?: boolean;      // pinned key didn't match — possible MITM / device replaced
  hostKey?: string;              // presented key (to pin on TOFU / re-pin)
  fingerprint?: string;         // human fingerprint for display
  raw?: Record<string, string>;   // intent -> raw output
  data?: CollectedData;
}

interface SidecarReply { results?: Record<string, string>; error?: string; status?: number; hostKey?: string; fingerprint?: string; }

// Talk to the Python sidecar. Read-only: we only ever send whitelisted commands.
// `expectedHostKey` pins the device identity (TOFU); a mismatch comes back 409.
async function callSidecar(conn: DeviceConnection, password: string, intents: CollectIntent[], expectedHostKey?: string): Promise<SidecarReply> {
  const commands = commandsFor(conn.vendor, intents);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COLLECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${process.env.COLLECTOR_URL}/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.COLLECTOR_TOKEN}` },
      body: JSON.stringify({
        host: conn.host,
        port: conn.port || 22,
        device_type: conn.vendor,
        username: conn.username,
        password,
        commands,
        expected_host_key: expectedHostKey || null,
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: (body as any).detail || (body as any).error || `Collector returned HTTP ${res.status}`, status: res.status };
    return { results: (body as any).results || {}, hostKey: (body as any).host_key, fingerprint: (body as any).fingerprint };
  } catch (err: any) {
    if (err.name === 'AbortError') return { error: 'Collection timed out' };
    return { error: `Cannot reach collector service: ${err.message}. Is the sidecar running?` };
  } finally {
    clearTimeout(timer);
  }
}

// Turn raw command outputs into the twin data model. Config goes through the
// existing parser; route/arp/neighbor outputs through the SSH normalizers.
export function assemble(vendor: string, raw: Record<string, string>, profiles: ParserProfile[]): CollectedData {
  const warnings: string[] = [];
  const profileId = PROFILE_FOR_VENDOR[vendor];
  const parsed = raw.config ? parseConfig(raw.config, profileId, profiles) : null;
  if (raw.config && parsed) warnings.push(...(parsed.warnings || []));

  // Prefer the live RIB (includes OSPF/BGP-learned routes); fall back to the
  // static routes parsed from the config when no routing table could be read.
  const global = raw.routes ? normalizeRib(vendor, raw.routes) : { routes: [], vrfs: [] };
  const perVrf = raw.vrfRoutes ? normalizeVrfRib(vendor, raw.vrfRoutes) : { routes: [], vrfs: [] };
  const ribVrfs = [...new Set([...global.vrfs, ...perVrf.vrfs])];
  const ribRoutes: Route[] = [...global.routes, ...perVrf.routes].map(r => ({ ...r, origin: 'rib' as const }));
  const configRoutes: Route[] = (parsed?.routes || []).map((r, i) => ({ ...r, id: `cfg_r_${i}` }));
  const routes = ribVrfs.length ? ribRoutes : configRoutes;
  if (raw.routes && !global.vrfs.length) {
    warnings.push('The device routing table could not be read; routes come from the static routes in the config.');
  }
  const firewallRules: FirewallRule[] = (parsed?.firewallRules || []).map((r, i) => ({ ...r, id: `cfg_fw_${i}` }));

  return {
    hostname: parsed?.hostname || '',
    vendor,
    interfaces: parsed?.interfaces || [],
    vrfs: parsed?.vrfs || [],
    routes,
    ribVrfs,
    firewallRules,
    natMappings: parsed?.natMappings || [],
    arp: raw.arp ? normalizeArp(vendor, raw.arp) : [],
    neighbors: raw.neighbors ? normalizeNeighbors(vendor, raw.neighbors) : [],
    warnings,
  };
}

export async function collect(conn: DeviceConnection, intents: CollectIntent[], profiles: ParserProfile[], opts?: { repin?: boolean }): Promise<CollectOutcome> {
  if (!collectorConfigured()) {
    return { ok: false, error: 'SSH collector is not configured (set COLLECTOR_URL and COLLECTOR_TOKEN).' };
  }
  if (!isVendorSupported(conn.vendor)) {
    return { ok: false, error: `Vendor "${conn.vendor}" is not supported yet for SSH collection` };
  }
  if (!conn.passwordEnc) return { ok: false, error: 'No stored credential for this connection' };

  let password: string;
  try {
    password = decryptSecret(conn.passwordEnc);
  } catch {
    return { ok: false, error: 'Failed to decrypt stored credential (wrong CRED_KEY?)' };
  }

  // Pin the stored host key unless this is a deliberate re-pin (Trust-On-First-Use).
  const expected = opts?.repin ? undefined : conn.hostKey;
  const reply = await callSidecar(conn, password, intents, expected);
  if (reply.error) {
    return { ok: false, error: reply.error, hostKeyMismatch: reply.status === 409 };
  }

  return {
    ok: true,
    raw: reply.results,
    hostKey: reply.hostKey,
    fingerprint: reply.fingerprint,
    data: assemble(conn.vendor, reply.results || {}, profiles),
  };
}

// ---- Drift: what would change if we applied this to the target twin node ----
export interface Drift {
  targetName: string | null;
  interfaces: { added: number; changed: number };
  routes: { added: number; removed: number };
  firewallRules: { added: number };
  summary: string;
}

export function computeDrift(data: CollectedData, target: NetworkNode | undefined): Drift {
  if (!target) {
    return {
      targetName: null,
      interfaces: { added: data.interfaces.length, changed: 0 },
      routes: { added: data.routes.length, removed: 0 },
      firewallRules: { added: data.firewallRules.length },
      summary: 'New device — everything collected would be added.',
    };
  }
  const twinIfs = new Map(target.vrfs.flatMap(v => v.interfaces).map(i => [i.name, i.ip]));
  let ifAdded = 0, ifChanged = 0;
  for (const i of data.interfaces) {
    if (!twinIfs.has(i.name)) ifAdded++;
    else if (twinIfs.get(i.name) !== i.ip) ifChanged++;
  }
  const twinRoutes = new Set(target.vrfs.flatMap(v => v.routes).map(r => `${r.destination}|${r.nextHop}`));
  const collectedRouteKeys = new Set(data.routes.map(r => `${r.destination}|${r.nextHop}`));
  let rAdded = 0;
  for (const k of collectedRouteKeys) if (!twinRoutes.has(k)) rAdded++;
  let rRemoved = 0;
  for (const k of twinRoutes) if (!collectedRouteKeys.has(k)) rRemoved++;

  return {
    targetName: target.name,
    interfaces: { added: ifAdded, changed: ifChanged },
    routes: { added: rAdded, removed: rRemoved },
    firewallRules: { added: data.firewallRules.length },
    summary: `${ifAdded} new / ${ifChanged} changed interfaces, ${rAdded} new / ${rRemoved} missing routes vs twin.`,
  };
}
