import React, { useState } from 'react';
import { NetworkNode } from '../types';
import { matchCidr } from '../engine';
import { ArrowRightLeft, Plus, Check, Trash2, Settings, HelpCircle } from 'lucide-react';

interface NatTabProps {
  nodes: NetworkNode[];
  canEdit: boolean;
  onUpdateNode: (node: NetworkNode) => Promise<boolean>;
}

export default function NatTab({ nodes, canEdit, onUpdateNode }: NatTabProps) {
  const firewalls = nodes.filter(n => n.type === 'firewall');
  const [selectedFwId, setSelectedFwId] = useState<string>(firewalls[0]?.id || '');
  const firewallNode = firewalls.find(n => n.id === selectedFwId) || firewalls[0];

  // Form states to add a NAT mapping
  const [natType, setNatType] = useState<'Static NAT' | 'PAT / Dynamic'>('Static NAT');
  const [localIp, setLocalIp] = useState('');
  const [globalIp, setGlobalIp] = useState('');
  const [vrfName, setVrfName] = useState('');

  // Terminology helper state
  const [activeTerm, setActiveTerm] = useState<'local' | 'global' | 'outside'>('local');

  // Header Playground State
  const [testSrcIp, setTestSrcIp] = useState('10.200.15.42');
  const [testDestIp, setTestDestIp] = useState('8.8.8.8');
  const [translatedSrc, setTranslatedSrc] = useState('10.200.15.42');
  const [translatedDst, setTranslatedDst] = useState('8.8.8.8');
  const [isTranslated, setIsTranslated] = useState(false);

  if (!firewallNode) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 text-center">
        <HelpCircle size={40} className="text-slate-300 mx-auto mb-3" />
        <h4 className="font-display font-semibold text-slate-700 text-sm">No Edge Firewall found in Twin</h4>
        <p className="text-xs text-slate-500 mt-1 max-w-[280px] mx-auto">
          Network Address Translation rules require a boundary gateway of type "firewall" to run.
        </p>
      </div>
    );
  }

  const natMappings = firewallNode.natMappings || [];
  const fwVrfNames = firewallNode.vrfs.map(v => v.name);
  // A VRF picked on another firewall doesn't exist here; fall back to this one's first.
  const effectiveVrf = fwVrfNames.includes(vrfName) ? vrfName : fwVrfNames[0] || 'default';

  // Add a NAT mapping (static 1:1 or dynamic PAT) to the selected firewall
  const handleAddNat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localIp || !globalIp) return;

    const newNat = {
      id: `nat_${Date.now()}`,
      type: natType,
      insideLocal: localIp.trim(),
      insideGlobal: globalIp.trim(),
      vrf: effectiveVrf,
    };

    const updatedNode = {
      ...firewallNode,
      natMappings: [...natMappings, newNat],
    };

    if (!(await onUpdateNode(updatedNode))) return;

    // Reset Form
    setLocalIp('');
    setGlobalIp('');
  };

  // Delete dynamic/static NAT
  const handleDeleteNat = (id: string) => {
    const updatedNode = {
      ...firewallNode,
      natMappings: natMappings.filter(n => n.id !== id),
    };
    onUpdateNode(updatedNode);
  };

  // Run header translate playground against the actual configured mappings,
  // mirroring the engine order: static DNAT on destination, then static
  // source NAT / PAT on source.
  const handleTranslatePlayground = () => {
    let finalSrc = testSrcIp.trim();
    let finalDst = testDestIp.trim();

    // Destination NAT (DNAT): public inside-global -> private inside-local
    const staticDnat = natMappings.find(n => n.type === 'Static NAT' && n.insideGlobal === finalDst);
    if (staticDnat) {
      finalDst = staticDnat.insideLocal;
    }

    // Source NAT: static 1:1 first, then PAT whose inside-local scope covers the source
    const staticSnat = natMappings.find(n => n.type === 'Static NAT' && n.insideLocal === finalSrc);
    const patMatch = natMappings.find(n => n.type === 'PAT / Dynamic' && matchCidr(finalSrc, n.insideLocal));
    if (staticSnat) {
      finalSrc = staticSnat.insideGlobal;
    } else if (patMatch) {
      finalSrc = patMatch.insideGlobal;
    }

    setTranslatedSrc(finalSrc);
    setTranslatedDst(finalDst);
    setIsTranslated(true);
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
      {/* Visual Glossary / NAT Explanation */}
      <div className="space-y-6 xl:col-span-1">
        {/* Terminology card */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5">
          <h3 className="font-display font-bold text-slate-800 text-sm mb-3 flex items-center gap-1.5">
            <Settings size={16} className="text-amber-500 animate-spin" /> Cisco/RFC Terminologies
          </h3>
          <p className="text-xs text-slate-500 mb-4 leading-relaxed">
            NAT categorizes IP headers relative to their physical position on the boundary gateway interface.
          </p>

          <div className="flex gap-1.5 mb-4 border-b border-slate-100 pb-2">
            {['local', 'global', 'outside'].map(term => (
              <button
                key={term}
                onClick={() => setActiveTerm(term as any)}
                className={`text-[10px] uppercase font-bold px-3 py-1 rounded-full transition ${
                  activeTerm === term ? 'bg-slate-900 text-white' : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                }`}
              >
                {term}
              </button>
            ))}
          </div>

          <div className="text-xs space-y-3.5 leading-relaxed">
            {activeTerm === 'local' && (
              <>
                <div>
                  <span className="font-bold text-slate-800 font-mono block">Inside Local IP:</span>
                  <span className="text-slate-500 mt-0.5 block">
                    The private IP address assigned to an internal server or host on your LAN (e.g. <code className="bg-slate-100 px-1 py-0.5 rounded font-bold">10.100.20.10</code>). Completely unreachable directly from outside networks.
                  </span>
                </div>
                <div>
                  <span className="font-bold text-slate-800 font-mono block">Outside Local IP:</span>
                  <span className="text-slate-500 mt-0.5 block">
                    The IP address of an external internet destination as known and registered by hosts on the internal LAN.
                  </span>
                </div>
              </>
            )}

            {activeTerm === 'global' && (
              <>
                <div>
                  <span className="font-bold text-slate-800 font-mono block">Inside Global IP:</span>
                  <span className="text-slate-500 mt-0.5 block">
                    The publicly routable IP address registered to represent your internal LAN hosts to the outside world (e.g. <code className="bg-slate-100 px-1 py-0.5 rounded font-bold">198.51.100.10</code>). This is translated from Inside Local.
                  </span>
                </div>
                <div>
                  <span className="font-bold text-slate-800 font-mono block">Outside Global IP:</span>
                  <span className="text-slate-500 mt-0.5 block">
                    The physical, legitimate IP address of the destination host on the public internet (e.g. Google DNS <code className="bg-slate-100 px-1 py-0.5 rounded font-bold">8.8.8.8</code>).
                  </span>
                </div>
              </>
            )}

            {activeTerm === 'outside' && (
              <div>
                <span className="font-bold text-slate-800 font-mono block">How translation flows:</span>
                <span className="text-slate-500 block mt-1">
                  1. **Outbound Packet (Source NAT/PAT)**: Translates source IP header: <code className="bg-slate-100 px-1 font-semibold text-rose-600">Inside Local ➔ Inside Global</code>.
                </span>
                <span className="text-slate-500 block mt-1">
                  2. **Inbound Packet (Static DNAT)**: Translates destination IP header: <code className="bg-slate-100 px-1 font-semibold text-emerald-600">Inside Global ➔ Inside Local</code>.
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Add NAT rule form */}
        {canEdit && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 text-xs">
          <h4 className="font-display font-bold text-slate-800 text-sm mb-3">Add NAT Mapping</h4>
          <form onSubmit={handleAddNat} className="space-y-3 font-mono">
            <div>
              <label className="block font-sans text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">
                Translation Type
              </label>
              <select
                value={natType}
                onChange={e => setNatType(e.target.value as any)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 font-sans focus:outline-none focus:ring-1 focus:ring-blue-500 text-xs"
              >
                <option value="Static NAT">Static NAT (1:1, inbound & outbound)</option>
                <option value="PAT / Dynamic">PAT / Dynamic (many:1 outbound)</option>
              </select>
            </div>

            <div>
              <label className="block font-sans text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">
                {natType === 'Static NAT' ? 'Inside Private IP (Local)' : 'Inside Local Subnet (CIDR)'}
              </label>
              <input
                type="text"
                value={localIp}
                onChange={e => setLocalIp(e.target.value)}
                placeholder={natType === 'Static NAT' ? 'e.g. 10.100.20.15' : 'e.g. 10.200.0.0/16'}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono text-xs"
                required
              />
            </div>

            <div>
              <label className="block font-sans text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">
                Outside Public IP (Global)
              </label>
              <input
                type="text"
                value={globalIp}
                onChange={e => setGlobalIp(e.target.value)}
                placeholder="e.g. 198.51.100.15"
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono text-xs"
                required
              />
            </div>

            <div>
              <label className="block font-sans text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">
                {natType === 'Static NAT' ? 'Inside VRF (real host zone)' : 'Source VRF (inside zone)'}
              </label>
              <select
                value={effectiveVrf}
                onChange={e => setVrfName(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 font-sans focus:outline-none focus:ring-1 focus:ring-blue-500 text-xs"
              >
                {fwVrfNames.map(v => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              className="w-full py-2 bg-slate-900 hover:bg-slate-800 text-white font-sans font-semibold rounded-lg transition text-center"
            >
              Add NAT Rule
            </button>
          </form>
        </div>
        )}
      </div>

      {/* NAT translation table & Interactive Playground */}
      <div className="xl:col-span-2 space-y-6">
        {/* Active Translations Table */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="font-display font-bold text-slate-800 text-sm">Boundary NAT Translation Mappings ({firewallNode.name})</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Defines dynamic Port address translations and static port forwards active on boundary gateways.
              </p>
            </div>
            {firewalls.length > 1 && (
              <select
                value={firewallNode.id}
                onChange={e => setSelectedFwId(e.target.value)}
                className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {firewalls.map(fw => (
                  <option key={fw.id} value={fw.id}>{fw.name}</option>
                ))}
              </select>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-600">
              <thead className="bg-slate-100/30 text-slate-500 font-bold uppercase text-[9px] border-b border-slate-150">
                <tr>
                  <th className="py-3 px-6">Translation Type</th>
                  <th className="py-3 px-6">Inside Local (LAN Private)</th>
                  <th className="py-3 px-6">Inside Global (WAN Public)</th>
                  <th className="py-3 px-6">Dest VRF</th>
                  <th className="py-3 px-6 text-right">Delete</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-150 font-mono">
                {natMappings.map(nat => (
                  <tr key={nat.id} className="hover:bg-slate-50/50">
                    <td className="py-3.5 px-6 font-semibold">
                      <span className={`px-2 py-0.5 rounded font-sans font-bold text-[9px] uppercase ${
                        nat.type === 'Static NAT' ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-amber-50 text-amber-700 border border-amber-100'
                      }`}>
                        {nat.type}
                      </span>
                    </td>
                    <td className="py-3.5 px-6 font-bold text-slate-700">
                      {nat.insideLocal}
                    </td>
                    <td className="py-3.5 px-6 font-bold text-blue-600">
                      {nat.insideGlobal}
                    </td>
                    <td className="py-3.5 px-6 text-slate-500 font-sans font-medium">
                      {nat.vrf}
                    </td>
                    <td className="py-3.5 px-6 text-right">
                      {canEdit && (
                      <button
                        onClick={() => handleDeleteNat(nat.id)}
                        className="text-rose-500 hover:text-rose-700 p-1.5 hover:bg-rose-50 rounded transition"
                        title="Delete NAT mapping"
                      >
                        <Trash2 size={13} />
                      </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Interactive Header Playground */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
          <h3 className="font-display font-bold text-slate-800 text-sm mb-2">Interactive Packet Translation Playground</h3>
          <p className="text-xs text-slate-500 mb-4">
            Test how boundary NAT rules dynamically mutate outbound or inbound IP headers.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-center">
            {/* Input Headers */}
            <div className="md:col-span-2 space-y-3 font-mono text-xs">
              <div>
                <label className="block font-sans text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">
                  Packet Source IP
                </label>
                <input
                  type="text"
                  value={testSrcIp}
                  onChange={e => { setTestSrcIp(e.target.value); setIsTranslated(false); }}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-none"
                />
              </div>

              <div>
                <label className="block font-sans text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">
                  Packet Destination IP
                </label>
                <input
                  type="text"
                  value={testDestIp}
                  onChange={e => { setTestDestIp(e.target.value); setIsTranslated(false); }}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-none"
                />
              </div>
            </div>

            {/* Translate Button */}
            <div className="md:col-span-1 flex justify-center py-2">
              <button
                type="button"
                onClick={handleTranslatePlayground}
                className="p-3 bg-slate-900 hover:bg-slate-800 text-white rounded-full shadow-md transition flex items-center justify-center hover:scale-105"
                title="Translate Packet"
              >
                <ArrowRightLeft size={16} />
              </button>
            </div>

            {/* Output Headers */}
            <div className="md:col-span-2 space-y-3 font-mono text-xs">
              <div>
                <label className="block font-sans text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">
                  Translated Source IP
                </label>
                <div className={`px-3 py-2 rounded-lg font-bold border ${isTranslated ? 'bg-amber-50/50 border-amber-200 text-amber-800' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>
                  {isTranslated ? translatedSrc : 'Click translate...'}
                </div>
              </div>

              <div>
                <label className="block font-sans text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px]">
                  Translated Destination IP
                </label>
                <div className={`px-3 py-2 rounded-lg font-bold border ${isTranslated ? 'bg-amber-50/50 border-amber-200 text-amber-800' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>
                  {isTranslated ? translatedDst : 'Click translate...'}
                </div>
              </div>
            </div>
          </div>

          {isTranslated && (
            <div className="mt-4 p-3 bg-emerald-50 border border-emerald-150 text-emerald-800 rounded-lg text-xs font-medium flex items-center gap-2">
              <Check size={16} className="text-emerald-600" />
              <span>
                Translation evaluated successfully. Headers mapped based on configured boundary digital twin policies.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
