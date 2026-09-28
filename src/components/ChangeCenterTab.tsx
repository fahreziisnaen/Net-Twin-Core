import React, { useEffect, useState } from 'react';
import { ChangeRequest, NetworkNode, FirewallRule, ComplianceAudit } from '../types';
import { Plus, CheckCircle, Clock, Play, RefreshCw } from 'lucide-react';

interface ChangeCenterTabProps {
  changeRequests: ChangeRequest[];
  nodes: NetworkNode[];
  audits: ComplianceAudit[];
  canDraft: boolean;   // draft change requests (operator/admin)
  canApply: boolean;   // approve & apply (admin)
  onAddChangeRequest: (cr: ChangeRequest) => Promise<ChangeRequest | null>;
  onApplyChangeRequest: (id: string) => Promise<boolean>;
}

export default function ChangeCenterTab({
  changeRequests,
  nodes,
  audits,
  canDraft,
  canApply,
  onAddChangeRequest,
  onApplyChangeRequest,
}: ChangeCenterTabProps) {
  const [showForm, setShowForm] = useState(false);
  const [activeCrId, setActiveCrId] = useState<string | null>(changeRequests[0]?.id || null);

  const firewalls = nodes.filter(n => n.type === 'firewall');

  // Form states
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [ruleName, setRuleName] = useState('');
  const [targetFwId, setTargetFwId] = useState(firewalls[0]?.id || '');
  const [srcVrf, setSrcVrf] = useState('PRODUCTION');
  const [dstVrf, setDstVrf] = useState('PCI-ZONE');
  const [srcIp, setSrcIp] = useState('10.100.10.0/24');
  const [dstIp, setDstIp] = useState('192.168.50.10/32');
  const [proto, setProto] = useState<'any' | 'tcp' | 'udp' | 'icmp'>('tcp');
  const [dstPort, setDstPort] = useState('5432');
  const [action, setAction] = useState<'permit' | 'deny'>('permit');

  const targetFw = firewalls.find(n => n.id === targetFwId) || firewalls[0];
  const vrfOptions = ['any', ...(targetFw?.vrfs.map(v => v.name) || [])];

  // Zone defaults come from the reference topology; when the chosen firewall
  // doesn't have that zone, fall back to "any" (what the select displays).
  useEffect(() => {
    if (!vrfOptions.includes(srcVrf)) setSrcVrf('any');
    if (!vrfOptions.includes(dstVrf)) setDstVrf('any');
  }, [targetFw?.id, vrfOptions.join('|')]);

  const [submitting, setSubmitting] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  // Active CR lookup
  const activeCr = changeRequests.find(cr => cr.id === activeCrId);

  const selectCr = (cr: ChangeRequest) => {
    setActiveCrId(cr.id);
    setShowForm(false);
  };

  // Submit Draft CR
  const handleSubmitCR = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    const proposedRule: FirewallRule = {
      id: `rule_cr_${Date.now()}`,
      name: ruleName.trim() || 'Custom Policy Change',
      sourceVrf: srcVrf,
      destVrf: dstVrf,
      sourceIp: srcIp.trim(),
      destIp: dstIp.trim(),
      protocol: proto,
      sourcePort: 'any',
      destPort: dstPort.trim() || 'any',
      action,
      description: description.trim(),
    };

    const newCR: ChangeRequest = {
      id: '', // Server assigns ID
      title: title.trim(),
      description: description.trim(),
      requester: '', // Server records the signed-in user
      status: 'draft',
      createdAt: '',
      proposedRules: [proposedRule],
      nodeId: targetFw?.id || '',
    };

    try {
      const savedCr = await onAddChangeRequest(newCR);
      // On failure the error was shown; keep the form and its input.
      if (!savedCr) return;
      setActiveCrId(savedCr.id);
      setShowForm(false);
      // Reset fields
      setTitle('');
      setDescription('');
      setRuleName('');
    } finally {
      setSubmitting(false);
    }
  };

  // Trigger apply to active digital twin topology. The button is disabled while
  // the request runs so a double click can't inject the rules twice.
  const handleApplyToTwin = async (id: string) => {
    if (applyingId) return;
    setApplyingId(id);
    try {
      await onApplyChangeRequest(id);
    } finally {
      setApplyingId(null);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
      {/* Change Requests Side Panel */}
      <div className="xl:col-span-1 space-y-4">
        <div className="flex items-center justify-between px-1">
          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block">
            Change Registry
          </span>
          {canDraft && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="text-xs text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1 transition"
          >
            <Plus size={14} /> New Change
          </button>
          )}
        </div>

        {/* List of CRs */}
        <div className="space-y-2.5">
          {changeRequests.map(cr => {
            const isActive = cr.id === activeCrId;
            return (
              <button
                key={cr.id}
                onClick={() => selectCr(cr)}
                className={`w-full text-left p-4 rounded-xl border transition flex flex-col justify-between ${
                  isActive
                    ? 'bg-slate-900 border-slate-900 text-white shadow-md'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <div className="font-display font-bold text-sm leading-tight">{cr.title}</div>
                <div className="flex items-center justify-between w-full mt-3 pt-2 border-t border-slate-100/10 text-[10px]">
                  <span className={`${isActive ? 'text-slate-400' : 'text-slate-400'}`}>
                    BY {cr.requester}
                  </span>
                  <span className={`px-2 py-0.5 font-bold rounded uppercase flex items-center gap-1 text-[9px] ${
                    cr.status === 'applied'
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : cr.status === 'simulated'
                      ? 'bg-amber-500/20 text-amber-400 animate-pulse'
                      : 'bg-slate-500/20 text-slate-400'
                  }`}>
                    {cr.status === 'applied' ? <CheckCircle size={10} /> : <Clock size={10} />}
                    {cr.status}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main column: draft form or selected change details */}
      <div className="xl:col-span-3 space-y-6">
        {canDraft && showForm ? (
          /* Create New Change Request Form */
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
            <h3 className="font-display font-bold text-slate-800 text-lg border-b border-slate-100 pb-3 mb-4">
              Draft Firewall Security Change Policy
            </h3>
            <form onSubmit={handleSubmitCR} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                    Change Title
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="e.g. Enable Production sync to Cardholder Database"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                    Rule Policy Name
                  </label>
                  <input
                    type="text"
                    value={ruleName}
                    onChange={e => setRuleName(e.target.value)}
                    placeholder="e.g. ALLOW_PROD_SQL_SYNC"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                    Target Firewall
                  </label>
                  <select
                    value={targetFw?.id || ''}
                    onChange={e => setTargetFwId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-semibold focus:outline-none focus:ring-1 focus:ring-blue-500"
                    required
                  >
                    {firewalls.map(fw => (
                      <option key={fw.id} value={fw.id}>{fw.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                  Change Justification / Description
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="Explain why this security exception is required for PCI compliance audits..."
                  rows={2}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <div className="p-4 bg-slate-50 rounded-xl border border-slate-150 space-y-4 font-mono">
                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest font-sans">
                  5-Tuple Firewall Exception Spec
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-slate-500 font-semibold mb-1 text-[9px] font-sans">Source VRF</label>
                    <select
                      value={srcVrf}
                      onChange={e => setSrcVrf(e.target.value)}
                      className="w-full px-2 py-1.5 bg-white border border-slate-250 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {vrfOptions.map(v => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-500 font-semibold mb-1 text-[9px] font-sans">Source IP (CIDR)</label>
                    <input
                      type="text"
                      value={srcIp}
                      onChange={e => setSrcIp(e.target.value)}
                      className="w-full px-2 py-1.5 bg-white border border-slate-250 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 font-semibold mb-1 text-[9px] font-sans">Dest VRF</label>
                    <select
                      value={dstVrf}
                      onChange={e => setDstVrf(e.target.value)}
                      className="w-full px-2 py-1.5 bg-white border border-slate-250 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {vrfOptions.map(v => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-500 font-semibold mb-1 text-[9px] font-sans">Dest IP (CIDR)</label>
                    <input
                      type="text"
                      value={dstIp}
                      onChange={e => setDstIp(e.target.value)}
                      className="w-full px-2 py-1.5 bg-white border border-slate-250 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-slate-500 font-semibold mb-1 text-[9px] font-sans">IP Protocol</label>
                    <select
                      value={proto}
                      onChange={e => setProto(e.target.value as any)}
                      className="w-full px-2 py-1.5 bg-white border border-slate-250 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                      <option value="icmp">ICMP</option>
                      <option value="any">ANY</option>
                    </select>
                  </div>
                  {proto !== 'icmp' && (
                    <div>
                      <label className="block text-slate-500 font-semibold mb-1 text-[9px] font-sans">Dest Port</label>
                      <input
                        type="text"
                        value={dstPort}
                        onChange={e => setDstPort(e.target.value)}
                        className="w-full px-2 py-1.5 bg-white border border-slate-250 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-slate-500 font-semibold mb-1 text-[9px] font-sans font-sans">Policy Action</label>
                    <select
                      value={action}
                      onChange={e => setAction(e.target.value as any)}
                      className="w-full px-2 py-1.5 bg-white border border-slate-250 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 font-sans"
                    >
                      <option value="permit">PERMIT / ACCEPT</option>
                      <option value="deny">DENY / DROP</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || !targetFw}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white font-semibold rounded-lg transition flex items-center gap-1.5"
                >
                  {submitting ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />} Simulate & Submit
                </button>
              </div>
            </form>
          </div>
        ) : activeCr ? (
          /* Selected Change Request Details */
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
              <div>
                <h3 className="font-display font-bold text-slate-800 text-lg">{activeCr.title}</h3>
                <p className="text-xs text-slate-500 mt-1 font-medium">{activeCr.description}</p>
              </div>

              {activeCr.status === 'applied' ? (
                <span className="bg-emerald-50 text-emerald-800 border border-emerald-100 px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5">
                  <CheckCircle size={14} className="text-emerald-500" /> Policy Applied to Twin
                </span>
              ) : canApply ? (
                <button
                  onClick={() => handleApplyToTwin(activeCr.id)}
                  disabled={!!applyingId}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white font-semibold rounded-lg text-xs transition shadow-sm flex items-center gap-1.5 self-start"
                >
                  {applyingId === activeCr.id ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle size={14} />} Approve & Push Rule
                </button>
              ) : (
                <span className="bg-amber-50 text-amber-800 border border-amber-100 px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1.5 self-start" title="Only admins can approve">
                  <Clock size={13} /> Awaiting Admin Approval
                </span>
              )}
            </div>

            {/* Proposed 5-Tuple Policy visual list */}
            <div>
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-3">
                Proposed Rule Configuration Spec
              </span>
              <div className="space-y-2">
                {activeCr.proposedRules.map(rule => (
                  <div key={rule.id} className="p-4 bg-slate-50 border border-slate-150 rounded-xl font-mono text-xs text-slate-700 grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
                    <div className="md:col-span-1.5">
                      <div className="text-[9px] uppercase font-sans text-slate-400 font-bold mb-0.5">Rule Name</div>
                      <div className="font-bold text-slate-800 font-sans">{rule.name}</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase font-sans text-slate-400 font-bold mb-0.5">Source Vector</div>
                      <div className="font-bold">{rule.sourceVrf}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">{rule.sourceIp}</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase font-sans text-slate-400 font-bold mb-0.5">Dest Vector</div>
                      <div className="font-bold text-blue-600">{rule.destVrf}</div>
                      <div className="text-[10px] text-slate-500 mt-0.5">{rule.destIp}</div>
                    </div>
                    <div className="flex justify-between items-center">
                      <div>
                        <div className="text-[9px] uppercase font-sans text-slate-400 font-bold mb-0.5">Protocol/Port</div>
                        <div className="font-bold text-slate-800">{rule.protocol.toUpperCase()} / {rule.destPort}</div>
                      </div>
                      <span className={`text-[10px] px-2.5 py-0.5 font-bold rounded uppercase ${
                        rule.action === 'permit' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                      }`}>
                        {rule.action}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* What-if before/after simulation verdict */}
            {activeCr.simulationResults && (
              <div>
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-3">
                  What-If Impact Analysis (Probe Flow)
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {([
                    { label: 'BEFORE change', status: activeCr.simulationResults.beforeStatus, hops: activeCr.simulationResults.beforeHops },
                    { label: 'AFTER change', status: activeCr.simulationResults.afterStatus, hops: activeCr.simulationResults.afterHops },
                  ]).map(side => (
                    <div
                      key={side.label}
                      className={`p-4 rounded-xl border ${
                        side.status === 'SUCCESS'
                          ? 'bg-emerald-50/60 border-emerald-150'
                          : 'bg-rose-50/60 border-rose-150'
                      }`}
                    >
                      <div className="text-[9px] uppercase font-bold text-slate-400 tracking-wider">{side.label}</div>
                      <div className={`font-display font-bold text-sm mt-1 ${
                        side.status === 'SUCCESS' ? 'text-emerald-700' : 'text-rose-700'
                      }`}>
                        {side.status}
                      </div>
                      <div className="text-[10px] text-slate-500 mt-1 font-mono">
                        {side.hops.length} hops • last: {side.hops[side.hops.length - 1]?.decision || '-'}
                      </div>
                    </div>
                  ))}
                </div>
                {activeCr.simulationResults.beforeStatus !== activeCr.simulationResults.afterStatus && (
                  <p className="text-[11px] text-slate-500 mt-2 italic">
                    This change flips the probe flow result from <strong>{activeCr.simulationResults.beforeStatus}</strong> to <strong>{activeCr.simulationResults.afterStatus}</strong>.
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 text-center">
            <Clock size={40} className="text-slate-300 mx-auto mb-3" />
            <h4 className="font-display font-semibold text-slate-700 text-sm">No Change Requests Selected</h4>
            <p className="text-xs text-slate-500 mt-1">
              Select or draft a custom policy change request from the left registry panel.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
