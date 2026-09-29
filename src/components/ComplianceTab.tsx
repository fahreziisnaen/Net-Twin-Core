import React, { useEffect, useState } from 'react';
import { ComplianceAudit, NetworkNode } from '../types';
import { useDialog } from './DialogProvider';
import { ShieldCheck, ShieldAlert, Play, Plus, RefreshCw, Layers, CheckCircle2, XCircle, Trash2 } from 'lucide-react';

interface ComplianceTabProps {
  audits: ComplianceAudit[];
  nodes: NetworkNode[];
  canEdit: boolean;
  onRunAudits: () => Promise<void>;
  onAddAudit: (audit: ComplianceAudit) => Promise<boolean>;
  onDeleteAudit: (auditId: string) => Promise<boolean>;
}

export default function ComplianceTab({ audits, nodes, canEdit, onRunAudits, onAddAudit, onDeleteAudit }: ComplianceTabProps) {
  const dialog = useDialog();
  const [running, setRunning] = useState(false);
  const [showForm, setShowForm] = useState(false);

  // Custom Audit Form States
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<'PCI-DSS' | 'Security Policy' | 'Routing'>('PCI-DSS');
  const [srcNodeId, setSrcNodeId] = useState('corp-pc-01');
  const [srcVrf, setSrcVrf] = useState('CORPORATE');
  const [srcIp, setSrcIp] = useState('10.200.15.42');
  const [destIp, setDestIp] = useState('192.168.50.10');
  const [protocol, setProtocol] = useState<'tcp' | 'udp' | 'icmp'>('tcp');
  const [destPort, setDestPort] = useState('5432');
  const [expectedResult, setExpectedResult] = useState<'SUCCESS' | 'BLOCKED_BY_FIREWALL' | 'NO_ROUTE'>('BLOCKED_BY_FIREWALL');

  // The form defaults come from the reference topology; if that device isn't
  // in this twin, start from one that is (the select would otherwise show one
  // device while submitting another).
  useEffect(() => {
    if (nodes.length && !nodes.some(n => n.id === srcNodeId)) {
      setSrcNodeId(nodes[0].id);
      setSrcVrf(nodes[0].vrfs[0]?.name || '');
    }
  }, [nodes, srcNodeId]);

  const handleTriggerRun = async () => {
    setRunning(true);
    try {
      await onRunAudits();
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(false);
    }
  };

  const handleAddCustomAudit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newAudit: ComplianceAudit = {
      id: `audit_${Date.now()}`,
      name: name.trim(),
      description: description.trim(),
      category,
      query: {
        sourceNodeId: srcNodeId,
        sourceVrf: srcVrf,
        sourceIp: srcIp.trim(),
        destIp: destIp.trim(),
        protocol,
        sourcePort: '1024',
        destPort: destPort.trim(),
      },
      expectedResult,
      status: 'untested',
    };

    if (!(await onAddAudit(newAudit))) return;
    setShowForm(false);
    setName('');
    setDescription('');
  };

  return (
    <div className="space-y-6">
      {/* Run Auditor Header Banner */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-6">
        <div>
          <h3 className="font-display font-bold text-slate-800 text-lg">Regulatory Compliance Audit Suite</h3>
          <p className="text-xs text-slate-500 mt-1 max-w-xl leading-relaxed">
            Continuously evaluate running digital twin states against strict security regulations (PCI-DSS segment boundaries, corporate compliance, and egress filters).
          </p>
        </div>

        {canEdit && (
        <div className="flex gap-2">
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs transition"
          >
            Create Custom Rule
          </button>
          <button
            onClick={handleTriggerRun}
            disabled={running}
            className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg text-xs transition flex items-center gap-1.5 shadow-sm"
          >
            {running ? (
              <>
                <RefreshCw size={14} className="animate-spin" /> Verifying...
              </>
            ) : (
              <>
                <Play size={14} fill="currentColor" /> Run Active Audits
              </>
            )}
          </button>
        </div>
        )}
      </div>

      {canEdit && showForm && (
        /* Create custom regulatory rule verification */
        <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm text-xs">
          <h4 className="font-display font-bold text-slate-800 text-sm mb-4">Add Regulatory Compliance Requirement</h4>
          <form onSubmit={handleAddCustomAudit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">Requirement Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Audit PCI isolation check"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800"
                  required
                />
              </div>
              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">Audit Category</label>
                <select
                  value={category}
                  onChange={e => setCategory(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 font-sans"
                >
                  <option value="PCI-DSS">PCI-DSS (Fintech Standard)</option>
                  <option value="Security Policy">Security Policy (Corporate)</option>
                  <option value="Routing">Routing / Reachability</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">Description / Regulation Detail</label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Explain the security regulation parameter..."
                rows={2}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800"
                required
              />
            </div>

            <div className="p-4 bg-slate-50 rounded-xl border border-slate-150 space-y-3 font-mono">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-sans">Verification Probe Specs</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-slate-400 font-semibold mb-1 text-[9px]">Source Device</label>
                  <select
                    value={srcNodeId}
                    onChange={e => {
                      const nodeId = e.target.value;
                      setSrcNodeId(nodeId);
                      const node = nodes.find(n => n.id === nodeId);
                      if (node?.vrfs[0]) setSrcVrf(node.vrfs[0].name);
                    }}
                    className="w-full px-2 py-1 bg-white border border-slate-250 rounded font-sans"
                    required
                  >
                    {nodes.map(n => (
                      <option key={n.id} value={n.id}>{n.name} ({n.type})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 font-semibold mb-1 text-[9px]">Source VRF</label>
                  <select
                    value={srcVrf}
                    onChange={e => setSrcVrf(e.target.value)}
                    className="w-full px-2 py-1 bg-white border border-slate-250 rounded font-sans"
                    required
                  >
                    {(nodes.find(n => n.id === srcNodeId)?.vrfs || []).map(v => (
                      <option key={v.name} value={v.name}>{v.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 font-semibold mb-1 text-[9px]">Source IP</label>
                  <input type="text" value={srcIp} onChange={e => setSrcIp(e.target.value)} className="w-full px-2 py-1 bg-white border border-slate-250 rounded" required />
                </div>
                <div>
                  <label className="block text-slate-400 font-semibold mb-1 text-[9px]">Dest IP</label>
                  <input type="text" value={destIp} onChange={e => setDestIp(e.target.value)} className="w-full px-2 py-1 bg-white border border-slate-250 rounded" required />
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-slate-400 font-semibold mb-1 text-[9px]">Protocol</label>
                  <select value={protocol} onChange={e => setProtocol(e.target.value as any)} className="w-full px-2 py-1 bg-white border border-slate-250 rounded font-sans">
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                    <option value="icmp">ICMP</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 font-semibold mb-1 text-[9px]">Dest Port</label>
                  <input type="text" value={destPort} onChange={e => setDestPort(e.target.value)} className="w-full px-2 py-1 bg-white border border-slate-250 rounded" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-slate-400 font-semibold mb-1 text-[9px]">Expected Simulation Outcome</label>
                  <select value={expectedResult} onChange={e => setExpectedResult(e.target.value as any)} className="w-full px-2 py-1 bg-white border border-slate-250 rounded font-sans">
                    <option value="BLOCKED_BY_FIREWALL">BLOCKED_BY_FIREWALL (Should fail path check)</option>
                    <option value="SUCCESS">SUCCESS (Should complete path check)</option>
                    <option value="NO_ROUTE">NO_ROUTE (Blackholed route)</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-lg">Cancel</button>
              <button type="submit" className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white font-semibold rounded-lg">Inject Requirement</button>
            </div>
          </form>
        </div>
      )}

      {/* Audits Grids */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {audits.map(audit => {
          const isPassed = audit.status === 'passed';
          const isFailed = audit.status === 'failed';
          const isUntested = audit.status === 'untested';

          return (
            <div
              key={audit.id}
              className={`bg-white border rounded-xl shadow-sm p-5 transition hover:shadow-md flex flex-col justify-between h-[210px] ${
                isPassed
                  ? 'border-emerald-200 bg-emerald-50/10'
                  : isFailed
                  ? 'border-rose-200 bg-rose-50/10'
                  : 'border-slate-200'
              }`}
            >
              <div>
                {/* Header Category tag */}
                <div className="flex items-center justify-between">
                  <span className={`px-2 py-0.5 rounded font-mono font-bold text-[9px] uppercase tracking-wider ${
                    audit.category === 'PCI-DSS' ? 'bg-indigo-50 text-indigo-700 border border-indigo-100' : 'bg-slate-100 text-slate-700 border border-slate-200'
                  }`}>
                    {audit.category}
                  </span>

                  {/* Pass/Fail Status badge */}
                  <div className="flex items-center gap-1">
                    {isPassed ? (
                      <span className="text-emerald-700 text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 bg-emerald-100 px-2.5 py-0.5 rounded-full">
                        <CheckCircle2 size={12} /> Compliance Pass
                      </span>
                    ) : isFailed ? (
                      <span className="text-rose-700 text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 bg-rose-100 px-2.5 py-0.5 rounded-full animate-pulse">
                        <XCircle size={12} /> Compliance Fail
                      </span>
                    ) : (
                      <span className="text-slate-500 text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 bg-slate-100 px-2.5 py-0.5 rounded-full">
                        Untested
                      </span>
                    )}
                  </div>
                </div>

                <h4 className="font-display font-bold text-slate-800 text-sm mt-3 leading-snug">{audit.name}</h4>
                <p className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">{audit.description}</p>
              </div>

              {/* Technical Path Probe Log */}
              <div className="mt-4 pt-3 border-t border-slate-100 flex items-end justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[10px] text-slate-400 font-mono flex items-center gap-1.5">
                    <Layers size={10} /> Probe: {audit.query?.sourceIp} ➔ {audit.query?.destIp} (Port {audit.query?.destPort})
                  </div>
                  {audit.lastRunDetails && (
                    <p className="text-[10.5px] font-semibold text-slate-600 mt-1.5 truncate">
                      {audit.lastRunDetails}
                    </p>
                  )}
                </div>
                {canEdit && (
                  <button
                    onClick={async () => {
                      const ok = await dialog.confirm(`Delete audit "${audit.name}"?`, { title: 'Delete audit', tone: 'danger', confirmLabel: 'Delete' });
                      if (ok) void onDeleteAudit(audit.id);
                    }}
                    className="text-rose-400 hover:text-rose-600 p-1.5 hover:bg-rose-50 rounded transition shrink-0"
                    title="Delete audit"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
