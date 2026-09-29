import React, { useEffect, useMemo, useState } from 'react';
import { NetworkNode, IpReservation } from '../types';
import { enumerateSubnets, computeSubnetUsage, groupByVlan, SubnetInfo, IpUsage } from '../ipam';
import { useLang } from '../i18n';
import { useDialog } from './DialogProvider';
import { Network, Search, Plus, Trash2, CheckCircle2, AlertCircle, Layers, Tag, Play, Server } from 'lucide-react';

interface IpamTabProps {
  nodes: NetworkNode[];
  canEdit: boolean;
  onSimulateFrom?: (ip: string) => void;
}

export default function IpamTab({ nodes, canEdit, onSimulateFrom }: IpamTabProps) {
  const { t } = useLang();
  const dialog = useDialog();
  const [reservations, setReservations] = useState<IpReservation[]>([]);
  const [selectedCidr, setSelectedCidr] = useState<string>('');
  const [groupMode, setGroupMode] = useState<'subnet' | 'vlan'>('subnet');
  const [vrfFilter, setVrfFilter] = useState<string>('all');
  const [ipSearch, setIpSearch] = useState('');
  const [showFree, setShowFree] = useState(true);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [reserveNote, setReserveNote] = useState('');
  const [reserveIp, setReserveIp] = useState('');

  const flash = (kind: 'ok' | 'error', text: string) => { setMsg({ kind, text }); setTimeout(() => setMsg(null), 4000); };

  const loadReservations = async () => {
    try {
      const res = await fetch('/api/twin/ipam/reservations');
      if (res.ok) setReservations(await res.json());
    } catch (err) { console.error('Error loading reservations:', err); }
  };
  useEffect(() => { loadReservations(); }, []);

  const subnets = useMemo(() => enumerateSubnets(nodes, reservations), [nodes, reservations]);
  const vrfs = useMemo(() => ['all', ...new Set(subnets.map(s => s.vrf))], [subnets]);
  const visibleSubnets = useMemo(
    () => subnets.filter(s => vrfFilter === 'all' || s.vrf === vrfFilter),
    [subnets, vrfFilter]
  );

  // Default selection: first subnet
  useEffect(() => {
    if (!selectedCidr && visibleSubnets.length) setSelectedCidr(visibleSubnets[0].cidr);
    if (selectedCidr && !visibleSubnets.some(s => s.cidr === selectedCidr) && visibleSubnets.length) {
      setSelectedCidr(visibleSubnets[0].cidr);
    }
  }, [visibleSubnets, selectedCidr]);

  const usage = useMemo(
    () => (selectedCidr ? computeSubnetUsage(selectedCidr, nodes, reservations) : null),
    [selectedCidr, nodes, reservations]
  );

  const handleReserve = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/twin/ipam/reservations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: reserveIp, note: reserveNote }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Failed to reserve IP'));
      flash('ok', t('{ip} reserved.', { ip: reserveIp }));
      setReserveIp(''); setReserveNote('');
      await loadReservations();
    } catch (err: any) { flash('error', err.message); }
  };

  const handleRelease = async (ip: string) => {
    const r = reservations.find(x => x.ip === ip);
    if (!r) return;
    const ok = await dialog.confirm(t('Release reservation for {ip}?', { ip }), { title: t('Release reservation'), tone: 'danger', confirmLabel: t('Release') });
    if (!ok) return;
    try {
      const res = await fetch(`/api/twin/ipam/reservations/${r.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || t('Failed to release'));
      flash('ok', t('{ip} released.', { ip }));
      await loadReservations();
    } catch (err: any) { flash('error', err.message); }
  };

  const kindStyle = (k: IpUsage['kind']) =>
    k === 'interface' ? 'bg-blue-100 text-blue-700 border-blue-200'
      : k === 'nat' ? 'bg-amber-100 text-amber-700 border-amber-200'
        : 'bg-violet-100 text-violet-700 border-violet-200';

  const matchesSearch = (ip: string) => !ipSearch.trim() || ip.includes(ipSearch.trim());
  const filteredUsed = (usage?.used || []).filter(u => matchesSearch(u.ip)).sort((a, b) =>
    a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  const filteredFree = (usage?.free || []).filter(matchesSearch);

  const vlanGroups = useMemo(() => groupByVlan(visibleSubnets), [visibleSubnets]);

  const subnetButton = (s: SubnetInfo) => {
    const pct = Math.round(s.utilization * 100);
    const active = s.cidr === selectedCidr;
    return (
      <button key={s.cidr} onClick={() => setSelectedCidr(s.cidr)}
        className={`w-full text-left p-3 rounded-xl border transition ${active ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-200 hover:bg-slate-50'}`}>
        <div className="flex items-center justify-between">
          <span className="font-mono font-bold text-xs">{s.cidr}</span>
          {s.vlan !== undefined && (
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${active ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 text-slate-600'}`}>VLAN {s.vlan}</span>
          )}
        </div>
        <div className={`text-[10px] mt-1 ${active ? 'text-slate-400' : 'text-slate-500'}`}>
          {s.vrf} · {s.usedCount}/{s.totalUsable} {t('used')} · <strong className={pct >= 80 ? 'text-rose-500' : ''}>{pct}%</strong>
        </div>
        <div className="mt-1.5 h-1 rounded-full bg-slate-200/60 overflow-hidden">
          <div className={`h-full ${pct >= 80 ? 'bg-rose-500' : pct >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-4 text-xs">
      {msg && (
        <div className={`p-3 rounded-lg border font-semibold flex items-center gap-2 ${msg.kind === 'ok' ? 'bg-emerald-50 border-emerald-150 text-emerald-800' : 'bg-rose-50 border-rose-150 text-rose-800'}`}>
          {msg.kind === 'ok' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}{msg.text}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        {/* Subnet / VLAN list */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 space-y-3 h-[640px] flex flex-col">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
              <Network size={13} /> {groupMode === 'subnet' ? t('Subnets') : t('VLANs')}
            </span>
            <div className="flex gap-1">
              {(['subnet', 'vlan'] as const).map(m => (
                <button key={m} onClick={() => setGroupMode(m)}
                  className={`px-2 py-0.5 rounded font-bold uppercase text-[9px] transition ${groupMode === m ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                  {m === 'subnet' ? t('Subnet') : 'VLAN'}
                </button>
              ))}
            </div>
          </div>

          <select value={vrfFilter} onChange={e => setVrfFilter(e.target.value)}
            className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg font-semibold text-slate-700">
            {vrfs.map(v => <option key={v} value={v}>{v === 'all' ? t('All VRFs / zones') : v}</option>)}
          </select>

          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {groupMode === 'subnet'
              ? visibleSubnets.map(subnetButton)
              : vlanGroups.map(g => (
                <div key={String(g.vlan)} className="space-y-1.5">
                  <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1 pt-1">
                    <Tag size={10} /> {g.vlan === null ? t('No VLAN tag') : `VLAN ${g.vlan}`}
                  </div>
                  {g.subnets.map(subnetButton)}
                </div>
              ))}
            {visibleSubnets.length === 0 && (
              <div className="text-slate-400 italic text-[11px] py-3 text-center">{t('No subnets found. Add interfaces with a CIDR in Inventory.')}</div>
            )}
          </div>
        </div>

        {/* IP map */}
        <div className="xl:col-span-3 bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col h-[640px] overflow-hidden">
          {!usage ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-[11px]">{t('Select a subnet to see its IP allocation.')}</div>
          ) : (
            <>
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="font-display font-bold text-slate-800 text-sm flex items-center gap-2">
                    <Layers size={15} className="text-blue-500" />
                    <span className="font-mono">{usage.info.cidr}</span>
                    {usage.info.vlan !== undefined && <span className="text-[9px] bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded font-bold">VLAN {usage.info.vlan}</span>}
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {t('VRF')}: <strong>{usage.info.vrf}</strong>
                    {usage.info.gateway && <> · {t('Gateway')}: <span className="font-mono">{usage.info.gateway}</span> ({usage.info.gatewayDevice})</>}
                  </p>
                </div>
                <div className="flex gap-2 text-[10px] font-bold">
                  <span className="px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-100">{usage.usedCount} {t('used')}</span>
                  <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">{usage.freeCount} {t('free')}</span>
                  <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 border border-slate-200">{usage.info.totalUsable} {t('usable')}</span>
                </div>
              </div>

              {/* controls */}
              <div className="px-5 py-3 border-b border-slate-100 flex flex-wrap items-center gap-3">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-2 text-slate-400" />
                  <input value={ipSearch} onChange={e => setIpSearch(e.target.value)} placeholder={t('Search IP...')}
                    className="pl-7 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg font-mono w-40 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
                <label className="flex items-center gap-1.5 text-slate-600 font-semibold cursor-pointer">
                  <input type="checkbox" checked={showFree} onChange={e => setShowFree(e.target.checked)} className="accent-emerald-600" />
                  {t('Show free addresses')}
                </label>
                {usage.nextFree && (
                  <span className="text-[11px] text-slate-500">
                    {t('Next available:')} <strong className="font-mono text-emerald-700">{usage.nextFree}</strong>
                  </span>
                )}
                {canEdit && (
                  <form onSubmit={handleReserve} className="flex items-center gap-1.5 ml-auto">
                    <input value={reserveIp} onChange={e => setReserveIp(e.target.value)} placeholder={usage.nextFree || '10.0.0.5'}
                      className="px-2 py-1.5 bg-white border border-slate-200 rounded-lg font-mono w-28 focus:outline-none focus:ring-1 focus:ring-blue-500" required />
                    <input value={reserveNote} onChange={e => setReserveNote(e.target.value)} placeholder={t('note (e.g. Printer)')}
                      className="px-2 py-1.5 bg-white border border-slate-200 rounded-lg w-36 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                    <button type="submit" className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg flex items-center gap-1">
                      <Plus size={12} /> {t('Reserve')}
                    </button>
                  </form>
                )}
              </div>

              {/* lists */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                <div>
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">{t('Used')} ({filteredUsed.length})</div>
                  <div className="space-y-1">
                    {filteredUsed.map(u => (
                      <div key={u.ip} className="flex items-center gap-2 p-2 rounded-lg border border-slate-150 bg-slate-50/50">
                        <span className="font-mono font-bold text-slate-800 w-32 shrink-0">{u.ip}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold uppercase shrink-0 ${kindStyle(u.kind)}`}>
                          {u.kind === 'interface' ? t('device') : u.kind === 'nat' ? 'NAT' : t('reserved')}
                        </span>
                        <span className="flex items-center gap-1 text-slate-700 font-semibold truncate">
                          <Server size={11} className="text-slate-400 shrink-0" /> {u.owner}
                        </span>
                        <span className="text-slate-500 truncate flex-1">{u.detail}</span>
                        {onSimulateFrom && (
                          <button onClick={() => onSimulateFrom(u.ip)} title={t('Simulate from this IP')}
                            className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded shrink-0">
                            <Play size={11} />
                          </button>
                        )}
                        {canEdit && u.kind === 'reserved' && (
                          <button onClick={() => handleRelease(u.ip)} title={t('Release reservation')}
                            className="p-1 text-rose-400 hover:text-rose-600 hover:bg-rose-50 rounded shrink-0">
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    ))}
                    {filteredUsed.length === 0 && <div className="text-slate-300 italic text-[11px]">{t('none')}</div>}
                  </div>
                </div>

                {showFree && (
                  <div>
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                      {t('Free')} ({usage.freeCount}{usage.freeCapped ? t(', showing first {n}', { n: usage.free.length }) : ''})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {filteredFree.map(ip => (
                        <button key={ip} onClick={() => canEdit && setReserveIp(ip)}
                          title={canEdit ? t('Click to fill the reserve form') : ''}
                          className={`px-1.5 py-0.5 rounded font-mono text-[10px] border border-emerald-100 bg-emerald-50 text-emerald-700 ${canEdit ? 'hover:bg-emerald-100 cursor-pointer' : ''}`}>
                          {ip}
                        </button>
                      ))}
                      {filteredFree.length === 0 && <div className="text-slate-300 italic text-[11px]">{t('none')}</div>}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
