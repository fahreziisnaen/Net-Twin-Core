import React, { useState, useEffect } from 'react';
import { NetworkNode, PathQuery, SimulationResult, SimulationHop } from '../types';
import { useLang } from '../i18n';
import { Play, ArrowRight, ShieldAlert, ShieldCheck, HelpCircle, RefreshCw, Layers, Radio, Terminal, Settings } from 'lucide-react';

interface PathSimulatorTabProps {
  nodes: NetworkNode[];
  onSimulationRun: (result: SimulationResult) => void;
  activeResult: SimulationResult | null;
  onClear: () => void;
  seedSourceIp?: string | null;   // pre-fill Source IP (e.g. from the IPAM tab)
  onSeedConsumed?: () => void;
}

const PRESET_QUERIES = [
  {
    name: 'Corp PC to Web App (HTTPS)',
    sourceNodeId: 'corp-pc-01',
    sourceVrf: 'CORPORATE',
    sourceIp: '10.200.15.42',
    destIp: '10.100.20.10',
    protocol: 'tcp' as const,
    sourcePort: '51020',
    destPort: '443',
    description: 'Corporate workstation requesting internal production web server over HTTPS.',
  },
  {
    name: 'Corporate work to PCI Database (Block check)',
    sourceNodeId: 'corp-pc-01',
    sourceVrf: 'CORPORATE',
    sourceIp: '10.200.15.42',
    destIp: '192.168.50.10',
    protocol: 'tcp' as const,
    sourcePort: '49220',
    destPort: '5432',
    description: 'Compliance verify: Corporate network must be forbidden from accessing database core.',
  },
  {
    name: 'Prod App Server to PCI Database (Permitted SQL)',
    sourceNodeId: 'core-r1',
    sourceVrf: 'PRODUCTION',
    sourceIp: '10.100.10.15',
    destIp: '192.168.50.10',
    protocol: 'tcp' as const,
    sourcePort: '33054',
    destPort: '5432',
    description: 'Production backend querying PostgreSQL db in PCI zone. Permitted replication flow.',
  },
  {
    name: 'Outside Client to Public Static NAT Web Server',
    sourceNodeId: 'internet',
    sourceVrf: 'default',
    sourceIp: '203.0.113.50',
    destIp: '198.51.100.10',
    protocol: 'tcp' as const,
    sourcePort: '51112',
    destPort: '443',
    description: 'External client accessing static NAT public IP 198.51.100.10. Translates to internal web host.',
  },
  {
    name: 'Prod Host out to Google DNS',
    sourceNodeId: 'prod-web-01',
    sourceVrf: 'PRODUCTION',
    sourceIp: '10.100.20.10',
    destIp: '8.8.8.8',
    protocol: 'tcp' as const,
    sourcePort: '1022',
    destPort: '53',
    description: 'Production server accessing DNS lookup. Outbound traffic translated via PAT on Firewall.',
  },
];

export default function PathSimulatorTab({ nodes, onSimulationRun, activeResult, onClear, seedSourceIp, onSeedConsumed }: PathSimulatorTabProps) {
  const { t } = useLang();
  const [sourceNodeId, setSourceNodeId] = useState('auto');
  const [sourceVrf, setSourceVrf] = useState('');
  const [sourceIp, setSourceIp] = useState('10.200.15.42');
  const [destIp, setDestIp] = useState('10.100.20.10');
  const [protocol, setProtocol] = useState<'tcp' | 'udp' | 'icmp'>('tcp');
  const [sourcePort, setSourcePort] = useState('1024');
  const [destPort, setDestPort] = useState('443');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasAutoDetected, setWasAutoDetected] = useState(false);
  const [bypassPolicies, setBypassPolicies] = useState(false);

  // Picking a Source Device by hand fills in its first VRF and interface IP.
  // Done in the select's handler rather than an effect, so loading a preset
  // (which sets device, VRF and IP together) keeps the preset's own values.
  const handleSourceNodeChange = (nodeId: string) => {
    setSourceNodeId(nodeId);
    if (nodeId === 'auto') {
      setSourceVrf('');
      return;
    }
    const selectedNode = nodes.find(n => n.id === nodeId);
    if (selectedNode && selectedNode.vrfs.length > 0) {
      const defaultVrf = selectedNode.vrfs[0];
      setSourceVrf(defaultVrf.name);
      const defaultInt = defaultVrf.interfaces[0];
      if (defaultInt) {
        // Strip CIDR mask to get plain IP
        setSourceIp(defaultInt.ip.split('/')[0]);
      }
    }
  };

  // Pre-fill the source IP when arriving from another tab (e.g. IPAM's
  // "simulate from this IP"). Auto-detect resolves the owning device.
  useEffect(() => {
    if (!seedSourceIp) return;
    setSourceNodeId('auto');
    setSourceVrf('');
    setSourceIp(seedSourceIp);
    onSeedConsumed?.();
  }, [seedSourceIp]);

  // Load a preset query
  const handleLoadPreset = (preset: typeof PRESET_QUERIES[0]) => {
    // Presets name devices of the reference topology; if that device isn't in
    // this twin, let the server auto-detect the source from the IP instead.
    const known = nodes.some(n => n.id === preset.sourceNodeId);
    setSourceNodeId(known ? preset.sourceNodeId : 'auto');
    setSourceVrf(known ? preset.sourceVrf : '');
    setSourceIp(preset.sourceIp);
    setDestIp(preset.destIp);
    setProtocol(preset.protocol);
    setSourcePort(preset.sourcePort);
    setDestPort(preset.destPort);
    setWasAutoDetected(false);
  };

  // Submit simulation
  const handleSimulate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const isAuto = sourceNodeId === 'auto';
    const queryPayload: PathQuery = {
      sourceNodeId,
      sourceVrf: isAuto ? '' : sourceVrf,
      sourceIp,
      destIp,
      protocol,
      sourcePort,
      destPort,
      bypassPolicies,
    };

    try {
      const res = await fetch('/api/twin/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(queryPayload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Simulation endpoint failed to return valid trace.');
      }

      const result: SimulationResult = await res.json();
      setWasAutoDetected(isAuto);
      onSimulationRun(result);
    } catch (err: any) {
      setError(err.message || 'An error occurred running the digital twin simulation.');
    } finally {
      setLoading(false);
    }
  };

  const selectedNode = nodes.find(n => n.id === sourceNodeId);
  const availableVrfs = selectedNode ? selectedNode.vrfs : [];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
      {/* Simulation Inputs Column */}
      <div className="space-y-6 xl:col-span-1">
        {/* presets panel */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
          <h3 className="font-display font-bold text-slate-800 text-sm mb-3 flex items-center gap-1.5">
            <Radio size={16} className="text-blue-500 animate-pulse" /> Simulation Presets
          </h3>
          <div className="space-y-2">
            {PRESET_QUERIES.map((preset, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleLoadPreset(preset)}
                className="w-full text-left p-2.5 rounded-lg border border-slate-100 hover:border-blue-200 hover:bg-blue-50/40 text-xs transition"
              >
                <div className="font-bold text-slate-700 flex items-center justify-between">
                  <span>{preset.name}</span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {preset.protocol.toUpperCase()} ➔ {preset.destPort}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">{preset.description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Core simulator form */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
          <h3 className="font-display font-bold text-slate-800 text-sm mb-4 flex items-center gap-1.5">
            <Layers size={16} className="text-blue-500" /> Simulate Path Vector
          </h3>

          <form onSubmit={handleSimulate} className="space-y-4 text-xs">
            {/* Source Device Node Selection */}
            <div>
              <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                Source Device
              </label>
              <select
                value={sourceNodeId}
                onChange={e => handleSourceNodeChange(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 font-semibold"
              >
                <option value="auto">🔍 {t('Auto-detect from Source IP (Recommended)')}</option>
                {nodes.map(n => (
                  <option key={n.id} value={n.id}>
                    {n.name} ({n.type})
                  </option>
                ))}
              </select>

              {sourceNodeId === 'auto' && (
                <p className="text-[11px] text-emerald-800 bg-emerald-50/50 border border-emerald-100/60 rounded-lg p-2.5 mt-2 leading-relaxed">
                  <strong>💡 {t('No Source Device needed:')}</strong> {t('You do not need to register/create each host device (PC/Server) in the topology. Just enter any source IP and the digital twin auto-detects the default gateway and simulates its route.')}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Source VRF */}
              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                  Routing Context (VRF)
                </label>
                <select
                  value={sourceVrf}
                  onChange={e => setSourceVrf(e.target.value)}
                  disabled={sourceNodeId === 'auto'}
                  className={`w-full px-3 py-2 border rounded-lg font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    sourceNodeId === 'auto'
                      ? 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed'
                      : 'bg-slate-50 border-slate-200 text-slate-800'
                  }`}
                >
                  {sourceNodeId === 'auto' ? (
                    <option value="">{t('Automatic (Auto)')}</option>
                  ) : (
                    <>
                      {availableVrfs.map(v => (
                        <option key={v.name} value={v.name}>
                          {v.name}
                        </option>
                      ))}
                      {availableVrfs.length === 0 && <option value="default">default</option>}
                    </>
                  )}
                </select>
              </div>

              {/* Source IP Address */}
              <div>
                <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                  Source IP
                </label>
                <input
                  type="text"
                  value={sourceIp}
                  onChange={e => setSourceIp(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm font-semibold"
                  placeholder="e.g. 10.200.15.42"
                  required
                />
              </div>
            </div>

            {/* Destination IP */}
            <div>
              <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                Destination IP Address
              </label>
              <input
                type="text"
                value={destIp}
                onChange={e => setDestIp(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm font-semibold"
                placeholder="e.g. 10.100.20.10"
                required
              />
            </div>

            {/* Protocol */}
            <div>
              <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                IP Protocol
              </label>
              <div className="grid grid-cols-3 gap-2">
                {['tcp', 'udp', 'icmp'].map(p => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setProtocol(p as any)}
                    className={`py-1.5 rounded-lg border font-bold uppercase transition ${
                      protocol === p
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {protocol !== 'icmp' && (
              <div className="grid grid-cols-2 gap-3">
                {/* Source Port */}
                <div>
                  <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                    Source Port
                  </label>
                  <input
                    type="text"
                    value={sourcePort}
                    onChange={e => setSourcePort(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="any"
                  />
                </div>

                {/* Destination Port */}
                <div>
                  <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[10px]">
                    Dest Port
                  </label>
                  <input
                    type="text"
                    value={destPort}
                    onChange={e => setDestPort(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="any"
                  />
                </div>
              </div>
            )}

            {/* Policy Bypass Toggle */}
            <div className="bg-emerald-50/50 border border-emerald-100/60 rounded-xl p-3 flex items-start gap-2.5">
              <input
                type="checkbox"
                id="bypassPolicies"
                checked={bypassPolicies}
                onChange={e => setBypassPolicies(e.target.checked)}
                className="w-4 h-4 text-emerald-600 bg-white border-slate-300 rounded focus:ring-emerald-500 mt-0.5 accent-emerald-600"
              />
              <label htmlFor="bypassPolicies" className="text-[11px] text-emerald-800 font-semibold cursor-pointer select-none leading-relaxed">
                <strong>{t('Bypass Security Policies:')}</strong> {t('Ignore firewall Permit/Deny rules to focus purely on routing & NAT flow.')}
              </label>
            </div>

            {/* Buttons */}
            <div className="pt-3 flex gap-2">
              <button
                type="button"
                onClick={onClear}
                className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-lg transition text-center"
              >
                Reset
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-[2] py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition shadow-sm flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <RefreshCw size={14} className="animate-spin" /> Simulating...
                  </>
                ) : (
                  <>
                    <Play size={14} fill="currentColor" /> Run Hop Trace
                  </>
                )}
              </button>
            </div>
          </form>

          {error && <div className="mt-4 p-2.5 bg-rose-50 border border-rose-100 text-rose-800 rounded-lg text-xs font-semibold">{error}</div>}
        </div>
      </div>

      {/* Simulation Trace Output Column */}
      <div className="xl:col-span-2 space-y-6">
        {activeResult ? (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 flex flex-col h-full min-h-[600px]">
            {/* Header / Verdict Summary */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 border-b border-slate-100">
              <div>
                <h3 className="font-display font-bold text-slate-800 text-lg">Simulation Flow Analysis</h3>
                <div className="flex items-center gap-1.5 text-xs font-mono text-slate-500 mt-1">
                  <span>{activeResult.query.sourceIp}</span>
                  <ArrowRight size={12} className="text-slate-400" />
                  <span>{activeResult.query.destIp}</span>
                  <span className="text-slate-300">•</span>
                  <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[10px] uppercase font-bold">
                    {activeResult.query.protocol.toUpperCase()}
                  </span>
                  {activeResult.query.protocol !== 'icmp' && (
                    <>
                      <span className="text-slate-300">•</span>
                      <span>Port {activeResult.query.destPort}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Status Verdict Badge */}
              <div>
                {activeResult.status === 'SUCCESS' ? (
                  <div className="flex items-center gap-2 px-3.5 py-2 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-800">
                    <ShieldCheck size={18} className="text-emerald-600" />
                    <div>
                      <div className="font-bold text-xs uppercase tracking-wider">Path Permitted</div>
                      <div className="text-[10px] text-emerald-600 font-semibold">Reached destination successfully</div>
                    </div>
                  </div>
                ) : activeResult.status === 'BLOCKED_BY_FIREWALL' ? (
                  <div className="flex items-center gap-2 px-3.5 py-2 bg-rose-50 border border-rose-200 rounded-xl text-rose-800">
                    <ShieldAlert size={18} className="text-rose-600" />
                    <div>
                      <div className="font-bold text-xs uppercase tracking-wider">Blocked by Policy</div>
                      <div className="text-[10px] text-rose-600 font-semibold">Firewall security drop applied</div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-700">
                    <HelpCircle size={18} className="text-slate-500" />
                    <div>
                      <div className="font-bold text-xs uppercase tracking-wider">Routing Drop</div>
                      <div className="text-[10px] text-slate-500 font-semibold">{activeResult.status}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {wasAutoDetected && activeResult.hops.length > 0 && (() => {
              const hasImpliedHost = activeResult.hops[0].nodeId === 'implied-host';
              const gatewayHop = hasImpliedHost ? activeResult.hops[1] : activeResult.hops[0];
              if (!gatewayHop) return null;
              return (
                <div className="mt-4 p-4 bg-emerald-50 border border-emerald-100 rounded-xl flex items-start gap-3 text-emerald-950">
                  <div className="w-7 h-7 rounded-full bg-emerald-100 border border-emerald-200 flex items-center justify-center text-emerald-600 shrink-0 mt-0.5 font-bold text-xs">
                    ✓
                  </div>
                  <div>
                    <h4 className="font-display font-bold text-sm text-emerald-900">{t('Gateway auto-detected!')}</h4>
                    <p className="text-xs text-emerald-700 mt-1 leading-relaxed">
                      {t('Source IP')} <strong>{activeResult.query.sourceIp}</strong> {t('reaches its default gateway')} <strong>{gatewayHop.nodeName}</strong> ({gatewayHop.nodeType}) {t('in VRF context')} <strong>{gatewayHop.ingressVrf || 'default'}</strong>. {t('The route simulation ran from this segment.')}
                    </p>
                  </div>
                </div>
              );
            })()}

            {/* Simulated Packet Headers morph tracker */}
            <div className="my-5 p-3.5 bg-slate-900 rounded-xl border border-slate-800 flex items-center justify-between text-slate-400 text-xs">
              <div className="flex items-center gap-2">
                <Terminal size={14} className="text-blue-400" />
                <span className="font-display font-bold text-slate-200">Active Packet Header State:</span>
              </div>
              <div className="flex items-center gap-4 font-mono text-[11px]">
                <div className="flex flex-col items-end">
                  <span className="text-[9px] uppercase tracking-wider text-slate-500 font-sans font-bold">Source IP</span>
                  <span className="text-slate-100 font-bold">{activeResult.query.sourceIp}</span>
                </div>
                <div className="text-slate-600 font-bold font-sans">➔</div>
                <div className="flex flex-col">
                  <span className="text-[9px] uppercase tracking-wider text-slate-500 font-sans font-bold">Destination IP</span>
                  <span className="text-slate-100 font-bold">
                    {activeResult.hops[activeResult.hops.length - 1]?.decision === 'Reached Destination' || activeResult.status === 'SUCCESS'
                      ? activeResult.hops[activeResult.hops.length - 1]?.routeMatched?.destination.split('/')[0] || activeResult.query.destIp
                      : activeResult.query.destIp}
                  </span>
                </div>
              </div>
            </div>

            {/* Stepper Vertical Timeline */}
            <div className="flex-1 space-y-6 relative before:absolute before:left-6 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-100 pl-1">
              {activeResult.hops.map((hop, index) => {
                const isLast = index === activeResult.hops.length - 1;
                const isBlocked = hop.decision === 'Firewall Deny' || hop.decision === 'Loop Detected';
                const isSuccess = hop.decision === 'Reached Destination';

                return (
                  <div key={index} className="flex gap-4 relative">
                    {/* Timeline dot */}
                    <div
                      className={`w-12 h-12 rounded-full border-4 flex items-center justify-center z-10 transition-all font-display font-bold text-sm ${
                        isBlocked
                          ? 'bg-rose-50 border-rose-200 text-rose-600 shadow-md shadow-rose-100'
                          : isSuccess
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-600 shadow-md shadow-emerald-100'
                          : 'bg-slate-100 border-slate-200 text-slate-600'
                      }`}
                    >
                      {hop.step}
                    </div>

                    {/* Step Card */}
                    <div className="flex-1 bg-slate-50/50 hover:bg-slate-50 border border-slate-150 rounded-xl p-4 transition">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-display font-bold text-slate-800 text-sm">
                            {hop.nodeName}
                          </span>
                          <span className="text-[10px] px-2 py-0.5 bg-slate-200/60 rounded-full font-semibold uppercase tracking-wider text-slate-500">
                            {hop.nodeType}
                          </span>
                        </div>

                        {/* Status Label */}
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                            isBlocked
                              ? 'bg-rose-100 text-rose-700'
                              : isSuccess
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-blue-100 text-blue-700'
                          }`}
                        >
                          {hop.decision}
                        </span>
                      </div>

                      {/* Detailed narrative */}
                      <p className="text-xs text-slate-600 mt-2 font-medium">
                        {hop.details}
                      </p>

                      {/* Context Metadata (VRFs / route matched) */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 pt-3 border-t border-slate-200/50 text-[11px]">
                        <div>
                          <span className="text-slate-400 font-bold uppercase text-[9px] tracking-wider block mb-1">
                            Ingress Details
                          </span>
                          <div className="font-mono space-y-0.5 text-slate-600">
                            <div>VRF: <span className="font-bold text-slate-800">{hop.ingressVrf}</span></div>
                            {hop.ingressInterface && (
                              <div>Interface: <span className="font-bold text-slate-800">{hop.ingressInterface}</span></div>
                            )}
                          </div>
                        </div>

                        {hop.routeMatched && (
                          <div>
                            <span className="text-slate-400 font-bold uppercase text-[9px] tracking-wider block mb-1">
                              LPM Route Decision
                            </span>
                            <div className="font-mono space-y-0.5 text-slate-600">
                              <div>Match: <span className="font-bold text-blue-600">{hop.routeMatched.destination}</span></div>
                              <div>Protocol: <span className="font-semibold text-slate-800">{hop.routeMatched.protocol} (metric {hop.routeMatched.metric})</span></div>
                              {hop.egressInterface && (
                                <div>Egress: <span className="font-semibold text-slate-800">{hop.egressInterface}</span></div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Dynamic NAT Headers Overlay inside Step Card */}
                      {hop.natApplied && (
                        <div className="mt-3 p-2 bg-amber-50/50 border border-amber-100 rounded-lg text-[11px] flex items-center justify-between text-amber-800 font-mono">
                          <div className="flex items-center gap-1">
                            <Settings size={12} className="text-amber-600 animate-spin" />
                            <span className="font-sans font-bold text-[10px] uppercase">NAT Applied:</span>
                          </div>
                          <div>
                            <span className="text-slate-400 text-[10px] mr-1">{hop.natApplied.type}</span>
                            <span className="font-bold">{hop.natApplied.before}</span> ➔ <span className="font-bold text-blue-600">{hop.natApplied.after}</span>
                          </div>
                        </div>
                      )}

                      {/* Firewall policy triggered overlay inside Step Card */}
                      {hop.firewallRuleMatched && (
                        <div className={`mt-3 p-2.5 rounded-lg border text-[11px] font-mono ${
                          hop.firewallRuleMatched.action === 'permit'
                            ? 'bg-emerald-50 border-emerald-100 text-emerald-800'
                            : 'bg-rose-50 border-rose-100 text-rose-800'
                        }`}>
                          <div className="font-bold text-[10px] uppercase tracking-wider flex items-center gap-1 mb-1">
                            <span>Policy Evaluated:</span>
                            <span className="underline">{hop.firewallRuleMatched.name}</span>
                          </div>
                          <p className="text-[10px] text-slate-500 font-sans italic">
                            "{hop.firewallRuleMatched.description}"
                          </p>
                          <div className="mt-1 flex gap-3 text-[10px] text-slate-500">
                            <span>Source: {hop.firewallRuleMatched.sourceIp}</span>
                            <span>Dest: {hop.firewallRuleMatched.destIp}</span>
                            <span>Port: {hop.firewallRuleMatched.destPort}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 flex flex-col items-center justify-center h-full min-h-[500px] text-center">
            <div className="w-16 h-16 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center mb-4">
              <Play size={26} className="text-slate-400 translate-x-0.5" />
            </div>
            <h4 className="font-display font-semibold text-slate-700 text-base">Ready for Simulation</h4>
            <p className="text-xs text-slate-500 mt-1 max-w-[360px] leading-relaxed">
              Define a source and destination above, select custom port flow protocols, or select one of the core presets to trigger the digital twin Hop Engine.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
