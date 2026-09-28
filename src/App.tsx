import React, { useState, useEffect, useRef } from 'react';
import { NetworkNode, NetworkLink, SimulationResult, ComplianceAudit, ChangeRequest, SimulationSettings } from './types';
import TopologyTab from './components/TopologyTab';
import PathSimulatorTab from './components/PathSimulatorTab';
import InventoryTab from './components/InventoryTab';
import NatTab from './components/NatTab';
import ChangeCenterTab from './components/ChangeCenterTab';
import ComplianceTab from './components/ComplianceTab';
import ImporterTab from './components/ImporterTab';
import IpamTab from './components/IpamTab';
import SshSyncTab from './components/SshSyncTab';
import ParserProfilesTab from './components/ParserProfilesTab';
import SettingsTab from './components/SettingsTab';
import LoginView, { AuthUser } from './components/LoginView';
import ErrorBoundary from './components/ErrorBoundary';
import { canAccess, Action } from './rbac';
import { useLang } from './i18n';
import {
  Shield,
  Network,
  Sliders,
  RefreshCw,
  Layers,
  Radio,
  Terminal,
  FileCode2,
  Settings,
  Activity,
  Award,
  ExternalLink,
  Laptop,
  LogOut,
  UserCircle2,
  Cpu
} from 'lucide-react';

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export default function App() {
  const [nodes, setNodes] = useState<NetworkNode[]>([]);
  const [links, setLinks] = useState<NetworkLink[]>([]);
  const [audits, setAudits] = useState<ComplianceAudit[]>([]);
  const [changeRequests, setChangeRequests] = useState<ChangeRequest[]>([]);
  const [activeTab, setActiveTab] = useState<'simulator' | 'topology' | 'inventory' | 'ipam' | 'nat' | 'changes' | 'compliance' | 'importer' | 'ssh' | 'parsers' | 'settings'>('simulator');
  const [simulatorSeedIp, setSimulatorSeedIp] = useState<string | null>(null);
  const [inventoryFocusId, setInventoryFocusId] = useState<string | null>(null);
  const [activeSimulationResult, setActiveSimulationResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const { t, lang, setLang } = useLang();

  const can = (action: Action) => !!currentUser && canAccess(currentUser.role, action);

  // Re-read the signed-in user: the server applies role changes immediately,
  // so the UI's gating follows along.
  const refreshMe = async () => {
    try {
      const res = await fetch('/api/auth/me');
      if (res.ok) setCurrentUser((await res.json()).user);
      else if (res.status === 401) setCurrentUser(null);
    } catch { /* server unreachable: keep the current session view */ }
  };

  // Runs a mutating API call and returns the parsed body, or null on failure.
  // A failure is shown to the user once (401 is handled by the session guard),
  // so callers only clear forms / show success when the change was saved.
  const mutate = async (input: string, init: RequestInit): Promise<any | null> => {
    let res: Response;
    try {
      res = await fetch(input, init);
    } catch {
      alert(t('Cannot reach the server. Check your connection and try again.'));
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    if (res.status === 401) return null;
    if (res.status === 403) {
      void refreshMe();
      alert(data.error || t('Access denied: your role does not have permission for this action.'));
    } else {
      alert(data.error || t('Request failed (HTTP {status}).', { status: res.status }));
    }
    // Someone else changed the device meanwhile: show them the current version.
    if (res.status === 409 && data.stale) await fetchTopology();
    return null;
  };

  // Global session guard: any 401 from a protected /api call (including those
  // made directly by child tabs) returns the whole app to the login screen.
  useEffect(() => {
    const orig = window.fetch;
    window.fetch = async (...args: Parameters<typeof window.fetch>) => {
      const res = await orig(...args);
      try {
        const raw = args[0];
        const url = typeof raw === 'string' ? raw : raw instanceof Request ? raw.url : String(raw);
        if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
          setCurrentUser(null);
        }
      } catch { /* ignore */ }
      return res;
    };
    return () => { window.fetch = orig; };
  }, []);

  // Fetch initial digital twin configuration
  const fetchTopology = async () => {
    try {
      const res = await fetch('/api/twin/topology');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.nodes)) setNodes(data.nodes);
      if (Array.isArray(data.links)) setLinks(data.links);
    } catch (err) {
      console.error('Error fetching digital twin topology:', err);
    }
  };

  const fetchAudits = async () => {
    try {
      const res = await fetch('/api/twin/audits');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setAudits(data);
    } catch (err) {
      console.error('Error fetching audits:', err);
    }
  };

  const fetchChangeRequests = async () => {
    try {
      const res = await fetch('/api/twin/changes');
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setChangeRequests(data);
    } catch (err) {
      console.error('Error fetching change requests:', err);
    }
  };

  const refreshAll = () => Promise.all([fetchTopology(), fetchAudits(), fetchChangeRequests()]);

  const initData = async () => {
    setLoading(true);
    await refreshAll();
    setLoading(false);
  };

  // Pick up role changes made by an admin while this tab was in the background.
  useEffect(() => {
    if (!currentUser) return;
    const onFocus = () => { void refreshMe(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [currentUser?.id]);

  // Session check on mount: only load twin data once authenticated
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          setCurrentUser(data.user);
          await initData();
        }
      } catch (err) {
        console.error('Auth check failed:', err);
      } finally {
        setAuthChecked(true);
        setLoading(false);
      }
    })();
  }, []);

  const handleLogin = async (user: AuthUser) => {
    setCurrentUser(user);
    await initData();
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      console.error('Logout failed:', err);
    }
    setCurrentUser(null);
    setActiveSimulationResult(null);
  };

  // Save a node; the server's copy (with its new revision) replaces ours.
  // While a save for a node is in flight, further edits to it are ignored: they
  // were computed from the pre-save copy and would only be refused as stale.
  const savingNodeIds = useRef(new Set<string>());
  const handleUpdateNode = async (updatedNode: NetworkNode): Promise<boolean> => {
    if (savingNodeIds.current.has(updatedNode.id)) return false;
    savingNodeIds.current.add(updatedNode.id);
    try {
      const data = await mutate(`/api/twin/nodes/${encodeURIComponent(updatedNode.id)}`, jsonInit('PUT', updatedNode));
      if (!data?.node) return false;
      setNodes(prev => prev.map(n => (n.id === data.node.id ? data.node : n)));
      return true;
    } finally {
      savingNodeIds.current.delete(updatedNode.id);
    }
  };

  // Create a new node in the digital twin topology
  const handleCreateNode = async (newNode: NetworkNode): Promise<boolean> => {
    if (!(await mutate('/api/twin/nodes', jsonInit('POST', newNode)))) return false;
    await fetchTopology();
    return true;
  };

  // Delete a node from the digital twin topology
  const handleDeleteNode = async (nodeId: string): Promise<boolean> => {
    if (!(await mutate(`/api/twin/nodes/${encodeURIComponent(nodeId)}`, { method: 'DELETE' }))) return false;
    await fetchTopology();
    return true;
  };

  // Create a physical link (cable) between two device interfaces
  const handleCreateLink = async (link: NetworkLink): Promise<boolean> => {
    if (!(await mutate('/api/twin/links', jsonInit('POST', link)))) return false;
    await fetchTopology();
    return true;
  };

  // Remove a physical link from the topology
  const handleDeleteLink = async (linkId: string): Promise<boolean> => {
    if (!(await mutate(`/api/twin/links/${encodeURIComponent(linkId)}`, { method: 'DELETE' }))) return false;
    await fetchTopology();
    return true;
  };

  // Delete a compliance audit rule
  const handleDeleteAudit = async (auditId: string): Promise<boolean> => {
    if (!(await mutate(`/api/twin/audits/${encodeURIComponent(auditId)}`, { method: 'DELETE' }))) return false;
    await fetchAudits();
    return true;
  };

  // Run compliance suite audit tests
  const handleRunAudits = async () => {
    const data = await mutate('/api/twin/audits/run', { method: 'POST' });
    if (Array.isArray(data)) setAudits(data);
  };

  // Add custom compliance audit rule
  const handleAddAudit = async (newAudit: ComplianceAudit): Promise<boolean> => {
    if (!(await mutate('/api/twin/audits', jsonInit('POST', newAudit)))) return false;
    await fetchAudits();
    return true;
  };

  // Add custom security change request
  const handleAddChangeRequest = async (newCr: ChangeRequest): Promise<ChangeRequest | null> => {
    const data = await mutate('/api/twin/changes', jsonInit('POST', newCr));
    if (!data?.changeRequest) return null;
    await fetchChangeRequests();
    return data.changeRequest;
  };

  // Apply change request rules to Live Digital Twin
  const handleApplyChangeRequest = async (id: string): Promise<boolean> => {
    const ok = !!(await mutate(`/api/twin/changes/${encodeURIComponent(id)}/apply`, { method: 'POST' }));
    // Refresh either way: a 409 means it was already applied elsewhere.
    await Promise.all([fetchTopology(), fetchChangeRequests(), fetchAudits()]);
    return ok;
  };

  // Reset the twin back to the certified seed state on the server, then refetch
  // (without the full-screen loader, so the Settings tab can show its message).
  const handleResetTopology = async (): Promise<boolean> => {
    if (!(await mutate('/api/twin/reset', { method: 'POST' }))) return false;
    setActiveSimulationResult(null);
    await refreshAll();
    return true;
  };

  // Navigation groups (label = English key, translated at render)
  const primaryTabs = [
    { id: 'simulator', label: 'Path Simulator', icon: <Layers size={16} /> },
    { id: 'topology', label: 'Global Topology', icon: <Network size={16} /> },
    { id: 'compliance', label: 'Compliance Auditor', icon: <Award size={16} /> },
    { id: 'changes', label: 'Change Request Center', icon: <Shield size={16} /> },
  ];
  const secondaryTabs = [
    { id: 'inventory', label: 'Devices & VRF Inventory', icon: <Terminal size={16} /> },
    { id: 'ipam', label: 'IP Allocation (IPAM)', icon: <Network size={16} /> },
    { id: 'nat', label: 'NAT Terminologies', icon: <Sliders size={16} /> },
    { id: 'importer', label: 'Config Importer', icon: <FileCode2 size={16} /> },
    { id: 'ssh', label: 'SSH Sync', icon: <Radio size={16} /> },
    { id: 'parsers', label: 'Parser Profiles', icon: <Cpu size={16} /> },
    { id: 'settings', label: 'Simulator Settings', icon: <Settings size={16} /> },
  ];
  const activeLabel = [...primaryTabs, ...secondaryTabs].find(x => x.id === activeTab)?.label || '';

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-4 text-slate-300">
        <RefreshCw size={40} className="text-blue-500 animate-spin" />
        <h2 className="font-display font-bold text-lg text-white">{t('Checking session...')}</h2>
      </div>
    );
  }

  if (!currentUser) {
    return <LoginView onLogin={handleLogin} />;
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center gap-4 text-slate-300">
        <RefreshCw size={40} className="text-blue-500 animate-spin" />
        <h2 className="font-display font-bold text-lg text-white">{t('Initializing NetTwin Core...')}</h2>
        <p className="text-xs text-slate-500 font-mono">{t('Synchronizing digital twin control plane states')}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-slate-50 text-slate-900 font-sans">
      
      {/* 1. Flat, high-density, 'Dark/Technical' aesthetic sidebar */}
      <aside className="w-full lg:w-72 bg-[#0f172a] text-slate-300 flex flex-col border-r border-slate-800 shrink-0">
        {/* Brand Banner */}
        <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-md shadow-blue-500/20">
              <Network size={18} />
            </div>
            <div>
              <h1 className="font-display font-bold text-base text-white tracking-tight">NetTwin Core</h1>
              <p className="text-[10px] text-slate-500 font-mono tracking-wider uppercase font-bold mt-0.5">{t('Control Plane Twin')}</p>
            </div>
          </div>
          <Activity size={14} className="text-emerald-500 animate-pulse" />
        </div>

        {/* Navigation list */}
        <nav className="flex-1 px-4 py-6 space-y-1.5 overflow-y-auto">
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block mb-2 px-2">
            {t('Simulate & Analyze')}
          </span>
          {primaryTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id as any); setInventoryFocusId(null); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-semibold transition ${
                activeTab === tab.id
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-500/10'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              {tab.icon}
              {t(tab.label)}
            </button>
          ))}

          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest block pt-5 mb-2 px-2">
            {t('Configure & Synchronize')}
          </span>
          {secondaryTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => { setActiveTab(tab.id as any); setInventoryFocusId(null); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-semibold transition ${
                activeTab === tab.id
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-500/10'
                  : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
              }`}
            >
              {tab.icon}
              {t(tab.label)}
            </button>
          ))}
        </nav>

        {/* Footer info card */}
        <div className="p-4 border-t border-slate-800 bg-[#090d16] text-[11px] space-y-2.5 text-slate-500">
          {/* Language switcher */}
          <div className="flex items-center justify-between gap-2">
            <span className="uppercase tracking-wider text-[9px] font-bold">{t('Language')}</span>
            <div className="flex gap-1">
              {(['en', 'id'] as const).map(l => (
                <button
                  key={l}
                  onClick={() => setLang(l)}
                  className={`px-2 py-0.5 rounded font-bold uppercase text-[9px] tracking-wider transition ${
                    lang === l ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
            <div className="flex items-center gap-2 min-w-0">
              <UserCircle2 size={18} className="text-blue-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-slate-200 font-semibold truncate">{currentUser.username}</div>
                <div className="text-[9px] uppercase tracking-wider font-bold text-slate-500">{currentUser.role}</div>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded-lg transition shrink-0"
              title={t('Logout')}
            >
              <LogOut size={14} />
            </button>
          </div>
          <div className="flex justify-between items-center">
            <span>{t('Control Plane Status:')}</span>
            <span className="text-emerald-400 font-semibold uppercase tracking-wider text-[9px] flex items-center gap-1">
              <span className="w-1 h-1 rounded-full bg-emerald-400 animate-ping" /> {t('Online')}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span>{t('Devices Synchronized:')}</span>
            <span className="font-mono text-slate-400">{t('{count} nodes', { count: nodes.length })}</span>
          </div>
        </div>
      </aside>

      {/* 2. Clean 'Surface' white/gray for the content area */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-50/50">
        
        {/* Top Navigation Bar with active context */}
        <header className="h-16 border-b border-slate-200 bg-white px-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-display font-bold text-slate-800 text-lg uppercase tracking-wide">
              {t(activeLabel)}
            </h2>
            <span className="text-slate-300">|</span>
            <span className="text-xs text-slate-500 font-medium">{t('Digital Twin Console')}</span>
          </div>

          <div className="flex items-center gap-4 text-xs font-semibold text-slate-500">
            <span className="bg-slate-100 text-slate-700 px-3 py-1 rounded-full border border-slate-200 font-mono">
              {window.location.host}
            </span>
            <span className="bg-blue-50 text-blue-800 px-3 py-1 rounded-full border border-blue-100 font-mono flex items-center gap-1">
              <Laptop size={12} /> {currentUser.role.toUpperCase()}
            </span>
          </div>
        </header>

        {/* Core Tab Canvas Wrapper */}
        <div className="flex-1 p-8 overflow-y-auto">
          <ErrorBoundary
            key={activeTab}
            title={t('This view hit an unexpected error.')}
            hint={t('The rest of the app still works. Try again, or switch to another menu.')}
            retryLabel={t('Try again')}
          >
          {activeTab === 'simulator' && (
            <PathSimulatorTab
              nodes={nodes}
              seedSourceIp={simulatorSeedIp}
              onSeedConsumed={() => setSimulatorSeedIp(null)}
              onSimulationRun={result => {
                setActiveSimulationResult(result);
              }}
              activeResult={activeSimulationResult}
              onClear={() => {
                setActiveSimulationResult(null);
              }}
            />
          )}

          {activeTab === 'ipam' && (
            <IpamTab
              nodes={nodes}
              canEdit={canAccess(currentUser.role, 'mutate-twin')}
              onSimulateFrom={ip => {
                setSimulatorSeedIp(ip);
                setActiveTab('simulator');
              }}
            />
          )}

          {activeTab === 'topology' && (
            <TopologyTab
              nodes={nodes}
              links={links}
              activeHops={activeSimulationResult?.hops}
              onSelectNode={nodeId => {
                // "Open Full Routing Table": show that device in the inventory
                setInventoryFocusId(nodeId);
                setActiveTab('inventory');
              }}
            />
          )}

          {activeTab === 'inventory' && (
            <InventoryTab
              nodes={nodes}
              links={links}
              canEdit={can('mutate-twin')}
              focusNodeId={inventoryFocusId}
              onUpdateNode={handleUpdateNode}
              onCreateNode={handleCreateNode}
              onDeleteNode={handleDeleteNode}
              onCreateLink={handleCreateLink}
              onDeleteLink={handleDeleteLink}
            />
          )}

          {activeTab === 'nat' && (
            <NatTab
              nodes={nodes}
              canEdit={can('mutate-twin')}
              onUpdateNode={handleUpdateNode}
            />
          )}

          {activeTab === 'changes' && (
            <ChangeCenterTab
              changeRequests={changeRequests}
              nodes={nodes}
              audits={audits}
              canDraft={can('mutate-twin')}
              canApply={can('apply-change')}
              onAddChangeRequest={handleAddChangeRequest}
              onApplyChangeRequest={handleApplyChangeRequest}
            />
          )}

          {activeTab === 'compliance' && (
            <ComplianceTab
              audits={audits}
              nodes={nodes}
              canEdit={can('mutate-twin')}
              onRunAudits={handleRunAudits}
              onAddAudit={handleAddAudit}
              onDeleteAudit={handleDeleteAudit}
            />
          )}

          {activeTab === 'importer' && (
            <ImporterTab
              nodes={nodes}
              canEdit={can('mutate-twin')}
              onUpdateNode={handleUpdateNode}
              onCreateNode={handleCreateNode}
            />
          )}

          {activeTab === 'ssh' && (
            <SshSyncTab
              nodes={nodes}
              links={links}
              isAdmin={can('manage-settings')}
              onUpdateNode={handleUpdateNode}
              onCreateNode={handleCreateNode}
              onApplied={fetchTopology}
            />
          )}

          {activeTab === 'parsers' && (
            <ParserProfilesTab currentUser={currentUser} />
          )}

          {activeTab === 'settings' && (
            <SettingsTab
              onResetTopology={handleResetTopology}
              currentUser={currentUser}
            />
          )}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
