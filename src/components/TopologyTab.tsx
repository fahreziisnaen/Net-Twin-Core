import React, { useState } from 'react';
import { NetworkNode, NetworkLink, SimulationHop } from '../types';
import { Server, Shield, Network, Laptop, Globe, Check, Info } from 'lucide-react';

interface TopologyTabProps {
  nodes: NetworkNode[];
  links: NetworkLink[];
  activeHops?: SimulationHop[];
  onSelectNode: (nodeId: string) => void;
}

// Predefined visually balanced desktop-first coordinates for our nodes
const NODE_COORDINATES: Record<string, { x: number; y: number }> = {
  'corp-pc-01': { x: 120, y: 120 },
  'pci-db-01': { x: 120, y: 320 },
  'core-r2': { x: 340, y: 120 },
  'core-r1': { x: 340, y: 320 },
  'prod-web-01': { x: 340, y: 480 },
  'edge-fw01': { x: 580, y: 220 },
  'internet': { x: 800, y: 220 },
};

export default function TopologyTab({ nodes, links, activeHops = [], onSelectNode }: TopologyTabProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Helper to retrieve node metadata by ID
  const getNode = (id: string) => nodes.find(n => n.id === id);

  // Helper to get coordinates for any node (with fallback for dynamically added ones)
  const getNodeCoordinates = (nodeId: string) => {
    if (NODE_COORDINATES[nodeId]) {
      return NODE_COORDINATES[nodeId];
    }
    // Generate deterministic coordinate based on name hash
    let hash = 0;
    for (let i = 0; i < nodeId.length; i++) {
      hash = nodeId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const x = 150 + Math.abs(hash % 550);
    const y = 80 + Math.abs((hash >> 8) % 320);
    return { x, y };
  };

  // Parse path links to animate
  const activePathLinks: { source: string; target: string; decision: string }[] = [];
  if (activeHops && activeHops.length > 1) {
    for (let i = 0; i < activeHops.length - 1; i++) {
      const currentHop = activeHops[i];
      const nextHop = activeHops[i + 1];
      if (currentHop.nodeId && nextHop.nodeId && nextHop.nodeId !== 'outside') {
        activePathLinks.push({
          source: currentHop.nodeId,
          target: nextHop.nodeId,
          decision: currentHop.decision,
        });
      }
    }
  }

  // Check if a specific link is part of the active simulated path
  const isLinkActive = (l: NetworkLink) => {
    return activePathLinks.some(
      path =>
        (path.source === l.sourceNodeId && path.target === l.destNodeId) ||
        (path.source === l.destNodeId && path.target === l.sourceNodeId)
    );
  };

  // Render correct Lucide icon for node type
  const renderNodeIcon = (type: string, size = 20) => {
    switch (type) {
      case 'firewall':
        return <Shield size={size} className="text-rose-500" />;
      case 'router':
        return <Network size={size} className="text-blue-500" />;
      case 'host':
        return <Server size={size} className="text-emerald-500" />;
      case 'switch':
        return <Network size={size} className="text-slate-500" />;
      default:
        return <Laptop size={size} className="text-slate-400" />;
    }
  };

  // Clicking a node shows it in the side inspector; the inspector's
  // "Open Full Routing Table" button navigates to the inventory.
  const handleNodeClick = (node: NetworkNode) => {
    setSelectedNodeId(node.id);
  };

  const selectedNode = selectedNodeId ? getNode(selectedNodeId) : null;

  return (
    <div id="topology_view" className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* Topology Map Panel */}
      <div className="lg:col-span-3 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col h-[550px]">
        {/* Panel Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div>
            <h3 className="font-display text-lg font-bold text-slate-800">Global Digital Twin Topology Map</h3>
            <p className="text-xs text-slate-500">
              Interactive structural map of control plane connections. Active pathways glow when paths are simulated.
            </p>
          </div>
          {/* Map Legend */}
          <div className="hidden sm:flex items-center space-x-4 text-xs">
            <span className="flex items-center gap-1.5 font-medium text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500" /> Router
            </span>
            <span className="flex items-center gap-1.5 font-medium text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500" /> Firewall
            </span>
            <span className="flex items-center gap-1.5 font-medium text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Host
            </span>
            {activeHops.length > 0 && (
              <span className="flex items-center gap-1.5 font-semibold text-amber-600 animate-pulse">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500" /> Active Path Flow
              </span>
            )}
          </div>
        </div>

        {/* Interactive SVG Canvas */}
        <div className="flex-1 bg-slate-900 relative overflow-hidden flex items-center justify-center p-4">
          <svg className="w-full h-full max-w-[900px] max-h-[500px]" viewBox="0 0 950 520" fill="none">
            {/* SVG Filter for Outer Glow Effects */}
            <defs>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="6" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
              <filter id="glow-red" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="6" result="blur" />
                <feComponentTransfer>
                  <feFuncA type="linear" slope="0.8" />
                </feComponentTransfer>
                <feMerge>
                  <feMergeNode />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Render Passive Physical Links */}
            {links.map(link => {
              const srcCoord = getNodeCoordinates(link.sourceNodeId);
              const destCoord = getNodeCoordinates(link.destNodeId);
              const isActive = isLinkActive(link);

              return (
                <g key={link.id}>
                  {/* Background link line */}
                  <line
                    x1={srcCoord.x}
                    y1={srcCoord.y}
                    x2={destCoord.x}
                    y2={destCoord.y}
                    stroke={isActive ? '#3b82f6' : '#334155'}
                    strokeWidth={isActive ? '5' : '2'}
                    strokeDasharray={isActive ? 'none' : '4,4'}
                    className="transition-all duration-300"
                  />
                  {/* Glowing layer if active */}
                  {isActive && (
                    <line
                      x1={srcCoord.x}
                      y1={srcCoord.y}
                      x2={destCoord.x}
                      y2={destCoord.y}
                      stroke="#60a5fa"
                      strokeWidth="2"
                      filter="url(#glow)"
                      className="animate-pulse"
                    />
                  )}
                  {/* Interface Labels */}
                  <text
                    x={srcCoord.x + (destCoord.x - srcCoord.x) * 0.2}
                    y={srcCoord.y + (destCoord.y - srcCoord.y) * 0.2 - 6}
                    fill="#94a3b8"
                    fontSize="9"
                    fontFamily="var(--font-mono)"
                    textAnchor="middle"
                  >
                    {link.sourceInterface}
                  </text>
                  <text
                    x={srcCoord.x + (destCoord.x - srcCoord.x) * 0.8}
                    y={srcCoord.y + (destCoord.y - srcCoord.y) * 0.8 - 6}
                    fill="#94a3b8"
                    fontSize="9"
                    fontFamily="var(--font-mono)"
                    textAnchor="middle"
                  >
                    {link.destInterface}
                  </text>
                </g>
              );
            })}

            {/* Render Simulated Animated Packet Pulses if active hops exist */}
            {activeHops.length > 0 &&
              links.map(link => {
                if (!isLinkActive(link)) return null;
                const srcCoord = getNodeCoordinates(link.sourceNodeId);
                const destCoord = getNodeCoordinates(link.destNodeId);

                return (
                  <circle
                    key={`pulse-${link.id}`}
                    r="6"
                    fill="#f59e0b"
                    filter="url(#glow)"
                  >
                    <animateMotion
                      dur="2.5s"
                      repeatCount="indefinite"
                      path={`M ${srcCoord.x} ${srcCoord.y} L ${destCoord.x} ${destCoord.y}`}
                    />
                  </circle>
                );
              })}

            {/* Render Topology Nodes */}
            {nodes.map(node => {
              const coord = getNodeCoordinates(node.id);

              const isSelected = selectedNodeId === node.id;
              const hasActiveHop = activeHops.some(h => h.nodeId === node.id);

              return (
                <g
                  key={node.id}
                  transform={`translate(${coord.x},${coord.y})`}
                  className="cursor-pointer group"
                  onClick={() => handleNodeClick(node)}
                >
                  {/* Outer glow aura */}
                  <circle
                    r="28"
                    fill={node.type === 'firewall' ? '#ef4444' : node.type === 'router' ? '#3b82f6' : '#10b981'}
                    fillOpacity={isSelected ? '0.25' : '0.05'}
                    className="transition-all duration-300 group-hover:fill-opacity-20"
                    stroke={isSelected ? '#f59e0b' : hasActiveHop ? '#f59e0b' : 'transparent'}
                    strokeWidth="2"
                    strokeDasharray={hasActiveHop ? '3,3' : 'none'}
                    filter={isSelected ? 'url(#glow)' : 'none'}
                  />

                  {/* Device Core circle */}
                  <circle
                    r="20"
                    fill="#1e293b"
                    stroke={
                      node.type === 'firewall'
                        ? '#ef4444'
                        : node.type === 'router'
                        ? '#3b82f6'
                        : '#10b981'
                    }
                    strokeWidth="2"
                    className="transition-transform duration-200 group-hover:scale-110"
                  />

                  {/* Icon Wrapper (Centering in SVG) */}
                  <foreignObject x="-10" y="-10" width="20" height="20">
                    <div className="flex items-center justify-center w-full h-full">
                      {node.type === 'firewall' ? (
                        <Shield size={14} className="text-rose-400" />
                      ) : node.type === 'router' ? (
                        <Network size={14} className="text-blue-400" />
                      ) : node.id === 'internet' ? (
                        <Globe size={14} className="text-teal-400" />
                      ) : (
                        <Server size={14} className="text-emerald-400" />
                      )}
                    </div>
                  </foreignObject>

                  {/* Host IP Overlay text inside node boundary */}
                  <text
                    y="36"
                    fill="#f8fafc"
                    fontSize="11"
                    fontWeight="600"
                    fontFamily="var(--font-display)"
                    textAnchor="middle"
                    className="select-none"
                  >
                    {node.name}
                  </text>

                  {/* Tiny interface IP indicator below node name */}
                  <text
                    y="48"
                    fill="#94a3b8"
                    fontSize="8.5"
                    fontFamily="var(--font-mono)"
                    textAnchor="middle"
                    className="select-none"
                  >
                    {node.vrfs[0]?.interfaces[0]?.ip.split('/')[0] || ''}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Info Panel / Side Inspector for Selected Node */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 flex flex-col h-[550px] overflow-hidden">
        {selectedNode ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-3 pb-4 border-b border-slate-100">
              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                {renderNodeIcon(selectedNode.type, 22)}
              </div>
              <div>
                <h4 className="font-display font-bold text-slate-800 text-base">{selectedNode.name}</h4>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`w-2 h-2 rounded-full ${selectedNode.status === 'online' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                  <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
                    {selectedNode.type} • {selectedNode.status}
                  </span>
                </div>
              </div>
            </div>

            {/* Scrollable details */}
            <div className="flex-1 overflow-y-auto mt-4 space-y-4 pr-1">
              {/* VRF Context Definitions */}
              <div>
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-2">
                  L3 Routing Contexts (VRFs)
                </span>
                <div className="space-y-2">
                  {selectedNode.vrfs.map(vrf => (
                    <div key={vrf.name} className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs">
                      <div className="flex items-center justify-between font-bold text-slate-700">
                        <span className="font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                          VRF: {vrf.name}
                        </span>
                        <span className="text-slate-500 font-normal">{vrf.routes.length} routes</span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-1">{vrf.description}</p>

                      {/* Interfaces list inside VRF */}
                      <div className="mt-2 pt-2 border-t border-slate-200/50 space-y-1">
                        <div className="text-[10px] text-slate-400 font-semibold uppercase">Interfaces:</div>
                        {vrf.interfaces.map(i => (
                          <div key={i.name} className="flex justify-between items-center text-[11px] font-mono">
                            <span className="text-slate-600">{i.name}</span>
                            <span className="text-slate-800 font-semibold">{i.ip}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Firewall Policy Rules Brief (if Firewall) */}
              {selectedNode.type === 'firewall' && selectedNode.firewallRules && (
                <div>
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-2">
                    Security Policy Rules ({selectedNode.firewallRules.length})
                  </span>
                  <div className="space-y-1.5 max-h-[160px] overflow-y-auto">
                    {selectedNode.firewallRules.map((rule, idx) => (
                      <div
                        key={rule.id}
                        className={`p-2 rounded border text-xs flex justify-between items-center font-mono ${
                          rule.action === 'permit'
                            ? 'bg-emerald-50/50 border-emerald-100 text-emerald-800'
                            : 'bg-rose-50/50 border-rose-100 text-rose-800'
                        }`}
                      >
                        <div className="truncate pr-2">
                          <div className="font-bold text-[11px] truncate flex items-center gap-1">
                            <span className="font-sans font-normal text-slate-500">#{idx + 1}</span>
                            {rule.name}
                          </div>
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            {rule.sourceVrf} ➔ {rule.destVrf}
                          </div>
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 font-bold rounded uppercase ${
                          rule.action === 'permit' ? 'bg-emerald-100/80 text-emerald-700' : 'bg-rose-100/80 text-rose-700'
                        }`}>
                          {rule.action}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* NAT Mapping Summary */}
              {selectedNode.natMappings && selectedNode.natMappings.length > 0 && (
                <div>
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-widest block mb-2">
                    NAT Mappings ({selectedNode.natMappings.length})
                  </span>
                  <div className="space-y-1.5">
                    {selectedNode.natMappings.map(nat => (
                      <div key={nat.id} className="p-2 bg-amber-50/30 border border-amber-100 rounded text-xs font-mono text-slate-700">
                        <div className="font-semibold text-amber-800 text-[11px]">{nat.type}</div>
                        <div className="flex justify-between items-center text-[10px] mt-1 text-slate-600">
                          <span>Local:</span>
                          <span className="font-bold">{nat.insideLocal}</span>
                        </div>
                        <div className="flex justify-between items-center text-[10px] text-slate-600">
                          <span>Global:</span>
                          <span className="font-bold text-blue-600">{nat.insideGlobal}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="pt-3 mt-3 border-t border-slate-100">
              <button
                onClick={() => onSelectNode(selectedNode.id)}
                className="w-full flex items-center justify-center gap-1.5 py-2 bg-slate-950 hover:bg-slate-900 text-white font-medium rounded-lg text-xs transition"
              >
                <Info size={14} /> Open Full Routing Table
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center p-4">
            <div className="w-12 h-12 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center mb-3">
              <Network size={20} className="text-slate-400" />
            </div>
            <h4 className="font-display font-semibold text-slate-700 text-sm">No Device Inspected</h4>
            <p className="text-xs text-slate-500 mt-1 max-w-[200px]">
              Click on any device node in the global topology map to inspect its running configuration and active VRFs.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
