// Data-driven config parser types.
//
// A ParserProfile is DATA (stored in the DB, editable in the web UI), not code.
// The engine in engine.ts interprets it. Adding a new vendor = writing a new
// profile, no code change or redeploy.

export interface ParsedInterface {
  name: string;
  ip: string;            // CIDR
  status: 'up' | 'down';
  vrf?: string;          // owning VRF / security zone
}

export interface ParsedRoute {
  destination: string;   // CIDR
  nextHop: string;
  protocol: 'Static' | 'OSPF' | 'BGP' | 'Connected';
  metric: number;
  vrf: string;
}

export interface ParsedFirewallRule {
  name: string;
  sourceVrf: string;     // zone
  destVrf: string;       // zone
  sourceIp: string;      // CIDR or 'any'
  destIp: string;        // CIDR or 'any'
  protocol: 'any' | 'tcp' | 'udp' | 'icmp';
  sourcePort: string;
  destPort: string;
  action: 'permit' | 'deny';
  description: string;
}

export interface ParsedNat {
  type: 'Static NAT' | 'PAT / Dynamic';
  insideLocal: string;
  insideGlobal: string;
  vrf: string;
}

export interface ParsedConfig {
  hostname: string;
  vrfs: string[];
  interfaces: ParsedInterface[];
  routes: ParsedRoute[];
  firewallRules: ParsedFirewallRule[];
  natMappings: ParsedNat[];
  warnings: string[];
}

// A value expression, resolved against regex capture groups, active context
// keys, lookup tables and transforms.
export type FieldExpr =
  | string                                                   // shorthand: "$1", "$intf" (ctx key), or literal
  | { lit: string }
  | { group: number }                                        // capture group N of the rule's match
  | { ctx: string }                                          // key of an active context by id
  | { concat: FieldExpr[]; sep?: string }
  | { transform: 'maskToCidr' | 'wildcardToCidr' | 'ciscoAddr' | 'toCidr32' | 'lower' | 'upper' | 'protoName'; arg: FieldExpr }
  | { resolve: string; arg: FieldExpr; fallback?: FieldExpr }; // look arg up in table `resolve`

export type Collection = 'interfaces' | 'routes' | 'firewallRules' | 'natMappings';

// Rule kinds the engine understands.
export interface ParserRule {
  // Only fire when this context id is on the active stack (optional).
  context?: string;
  // Regex tested against the trimmed line (JS regex source string).
  match: string;

  // Exactly one action per rule:
  push?: { id: string; keyGroup?: number };  // enter a context (key from capture group)
  pop?: string;                              // pop this context id
  setHostname?: FieldExpr;
  addVrf?: FieldExpr;
  // Build a lookup table entry. Key comes from a capture group OR an active context key.
  table?: { name: string; keyGroup?: number; keyCtx?: string; value: FieldExpr };
  // Accumulate fields onto a record that spans several lines.
  //  - `context`: draft lives on that context frame, emitted when it pops (block configs).
  //  - `key`: draft lives in a global map keyed by the resolved value, emitted at EOF (set-style configs).
  // activate:false means "populate but don't by itself justify emitting" (used
  // e.g. so a NAT record only emerges when a `nat enable` line is seen).
  accumulate?: { context?: string; key?: FieldExpr; target: Collection; fields: Record<string, FieldExpr>; activate?: boolean };
  // Emit a record immediately from this single line:
  emit?: { target: Collection; fields: Record<string, FieldExpr> };
}

export interface ParserProfile {
  id: string;                 // 'cisco-ios'
  name: string;               // 'Cisco IOS / IOS-XE'
  builtin?: boolean;          // seeded profiles cannot be deleted, only overridden
  detect: string[];           // regex; more matches = higher confidence
  // Contexts that auto-pop at a boundary line (block configs). For set-style
  // vendors this is usually empty.
  boundary?: string;          // regex marking end of a block (e.g. '^!' or '^(next|end)$')
  // Static lookup tables (e.g. builtin service names -> ports), name -> {key:value}
  statics?: Record<string, Record<string, string>>;
  rules: ParserRule[];
}
