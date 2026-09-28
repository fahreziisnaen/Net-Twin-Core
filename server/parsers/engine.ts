// Generic, data-driven config parser engine.
//
// It knows nothing about any vendor. It walks a config line by line, driven
// entirely by a ParserProfile (data). Adding/fixing a vendor = editing the
// profile, never this file.

import {
  ParserProfile,
  ParserRule,
  FieldExpr,
  ParsedConfig,
  ParsedInterface,
  ParsedRoute,
  ParsedFirewallRule,
  ParsedNat,
  Collection,
} from './types';

// --- bit / mask helpers -----------------------------------------------------
function popcount(mask: string): number {
  return mask.trim().split('.').reduce((acc, o) => {
    const n = parseInt(o, 10);
    if (isNaN(n)) return acc;
    return acc + n.toString(2).split('').filter(b => b === '1').length;
  }, 0);
}

function maskToCidr(s: string): string {
  const [ip, mask] = s.trim().split(/\s+/);
  if (!mask) return ip || s;
  return `${ip}/${popcount(mask)}`;
}

function wildcardToCidr(s: string): string {
  const [net, wild] = s.trim().split(/\s+/);
  if (!wild) return net || s;
  const mask = wild.split('.').map(o => (255 - parseInt(o, 10))).join('.');
  return `${net}/${popcount(mask)}`;
}

function ciscoAddr(tok: string): string {
  const t = tok.trim();
  if (/^any$/i.test(t)) return 'any';
  const host = t.match(/^host\s+(\S+)$/i);
  if (host) return `${host[1]}/32`;
  const pair = t.match(/^(\S+)\s+(\S+)$/);
  if (pair) return wildcardToCidr(`${pair[1]} ${pair[2]}`);
  return t;
}

function toCidr32(ip: string): string {
  const t = ip.trim();
  return t.includes('/') ? t : `${t}/32`;
}

// Profiles are user-editable data, so every name they use as a lookup key
// (table, transform, context, captured config token) is resolved against own
// properties only. Otherwise a key like "__proto__" or "constructor" reaches
// Object.prototype: reads return functions instead of strings, and a table
// named "__proto__" would write config tokens onto every object in the process.
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function lookup<T>(o: Record<string, T> | undefined, k: string): T | undefined {
  return o && hasOwn(o, k) ? o[k] : undefined;
}

const TRANSFORMS: Record<string, (s: string) => string> = {
  maskToCidr,
  wildcardToCidr,
  ciscoAddr,
  toCidr32,
  lower: s => s.toLowerCase(),
  upper: s => s.toUpperCase(),
  protoName: s => (s.trim().toLowerCase() === 'ip' ? 'any' : s.trim().toLowerCase()),
};

// --- evaluation environment for a single rule firing ------------------------
interface Env {
  groups: string[];                 // regex capture groups (index 0 = whole match)
  ctx: Record<string, string>;      // active context id -> instance key
}

interface Tables {
  [table: string]: Record<string, string>;
}

function stripQuotes(s: string): string {
  return s.replace(/^"(.*)"$/, '$1');
}

function evalExpr(expr: FieldExpr, env: Env, tables: Tables, statics: Record<string, Record<string, string>>): string {
  if (typeof expr === 'string') {
    const g = expr.match(/^\$(\d+)$/);
    if (g) return env.groups[parseInt(g[1], 10)] ?? '';
    return expr; // literal
  }
  if (!expr || typeof expr !== 'object') return '';
  if ('lit' in expr) return String(expr.lit ?? '');
  if ('group' in expr) return env.groups[expr.group] ?? '';
  if ('ctx' in expr) return lookup(env.ctx, expr.ctx) ?? '';
  if ('concat' in expr) return (Array.isArray(expr.concat) ? expr.concat : []).map(e => evalExpr(e, env, tables, statics)).join(expr.sep ?? ' ');
  if ('transform' in expr) {
    const v = evalExpr(expr.arg, env, tables, statics);
    return (lookup(TRANSFORMS, expr.transform) || ((x: string) => x))(v);
  }
  if ('resolve' in expr) {
    const key = evalExpr(expr.arg, env, tables, statics);
    const found = lookup(lookup(tables, expr.resolve), key) ?? lookup(lookup(statics, expr.resolve), key);
    if (typeof found === 'string') return found;
    return expr.fallback !== undefined ? evalExpr(expr.fallback, env, tables, statics) : key;
  }
  return '';
}

// A record field remembers the environment of the line that produced it, so
// resolution can be deferred to phase B (after all tables are built).
interface PendingField {
  expr: FieldExpr;
  env: Env;
}
interface PendingRecord {
  target: Collection;
  fields: Record<string, PendingField>;
  active: boolean;
}

interface ContextFrame {
  id: string;
  key: string;
  drafts: Map<string, PendingRecord>; // keyed by target collection
}

export function detectVendor(config: string, profiles: ParserProfile[]): string | null {
  let best: { id: string; score: number } | null = null;
  for (const p of profiles) {
    let score = 0;
    for (const pat of p.detect) {
      try {
        if (new RegExp(pat, 'm').test(config)) score++;
      } catch { /* ignore bad pattern */ }
    }
    if (score > 0 && (!best || score > best.score)) best = { id: p.id, score };
  }
  return best?.id ?? null;
}

function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function runProfile(config: string, profile: ParserProfile): ParsedConfig {
  const statics = profile.statics || {};
  const tables: Tables = Object.create(null);
  const warnings: string[] = [];

  let hostname = '';
  const vrfs = new Set<string>();
  const pending: PendingRecord[] = [];
  const keyedDrafts = new Map<string, PendingRecord>(); // `${target}::${key}`
  const stack: ContextFrame[] = [];

  const boundary = profile.boundary ? compile(profile.boundary) : null;

  const activeCtx = (): Record<string, string> => {
    const c: Record<string, string> = Object.create(null);
    for (const f of stack) c[f.id] = f.key;
    return c;
  };

  const flushFrame = (frame: ContextFrame) => {
    for (const draft of frame.drafts.values()) {
      if (draft.active) pending.push(draft);
    }
  };

  const rules = profile.rules.map(r => ({ rule: r, re: compile(r.match) }));

  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Auto-pop innermost context at a boundary token (block configs)
    if (boundary && boundary.test(line) && stack.length) {
      flushFrame(stack.pop()!);
    }

    for (const { rule, re } of rules) {
      if (!re) continue;
      if (rule.context && !stack.some(f => f.id === rule.context)) continue;
      const m = re.exec(line);
      if (!m) continue;

      const env: Env = { groups: m.map(x => x ?? ''), ctx: activeCtx() };

      // pop (explicit)
      if (rule.pop) {
        const idx = [...stack].reverse().findIndex(f => f.id === rule.pop);
        if (idx >= 0) {
          const realIdx = stack.length - 1 - idx;
          flushFrame(stack[realIdx]);
          stack.splice(realIdx, 1);
        }
      }

      // push
      if (rule.push) {
        const key = rule.push.keyGroup !== undefined ? stripQuotes(m[rule.push.keyGroup] ?? '') : '';
        stack.push({ id: rule.push.id, key, drafts: new Map() });
      }

      if (rule.setHostname) hostname = evalExpr(rule.setHostname, env, tables, statics);
      if (rule.addVrf) {
        const v = evalExpr(rule.addVrf, env, tables, statics);
        if (v) vrfs.add(v);
      }

      // table build (key from a capture group or an active context key)
      if (rule.table) {
        const key = rule.table.keyCtx !== undefined
          ? (lookup(env.ctx, rule.table.keyCtx) ?? '')
          : (rule.table.keyGroup !== undefined ? stripQuotes(m[rule.table.keyGroup] ?? '') : '');
        if (key) {
          (tables[rule.table.name] ||= Object.create(null))[key] = evalExpr(rule.table.value, env, tables, statics);
        }
      }

      // accumulate: either onto a context draft (emitted when that context
      // pops) or into a global keyed draft (emitted at EOF, for set-style)
      if (rule.accumulate) {
        const acc = rule.accumulate;
        let draft: PendingRecord | undefined;
        if (acc.key !== undefined) {
          const key = `${acc.target}::${evalExpr(acc.key, env, tables, statics)}`;
          draft = keyedDrafts.get(key);
          if (!draft) {
            draft = { target: acc.target, fields: Object.create(null), active: false };
            keyedDrafts.set(key, draft);
          }
        } else if (acc.context) {
          const frame = [...stack].reverse().find(f => f.id === acc.context);
          if (frame) {
            draft = frame.drafts.get(acc.target);
            if (!draft) {
              draft = { target: acc.target, fields: Object.create(null), active: false };
              frame.drafts.set(acc.target, draft);
            }
          }
        }
        if (draft) {
          for (const [k, expr] of Object.entries(acc.fields)) {
            draft.fields[k] = { expr, env };
          }
          if (acc.activate !== false) draft.active = true;
        }
      }

      // immediate emit (one record per matching line)
      if (rule.emit) {
        const fields: Record<string, PendingField> = Object.create(null);
        for (const [k, expr] of Object.entries(rule.emit.fields)) fields[k] = { expr, env };
        pending.push({ target: rule.emit.target, fields, active: true });
      }
    }
  }

  // flush any contexts left open at EOF
  while (stack.length) flushFrame(stack.pop()!);
  for (const draft of keyedDrafts.values()) if (draft.active) pending.push(draft);

  // --- Phase B: resolve interfaces first so an interface-IP table exists ----
  const resolveRecord = (rec: PendingRecord): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, pf] of Object.entries(rec.fields)) {
      out[k] = evalExpr(pf.expr, pf.env, tables, statics);
    }
    return out;
  };

  const interfaces: ParsedInterface[] = [];
  for (const rec of pending.filter(r => r.target === 'interfaces')) {
    const o = resolveRecord(rec);
    if (!o.name || !o.ip) continue;
    interfaces.push({
      name: o.name,
      ip: o.ip,
      status: o.status === 'down' ? 'down' : 'up',
      vrf: o.vrf || undefined,
    });
  }
  // auto tables for NAT/PAT resolution: interface name -> IP, and zone -> IP
  tables['__if'] ||= Object.create(null);
  tables['__zoneip'] ||= Object.create(null);
  for (const i of interfaces) {
    tables['__if'][i.name] = i.ip.split('/')[0];
    if (i.vrf) tables['__zoneip'][i.vrf] = i.ip.split('/')[0];
  }

  const routes: ParsedRoute[] = [];
  const firewallRules: ParsedFirewallRule[] = [];
  const natMappings: ParsedNat[] = [];

  for (const rec of pending) {
    if (rec.target === 'interfaces') continue;
    const o = resolveRecord(rec);
    if (rec.target === 'routes') {
      if (!o.destination || !o.nextHop) continue;
      routes.push({
        destination: o.destination,
        nextHop: o.nextHop,
        protocol: (['Static', 'OSPF', 'BGP', 'Connected'].includes(o.protocol) ? o.protocol : 'Static') as ParsedRoute['protocol'],
        metric: parseInt(o.metric, 10) || 0,
        vrf: o.vrf || 'default',
      });
    } else if (rec.target === 'firewallRules') {
      if (!o.name) continue;
      firewallRules.push({
        name: o.name,
        sourceVrf: o.sourceVrf || 'any',
        destVrf: o.destVrf || 'any',
        sourceIp: o.sourceIp || 'any',
        destIp: o.destIp || 'any',
        protocol: (['any', 'tcp', 'udp', 'icmp'].includes(o.protocol) ? o.protocol : 'any') as ParsedFirewallRule['protocol'],
        sourcePort: o.sourcePort || 'any',
        destPort: o.destPort || 'any',
        action: o.action === 'deny' ? 'deny' : 'permit',
        description: o.description || '',
      });
    } else if (rec.target === 'natMappings') {
      if (!o.insideLocal || !o.insideGlobal) continue;
      natMappings.push({
        type: o.type === 'Static NAT' ? 'Static NAT' : 'PAT / Dynamic',
        insideLocal: o.insideLocal,
        insideGlobal: o.insideGlobal,
        vrf: o.vrf || 'default',
      });
    }
  }

  // Signal when a profile ran but extracted nothing from a non-empty config —
  // usually means the profile's rules don't match this config's dialect yet.
  const totalRecords = interfaces.length + routes.length + firewallRules.length + natMappings.length;
  const nonEmptyLines = config.split(/\r?\n/).filter(l => l.trim()).length;
  if (totalRecords === 0 && !hostname && nonEmptyLines > 2) {
    warnings.push(`Profile "${profile.name}" found no interfaces/routes/policies/NAT in ${nonEmptyLines} config lines. Check that the vendor is correct, or adjust the rules in the Parser Profiles menu.`);
  }

  return {
    hostname,
    vrfs: [...vrfs],
    interfaces,
    routes,
    firewallRules,
    natMappings,
    warnings,
  };
}
