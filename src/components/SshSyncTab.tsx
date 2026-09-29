import React, { useEffect, useState } from 'react';
import { NetworkNode, NetworkLink, DeviceConnection, Interface, Route, FirewallRule } from '../types';
import { useLang } from '../i18n';
import { slugify, uniqueNodeId, mergeIntoNode, buildNode } from '../nodeUtils';
import { Server, Plus, Trash2, RefreshCw, AlertCircle, CheckCircle2, Radio, Pencil, X, Lock, Cable, Network, ArrowRightLeft, Shield, Play } from 'lucide-react';

interface SshSyncTabProps {
  nodes: NetworkNode[];
  links: NetworkLink[];
  isAdmin: boolean;                                  // SSH Sync is admin-only
  onUpdateNode: (node: NetworkNode) => Promise<boolean>;
  onCreateNode: (node: NetworkNode) => Promise<boolean>;
  onApplied: () => void; // refresh topology after apply
}

interface Meta { supportedVendors: string[]; credKeyConfigured: boolean; collectorConfigured: boolean; }
interface Collected {
  hostname: string; vendor: string;
  interfaces: (Interface & { vrf?: string })[];
  vrfs: string[]; routes: Route[]; firewallRules: FirewallRule[];
  ribVrfs: string[]; // VRFs whose live routing table was read (empty = routes from config)
  natMappings: { type: 'Static NAT' | 'PAT / Dynamic'; insideLocal: string; insideGlobal: string; vrf: string }[];
  arp: { ip: string; mac: string; iface: string }[];
  neighbors: { localInterface: string; remoteDevice: string; remoteInterface: string }[];
  warnings: string[];
}
interface Drift {
  targetName: string | null;
  interfaces: { added: number; changed: number };
  routes: { added: number; removed: number };
  firewallRules: { added: number };
  summary: string;
}

const BLANK = { name: '', host: '', port: '22', vendor: 'cisco_ios', username: '', password: '', targetNodeId: '' };

// Error text from a failed response, tolerating non-JSON bodies (e.g. a proxy's HTML error page).
async function errorOf(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return data.error || `${fallback} (HTTP ${res.status})`;
}

export default function SshSyncTab({ nodes, links, isAdmin, onUpdateNode, onCreateNode, onApplied }: SshSyncTabProps) {
  const { t } = useLang();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [conns, setConns] = useState<DeviceConnection[]>([]);
  const [form, setForm] = useState({ ...BLANK });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [collecting, setCollecting] = useState<string | null>(null);
  const [result, setResult] = useState<{ conn: DeviceConnection; data: Collected; drift: Drift } | null>(null);
  const [applyArp, setApplyArp] = useState(true);
  const [applyLinks, setApplyLinks] = useState(true);
  const [applying, setApplying] = useState(false);

  const flash = (kind: 'ok' | 'error', text: string) => { setMsg({ kind, text }); setTimeout(() => setMsg(null), 5000); };

  const load = async () => {
    if (!isAdmin) return;
    try {
      const [m, c] = await Promise.all([
        fetch('/api/twin/ssh/meta').then(r => r.ok ? r.json() : null),
        fetch('/api/twin/ssh/connections').then(r => r.ok ? r.json() : []),
      ]);
      setMeta(m); setConns(Array.isArray(c) ? c : []);
    } catch (err) { console.error(err); }
  };
  useEffect(() => { load(); }, [isAdmin]);

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = editingId ? `/api/twin/ssh/connections/${editingId}` : '/api/twin/ssh/connections';
    const body: any = { ...form, port: parseInt(form.port, 10) || 22 };
    if (editingId && !form.password) delete body.password; // keep existing password on edit
    try {
      const res = await fetch(url, { method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) return flash('error', await errorOf(res, t('Failed to save connection')));
    } catch {
      return flash('error', t('Cannot reach the server. Check your connection and try again.'));
    }
    flash('ok', t('Connection saved.'));
    setShowForm(false); setEditingId(null); setForm({ ...BLANK });
    await load();
  };

  const startEdit = (c: DeviceConnection) => {
    setEditingId(c.id);
    setForm({ name: c.name, host: c.host, port: String(c.port), vendor: c.vendor, username: c.username, password: '', targetNodeId: c.targetNodeId || '' });
    setShowForm(true);
  };

  const remove = async (c: DeviceConnection) => {
    if (!confirm(t('Delete connection "{name}"?', { name: c.name }))) return;
    try {
      const res = await fetch(`/api/twin/ssh/connections/${c.id}`, { method: 'DELETE' });
      if (!res.ok) return flash('error', await errorOf(res, t('Failed to delete')));
    } catch {
      return flash('error', t('Cannot reach the server. Check your connection and try again.'));
    }
    flash('ok', t('Connection deleted.'));
    if (result?.conn.id === c.id) setResult(null);
    await load();
  };

  const runCollect = async (c: DeviceConnection, repin = false) => {
    setCollecting(c.id); setResult(null);
    try {
      const res = await fetch(`/api/twin/ssh/connections/${c.id}/collect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repin }) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.hostKeyMismatch) {
        // Host key changed since it was pinned — possible MITM or the device was replaced.
        const okRepin = confirm(t('⚠ HOST KEY MISMATCH for {name}. The device SSH key changed since it was pinned — this could mean the device was replaced, or a man-in-the-middle. Only trust the new key if you know the device changed.\n\nTrust the new key and re-collect?', { name: c.name }));
        if (okRepin) return runCollect(c, true);
        throw new Error(t('Host key mismatch — collection aborted.'));
      }
      if (!res.ok) throw new Error(data.error || t('Collection failed'));
      setResult({ conn: c, data: data.data, drift: data.drift });
      if (data.hostKeyPinned) flash('ok', t('Host key pinned: {fp}', { fp: data.fingerprint || '' }));
      await load();
    } catch (err: any) { flash('error', err.message); await load(); }
    finally { setCollecting(null); }
  };

  // Merge collected data into the connection's target device (or create a new
  // one), then optionally seed IPAM from ARP and links from neighbors.
  const applyToTwin = async () => {
    if (!result) return;
    setApplying(true);
    try {
      const { conn, data } = result;
      const incoming = {
        interfaces: data.interfaces,
        routes: data.routes,
        firewallRules: data.firewallRules,
        natMappings: data.natMappings,
      };
      const target = conn.targetNodeId ? nodes.find(n => n.id === conn.targetNodeId) : undefined;

      let node: NetworkNode;
      if (target) {
        // Non-destructive merge: a partial collection (e.g. no policies parsed)
        // never wipes the device's rules/NAT or turns a firewall into a router.
        // Routing tables read live replace the routes learned in earlier syncs.
        node = mergeIntoNode(target, incoming, { ribVrfs: data.ribVrfs });
        if (!(await onUpdateNode(node))) return;
      } else {
        const name = data.hostname || conn.name;
        node = buildNode(uniqueNodeId(name, nodes), name, data.firewallRules.length ? 'firewall' : 'router', incoming, { ribVrfs: data.ribVrfs });
        if (!(await onCreateNode(node))) return;
        // Link the connection to the device it created, so the next collection
        // updates it instead of creating another copy.
        await fetch(`/api/twin/ssh/connections/${conn.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetNodeId: node.id }) })
          .catch(() => {});
      }
      const nodeId = node.id;

      // ARP -> IPAM reservations (tolerate duplicates)
      let arpAdded = 0;
      if (applyArp) {
        const ifaceIps = new Set(data.interfaces.map(i => i.ip.split('/')[0]));
        for (const a of data.arp) {
          if (ifaceIps.has(a.ip)) continue;
          const r = await fetch('/api/twin/ipam/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: a.ip, note: `ARP ${a.mac} via ${a.iface} (${node.name})` }) });
          if (r.ok) arpAdded++;
        }
      }

      // Neighbors -> links (only when the remote device already exists in the twin)
      let linksAdded = 0;
      if (applyLinks) {
        for (const nb of data.neighbors) {
          const remote = nodes.find(n => n.name.toLowerCase() === nb.remoteDevice.toLowerCase() || n.id === slugify(nb.remoteDevice));
          if (!remote || remote.id === nodeId) continue;
          // Skip cables the twin already has on this port.
          if (links.some(l => (l.sourceNodeId === nodeId && l.sourceInterface === nb.localInterface) || (l.destNodeId === nodeId && l.destInterface === nb.localInterface))) continue;
          const r = await fetch('/api/twin/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `ssh_link_${Date.now()}_${linksAdded}`, sourceNodeId: nodeId, sourceInterface: nb.localInterface, destNodeId: remote.id, destInterface: nb.remoteInterface }) });
          if (r.ok) linksAdded++;
        }
      }

      flash('ok', t('Applied "{name}" to twin. {arp} ARP reservations, {links} links added.', { name: node.name, arp: arpAdded, links: linksAdded }));
      setResult(null);
      onApplied();
      await load();
    } catch (err: any) { flash('error', err.message); }
    finally { setApplying(false); }
  };

  const notReady = meta && (!meta.collectorConfigured);

  if (!isAdmin) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 text-center text-xs text-slate-500">
        <Lock size={36} className="text-slate-300 mx-auto mb-3" />
        {t('SSH Sync touches real devices and is limited to admins. Ask an admin to collect from a device.')}
      </div>
    );
  }

  return (
    <div className="space-y-4 text-xs">
      {msg && (
        <div className={`p-3 rounded-lg border font-semibold flex items-center gap-2 ${msg.kind === 'ok' ? 'bg-emerald-50 border-emerald-150 text-emerald-800' : 'bg-rose-50 border-rose-150 text-rose-800'}`}>
          {msg.kind === 'ok' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}{msg.text}
        </div>
      )}
      {notReady && (
        <div className="p-3 rounded-lg border bg-amber-50 border-amber-100 text-amber-800 font-semibold flex items-center gap-2">
          <AlertCircle size={14} /> {t('SSH collector sidecar is not configured. Run the app via docker-compose (which starts the collector). Manual config upload still works normally.')}
        </div>
      )}
      {meta && !meta.credKeyConfigured && (
        <div className="p-3 rounded-lg border bg-rose-50 border-rose-100 text-rose-800 font-semibold flex items-center gap-2">
          <Lock size={14} /> {t('CRED_KEY is not set — set it before storing device credentials in production.')}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Connections */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5"><Server size={13} /> {t('Device Connections')}</span>
            <button onClick={() => { setShowForm(true); setEditingId(null); setForm({ ...BLANK }); }} className="text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1"><Plus size={13} /> {t('Add')}</button>
          </div>

          {showForm && (
            <form onSubmit={submitForm} className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-700">{editingId ? t('Edit connection') : t('New connection')}</span>
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }} className="text-slate-400 hover:text-slate-600"><X size={14} /></button>
              </div>
              <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder={t('Name (e.g. Core-R1)')} className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg" />
              <div className="grid grid-cols-3 gap-2">
                <input required value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} placeholder={t('Mgmt IP')} className="col-span-2 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg font-mono" />
                <input value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} placeholder="22" className="px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg font-mono" />
              </div>
              <select value={form.vendor} onChange={e => setForm({ ...form, vendor: e.target.value })} className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg font-semibold">
                {(meta?.supportedVendors || ['cisco_ios']).map(v => <option key={v} value={v}>{v}</option>)}
              </select>
              <input required value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder={t('Read-only username')} className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg" autoComplete="off" />
              <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder={editingId ? t('Password (leave blank to keep)') : t('Password')} className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg" autoComplete="new-password" />
              <select value={form.targetNodeId} onChange={e => setForm({ ...form, targetNodeId: e.target.value })} className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg">
                <option value="">{t('Target: new device')}</option>
                {nodes.map(n => <option key={n.id} value={n.id}>{t('Target: merge into')} {n.name}</option>)}
              </select>
              <button type="submit" className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg flex items-center justify-center gap-1"><CheckCircle2 size={13} /> {t('Save connection')}</button>
            </form>
          )}

          <div className="space-y-2">
            {conns.map(c => (
              <div key={c.id} className="p-3 rounded-xl border border-slate-200 bg-white">
                <div className="flex items-center justify-between">
                  <span className="font-display font-bold text-slate-800 text-[12px]">{c.name}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase ${c.lastStatus === 'ok' ? 'bg-emerald-100 text-emerald-700' : c.lastStatus === 'error' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500'}`}>{c.lastStatus || 'never'}</span>
                </div>
                <div className="font-mono text-[10px] text-slate-500 mt-0.5">{c.username}@{c.host}:{c.port} · {c.vendor}</div>
                {c.hostKeyFingerprint && (
                  <div className="font-mono text-[9px] text-slate-400 mt-0.5 flex items-center gap-1 truncate" title={c.hostKeyFingerprint}>
                    <Lock size={9} className="shrink-0" /> {c.hostKeyFingerprint}
                  </div>
                )}
                {c.lastError && <div className="text-[10px] text-rose-600 mt-1 truncate" title={c.lastError}>{c.lastError}</div>}
                <div className="flex gap-1.5 mt-2">
                  <button onClick={() => runCollect(c)} disabled={collecting === c.id || notReady || undefined}
                    className="flex-1 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white font-semibold rounded-lg flex items-center justify-center gap-1.5">
                    {collecting === c.id ? <RefreshCw size={12} className="animate-spin" /> : <Radio size={12} />} {t('Collect now')}
                  </button>
                  <button onClick={() => startEdit(c)} className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded"><Pencil size={13} /></button>
                  <button onClick={() => remove(c)} className="p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded"><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
            {conns.length === 0 && !showForm && <div className="text-slate-400 italic text-[11px] py-2 text-center">{t('No connections yet. Add a read-only SSH connection to a device.')}</div>}
          </div>
        </div>

        {/* Collect result */}
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-xl shadow-sm p-5 min-h-[500px]">
          {!result ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-400">
              <Radio size={40} className="text-slate-300 mb-3" />
              <p className="text-[11px] max-w-[320px]">{t('Pick a connection and click "Collect now" to pull read-only data (config, routes, ARP, LLDP/CDP) and preview the drift vs your twin.')}</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                  <h3 className="font-display font-bold text-slate-800 text-base flex items-center gap-2"><Server size={16} className="text-blue-500" /> {result.data.hostname || result.conn.name}</h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">{result.conn.host} · {result.conn.vendor}</p>
                </div>
                <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-1 rounded-full font-bold">{t('Collected')}</span>
              </div>

              {result.data.warnings.length > 0 && (
                <div className="p-2.5 bg-amber-50 border border-amber-100 text-amber-800 rounded-lg text-[11px] flex items-start gap-2"><AlertCircle size={13} className="mt-0.5 shrink-0" /> {result.data.warnings.join(' ')}</div>
              )}

              {/* Drift */}
              <div className="p-3 bg-slate-50 border border-slate-150 rounded-xl">
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">{t('Drift vs twin')} {result.drift.targetName ? `(${result.drift.targetName})` : `(${t('new device')})`}</div>
                <p className="text-slate-700 font-semibold">{result.drift.summary}</p>
              </div>

              {/* Counts */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                <Stat icon={<Network size={13} />} label={t('Interfaces')} value={result.data.interfaces.length} />
                <Stat icon={<ArrowRightLeft size={13} />} label={t('Routes')} value={result.data.routes.length} />
                <Stat icon={<Shield size={13} />} label={t('ACL / Policy')} value={result.data.firewallRules.length} />
                <Stat icon={<ArrowRightLeft size={13} />} label="NAT" value={result.data.natMappings.length} />
                <Stat icon={<Server size={13} />} label={t('ARP hosts')} value={result.data.arp.length} />
                <Stat icon={<Cable size={13} />} label={t('Neighbors')} value={result.data.neighbors.length} />
              </div>

              {/* small previews */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                <Preview title={result.data.ribVrfs?.length ? `${t('Routes (RIB)')} · VRF: ${result.data.ribVrfs.join(', ')}` : t('Routes (from config)')} rows={result.data.routes.slice(0, 6).map(r => `${r.destination} → ${r.nextHop} [${r.protocol}]`)} more={result.data.routes.length - 6} />
                <Preview title={t('ARP (live hosts)')} rows={result.data.arp.slice(0, 6).map(a => `${a.ip}  ${a.mac}  ${a.iface}`)} more={result.data.arp.length - 6} />
                <Preview title={t('Neighbors (LLDP/CDP)')} rows={result.data.neighbors.slice(0, 6).map(n => `${n.localInterface} ↔ ${n.remoteDevice} (${n.remoteInterface})`)} more={result.data.neighbors.length - 6} />
                <Preview title={t('Interfaces')} rows={result.data.interfaces.slice(0, 6).map(i => `${i.name}  ${i.ip}${i.vrf ? '  ['+i.vrf+']' : ''}`)} more={result.data.interfaces.length - 6} />
              </div>

              {/* Apply */}
              <div className="pt-3 border-t border-slate-100 space-y-2">
                <div className="flex flex-wrap gap-4 text-slate-600 font-semibold">
                  <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={applyArp} onChange={e => setApplyArp(e.target.checked)} className="accent-blue-600" /> {t('Add ARP hosts to IPAM')}</label>
                  <label className="flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={applyLinks} onChange={e => setApplyLinks(e.target.checked)} className="accent-blue-600" /> {t('Auto-cable from neighbors')}</label>
                </div>
                <button onClick={applyToTwin} disabled={applying}
                  className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400 text-white font-semibold rounded-lg flex items-center justify-center gap-2">
                  {applying ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} {t('Apply to Digital Twin')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const Stat: React.FC<{ icon: React.ReactNode; label: string; value: number }> = ({ icon, label, value }) => (
  <div className="p-2.5 bg-slate-50 border border-slate-150 rounded-lg flex items-center gap-2">
    <span className="text-slate-400">{icon}</span>
    <div><div className="font-display font-bold text-slate-800 text-sm">{value}</div><div className="text-[9px] uppercase tracking-wider text-slate-400 font-bold">{label}</div></div>
  </div>
);

const Preview: React.FC<{ title: string; rows: string[]; more: number }> = ({ title, rows, more }) => (
  <div className="border border-slate-150 rounded-lg p-2.5 bg-slate-50/40">
    <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">{title}</div>
    {rows.length ? (
      <div className="font-mono text-[10px] text-slate-600 space-y-0.5">
        {rows.map((r, i) => <div key={i} className="truncate">{r}</div>)}
        {more > 0 && <div className="text-slate-400 italic">+{more} more…</div>}
      </div>
    ) : <div className="text-slate-300 italic text-[10px]">none</div>}
  </div>
);
