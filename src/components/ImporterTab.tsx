import React, { useEffect, useRef, useState } from 'react';
import { NetworkNode, Interface, Route, FirewallRule, VRF, NodeType } from '../types';
import { useLang } from '../i18n';
import { uniqueNodeId, mergeIntoNode, buildNode, IncomingConfig } from '../nodeUtils';
import { Upload, FileCode2, Play, CheckCircle2, RefreshCw, AlertCircle, Cpu, Shield, ArrowRightLeft, Server, Trash2 } from 'lucide-react';

interface ImporterTabProps {
  nodes: NetworkNode[];
  canEdit: boolean;
  onUpdateNode: (node: NetworkNode) => Promise<boolean>;
  onCreateNode: (node: NetworkNode) => Promise<boolean>;
}

interface ProfileMeta { id: string; name: string; }

// Editable preview rows carry an _include flag (checkbox) + a stable key.
type Row<T> = T & { _include: boolean; _key: number };

interface ParsedNat { type: 'Static NAT' | 'PAT / Dynamic'; insideLocal: string; insideGlobal: string; vrf: string; }

interface ParseResult {
  hostname: string;
  vrfs: string[];
  interfaces: Row<Interface & { vrf?: string }>[];
  routes: Row<Route>[];
  firewallRules: Row<FirewallRule>[];
  natMappings: Row<ParsedNat>[];
  warnings: string[];
}

let keySeq = 1;
const withRows = <T,>(arr: T[]): Row<T>[] => arr.map(x => ({ ...x, _include: true, _key: keySeq++ }));

export default function ImporterTab({ nodes, canEdit, onUpdateNode, onCreateNode }: ImporterTabProps) {
  const { t } = useLang();
  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
  const [rawConfig, setRawConfig] = useState('');
  const [vendor, setVendor] = useState('auto');
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [detectedVendor, setDetectedVendor] = useState<string | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Target: create a new device or merge into an existing one
  const [targetMode, setTargetMode] = useState<'new' | string>('new');
  const [deviceType, setDeviceType] = useState<NodeType>('firewall');

  useEffect(() => {
    fetch('/api/twin/parser-profiles')
      .then(r => r.ok ? r.json() : [])
      .then((list: any[]) => setProfiles(list.map(p => ({ id: p.id, name: p.name }))))
      .catch(() => {});
  }, []);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setRawConfig(await file.text());
    setResult(null);
    setApplyMsg(null);
  };

  const handleParse = async () => {
    setLoading(true); setError(null); setApplyMsg(null); setResult(null);
    try {
      const res = await fetch('/api/twin/parse-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawConfig, vendor: vendor === 'auto' ? undefined : vendor }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Failed to parse configuration'));
      const pd = data.parsedData;
      setDetectedVendor(data.detected ? data.vendorId : null);
      if (!data.vendorId) {
        setError(t('Vendor could not be auto-detected. Pick a vendor manually, or create a new parser profile in the Parser Profiles menu.'));
      }
      const r: ParseResult = {
        hostname: pd.hostname || '',
        vrfs: pd.vrfs || [],
        interfaces: withRows(pd.interfaces || []),
        routes: withRows(pd.routes || []),
        firewallRules: withRows(pd.firewallRules || []),
        natMappings: withRows(pd.natMappings || []),
        warnings: pd.warnings || [],
      };
      setResult(r);
      if ((pd.firewallRules || []).length || (pd.natMappings || []).length) setDeviceType('firewall');
      else setDeviceType('router');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const patch = <K extends keyof ParseResult>(key: K, idx: number, field: string, value: any) => {
    setResult(prev => {
      if (!prev) return prev;
      const arr = [...(prev[key] as any[])];
      arr[idx] = { ...arr[idx], [field]: value };
      return { ...prev, [key]: arr };
    });
  };

  const [applying, setApplying] = useState(false);

  const applyToTwin = async () => {
    if (!result || applying) return;
    const incoming: IncomingConfig = {
      interfaces: result.interfaces.filter(i => i._include),
      routes: result.routes.filter(r => r._include),
      firewallRules: result.firewallRules.filter(r => r._include),
      natMappings: result.natMappings.filter(n => n._include),
    };
    const existing = targetMode !== 'new' ? nodes.find(n => n.id === targetMode) : undefined;

    setApplying(true);
    try {
      if (existing) {
        // Non-destructive: keeps the device's type, links and existing entries;
        // re-importing the same config adds nothing twice.
        if (!(await onUpdateNode(mergeIntoNode(existing, incoming)))) return;
        setApplyMsg(t('Configuration merged into device "{name}".', { name: existing.name }));
      } else {
        const name = (result.hostname || 'Imported-Device').trim();
        // A fresh id, so a same-named device already in the twin is never replaced.
        const newNode = buildNode(uniqueNodeId(name, nodes), name, deviceType, incoming);
        if (!(await onCreateNode(newNode))) return;
        setApplyMsg(t('New device "{name}" created from config. Connect its cables in the Inventory menu so it can be simulated.', { name }));
      }
      // Only discard the (possibly hand-corrected) preview once it was saved.
      setResult(null);
    } finally {
      setApplying(false);
    }
  };

  if (!canEdit) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 text-center text-xs text-slate-500">
        <Cpu size={36} className="text-slate-300 mx-auto mb-3" />
        {t('Importing configurations requires the operator or admin role.')}
      </div>
    );
  }

  const countIncluded = (arr?: Row<any>[]) => (arr || []).filter(x => x._include).length;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 text-xs">
      {/* Input */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 flex flex-col h-[640px]">
        <div className="border-b border-slate-100 pb-3 mb-4">
          <h3 className="font-display font-bold text-slate-800 text-base flex items-center gap-1.5">
            <Cpu size={18} className="text-blue-500" /> {t('Static Multi-Vendor Config Importer')}
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
            {t('Parsing is 100% local & offline (no AI, no data leaves the server). Each vendor\'s rules are stored as a')} <strong>{t('Parser Profile')}</strong> {t('you can edit/extend.')}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">{t('Vendor')}</label>
            <select value={vendor} onChange={e => setVendor(e.target.value)}
              className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 font-semibold focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="auto">🔍 {t('Auto-detect')}</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">{t('Upload Config File')}</label>
            <button onClick={() => fileRef.current?.click()}
              className="w-full px-3 py-1.5 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg text-slate-700 font-semibold flex items-center justify-center gap-1.5 transition truncate">
              <Upload size={13} /> {fileName || t('Choose file...')}
            </button>
            <input ref={fileRef} type="file" accept=".txt,.cfg,.conf,.config,.log" onChange={handleFile} className="hidden" />
          </div>
        </div>

        <textarea
          value={rawConfig}
          onChange={e => { setRawConfig(e.target.value); setResult(null); }}
          placeholder={t('Paste running-config here, or upload a file...\n\nexample:\ninterface GigabitEthernet0/1\n ip address 10.10.1.1 255.255.255.0')}
          className="flex-1 w-full p-4 bg-slate-950 border border-slate-800 text-slate-300 font-mono rounded-xl focus:outline-none overflow-y-auto resize-none text-[11px]"
        />

        <button onClick={handleParse} disabled={loading || !rawConfig.trim()}
          className="mt-3 w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition flex items-center justify-center gap-2">
          {loading ? <><RefreshCw size={14} className="animate-spin" /> {t('Parsing...')}</> : <><Play size={14} fill="currentColor" /> {t('Parse Config')}</>}
        </button>
        {error && <div className="mt-3 p-2.5 bg-rose-50 border border-rose-100 text-rose-800 rounded-lg font-semibold flex items-center gap-2"><AlertCircle size={14} /> {error}</div>}
      </div>

      {/* Editable preview */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 flex flex-col h-[640px] overflow-hidden">
        <div className="border-b border-slate-100 pb-3 mb-3 flex items-center justify-between">
          <div>
            <h3 className="font-display font-bold text-slate-800 text-base">{t('Preview & Correct')}</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">{t('Fix wrong values, uncheck what you don\'t need, then apply.')}</p>
          </div>
          {detectedVendor && <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-100 px-2 py-1 rounded-full font-bold">{t('detected:')} {detectedVendor}</span>}
        </div>

        {!result ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-slate-400">
            <FileCode2 size={40} className="text-slate-300 mb-3" />
            <p className="text-[11px] max-w-[260px]">{t('Parsing results appear here as an editable table.')}</p>
            {applyMsg && <div className="mt-4 p-3 bg-emerald-50 border border-emerald-150 text-emerald-800 rounded-lg font-semibold flex items-center gap-2"><CheckCircle2 size={16} /> {applyMsg}</div>}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto pr-1 space-y-4">
            {result.warnings.length > 0 && (
              <div className="p-2.5 bg-amber-50 border border-amber-100 text-amber-800 rounded-lg text-[11px] flex items-start gap-2">
                <AlertCircle size={13} className="mt-0.5 shrink-0" /> {result.warnings.join(' ')}
              </div>
            )}

            <div className="flex items-center gap-2 text-[11px]">
              <Server size={13} className="text-slate-400" />
              <span className="text-slate-500 font-semibold">{t('Hostname:')}</span>
              <input value={result.hostname} onChange={e => setResult({ ...result, hostname: e.target.value })}
                className="px-2 py-1 bg-slate-50 border border-slate-200 rounded font-mono font-bold text-slate-800 flex-1" />
            </div>

            {/* Interfaces */}
            <PreviewSection title="Interfaces" count={countIncluded(result.interfaces)} icon={<ArrowRightLeft size={12} />}>
              {result.interfaces.map((it, i) => (
                <RowEditor key={it._key} checked={it._include} onCheck={v => patch('interfaces', i, '_include', v)}>
                  <input value={it.name} onChange={e => patch('interfaces', i, 'name', e.target.value)} className="w-28 in" />
                  <input value={it.ip} onChange={e => patch('interfaces', i, 'ip', e.target.value)} className="w-28 in" />
                  <input value={it.vrf || ''} onChange={e => patch('interfaces', i, 'vrf', e.target.value)} placeholder="vrf" className="w-20 in" />
                  <span className={`text-[9px] px-1.5 py-0.5 rounded ${it.status === 'up' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>{it.status}</span>
                </RowEditor>
              ))}
            </PreviewSection>

            {/* Routes */}
            <PreviewSection title="Routes" count={countIncluded(result.routes)} icon={<ArrowRightLeft size={12} />}>
              {result.routes.map((r, i) => (
                <RowEditor key={r._key} checked={r._include} onCheck={v => patch('routes', i, '_include', v)}>
                  <input value={r.destination} onChange={e => patch('routes', i, 'destination', e.target.value)} className="w-28 in" />
                  <span className="text-slate-400">via</span>
                  <input value={r.nextHop} onChange={e => patch('routes', i, 'nextHop', e.target.value)} className="w-24 in" />
                  <input value={r.vrf} onChange={e => patch('routes', i, 'vrf', e.target.value)} className="w-16 in" />
                </RowEditor>
              ))}
            </PreviewSection>

            {/* Firewall / ACL */}
            <PreviewSection title={t('ACL / Firewall Policy')} count={countIncluded(result.firewallRules)} icon={<Shield size={12} />}>
              {result.firewallRules.map((r, i) => (
                <RowEditor key={r._key} checked={r._include} onCheck={v => patch('firewallRules', i, '_include', v)}>
                  <input value={r.name} onChange={e => patch('firewallRules', i, 'name', e.target.value)} className="w-24 in" />
                  <input value={r.sourceIp} onChange={e => patch('firewallRules', i, 'sourceIp', e.target.value)} className="w-24 in" title="source" />
                  <span className="text-slate-400">→</span>
                  <input value={r.destIp} onChange={e => patch('firewallRules', i, 'destIp', e.target.value)} className="w-24 in" title="dest" />
                  <input value={r.destPort} onChange={e => patch('firewallRules', i, 'destPort', e.target.value)} className="w-12 in" title="dport" />
                  <select value={r.action} onChange={e => patch('firewallRules', i, 'action', e.target.value)}
                    className={`in w-16 ${r.action === 'permit' ? 'text-emerald-700' : 'text-rose-700'}`}>
                    <option value="permit">permit</option>
                    <option value="deny">deny</option>
                  </select>
                </RowEditor>
              ))}
            </PreviewSection>

            {/* NAT */}
            <PreviewSection title="NAT" count={countIncluded(result.natMappings)} icon={<ArrowRightLeft size={12} />}>
              {result.natMappings.map((n, i) => (
                <RowEditor key={n._key} checked={n._include} onCheck={v => patch('natMappings', i, '_include', v)}>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 ${n.type === 'Static NAT' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{n.type === 'Static NAT' ? 'STATIC' : 'PAT'}</span>
                  <input value={n.insideLocal} onChange={e => patch('natMappings', i, 'insideLocal', e.target.value)} className="w-28 in" title="inside local" />
                  <span className="text-slate-400">↔</span>
                  <input value={n.insideGlobal} onChange={e => patch('natMappings', i, 'insideGlobal', e.target.value)} className="w-28 in" title="inside global" />
                </RowEditor>
              ))}
            </PreviewSection>
          </div>
        )}

        {result && (
          <div className="pt-3 mt-2 border-t border-slate-100 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <select value={targetMode} onChange={e => setTargetMode(e.target.value)}
                className="px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg font-semibold text-slate-700">
                <option value="new">➕ {t('Create new device')}</option>
                {nodes.map(n => <option key={n.id} value={n.id}>{t('Merge into:')} {n.name}</option>)}
              </select>
              {targetMode === 'new' && (
                <select value={deviceType} onChange={e => setDeviceType(e.target.value as NodeType)}
                  className="px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg font-semibold text-slate-700">
                  <option value="firewall">{t('Type')}: {t('Firewall')}</option>
                  <option value="router">{t('Type')}: {t('Router')}</option>
                  <option value="switch">{t('Type')}: {t('Switch')}</option>
                  <option value="host">{t('Type')}: {t('Host')}</option>
                </select>
              )}
            </div>
            <button onClick={applyToTwin} disabled={applying}
              className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400 text-white font-semibold rounded-lg transition flex items-center justify-center gap-2">
              {applying ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} {t('Apply {n} items to Digital Twin', { n: countIncluded(result.interfaces) + countIncluded(result.routes) + countIncluded(result.firewallRules) + countIncluded(result.natMappings) })}
            </button>
          </div>
        )}
      </div>

      <style>{`.in{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:2px 6px;font-family:ui-monospace,monospace;font-size:11px;color:#1e293b}`}</style>
    </div>
  );
}

const PreviewSection: React.FC<{ title: string; count: number; icon: React.ReactNode; children: React.ReactNode }> = ({ title, count, icon, children }) => {
  const hasRows = React.Children.count(children) > 0;
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
        {icon} {title} <span className="text-slate-300">({count})</span>
      </div>
      {hasRows ? <div className="space-y-1">{children}</div> : <div className="text-[11px] text-slate-300 italic pl-4">none</div>}
    </div>
  );
};

const RowEditor: React.FC<{ checked: boolean; onCheck: (v: boolean) => void; children: React.ReactNode }> = ({ checked, onCheck, children }) => {
  return (
    <div className={`flex items-center gap-1.5 flex-wrap p-1.5 rounded-lg border ${checked ? 'bg-slate-50/60 border-slate-150' : 'bg-slate-50/20 border-slate-100 opacity-50'}`}>
      <input type="checkbox" checked={checked} onChange={e => onCheck(e.target.checked)} className="accent-blue-600 shrink-0" />
      {children}
    </div>
  );
};
