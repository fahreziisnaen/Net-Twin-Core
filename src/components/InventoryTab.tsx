import React, { useState } from 'react';
import { NetworkNode, NetworkLink, VRF, Route, Interface, NodeType, FirewallRule } from '../types';
import { useLang } from '../i18n';
import { uniqueNodeId } from '../nodeUtils';
import { Plus, Trash2, Search, ArrowRightLeft, Database, HardDrive, CheckCircle2, Sliders, AlertCircle, Cable, Shield, ChevronUp, ChevronDown, Pencil, X, Check } from 'lucide-react';

const EMPTY_RULE_DRAFT = {
  name: '',
  sourceVrf: 'any',
  destVrf: 'any',
  sourceIp: 'any',
  destIp: 'any',
  protocol: 'tcp' as FirewallRule['protocol'],
  sourcePort: 'any',
  destPort: 'any',
  action: 'permit' as FirewallRule['action'],
  description: '',
};

// Ordered first-match policy editor for firewall nodes: add, edit in place,
// delete, and reorder rules (order defines matching priority).
function FirewallRulesPanel({ node, canEdit, onUpdateNode }: { node: NetworkNode; canEdit: boolean; onUpdateNode: (n: NetworkNode) => Promise<boolean> }) {
  const { t } = useLang();
  const rules = node.firewallRules || [];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({ ...EMPTY_RULE_DRAFT });

  const vrfOptions = ['any', ...node.vrfs.map(v => v.name)];

  const commitRules = (next: FirewallRule[]) => onUpdateNode({ ...node, firewallRules: next });

  const moveRule = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target], next[index]];
    commitRules(next);
  };

  const deleteRule = (id: string) => {
    if (!confirm(t('Delete this rule from the policy set?'))) return;
    commitRules(rules.filter(r => r.id !== id));
  };

  const startEdit = (rule: FirewallRule) => {
    setShowAdd(false);
    setEditingId(rule.id);
    setDraft({
      name: rule.name,
      sourceVrf: rule.sourceVrf,
      destVrf: rule.destVrf,
      sourceIp: rule.sourceIp,
      destIp: rule.destIp,
      protocol: rule.protocol,
      sourcePort: rule.sourcePort,
      destPort: rule.destPort,
      action: rule.action,
      description: rule.description,
    });
  };

  const submitDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = editingId
      ? rules.map(r => (r.id === editingId ? { ...r, ...draft } : r))
      : [...rules, { id: `rule_${Date.now()}`, ...draft }];
    // Keep the form open with the user's input if the save was rejected.
    if (!(await commitRules(next))) return;
    setEditingId(null);
    setShowAdd(false);
    setDraft({ ...EMPTY_RULE_DRAFT });
  };

  const cancelDraft = () => {
    setEditingId(null);
    setShowAdd(false);
    setDraft({ ...EMPTY_RULE_DRAFT });
  };

  const draftForm = (
    <form onSubmit={submitDraft} className="p-4 bg-blue-50/40 border border-blue-100 rounded-xl space-y-3 text-xs">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className="block font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">Rule Name</label>
          <input
            type="text" required value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
            className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">Action</label>
          <select
            value={draft.action}
            onChange={e => setDraft({ ...draft, action: e.target.value as FirewallRule['action'] })}
            className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg font-semibold"
          >
            <option value="permit">PERMIT</option>
            <option value="deny">DENY</option>
          </select>
        </div>
        <div>
          <label className="block font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">Protocol</label>
          <select
            value={draft.protocol}
            onChange={e => setDraft({ ...draft, protocol: e.target.value as FirewallRule['protocol'] })}
            className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg font-semibold"
          >
            <option value="any">ANY</option>
            <option value="tcp">TCP</option>
            <option value="udp">UDP</option>
            <option value="icmp">ICMP</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono">
        <div>
          <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">Source Zone (VRF)</label>
          <select value={draft.sourceVrf} onChange={e => setDraft({ ...draft, sourceVrf: e.target.value })}
            className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg font-sans">
            {vrfOptions.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">Source IP (CIDR/any)</label>
          <input type="text" required value={draft.sourceIp} onChange={e => setDraft({ ...draft, sourceIp: e.target.value })}
            className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg" />
        </div>
        <div>
          <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">Dest Zone (VRF)</label>
          <select value={draft.destVrf} onChange={e => setDraft({ ...draft, destVrf: e.target.value })}
            className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg font-sans">
            {vrfOptions.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">Dest IP (CIDR/any)</label>
          <input type="text" required value={draft.destIp} onChange={e => setDraft({ ...draft, destIp: e.target.value })}
            className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg" />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 font-mono">
        <div>
          <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">Source Port</label>
          <input type="text" value={draft.sourcePort} onChange={e => setDraft({ ...draft, sourcePort: e.target.value })}
            placeholder="any / 443 / 1024-65535" className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg" />
        </div>
        <div>
          <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">Dest Port</label>
          <input type="text" value={draft.destPort} onChange={e => setDraft({ ...draft, destPort: e.target.value })}
            placeholder="any / 443 / 80,443" className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg" />
        </div>
        <div className="col-span-2">
          <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">Description</label>
          <input type="text" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })}
            className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg font-sans" />
        </div>
      </div>

      <div className="flex gap-2 justify-end pt-1">
        <button type="button" onClick={cancelDraft}
          className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-lg transition flex items-center gap-1">
          <X size={13} /> {t('Cancel')}
        </button>
        <button type="submit"
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition flex items-center gap-1">
          <Check size={13} /> {editingId ? t('Save Changes') : t('Add Rule')}
        </button>
      </div>
    </form>
  );

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
        <div>
          <h4 className="font-display font-bold text-slate-800 text-sm flex items-center gap-1.5">
            <Shield size={15} className="text-rose-500" /> {t('Security Policy Rules')} ({rules.length})
          </h4>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {t('Evaluated first-match top to bottom — order sets priority. Use the arrows to reorder.')}
          </p>
        </div>
        {canEdit && !showAdd && !editingId && (
          <button
            onClick={() => { setShowAdd(true); setDraft({ ...EMPTY_RULE_DRAFT }); }}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg transition flex items-center gap-1"
          >
            <Plus size={13} /> {t('Add Rule')}
          </button>
        )}
      </div>

      <div className="p-4 space-y-2">
        {rules.map((rule, idx) => (
          <div key={rule.id}>
            {editingId === rule.id ? draftForm : (
              <div className={`p-3 rounded-xl border flex items-center gap-3 text-xs ${
                rule.action === 'permit' ? 'bg-emerald-50/40 border-emerald-100' : 'bg-rose-50/40 border-rose-100'
              }`}>
                {canEdit && (
                <div className="flex flex-col gap-0.5 shrink-0">
                  <button onClick={() => moveRule(idx, -1)} disabled={idx === 0}
                    className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-25" title={t('Raise priority')}>
                    <ChevronUp size={14} />
                  </button>
                  <button onClick={() => moveRule(idx, 1)} disabled={idx === rules.length - 1}
                    className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-25" title={t('Lower priority')}>
                    <ChevronDown size={14} />
                  </button>
                </div>
                )}
                <span className="font-mono text-slate-400 font-bold shrink-0">#{idx + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-800 truncate">{rule.name}</div>
                  <div className="font-mono text-[10px] text-slate-500 truncate">
                    {rule.sourceVrf}[{rule.sourceIp}] ➔ {rule.destVrf}[{rule.destIp}] • {rule.protocol.toUpperCase()} dport {rule.destPort}
                  </div>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase shrink-0 ${
                  rule.action === 'permit' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                }`}>
                  {rule.action}
                </span>
                {canEdit && (
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => startEdit(rule)}
                    className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded transition" title="Edit rule">
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => deleteRule(rule.id)}
                    className="p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded transition" title={t('Delete rule')}>
                    <Trash2 size={13} />
                  </button>
                </div>
                )}
              </div>
            )}
          </div>
        ))}

        {rules.length === 0 && !showAdd && (
          <div className="text-slate-400 text-[11px] italic py-2 text-center">
            {t('No policy rules yet — the firewall forwards all traffic per routing (router behaviour).')}
          </div>
        )}

        {showAdd && draftForm}

        <div className="text-[10px] text-slate-400 font-mono text-center pt-1">
          ⬇ {t('implicit deny all (if enabled in Settings)')}
        </div>
      </div>
    </div>
  );
}

// Handlers resolve to true once the server accepted the change; forms only
// clear on success so a rejected edit doesn't lose the user's input.
interface InventoryTabProps {
  nodes: NetworkNode[];
  links: NetworkLink[];
  canEdit: boolean;
  focusNodeId?: string | null;   // device to open first (e.g. from the topology map)
  onUpdateNode: (node: NetworkNode) => Promise<boolean>;
  onCreateNode: (node: NetworkNode) => Promise<boolean>;
  onDeleteNode: (nodeId: string) => Promise<boolean>;
  onCreateLink: (link: NetworkLink) => Promise<boolean>;
  onDeleteLink: (linkId: string) => Promise<boolean>;
}

export default function InventoryTab({ nodes, links, canEdit, focusNodeId, onUpdateNode, onCreateNode, onDeleteNode, onCreateLink, onDeleteLink }: InventoryTabProps) {
  const { t } = useLang();
  const [selectedNodeId, setSelectedNodeId] = useState<string>(
    (focusNodeId && nodes.some(n => n.id === focusNodeId) ? focusNodeId : nodes[0]?.id) || ''
  );
  const [activeVrfName, setActiveVrfName] = useState<string>('');
  const [routeSearch, setRouteSearch] = useState('');

  // Form states for adding a route
  const [newDest, setNewDest] = useState('');
  const [newNextHop, setNewNextHop] = useState('');
  const [newProto, setNewProto] = useState<'Static' | 'OSPF' | 'BGP'>('Static');
  const [newMetric, setNewMetric] = useState('1');

  // Form states for adding an interface / VRF to the selected device
  const [newIntfName, setNewIntfName] = useState('');
  const [newIntfIp, setNewIntfIp] = useState('');
  const [newIntfVlan, setNewIntfVlan] = useState('');
  const [newVrfName, setNewVrfName] = useState('');

  // Form states for cabling (physical links)
  const [linkLocalIntf, setLinkLocalIntf] = useState('');
  const [linkRemoteNodeId, setLinkRemoteNodeId] = useState('');
  const [linkRemoteIntf, setLinkRemoteIntf] = useState('');

  // Form states for adding a new device
  const [isAddingDevice, setIsAddingDevice] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newDeviceType, setNewDeviceType] = useState<NodeType>('router');
  const [newDeviceStatus, setNewDeviceStatus] = useState<'online' | 'offline'>('online');
  const [newDeviceVrf, setNewDeviceVrf] = useState('default');
  const [newDeviceInterfaceName, setNewDeviceInterfaceName] = useState('GigabitEthernet1');
  const [newDeviceInterfaceIp, setNewDeviceInterfaceIp] = useState('10.50.1.1/24');

  const selectedNode = nodes.find(n => n.id === selectedNodeId);

  // Ensure selectedNodeId remains valid if nodes list changes
  React.useEffect(() => {
    if (nodes.length > 0 && !nodes.some(n => n.id === selectedNodeId)) {
      setSelectedNodeId(nodes[0].id);
    }
  }, [nodes, selectedNodeId]);

  // Switching devices starts on that device's first VRF...
  React.useEffect(() => {
    setActiveVrfName(nodes.find(n => n.id === selectedNodeId)?.vrfs[0]?.name || '');
  }, [selectedNodeId]);

  // ...but edits to the device keep the VRF being worked on, unless it's gone.
  React.useEffect(() => {
    if (selectedNode && !selectedNode.vrfs.some(v => v.name === activeVrfName)) {
      setActiveVrfName(selectedNode.vrfs[0]?.name || '');
    }
  }, [selectedNode, activeVrfName]);

  const handleCreateDeviceSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeviceName.trim()) return;

    // Never reuse an existing id: that would replace the other device.
    const generatedId = uniqueNodeId(newDeviceName, nodes);

    const newDevice: NetworkNode = {
      id: generatedId,
      name: newDeviceName.trim(),
      type: newDeviceType,
      status: newDeviceStatus,
      vrfs: [
        {
          name: newDeviceVrf.trim() || 'default',
          description: `Initial routing context for ${newDeviceName}`,
          interfaces: [
            {
              name: newDeviceInterfaceName.trim() || 'GigabitEthernet1',
              ip: newDeviceInterfaceIp.trim() || '10.50.1.1/24',
              status: 'up',
            }
          ],
          routes: [
            {
              id: `route_init_${Date.now()}`,
              destination: newDeviceInterfaceIp.split('/')[0] + '/' + (newDeviceInterfaceIp.split('/')[1] || '24'),
              nextHop: newDeviceInterfaceName.trim() || 'GigabitEthernet1',
              protocol: 'Connected',
              metric: 0,
              vrf: newDeviceVrf.trim() || 'default'
            }
          ]
        }
      ]
    };

    if (!(await onCreateNode(newDevice))) return;
    setSelectedNodeId(generatedId);

    // Reset Form
    setNewDeviceName('');
    setNewDeviceType('router');
    setNewDeviceStatus('online');
    setNewDeviceVrf('default');
    setNewDeviceInterfaceName('GigabitEthernet1');
    setNewDeviceInterfaceIp('10.50.1.1/24');
    setIsAddingDevice(false);
  };

  const activeVrf = selectedNode?.vrfs.find(v => v.name === activeVrfName);

  // Add route to currently active VRF on selected node
  const handleAddRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode || !activeVrf || !newDest || !newNextHop) return;

    const newRoute: Route = {
      id: `route_${Date.now()}`,
      destination: newDest.trim(),
      nextHop: newNextHop.trim(),
      protocol: newProto,
      metric: parseInt(newMetric, 10) || 1,
      vrf: activeVrf.name,
    };

    const updatedNode = { ...selectedNode };
    updatedNode.vrfs = updatedNode.vrfs.map(v => {
      if (v.name === activeVrfName) {
        return {
          ...v,
          routes: [...v.routes, newRoute],
        };
      }
      return v;
    });

    if (!(await onUpdateNode(updatedNode))) return;

    // Reset Form
    setNewDest('');
    setNewNextHop('');
    setNewProto('Static');
    setNewMetric('1');
  };

  // Add an interface to the active VRF (also injects its connected route,
  // mirroring what a real device does when an L3 interface comes up)
  const handleAddInterface = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode || !activeVrf || !newIntfName.trim() || !newIntfIp.trim()) return;
    if (activeVrf.interfaces.some(i => i.name === newIntfName.trim())) {
      alert(t('Interface "{name}" already exists in this VRF.', { name: newIntfName.trim() }));
      return;
    }

    const ipCidr = newIntfIp.trim();
    const maskLen = ipCidr.split('/')[1];
    const connectedRoute: Route | null = maskLen ? {
      id: `route_conn_${Date.now()}`,
      destination: ipCidr,
      nextHop: newIntfName.trim(),
      protocol: 'Connected',
      metric: 0,
      vrf: activeVrf.name,
    } : null;

    const updatedNode = { ...selectedNode };
    updatedNode.vrfs = updatedNode.vrfs.map(v => {
      if (v.name !== activeVrfName) return v;
      const vlanId = parseInt(newIntfVlan, 10);
      return {
        ...v,
        interfaces: [...v.interfaces, {
          name: newIntfName.trim(),
          ip: ipCidr,
          status: 'up' as const,
          ...(isNaN(vlanId) ? {} : { vlan: vlanId }),
        }],
        routes: connectedRoute ? [...v.routes, connectedRoute] : v.routes,
      };
    });

    if (!(await onUpdateNode(updatedNode))) return;
    setNewIntfName('');
    setNewIntfIp('');
    setNewIntfVlan('');
  };

  // Delete an interface (and its connected route) from the active VRF
  const handleDeleteInterface = (intfName: string) => {
    if (!selectedNode || !activeVrf) return;
    const usedByLink = links.some(l =>
      (l.sourceNodeId === selectedNode.id && l.sourceInterface === intfName) ||
      (l.destNodeId === selectedNode.id && l.destInterface === intfName)
    );
    if (usedByLink) {
      alert(t('This interface still has a cable (link) attached. Remove the link first.'));
      return;
    }
    const intf = activeVrf.interfaces.find(i => i.name === intfName);
    const updatedNode = { ...selectedNode };
    updatedNode.vrfs = updatedNode.vrfs.map(v => {
      if (v.name !== activeVrfName) return v;
      return {
        ...v,
        interfaces: v.interfaces.filter(i => i.name !== intfName),
        routes: v.routes.filter(r => !(r.protocol === 'Connected' && (r.nextHop === intfName || (intf && r.destination === intf.ip)))),
      };
    });
    onUpdateNode(updatedNode);
  };

  // Add an empty VRF context to the selected device
  const handleAddVrf = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newVrfName.trim();
    if (!selectedNode || !name) return;
    if (selectedNode.vrfs.some(v => v.name === name)) {
      alert(t('VRF "{name}" already exists on this device.', { name }));
      return;
    }
    const updatedNode = {
      ...selectedNode,
      vrfs: [...selectedNode.vrfs, { name, description: `Routing context ${name}`, interfaces: [], routes: [] }],
    };
    // Switch to the new VRF only once it exists on the saved node.
    if (!(await onUpdateNode(updatedNode))) return;
    setActiveVrfName(name);
    setNewVrfName('');
  };

  // Create a physical link between the selected device and a remote device
  const handleCreateLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode || !linkLocalIntf || !linkRemoteNodeId || !linkRemoteIntf) return;
    const ok = await onCreateLink({
      id: `link_${Date.now()}`,
      sourceNodeId: selectedNode.id,
      sourceInterface: linkLocalIntf,
      destNodeId: linkRemoteNodeId,
      destInterface: linkRemoteIntf,
    });
    if (!ok) return;
    setLinkLocalIntf('');
    setLinkRemoteNodeId('');
    setLinkRemoteIntf('');
  };

  // Delete route from active VRF
  const handleDeleteRoute = (routeId: string) => {
    if (!selectedNode || !activeVrf) return;

    const updatedNode = { ...selectedNode };
    updatedNode.vrfs = updatedNode.vrfs.map(v => {
      if (v.name === activeVrfName) {
        return {
          ...v,
          routes: v.routes.filter(r => r.id !== routeId),
        };
      }
      return v;
    });

    onUpdateNode(updatedNode);
  };

  // Filter routes based on search query
  const filteredRoutes = activeVrf
    ? activeVrf.routes.filter(
        r =>
          r.destination.includes(routeSearch) ||
          r.nextHop.toLowerCase().includes(routeSearch.toLowerCase()) ||
          r.protocol.toLowerCase().includes(routeSearch.toLowerCase())
      )
    : [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* Devices Sidebar Selector */}
      <div className="lg:col-span-1 space-y-3">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-1 px-1">
          Device Directory
        </span>
        <div className="space-y-2">
          {nodes.map(n => {
            const isSelected = n.id === selectedNodeId;
            return (
              <button
                key={n.id}
                onClick={() => setSelectedNodeId(n.id)}
                className={`w-full text-left p-3.5 rounded-xl border transition flex items-center justify-between ${
                  isSelected
                    ? 'bg-slate-900 border-slate-900 text-white shadow-md'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <div>
                  <div className="font-display font-bold text-sm">{n.name}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className={`w-2 h-2 rounded-full ${n.status === 'online' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${isSelected ? 'text-slate-400' : 'text-slate-500'}`}>
                      {n.type}
                    </span>
                  </div>
                </div>
                <div className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded ${
                  isSelected ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'
                }`}>
                  {n.vrfs.length} VRFs
                </div>
              </button>
            );
          })}
        </div>

        {/* Add New Device Button/Form */}
        {canEdit && (
        <div className="mt-4 pt-4 border-t border-slate-200">
          {!isAddingDevice ? (
            <button
              onClick={() => setIsAddingDevice(true)}
              className="w-full py-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 hover:text-slate-900 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm"
            >
              <Plus size={14} className="text-blue-600 animate-pulse" />
              {t('Add New Device')}
            </button>
          ) : (
            <form onSubmit={handleCreateDeviceSubmit} className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3 shadow-inner">
              <div className="flex items-center justify-between border-b border-slate-200 pb-2 mb-1">
                <span className="font-display font-bold text-xs text-slate-700">{t('New Device')}</span>
                <button
                  type="button"
                  onClick={() => setIsAddingDevice(false)}
                  className="text-slate-400 hover:text-slate-600 text-xs font-semibold px-1"
                >
                  {t('Cancel')}
                </button>
              </div>

              {/* Name */}
              <div>
                <label className="block text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                  {t('Device Name')}
                </label>
                <input
                  type="text"
                  placeholder="e.g. Router-HQ-03"
                  value={newDeviceName}
                  onChange={e => setNewDeviceName(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              {/* Type & Status */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                    {t('Type')}
                  </label>
                  <select
                    value={newDeviceType}
                    onChange={e => setNewDeviceType(e.target.value as NodeType)}
                    className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="router">Router</option>
                    <option value="firewall">Firewall</option>
                    <option value="switch">Switch</option>
                    <option value="host">Host/PC</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                    {t('Status')}
                  </label>
                  <select
                    value={newDeviceStatus}
                    onChange={e => setNewDeviceStatus(e.target.value as any)}
                    className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="online">Online</option>
                    <option value="offline">Offline</option>
                  </select>
                </div>
              </div>

              {/* Initial VRF */}
              <div>
                <label className="block text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                  Initial VRF Context
                </label>
                <input
                  type="text"
                  placeholder="e.g. default"
                  value={newDeviceVrf}
                  onChange={e => setNewDeviceVrf(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              {/* Interface Name */}
              <div>
                <label className="block text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                  Interface Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. GigabitEthernet1"
                  value={newDeviceInterfaceName}
                  onChange={e => setNewDeviceInterfaceName(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              {/* Interface IP */}
              <div>
                <label className="block text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                  Interface IP (CIDR)
                </label>
                <input
                  type="text"
                  placeholder="e.g. 10.50.1.1/24"
                  value={newDeviceInterfaceIp}
                  onChange={e => setNewDeviceInterfaceIp(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </div>

              <button
                type="submit"
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg transition shadow-sm flex items-center justify-center gap-1"
              >
                <Plus size={14} /> {t('Save Device')}
              </button>
            </form>
          )}
        </div>
        )}
      </div>

      {/* Main Configurations & Routing Table Panel */}
      <div className="lg:col-span-3 space-y-6">
        {!selectedNode ? (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-8 text-center text-xs text-slate-500">
            {t('No devices in the twin yet.')} {canEdit && t('Use "Add New Device" to create one, or import a config.')}
          </div>
        ) : (<>
        {/* Device summary & interface mappings card */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
            <div>
              <h3 className="font-display font-bold text-slate-800 text-lg flex items-center gap-2">
                <Database size={18} className="text-blue-500" /> Device Configuration Core: {selectedNode.name}
              </h3>
              <p className="text-xs text-slate-500">
                Manage physical interfaces, routing contexts (VRFs), and routing tables inside the digital twin.
              </p>
            </div>
            
            <div className="flex items-center gap-2.5 self-start sm:self-center">
              <span className="bg-emerald-50 text-emerald-800 border border-emerald-100 px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping" />
                Twin Synchronized: ACTIVE
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(t('Are you sure you want to remove device "{name}" from the digital twin topology?', { name: selectedNode.name }))) {
                      void onDeleteNode(selectedNode.id);
                    }
                  }}
                  className="bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition duration-150"
                  title={t('Remove Device from Twin')}
                >
                  <Trash2 size={13} />
                  {t('Delete Device')}
                </button>
              )}
            </div>
          </div>

          {/* Active VRF context tabs */}
          <div className="mt-5">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-2.5">
              Select Layer 3 VRF Context
            </span>
            <div className="flex flex-wrap gap-2 items-center">
              {selectedNode.vrfs.map(vrf => (
                <button
                  key={vrf.name}
                  onClick={() => setActiveVrfName(vrf.name)}
                  className={`px-3.5 py-1.5 rounded-lg border font-mono text-xs font-semibold transition ${
                    activeVrfName === vrf.name
                      ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
                      : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  VRF: {vrf.name}
                </button>
              ))}
              {canEdit && <form onSubmit={handleAddVrf} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={newVrfName}
                  onChange={e => setNewVrfName(e.target.value)}
                  placeholder={t('New VRF...')}
                  className="px-2.5 py-1.5 bg-white border border-dashed border-slate-300 rounded-lg text-xs font-mono w-28 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="submit"
                  className="p-1.5 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg text-slate-600 transition"
                  title={t('Add VRF')}
                >
                  <Plus size={13} />
                </button>
              </form>}
            </div>
          </div>

          {/* Interfaces inside selected VRF */}
          {activeVrf && (
            <div className="mt-5 p-4 bg-slate-50 rounded-xl border border-slate-150 text-xs">
              <div className="font-bold text-slate-700 uppercase tracking-wider mb-3 text-[10px] flex items-center gap-1.5">
                <HardDrive size={13} className="text-slate-400" /> Layer 3 Interface Configs on VRF "{activeVrf.name}"
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {activeVrf.interfaces.map(face => (
                  <div key={face.name} className="bg-white border border-slate-150 p-3 rounded-lg flex items-center justify-between shadow-sm">
                    <div>
                      <div className="font-mono font-bold text-slate-800 text-[11px]">{face.name}</div>
                      <div className="font-mono font-bold text-blue-600 mt-1">{face.ip}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="bg-emerald-100 text-emerald-800 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase flex items-center gap-1">
                        <span className="w-1 h-1 bg-emerald-500 rounded-full" /> {face.status}
                      </span>
                      {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleDeleteInterface(face.name)}
                        className="text-rose-400 hover:text-rose-600 p-1 hover:bg-rose-50 rounded transition"
                        title={t('Delete interface')}
                      >
                        <Trash2 size={12} />
                      </button>
                      )}
                    </div>
                  </div>
                ))}
                {activeVrf.interfaces.length === 0 && (
                  <div className="text-slate-400 text-[11px] italic py-2">{t('No interfaces in this VRF yet.')}</div>
                )}
              </div>

              {/* Add interface inline form */}
              {canEdit && (
              <form onSubmit={handleAddInterface} className="mt-3 pt-3 border-t border-slate-200/60 flex flex-wrap items-end gap-3">
                <div>
                  <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">
                    {t('New Interface')}
                  </label>
                  <input
                    type="text"
                    value={newIntfName}
                    onChange={e => setNewIntfName(e.target.value)}
                    placeholder="e.g. GigabitEthernet5"
                    className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg font-mono text-xs w-44 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">
                    IP Address (CIDR)
                  </label>
                  <input
                    type="text"
                    value={newIntfIp}
                    onChange={e => setNewIntfIp(e.target.value)}
                    placeholder="e.g. 10.60.1.1/24"
                    className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg font-mono text-xs w-40 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">
                    {t('VLAN (optional)')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="4094"
                    value={newIntfVlan}
                    onChange={e => setNewIntfVlan(e.target.value)}
                    placeholder="e.g. 20"
                    className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg font-mono text-xs w-24 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <button
                  type="submit"
                  className="py-1.5 px-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition text-xs flex items-center gap-1"
                >
                  <Plus size={13} /> Add Interface + Connected Route
                </button>
              </form>
              )}
            </div>
          )}
        </div>

        {/* Firewall policy rule manager (firewall nodes only). Keyed by node so
            an open edit form doesn't carry over to another firewall. */}
        {selectedNode.type === 'firewall' && (
          <FirewallRulesPanel key={selectedNode.id} node={selectedNode} canEdit={canEdit} onUpdateNode={onUpdateNode} />
        )}

        {/* Routing Table core */}
        {activeVrf && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/50">
              <div>
                <h4 className="font-display font-bold text-slate-800 text-sm">
                  Active Routing Information Base (RIB) • VRF: {activeVrf.name}
                </h4>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Longest Prefix Match (LPM) matches routes sequentially. Static/dynamic routing lookup table.
                </p>
              </div>

              {/* Search Bar */}
              <div className="relative">
                <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search routes..."
                  value={routeSearch}
                  onChange={e => setRouteSearch(e.target.value)}
                  className="pl-8 pr-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Routing Table list */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-600">
                <thead className="bg-slate-100/50 text-slate-500 font-bold uppercase text-[9px] border-b border-slate-150">
                  <tr>
                    <th className="py-3 px-6">Destination Prefix</th>
                    <th className="py-3 px-6">Next Hop Gateway</th>
                    <th className="py-3 px-6">Protocol Source</th>
                    <th className="py-3 px-6">Admin / Metric</th>
                    <th className="py-3 px-6 text-right">Operations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-150 font-mono">
                  {filteredRoutes.map(route => {
                    const isConnected = route.protocol === 'Connected';
                    return (
                      <tr key={route.id} className="hover:bg-slate-50/50">
                        <td className="py-3 px-6 font-bold text-slate-800 text-sm">
                          {route.destination}
                        </td>
                        <td className="py-3 px-6">
                          {route.nextHop}
                        </td>
                        <td className="py-3 px-6">
                          <span className={`px-2 py-0.5 rounded font-bold uppercase text-[10px] ${
                            isConnected
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                              : route.protocol === 'Static'
                              ? 'bg-slate-100 text-slate-700 border border-slate-250'
                              : route.protocol === 'OSPF'
                              ? 'bg-blue-50 text-blue-700 border border-blue-100'
                              : 'bg-amber-50 text-amber-700 border border-amber-100'
                          }`}>
                            {route.protocol}
                          </span>
                        </td>
                        <td className="py-3 px-6 font-semibold">
                          {route.metric}
                        </td>
                        <td className="py-3 px-6 text-right font-sans">
                          {isConnected || !canEdit ? (
                            <span className="text-[10px] font-semibold text-slate-400 select-none px-2 py-1">
                              Locked
                            </span>
                          ) : (
                            <button
                              onClick={() => handleDeleteRoute(route.id)}
                              className="text-rose-500 hover:text-rose-700 p-1.5 hover:bg-rose-50 rounded transition"
                              title="Delete Prefix"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredRoutes.length === 0 && (
                    <tr className="font-sans text-slate-400">
                      <td colSpan={5} className="py-8 text-center text-xs">
                        No custom route entries matched the prefix search.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Form to append static route */}
            {canEdit && (
            <div className="p-5 border-t border-slate-150 bg-slate-50/50">
              <h5 className="font-display font-semibold text-slate-700 text-xs mb-3 flex items-center gap-1">
                <Plus size={14} className="text-blue-500" /> Add Static / Dynamic Routing Entry
              </h5>
              <form onSubmit={handleAddRoute} className="grid grid-cols-1 md:grid-cols-4 lg:grid-cols-5 gap-4 items-end text-xs font-mono">
                {/* Destination Subnet CIDR */}
                <div className="md:col-span-2 lg:col-span-1.5">
                  <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">
                    Destination Subnet (CIDR)
                  </label>
                  <input
                    type="text"
                    value={newDest}
                    onChange={e => setNewDest(e.target.value)}
                    placeholder="e.g. 10.50.0.0/16"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                    required
                  />
                </div>

                {/* Next Hop IP or interface name */}
                <div className="md:col-span-2 lg:col-span-1.5">
                  <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">
                    Next Hop IP / Interface
                  </label>
                  <input
                    type="text"
                    value={newNextHop}
                    onChange={e => setNewNextHop(e.target.value)}
                    placeholder="e.g. 10.100.1.2"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 font-bold focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                    required
                  />
                </div>

                {/* Protocol Source selection */}
                <div>
                  <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1 font-sans">
                    Protocol Source
                  </label>
                  <select
                    value={newProto}
                    onChange={e => setNewProto(e.target.value as any)}
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-700 font-sans focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="Static">Static</option>
                    <option value="OSPF">OSPF</option>
                    <option value="BGP">BGP</option>
                  </select>
                </div>

                {/* Administrative Metric */}
                <div>
                  <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1 font-sans">
                    Admin / Metric
                  </label>
                  <input
                    type="number"
                    value={newMetric}
                    onChange={e => setNewMetric(e.target.value)}
                    min="1"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </div>

                {/* Submit button */}
                <div className="md:col-span-4 lg:col-span-1">
                  <button
                    type="submit"
                    className="w-full py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold font-sans rounded-lg transition shadow-sm flex items-center justify-center gap-1.5"
                  >
                    <Plus size={14} /> Inject Route
                  </button>
                </div>
              </form>
            </div>
            )}
          </div>
        )}

        {/* Physical Links (cabling) panel */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
            <h4 className="font-display font-bold text-slate-800 text-sm flex items-center gap-1.5">
              <Cable size={15} className="text-blue-500" /> Physical Links on {selectedNode.name}
            </h4>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {t('Physical cables determine which neighbor each egress interface reaches during hop-by-hop simulation.')}
            </p>
          </div>

          <div className="p-5 space-y-2">
            {links.filter(l => l.sourceNodeId === selectedNode.id || l.destNodeId === selectedNode.id).map(link => {
              const isSource = link.sourceNodeId === selectedNode.id;
              const localIntf = isSource ? link.sourceInterface : link.destInterface;
              const remoteId = isSource ? link.destNodeId : link.sourceNodeId;
              const remoteIntf = isSource ? link.destInterface : link.sourceInterface;
              const remoteName = nodes.find(n => n.id === remoteId)?.name || remoteId;
              return (
                <div key={link.id} className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-150 rounded-lg font-mono text-xs">
                  <div className="flex items-center gap-2 text-slate-700">
                    <span className="font-bold">{localIntf}</span>
                    <ArrowRightLeft size={12} className="text-slate-400" />
                    <span className="font-bold text-blue-600">{remoteName}</span>
                    <span className="text-slate-500">({remoteIntf})</span>
                  </div>
                  {canEdit && (
                    <button
                      onClick={() => { void onDeleteLink(link.id); }}
                      className="text-rose-500 hover:text-rose-700 p-1.5 hover:bg-rose-50 rounded transition"
                      title={t('Disconnect link')}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              );
            })}
            {links.filter(l => l.sourceNodeId === selectedNode.id || l.destNodeId === selectedNode.id).length === 0 && (
              <div className="text-slate-400 text-[11px] italic">{t('This device is not connected to any other device yet.')}</div>
            )}
          </div>

          {canEdit && (
            <form onSubmit={handleCreateLinkSubmit} className="p-5 border-t border-slate-150 bg-slate-50/50 grid grid-cols-1 md:grid-cols-4 gap-3 items-end text-xs">
              <div>
                <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">
                  Local Interface
                </label>
                <select
                  value={linkLocalIntf}
                  onChange={e => setLinkLocalIntf(e.target.value)}
                  className="w-full px-2.5 py-2 bg-white border border-slate-200 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                >
                  <option value="">{t('Choose interface...')}</option>
                  {selectedNode.vrfs.flatMap(v => v.interfaces.map(i => ({ vrf: v.name, ...i }))).map(i => (
                    <option key={`${i.vrf}/${i.name}`} value={i.name}>{i.name} ({i.ip})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">
                  Remote Device
                </label>
                <select
                  value={linkRemoteNodeId}
                  onChange={e => { setLinkRemoteNodeId(e.target.value); setLinkRemoteIntf(''); }}
                  className="w-full px-2.5 py-2 bg-white border border-slate-200 rounded-lg font-sans font-semibold focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                >
                  <option value="">{t('Choose device...')}</option>
                  {nodes.filter(n => n.id !== selectedNode.id).map(n => (
                    <option key={n.id} value={n.id}>{n.name} ({n.type})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-sans font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">
                  Remote Interface
                </label>
                <select
                  value={linkRemoteIntf}
                  onChange={e => setLinkRemoteIntf(e.target.value)}
                  className="w-full px-2.5 py-2 bg-white border border-slate-200 rounded-lg font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                  disabled={!linkRemoteNodeId}
                >
                  <option value="">{t('Choose interface...')}</option>
                  {(nodes.find(n => n.id === linkRemoteNodeId)?.vrfs || []).flatMap(v => v.interfaces.map(i => ({ vrf: v.name, ...i }))).map(i => (
                    <option key={`${i.vrf}/${i.name}`} value={i.name}>{i.name} ({i.ip})</option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                className="py-2 bg-slate-900 hover:bg-slate-800 text-white font-sans font-semibold rounded-lg transition flex items-center justify-center gap-1.5"
              >
                <Cable size={13} /> Connect Link
              </button>
            </form>
          )}
        </div>
        </>)}
      </div>
    </div>
  );
}
