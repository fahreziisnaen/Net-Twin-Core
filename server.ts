// Must stay the first import: modules below read process.env while loading.
import './server/env';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import {
  NetworkNode,
  NetworkLink,
  ComplianceAudit,
  ChangeRequest,
  IpReservation
} from './src/types';
import { executeSimulation, matchCidr, DEFAULT_SETTINGS, SimulationSettings } from './src/engine';
import { deriveProbeQuery } from './src/changeUtils';
import { getSeedNodes, getSeedLinks, getSeedAudits, getSeedChangeRequests } from './src/seedData';
import { ROLES, Role, canAccess } from './src/rbac';
import { DeviceConnection } from './src/types';
import { createStorage, TwinState } from './server/storage';
import { parseConfig, detectVendor, runProfile, SEED_PROFILES } from './server/parsers';
import { ParserProfile } from './server/parsers/types';
import { encryptSecret, credKeyConfigured } from './server/crypto';
import { collect, computeDrift, collectorConfigured } from './server/collector';
import { SUPPORTED_VENDORS, COLLECT_INTENTS, isVendorSupported, isCollectIntent, CollectIntent } from './server/collector/whitelist';
import { createSaveQueue } from './server/saveQueue';
import {
  ValidationError,
  normalizeNode,
  normalizeLink,
  normalizeQuery,
  normalizeAudit,
  normalizeRule,
  normalizeChangeRequest,
  normalizeReservation,
  normalizeSettings,
  normalizeProfile,
  assertUniqueIds,
  sameId,
} from './server/validate';
import {
  AUTH_COOKIE,
  AuthedRequest,
  authenticate,
  requireAction,
  signToken,
  hashPassword,
  verifyLogin,
  ensureAdminSeed,
  authCookieOptions,
  clearAuthCookie,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from './server/auth';

const app = express();
app.disable('x-powered-by');

// Behind a reverse proxy set TRUST_PROXY (e.g. "1" for one hop) so req.ip and
// req.secure reflect the real client and protocol — the login throttle and the
// session cookie's `secure` flag depend on them.
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(v) ? parseInt(v, 10) : v === 'true' ? true : v);
}

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// Full snapshots of a large twin exceed the general body limit; the import
// endpoint (admin-only) gets its own, larger one. Registered first, so the
// general parser below skips the already-parsed body.
app.use('/api/twin/import', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Express 4 doesn't catch rejected promises from async handlers; without this a
// storage error would become an unhandled rejection and kill the process.
type AsyncHandler = (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>;
const asyncRoute = (fn: AsyncHandler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req as AuthedRequest, res, next).catch(next);
};

const newId = (prefix: string) => `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

// STATE + PERSISTENCE
// The twin lives in memory and is flushed to the storage backend (MySQL when
// DB_HOST is configured, JSON files otherwise) after every mutation.
const storage = createStorage();

let nodes: NetworkNode[] = getSeedNodes();
let links: NetworkLink[] = getSeedLinks();
let audits: ComplianceAudit[] = getSeedAudits();
let changeRequests: ChangeRequest[] = getSeedChangeRequests();
let settings: SimulationSettings = { ...DEFAULT_SETTINGS };
let ipReservations: IpReservation[] = [];
let parserProfiles: ParserProfile[] = SEED_PROFILES.map(p => ({ ...p }));
let deviceConnections: DeviceConnection[] = [];

const stateSaver = createSaveQueue(
  () => storage.saveState({ nodes, links, audits, changeRequests, settings, ipReservations }),
  err => console.error('Failed to persist twin state:', err)
);
const connectionSaver = createSaveQueue(
  () => storage.saveConnections(deviceConnections),
  err => console.error('Failed to persist device connections:', err)
);
const profileSaver = createSaveQueue(
  () => storage.saveProfiles(parserProfiles),
  err => console.error('Failed to persist parser profiles:', err)
);

// Strip secrets before sending a connection to the client.
function publicConnection(c: DeviceConnection): DeviceConnection {
  const { passwordEnc, ...rest } = c;
  return { ...rest, hasPassword: !!passwordEnc };
}
function persistConnections() {
  void connectionSaver.request();
}
function saveState() {
  void stateSaver.request();
}

// Every node carries a revision for optimistic concurrency (see PUT
// /api/twin/nodes/:id). After a reset or import the twin is replaced wholesale,
// so revisions are raised past any value a client may still hold — a stale
// browser tab then gets a conflict instead of overwriting the new state.
const maxRev = () => nodes.reduce((m, n) => Math.max(m, n.rev ?? 0), 0);
function withRevisions(list: NetworkNode[], floor: number): NetworkNode[] {
  return list.map(n => ({ ...n, rev: Math.max(n.rev ?? 0, floor) }));
}

// Unauthenticated health probe (Docker HEALTHCHECK / load balancers). Reports
// unhealthy while changes can't be persisted (e.g. the database is down);
// saves keep retrying in the background.
app.get('/api/health', (_req, res) => {
  const persisted = stateSaver.healthy && connectionSaver.healthy && profileSaver.healthy;
  res.status(persisted ? 200 : 503).json({
    ok: persisted,
    storage: storage.kind,
    ...(persisted ? {} : { error: 'Saving to storage is failing; retrying. Recent changes are not persisted yet.' }),
  });
});

// All /api routes see req.user when a valid session cookie/token is present
app.use('/api', authenticate(storage));

// ---------------------------------------------------------------------------
// AUTH & USER MANAGEMENT
// ---------------------------------------------------------------------------
// Simple in-memory fixed-window brute-force throttle: max 10 failed attempts
// per IP per 15 minutes. Successful logins reset the counter.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function loginBlocked(ip: string): boolean {
  const rec = loginAttempts.get(ip);
  return !!rec && Date.now() < rec.resetAt && rec.count >= LOGIN_MAX;
}
function noteLoginFailure(ip: string) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else rec.count++;
}
// Drop expired windows so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) if (now > rec.resetAt) loginAttempts.delete(ip);
}, LOGIN_WINDOW_MS).unref();

const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (loginBlocked(ip)) {
    return res.status(429).json({ error: 'Too many failed login attempts. Try again in a few minutes.' });
  }
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  const user = password.length <= MAX_PASSWORD_LENGTH ? await storage.getUserByUsername(username.trim()) : null;
  if (!(await verifyLogin(user, password)) || !user) {
    noteLoginFailure(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  loginAttempts.delete(ip);
  res.cookie(AUTH_COOKIE, signToken(user), authCookieOptions(req));
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
}));

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(req, res);
  res.json({ success: true });
});

app.get('/api/auth/me', (req: AuthedRequest, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

app.get('/api/users', requireAction('manage-users'), asyncRoute(async (req, res) => {
  const users = await storage.listUsers();
  res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role })));
}));

app.post('/api/users', requireAction('manage-users'), asyncRoute(async (req, res) => {
  const { username, password, role } = req.body || {};
  const name = typeof username === 'string' ? username.trim() : '';
  if (!name || !password || !ROLES.includes(role as Role)) {
    return res.status(400).json({ error: 'username, password, and role (admin/operator/viewer) are required' });
  }
  if (!USERNAME_RE.test(name)) {
    return res.status(400).json({ error: 'Username may only contain letters, digits, ".", "_", "@" and "-" (max 64 characters)' });
  }
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  if (await storage.getUserByUsername(name)) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  try {
    const user = await storage.createUser(name, await hashPassword(password), role as Role);
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err: any) {
    // Lost a race with a concurrent create of the same username
    if (err?.code === 'ER_DUP_ENTRY' || /already exists/.test(String(err?.message))) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    throw err;
  }
}));

app.put('/api/users/:id', requireAction('manage-users'), asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { password, role } = req.body || {};
  const users = await storage.listUsers();
  const target = users.find(u => u.id === id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (role !== undefined) {
    if (!ROLES.includes(role as Role)) return res.status(400).json({ error: 'Invalid role' });
    const adminCount = users.filter(u => u.role === 'admin').length;
    if (target.role === 'admin' && role !== 'admin' && adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last admin' });
    }
  }
  if (password !== undefined) {
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
  }

  await storage.updateUser(id, {
    ...(password !== undefined ? { passwordHash: await hashPassword(password) } : {}),
    ...(role !== undefined ? { role: role as Role } : {}),
  });

  // A password change invalidates existing sessions; keep the admin who changed
  // their own password signed in with a fresh token.
  if (password !== undefined && req.user?.id === id) {
    const updated = await storage.getUserById(id);
    if (updated) res.cookie(AUTH_COOKIE, signToken(updated), authCookieOptions(req));
  }
  res.json({ success: true });
}));

app.delete('/api/users/:id', requireAction('manage-users'), asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.user && req.user.id === id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const users = await storage.listUsers();
  const target = users.find(u => u.id === id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'admin' && users.filter(u => u.role === 'admin').length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  }
  await storage.deleteUser(id);
  res.json({ success: true });
}));

function runAllAudits() {
  audits = audits.map(audit => {
    const result = executeSimulation(nodes, links, audit.query, settings);
    const passed = result.status === audit.expectedResult;
    return {
      ...audit,
      status: passed ? 'passed' as const : 'failed' as const,
      lastRunDetails: `Simulated path status is "${result.status}" (Expected: "${audit.expectedResult}"). Traversed ${result.hops.length} hops.`,
    };
  });
}

// REST API ENDPOINTS

// 1. Get entire digital twin topology state
app.get('/api/twin/topology', requireAction('read'), (req, res) => {
  res.json({ nodes, links });
});

// 2. Simulate Path
app.post('/api/twin/simulate', requireAction('simulate'), (req, res) => {
  const query = normalizeQuery(req.body);

  // Auto-detect source device from Source IP if sourceNodeId is 'auto'
  if (query.sourceNodeId === 'auto') {
    let foundNodeId = '';
    let foundVrfName = '';

    // Step 1: Find a node where the interface IP exactly matches the sourceIp (excluding subnet mask)
    for (const node of nodes) {
      for (const vrf of node.vrfs) {
        for (const intf of vrf.interfaces) {
          const intfIpOnly = intf.ip.split('/')[0];
          if (intfIpOnly === query.sourceIp) {
            foundNodeId = node.id;
            foundVrfName = vrf.name;
            break;
          }
        }
        if (foundNodeId) break;
      }
      if (foundNodeId) break;
    }

    // Step 2: Find if the source IP matches any interface's subnet
    if (!foundNodeId) {
      for (const node of nodes) {
        for (const vrf of node.vrfs) {
          for (const intf of vrf.interfaces) {
            if (matchCidr(query.sourceIp, intf.ip)) {
              foundNodeId = node.id;
              foundVrfName = vrf.name;
              break;
            }
          }
          if (foundNodeId) break;
        }
        if (foundNodeId) break;
      }
    }

    // Step 3: Find if the source IP matches any connected route (which defines local network)
    if (!foundNodeId) {
      for (const node of nodes) {
        for (const vrf of node.vrfs) {
          for (const route of vrf.routes) {
            if (route.protocol === 'Connected' && matchCidr(query.sourceIp, route.destination)) {
              foundNodeId = node.id;
              foundVrfName = vrf.name;
              break;
            }
          }
          if (foundNodeId) break;
        }
        if (foundNodeId) break;
      }
    }

    // Step 4: If still not found, check any route matching the IP inside any node
    if (!foundNodeId) {
      for (const node of nodes) {
        for (const vrf of node.vrfs) {
          for (const route of vrf.routes) {
            if (matchCidr(query.sourceIp, route.destination)) {
              foundNodeId = node.id;
              foundVrfName = vrf.name;
              break;
            }
          }
          if (foundNodeId) break;
        }
        if (foundNodeId) break;
      }
    }

    if (foundNodeId) {
      query.sourceNodeId = foundNodeId;
      query.sourceVrf = foundVrfName;
    } else {
      return res.status(404).json({
        error: `Auto-detect failed: could not determine the source device for IP ${query.sourceIp}. Please pick a 'Source Device' manually.`
      });
    }
  } else if (!query.sourceVrf) {
    return res.status(400).json({ error: 'Missing required simulation property: sourceVrf' });
  }

  const result = executeSimulation(nodes, links, query, settings);
  res.json(result);
});

// 3. Add node. Creation only: silently replacing an existing device (and
// orphaning its links) is never what a "new device" form means. Updates go
// through PUT.
app.post('/api/twin/nodes', requireAction('mutate-twin'), (req, res) => {
  const newNode = normalizeNode(req.body);
  if (nodes.some(n => sameId(n.id, newNode.id))) {
    return res.status(409).json({ error: `A device with id "${newNode.id}" already exists` });
  }
  newNode.rev = 1;
  nodes.push(newNode);
  saveState();
  res.json({ success: true, node: newNode, nodes });
});

// 4. Update Node (routes, firewalls, etc.). Clients send back the `rev` they
// loaded; if someone else saved the node since, the write is refused instead
// of silently overwriting their change with a stale copy.
app.put('/api/twin/nodes/:id', requireAction('mutate-twin'), (req, res) => {
  const nodeId = req.params.id;
  const idx = nodes.findIndex(n => n.id === nodeId);
  if (idx < 0) {
    return res.status(404).json({ error: 'Node not found' });
  }
  const currentRev = nodes[idx].rev ?? 0;
  const clientRev = req.body?.rev;
  if (clientRev !== undefined && clientRev !== currentRev) {
    return res.status(409).json({
      error: `"${nodes[idx].name}" was changed by someone else since you loaded it. The latest version has been reloaded — please redo your change.`,
      stale: true,
      node: nodes[idx],
    });
  }
  // The id in the URL is authoritative; a body id can't rename/duplicate a node.
  nodes[idx] = normalizeNode({ ...nodes[idx], ...req.body, id: nodeId, rev: currentRev + 1 });
  saveState();
  res.json({ success: true, node: nodes[idx] });
});

// 4.1 Delete Node
app.delete('/api/twin/nodes/:id', requireAction('mutate-twin'), (req, res) => {
  const nodeId = req.params.id;
  nodes = nodes.filter(n => n.id !== nodeId);
  links = links.filter(l => l.sourceNodeId !== nodeId && l.destNodeId !== nodeId);
  saveState();
  res.json({ success: true, nodes, links });
});

// 5. Add or update link
app.post('/api/twin/links', requireAction('mutate-twin'), (req, res) => {
  const newLink = normalizeLink(req.body);
  const idx = links.findIndex(l => sameId(l.id, newLink.id));
  if (idx >= 0) {
    links[idx] = newLink;
  } else {
    links.push(newLink);
  }
  saveState();
  res.json({ success: true, links });
});

// 6. Delete link
app.delete('/api/twin/links/:id', requireAction('mutate-twin'), (req, res) => {
  const linkId = req.params.id;
  links = links.filter(l => l.id !== linkId);
  saveState();
  res.json({ success: true, links });
});

// 7. Get audits
app.get('/api/twin/audits', requireAction('read'), (req, res) => {
  res.json(audits);
});

// 8. Run compliance tests
app.post('/api/twin/audits/run', requireAction('mutate-twin'), (req, res) => {
  runAllAudits();
  saveState();
  res.json(audits);
});

// 9. Add audit
app.post('/api/twin/audits', requireAction('mutate-twin'), (req, res) => {
  const newAudit = normalizeAudit({ ...(req.body || {}), status: 'untested' });
  if (audits.some(a => sameId(a.id, newAudit.id))) {
    return res.status(409).json({ error: `Audit "${newAudit.id}" already exists` });
  }
  audits.push(newAudit);
  saveState();
  res.json({ success: true, audits });
});

// 9.1 Delete audit
app.delete('/api/twin/audits/:id', requireAction('mutate-twin'), (req, res) => {
  const before = audits.length;
  audits = audits.filter(a => a.id !== req.params.id);
  if (audits.length === before) {
    return res.status(404).json({ error: 'Audit not found' });
  }
  saveState();
  res.json({ success: true, audits });
});

// 10. Get Change Requests
app.get('/api/twin/changes', requireAction('read'), (req, res) => {
  res.json(changeRequests);
});

// 11. Draft change request with automatic before/after what-if simulation
app.post('/api/twin/changes', requireAction('mutate-twin'), (req: AuthedRequest, res) => {
  const body = req.body || {};
  const firewallNode = nodes.find(n => n.id === body.nodeId);
  if (!firewallNode || firewallNode.type !== 'firewall') {
    return res.status(404).json({ error: 'Target node not found or is not a firewall.' });
  }
  if (!Array.isArray(body.proposedRules) || body.proposedRules.length === 0) {
    return res.status(400).json({ error: 'At least one proposed rule is required.' });
  }
  const newCR: ChangeRequest = {
    ...body,
    id: newId('cr'),
    createdAt: new Date().toISOString(),
    title: typeof body.title === 'string' ? body.title : '',
    description: typeof body.description === 'string' ? body.description : '',
    // Recorded from the session, not the request body, so the audit trail can't be spoofed.
    requester: req.user!.username,
    nodeId: firewallNode.id,
    proposedRules: body.proposedRules.map((r: unknown, i: number) => normalizeRule(r, `proposedRules[${i}]`)),
    status: 'simulated',
  };
  if (!firewallNode.firewallRules) firewallNode.firewallRules = [];

  // What-if: probe the flow the first proposed rule describes, before and
  // after injecting the proposed rules on a cloned topology.
  const probe = deriveProbeQuery(newCR.proposedRules[0], firewallNode);
  const before = executeSimulation(nodes, links, probe, settings);

  const clonedNodes: NetworkNode[] = JSON.parse(JSON.stringify(nodes));
  const clonedFw = clonedNodes.find(n => n.id === newCR.nodeId)!;
  clonedFw.firewallRules = [...newCR.proposedRules, ...(clonedFw.firewallRules || [])];
  const after = executeSimulation(clonedNodes, links, probe, settings);

  newCR.simulationResults = {
    beforeStatus: before.status,
    afterStatus: after.status,
    beforeHops: before.hops,
    afterHops: after.hops,
  };

  changeRequests.push(newCR);
  saveState();

  // Pre-change compliance snapshot kept for API compatibility
  const preChangeResults = audits.map(audit => ({
    auditId: audit.id,
    status: executeSimulation(nodes, links, audit.query, settings).status,
  }));

  res.json({ success: true, changeRequest: newCR, preChangeResults });
});

// 12. Apply Change Request
app.post('/api/twin/changes/:id/apply', requireAction('apply-change'), (req, res) => {
  const crId = req.params.id;
  const crIdx = changeRequests.findIndex(cr => cr.id === crId);
  if (crIdx < 0) return res.status(404).json({ error: 'Change request not found' });

  const cr = changeRequests[crIdx];
  // Applying twice would inject the same rules into the policy a second time.
  if (cr.status === 'applied') return res.status(409).json({ error: 'Change request has already been applied' });
  const fwNodeIdx = nodes.findIndex(n => n.id === cr.nodeId);
  if (fwNodeIdx < 0) return res.status(404).json({ error: 'Target firewall node no longer exists' });

  // Inject rules at the top of the policy list (rule order is first-match)
  nodes[fwNodeIdx] = {
    ...nodes[fwNodeIdx],
    firewallRules: [...cr.proposedRules, ...(nodes[fwNodeIdx].firewallRules || [])],
    rev: (nodes[fwNodeIdx].rev ?? 0) + 1,
  };

  cr.status = 'applied';
  changeRequests[crIdx] = cr;

  runAllAudits();
  saveState();

  res.json({ success: true, changeRequest: cr, audits });
});

// 12.1 IPAM — manual IP reservations (the "used" map itself is derived
// client-side from the twin; these are the extra records you log by hand).
app.get('/api/twin/ipam/reservations', requireAction('read'), (req, res) => {
  res.json(ipReservations);
});

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const isIpv4 = (ip: string) => IPV4_RE.test(ip) && ip.split('.').every(o => Number(o) <= 255);

app.post('/api/twin/ipam/reservations', requireAction('mutate-twin'), (req, res) => {
  const { ip, note } = req.body || {};
  const cleanIp = String(ip || '').trim();
  if (!isIpv4(cleanIp)) {
    return res.status(400).json({ error: 'A valid IPv4 address is required (e.g. 10.100.20.50)' });
  }
  if (ipReservations.some(r => r.ip === cleanIp)) {
    return res.status(409).json({ error: `${cleanIp} is already reserved` });
  }
  const reservation: IpReservation = {
    id: newId('res'),
    ip: cleanIp,
    note: String(note || '').trim().slice(0, 500),
    createdAt: new Date().toISOString(),
  };
  ipReservations.push(reservation);
  saveState();
  res.json({ success: true, reservation, reservations: ipReservations });
});

app.delete('/api/twin/ipam/reservations/:id', requireAction('mutate-twin'), (req, res) => {
  const before = ipReservations.length;
  ipReservations = ipReservations.filter(r => r.id !== req.params.id);
  if (ipReservations.length === before) return res.status(404).json({ error: 'Reservation not found' });
  saveState();
  res.json({ success: true, reservations: ipReservations });
});

// 12.2 SSH read-only collection (Fase 1). All admin-only for production safety.
app.get('/api/twin/ssh/meta', requireAction('read'), (req, res) => {
  res.json({
    supportedVendors: SUPPORTED_VENDORS,
    credKeyConfigured: credKeyConfigured(),
    collectorConfigured: collectorConfigured(),
  });
});

app.get('/api/twin/ssh/connections', requireAction('manage-settings'), (req, res) => {
  res.json(deviceConnections.map(publicConnection));
});

// Management address: hostname, IPv4 or IPv6 — no spaces or shell/URL syntax.
const HOST_RE = /^[A-Za-z0-9.:_\-\[\]]{1,255}$/;

// Validates the editable connection fields present in `body`; returns an error
// message or null. `requireAll` for create, partial updates otherwise.
function connectionProblem(body: any, requireAll: boolean): string | null {
  const { name, host, port, vendor, username } = body;
  const missing = (v: unknown) => typeof v !== 'string' || !v.trim();
  if (requireAll && [name, host, vendor, username].some(missing)) {
    return 'name, host, vendor, and username are required';
  }
  if (name !== undefined && (missing(name) || String(name).length > 128)) return 'name must be 1-128 characters';
  if (host !== undefined && !HOST_RE.test(String(host).trim())) return 'host must be a hostname or IP address';
  if (username !== undefined && (missing(username) || String(username).length > 128)) return 'username must be 1-128 characters';
  if (vendor !== undefined && !isVendorSupported(vendor)) {
    return `Unsupported vendor "${vendor}". Supported: ${SUPPORTED_VENDORS.join(', ')}`;
  }
  if (port !== undefined && port !== '' && port !== null) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return 'port must be between 1 and 65535';
  }
  return null;
}

app.post('/api/twin/ssh/connections', requireAction('manage-settings'), (req, res) => {
  const body = req.body || {};
  const problem = connectionProblem(body, true);
  if (problem) return res.status(400).json({ error: problem });
  if (typeof body.password !== 'string' || !body.password) return res.status(400).json({ error: 'password is required' });
  if (!credKeyConfigured()) {
    return res.status(400).json({ error: 'CRED_KEY is not configured on the server; device credentials cannot be stored securely.' });
  }
  const conn: DeviceConnection = {
    id: newId('conn'),
    name: String(body.name).trim(),
    host: String(body.host).trim(),
    port: parseInt(body.port, 10) || 22,
    vendor: body.vendor,
    username: String(body.username).trim(),
    passwordEnc: encryptSecret(body.password),
    targetNodeId: typeof body.targetNodeId === 'string' && body.targetNodeId ? body.targetNodeId : undefined,
    lastStatus: 'never',
  };
  deviceConnections.push(conn);
  persistConnections();
  res.json({ success: true, connection: publicConnection(conn) });
});

app.put('/api/twin/ssh/connections/:id', requireAction('manage-settings'), (req, res) => {
  const conn = deviceConnections.find(c => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  const body = req.body || {};
  const problem = connectionProblem(body, false);
  if (problem) return res.status(400).json({ error: problem });
  const { name, host, port, vendor, username, password, targetNodeId } = body;
  if (password && !credKeyConfigured()) {
    return res.status(400).json({ error: 'CRED_KEY is not configured on the server; device credentials cannot be stored securely.' });
  }
  if (name !== undefined) conn.name = String(name).trim();
  if (host !== undefined) conn.host = String(host).trim();
  if (port !== undefined) conn.port = parseInt(port, 10) || 22;
  if (vendor !== undefined) conn.vendor = vendor;
  if (username !== undefined) conn.username = String(username).trim();
  if (targetNodeId !== undefined) conn.targetNodeId = typeof targetNodeId === 'string' && targetNodeId ? targetNodeId : undefined;
  if (password) conn.passwordEnc = encryptSecret(String(password)); // only re-encrypt when a new one is given
  persistConnections();
  res.json({ success: true, connection: publicConnection(conn) });
});

app.delete('/api/twin/ssh/connections/:id', requireAction('manage-settings'), (req, res) => {
  const before = deviceConnections.length;
  deviceConnections = deviceConnections.filter(c => c.id !== req.params.id);
  if (deviceConnections.length === before) return res.status(404).json({ error: 'Connection not found' });
  persistConnections();
  res.json({ success: true });
});

// Collect read-only data from the device via the sidecar, return parsed data + drift.
app.post('/api/twin/ssh/connections/:id/collect', requireAction('manage-settings'), asyncRoute(async (req, res) => {
  const conn = deviceConnections.find(c => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });

  let intents: CollectIntent[] = COLLECT_INTENTS;
  if (Array.isArray(req.body?.intents) && req.body.intents.length) {
    intents = req.body.intents.filter(isCollectIntent);
    if (!intents.length) {
      return res.status(400).json({ error: `intents must be any of: ${COLLECT_INTENTS.join(', ')}` });
    }
  }

  const repin = req.body?.repin === true;
  // Audit trail: who collected which device, when.
  console.log(`[AUDIT] SSH collect by "${req.user?.username}" -> ${conn.name} (${conn.host}) intents=${intents.join(',')}${repin ? ' [re-pin host key]' : ''}`);

  const outcome = await collect(conn, intents, parserProfiles, { repin });
  conn.lastCollectedAt = new Date().toISOString();
  conn.lastStatus = outcome.ok ? 'ok' : 'error';
  conn.lastError = outcome.ok ? undefined : outcome.error;

  if (!outcome.ok) {
    persistConnections();
    // A host-key mismatch is a distinct, security-relevant outcome.
    if (outcome.hostKeyMismatch) {
      return res.status(409).json({ error: outcome.error, hostKeyMismatch: true, expectedFingerprint: conn.hostKeyFingerprint });
    }
    return res.status(502).json({ error: outcome.error });
  }

  // Trust-On-First-Use: pin the host key the first time (or on explicit re-pin).
  let pinned = false;
  if (outcome.hostKey && (!conn.hostKey || repin)) {
    conn.hostKey = outcome.hostKey;
    conn.hostKeyFingerprint = outcome.fingerprint;
    pinned = true;
  }
  persistConnections();

  const target = conn.targetNodeId ? nodes.find(n => n.id === conn.targetNodeId) : undefined;
  const drift = computeDrift(outcome.data!, target);
  res.json({ success: true, data: outcome.data, drift, connection: publicConnection(conn), hostKeyPinned: pinned, fingerprint: conn.hostKeyFingerprint });
}));

// 13. Simulation engine settings
app.get('/api/twin/settings', requireAction('read'), (req, res) => {
  res.json(settings);
});

app.put('/api/twin/settings', requireAction('manage-settings'), (req, res) => {
  settings = normalizeSettings(req.body || {}, settings);
  saveState();
  res.json({ success: true, settings });
});

// 14. Reset the whole twin back to the certified seed state
app.post('/api/twin/reset', requireAction('manage-settings'), (req, res) => {
  nodes = withRevisions(getSeedNodes(), maxRev() + 1);
  links = getSeedLinks();
  audits = getSeedAudits();
  changeRequests = getSeedChangeRequests();
  settings = { ...DEFAULT_SETTINGS };
  ipReservations = [];
  saveState();
  res.json({ success: true, nodes, links, audits, changeRequests, settings, ipReservations });
});

// 15. Export / import full twin state (topology snapshots)
app.get('/api/twin/export', requireAction('read'), (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="nettwin-state.json"');
  res.json({ nodes, links, audits, changeRequests, settings, ipReservations, exportedAt: new Date().toISOString() });
});

app.post('/api/twin/import', requireAction('manage-settings'), (req, res) => {
  const body = req.body as Partial<Record<keyof TwinState, unknown>>;
  if (!Array.isArray(body?.nodes) || !Array.isArray(body?.links)) {
    return res.status(400).json({ error: 'Import payload must contain "nodes" and "links" arrays.' });
  }
  // Validate the whole snapshot before touching the live twin, so a bad file
  // can't leave it half-imported.
  const snapshot = {
    nodes: body.nodes.map((n, i) => normalizeNode(n, `nodes[${i}]`)),
    links: body.links.map((l, i) => normalizeLink(l, `links[${i}]`)),
    audits: Array.isArray(body.audits) ? body.audits.map((a, i) => normalizeAudit(a, `audits[${i}]`)) : audits,
    changeRequests: Array.isArray(body.changeRequests)
      ? body.changeRequests.map((c, i) => normalizeChangeRequest(c, `changeRequests[${i}]`))
      : changeRequests,
    ipReservations: Array.isArray(body.ipReservations)
      ? body.ipReservations.map((r, i) => normalizeReservation(r, `ipReservations[${i}]`))
      : ipReservations,
    settings: body.settings ? normalizeSettings(body.settings, DEFAULT_SETTINGS) : settings,
  };
  assertUniqueIds(snapshot.nodes, 'nodes');
  assertUniqueIds(snapshot.links, 'links');
  assertUniqueIds(snapshot.audits, 'audits');
  assertUniqueIds(snapshot.changeRequests, 'changeRequests');
  assertUniqueIds(snapshot.ipReservations, 'ipReservations');
  snapshot.nodes = withRevisions(snapshot.nodes, maxRev() + 1);
  ({ nodes, links, audits, changeRequests, ipReservations, settings } = snapshot);
  saveState();
  res.json({ success: true, nodes, links, audits, changeRequests, settings, ipReservations });
});

// 17. STATIC config parser — 100% offline, deterministic, vendor profiles as data.
//     Auto-detects vendor if not given. No config ever leaves the server.
const MAX_CONFIG_CHARS = 2_000_000;

app.post('/api/twin/parse-config', requireAction('mutate-twin'), (req, res) => {
  const { rawConfig, vendor } = req.body || {};
  if (!rawConfig || typeof rawConfig !== 'string') {
    return res.status(400).json({ error: 'Missing configuration text (rawConfig).' });
  }
  if (rawConfig.length > MAX_CONFIG_CHARS) {
    return res.status(413).json({ error: `Configuration is too large (max ${MAX_CONFIG_CHARS} characters).` });
  }
  const vendorId = (typeof vendor === 'string' && vendor) || detectVendor(rawConfig, parserProfiles);
  const parsedData = parseConfig(rawConfig, vendorId, parserProfiles);
  res.json({ success: true, vendorId, detected: !vendor, parsedData });
});

// 17.1 Live-test a profile against a config sample — powers the editor. Only
// admins may test unsaved drafts; everyone else tests the stored profile with
// that id, so non-admins can't run arbitrary regexes on the server.
app.post('/api/twin/parser-profiles/test', requireAction('mutate-twin'), (req: AuthedRequest, res) => {
  const { rawConfig, profile } = req.body || {};
  if (typeof rawConfig !== 'string' || !rawConfig || !profile || !profile.id) {
    return res.status(400).json({ error: 'rawConfig and profile (with id) are required.' });
  }
  if (rawConfig.length > MAX_CONFIG_CHARS) {
    return res.status(413).json({ error: `Configuration is too large (max ${MAX_CONFIG_CHARS} characters).` });
  }
  let testProfile: ParserProfile | undefined;
  if (canAccess(req.user!.role, 'manage-settings')) {
    try {
      testProfile = normalizeProfile(profile);
    } catch (err: any) {
      return res.status(400).json({ error: `Invalid profile: ${err.message}` });
    }
  } else {
    testProfile = parserProfiles.find(p => p.id === profile.id);
    if (!testProfile) return res.status(404).json({ error: 'Profile not found' });
  }
  try {
    const parsedData = runProfile(rawConfig, testProfile);
    res.json({ success: true, parsedData });
  } catch (err: any) {
    res.status(400).json({ error: `Invalid profile: ${err.message}` });
  }
});

// 17.2 List parser profiles
app.get('/api/twin/parser-profiles', requireAction('read'), (req, res) => {
  res.json(parserProfiles);
});

// 17.3 Create/update a parser profile (admin)
app.post('/api/twin/parser-profiles', requireAction('manage-settings'), (req, res) => {
  const profile = normalizeProfile(req.body);
  const idx = parserProfiles.findIndex(p => sameId(p.id, profile.id));
  // `builtin` is owned by the server: kept on edits, never granted by a client.
  if (idx >= 0) parserProfiles[idx] = { ...profile, id: parserProfiles[idx].id, builtin: parserProfiles[idx].builtin };
  else parserProfiles.push({ ...profile, builtin: undefined });
  void profileSaver.request();
  res.json({ success: true, profiles: parserProfiles });
});

// 17.4 Delete a parser profile (admin) — built-ins can be reset but not deleted
app.delete('/api/twin/parser-profiles/:id', requireAction('manage-settings'), (req, res) => {
  const target = parserProfiles.find(p => p.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Profile not found' });
  if (target.builtin) {
    return res.status(400).json({ error: 'Built-in profiles cannot be deleted (use Reset to restore defaults).' });
  }
  parserProfiles = parserProfiles.filter(p => p.id !== req.params.id);
  void profileSaver.request();
  res.json({ success: true, profiles: parserProfiles });
});

// 17.5 Reset built-in profiles back to their seeded definitions (admin)
app.post('/api/twin/parser-profiles/reset', requireAction('manage-settings'), (req, res) => {
  const custom = parserProfiles.filter(p => !p.builtin && !SEED_PROFILES.some(s => s.id === p.id));
  parserProfiles = [...SEED_PROFILES.map(p => ({ ...p })), ...custom];
  void profileSaver.request();
  res.json({ success: true, profiles: parserProfiles });
});

// Unknown API paths get a JSON 404 instead of falling through to the SPA's index.html.
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// Errors thrown by handlers (validation, malformed JSON, storage failures)
// become JSON responses; internals are logged, not leaked.
function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  const status = err?.status || err?.statusCode;
  if (status >= 400 && status < 500) {
    const message = err.type === 'entity.parse.failed' ? 'Malformed JSON request body' : (err.expose ? err.message : 'Bad request');
    return res.status(status).json({ error: message });
  }
  console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

// Run Vite dev server in development or serve static files in production
async function startServer() {
  // Bring up the storage backend, restore persisted state (or persist the
  // seed on first boot), and guarantee an admin account exists.
  await storage.init();
  const restored = await storage.loadState();
  if (restored) {
    nodes = withRevisions(restored.nodes, 1);
    links = restored.links;
    audits = restored.audits;
    changeRequests = restored.changeRequests;
    ipReservations = restored.ipReservations || [];
    settings = { ...DEFAULT_SETTINGS, ...restored.settings };
    console.log(`Twin state restored from ${storage.kind} storage`);
  } else {
    nodes = withRevisions(nodes, 1);
    await storage.saveState({ nodes, links, audits, changeRequests, settings, ipReservations });
    console.log(`Seed twin state persisted to ${storage.kind} storage`);
  }

  // Load parser profiles. Stored profiles (incl. admin edits to built-ins) win;
  // newly-released seed vendors that aren't stored yet are added. Admins can
  // restore a built-in to its seed via the reset endpoint.
  const storedProfiles = await storage.loadProfiles();
  if (storedProfiles) {
    const newSeeds = SEED_PROFILES.filter(s => !storedProfiles.some(p => p.id === s.id));
    parserProfiles = [...storedProfiles, ...newSeeds.map(p => ({ ...p }))];
  } else {
    parserProfiles = SEED_PROFILES.map(p => ({ ...p }));
  }
  await storage.saveProfiles(parserProfiles);

  // SSH device connections (credentials stored encrypted)
  deviceConnections = await storage.loadConnections();
  if (!credKeyConfigured()) {
    console.warn('WARNING: CRED_KEY is not set to a strong value — SSH Sync cannot store device credentials. Set CRED_KEY (16+ random chars) to enable it.');
  }
  await ensureAdminSeed(storage);

  if (process.env.NODE_ENV !== 'production') {
    // Vite is only needed for the dev server; keep it out of production images
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    // Hashed asset files never change, so they can be cached for good; the
    // HTML shell must be revalidated so a redeploy is picked up immediately.
    // fallthrough:false -> a missing asset is a 404, not the SPA's index.html.
    app.use('/assets', express.static(path.join(distPath, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
    app.use(express.static(distPath, { index: false }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
  app.use(errorHandler);

  const server = app.listen(PORT, HOST, () => {
    console.log(`NetTwin Core Digital Twin server active on http://${HOST}:${PORT}`);
  });

  // `docker stop` sends SIGTERM: stop accepting requests, then let queued
  // saves finish so the last mutations aren't lost.
  const shutdown = (signal: string) => {
    console.log(`${signal} received — flushing pending saves and shutting down...`);
    server.close();
    setTimeout(() => process.exit(1), 10_000).unref();
    Promise.all([stateSaver.flush(), connectionSaver.flush(), profileSaver.flush()])
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch(err => {
  console.error('FATAL: server failed to start:', err);
  process.exit(1);
});
