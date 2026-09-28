import React, { useEffect, useState } from 'react';
import { Role } from '../rbac';
import { useLang } from '../i18n';
import { FileCode2, Play, Save, Plus, Trash2, RefreshCw, AlertCircle, CheckCircle2, FlaskConical, Lock } from 'lucide-react';

interface ParserProfilesTabProps {
  currentUser: { role: Role };
}

interface Profile { id: string; name: string; builtin?: boolean; [k: string]: any; }

const BLANK_TEMPLATE = {
  id: 'my-vendor',
  name: 'My Vendor',
  detect: ['^set ', '^config '],
  rules: [
    { match: '^hostname (\\S+)', setHostname: '$1' },
    { match: '^interface (\\S+) ip (\\S+)', emit: { target: 'interfaces', fields: { name: '$1', ip: '$2', status: { lit: 'up' } } } },
  ],
};

export default function ParserProfilesTab({ currentUser }: ParserProfilesTabProps) {
  const { t } = useLang();
  const isAdmin = currentUser.role === 'admin';
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [draft, setDraft] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [sampleConfig, setSampleConfig] = useState('');
  const [testResult, setTestResult] = useState<any | null>(null);
  const [testing, setTesting] = useState(false);

  const flash = (kind: 'ok' | 'error', text: string) => { setMsg({ kind, text }); setTimeout(() => setMsg(null), 4000); };

  // `select`: profile id to show after loading; '' = the first profile;
  // undefined = keep the current selection when it still exists.
  const load = async (select?: string) => {
    try {
      const res = await fetch('/api/twin/parser-profiles');
      if (!res.ok) return;
      const list: Profile[] = await res.json();
      setProfiles(list);
      const wanted = select === undefined ? selectedId : select;
      const pick = list.some(p => p.id === wanted) ? wanted : list[0]?.id || '';
      if (pick) selectProfile(list, pick);
      else { setSelectedId(''); setDraft(''); setTestResult(null); }
    } catch (err) { console.error(err); }
  };

  const selectProfile = (list: Profile[], id: string) => {
    const p = list.find(x => x.id === id);
    if (p) { setSelectedId(id); setDraft(JSON.stringify(p, null, 2)); setJsonError(null); setTestResult(null); }
  };

  useEffect(() => { load(); }, []);

  const parseDraft = (): Profile | null => {
    try { const p = JSON.parse(draft); setJsonError(null); return p; }
    catch (e: any) { setJsonError(e.message); return null; }
  };

  const draftError = (): string => {
    try { JSON.parse(draft); return ''; } catch (e: any) { return e.message; }
  };

  const handleTest = async () => {
    const profile = parseDraft();
    if (!profile) return;
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch('/api/twin/parser-profiles/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawConfig: sampleConfig, profile }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('Test failed'));
      setTestResult(data.parsedData);
    } catch (e: any) { flash('error', e.message); }
    finally { setTesting(false); }
  };

  const handleSave = async () => {
    const profile = parseDraft();
    if (!profile) { flash('error', t('Invalid JSON: ') + draftError()); return; }
    let res: Response;
    try {
      res = await fetch('/api/twin/parser-profiles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile),
      });
    } catch { return flash('error', t('Cannot reach the server. Check your connection and try again.')); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return flash('error', data.error || t('Failed to save'));
    flash('ok', t('Profile "{name}" saved.', { name: profile.name }));
    await load(profile.id);
  };

  const handleNew = () => {
    setSelectedId('');
    setDraft(JSON.stringify(BLANK_TEMPLATE, null, 2));
    setTestResult(null); setJsonError(null);
  };

  const handleDelete = async () => {
    if (!selectedId || !confirm(t('Delete profile "{id}"?', { id: selectedId }))) return;
    let res: Response;
    try {
      res = await fetch(`/api/twin/parser-profiles/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
    } catch { return flash('error', t('Cannot reach the server. Check your connection and try again.')); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return flash('error', data.error || t('Failed to delete'));
    flash('ok', t('Profile deleted.'));
    // Show the first remaining profile, not the deleted one's stale JSON
    // (saving that would silently re-create it).
    await load('');
  };

  const handleReset = async () => {
    if (!confirm(t('Restore all built-in profiles (Cisco/FortiGate/Junos/PAN-OS) to their original definitions? Custom profiles are unaffected.'))) return;
    const res = await fetch('/api/twin/parser-profiles/reset', { method: 'POST' }).catch(() => null);
    if (!res?.ok) return flash('error', t('Reset failed'));
    flash('ok', t('Built-in profiles restored to defaults.'));
    await load();
  };

  const selected = profiles.find(p => p.id === selectedId);
  const counts = testResult ? {
    interfaces: testResult.interfaces?.length || 0, routes: testResult.routes?.length || 0,
    firewallRules: testResult.firewallRules?.length || 0, natMappings: testResult.natMappings?.length || 0,
  } : null;

  return (
    <div className="space-y-4 text-xs">
      {msg && (
        <div className={`p-3 rounded-lg border font-semibold flex items-center gap-2 ${msg.kind === 'ok' ? 'bg-emerald-50 border-emerald-150 text-emerald-800' : 'bg-rose-50 border-rose-150 text-rose-800'}`}>
          {msg.kind === 'ok' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}{msg.text}
        </div>
      )}
      {!isAdmin && (
        <div className="p-3 rounded-lg border bg-amber-50 border-amber-100 text-amber-800 font-semibold flex items-center gap-2">
          <Lock size={14} /> {t('Read-only mode. Only admins can edit/save parser profiles.')}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Profile list */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{t('Parser Profiles')}</span>
            {isAdmin && <button onClick={handleNew} className="text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1"><Plus size={13} /> {t('New')}</button>}
          </div>
          {profiles.map(p => (
            <button key={p.id} onClick={() => selectProfile(profiles, p.id)}
              className={`w-full text-left p-2.5 rounded-lg border transition ${selectedId === p.id ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-slate-200 hover:bg-slate-50'}`}>
              <div className="font-display font-bold text-[12px] flex items-center justify-between">
                {p.name}
                {p.builtin && <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-bold ${selectedId === p.id ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-500'}`}>BUILTIN</span>}
              </div>
              <div className={`font-mono text-[10px] ${selectedId === p.id ? 'text-slate-400' : 'text-slate-400'}`}>{p.id} · {(p.rules?.length || 0)} rules</div>
            </button>
          ))}
          {isAdmin && (
            <button onClick={handleReset} className="w-full mt-2 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-semibold flex items-center justify-center gap-1.5">
              <RefreshCw size={12} /> {t('Reset built-in profiles')}
            </button>
          )}
        </div>

        {/* JSON editor */}
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-xl shadow-sm p-4 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5"><FileCode2 size={13} /> {t('Profile definition (JSON)')}</span>
            <div className="flex gap-1.5">
              {isAdmin && selected && !selected.builtin && (
                <button onClick={handleDelete} className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded font-semibold flex items-center gap-1"><Trash2 size={12} /> {t('Delete')}</button>
              )}
              {isAdmin && (
                <button onClick={handleSave} className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded font-semibold flex items-center gap-1"><Save size={12} /> {t('Save')}</button>
              )}
            </div>
          </div>
          <textarea value={draft} onChange={e => { setDraft(e.target.value); setJsonError(null); }} readOnly={!isAdmin} spellCheck={false}
            className="flex-1 min-h-[280px] w-full p-3 bg-slate-950 border border-slate-800 text-emerald-200 font-mono rounded-lg focus:outline-none resize-none text-[11px] leading-relaxed" />
          {jsonError && <div className="mt-2 p-2 bg-rose-50 border border-rose-100 text-rose-700 rounded text-[11px] font-semibold flex items-center gap-1.5"><AlertCircle size={12} /> {jsonError}</div>}
        </div>
      </div>

      {/* Live Test */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
        <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5"><FlaskConical size={13} className="text-blue-500" /> {t('Live Test')}</span>
          <button onClick={handleTest} disabled={testing || !sampleConfig.trim()}
            className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white rounded-lg font-semibold flex items-center gap-1.5">
            {testing ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} fill="currentColor" />} {t('Test parse')}
          </button>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <textarea value={sampleConfig} onChange={e => setSampleConfig(e.target.value)}
            placeholder={t('Paste a sample config here to test the profile above...')}
            className="h-56 w-full p-3 bg-slate-950 border border-slate-800 text-slate-300 font-mono rounded-lg focus:outline-none resize-none text-[11px]" />
          <div className="h-56 overflow-y-auto border border-slate-200 rounded-lg p-3 bg-slate-50/50">
            {!testResult ? (
              <div className="h-full flex items-center justify-center text-slate-400 text-[11px] text-center">{t('Test results appear here. Edit profile → Test → see whether interfaces/routes/ACL/NAT are read correctly.')}</div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2 text-[10px] font-bold">
                  {counts && Object.entries(counts).map(([k, v]) => (
                    <span key={k} className={`px-2 py-1 rounded-full ${v > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}`}>{k}: {v}</span>
                  ))}
                  {testResult.hostname && <span className="px-2 py-1 rounded-full bg-blue-100 text-blue-700">host: {testResult.hostname}</span>}
                </div>
                {(testResult.warnings || []).length > 0 && (
                  <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded p-2">{testResult.warnings.join(' ')}</div>
                )}
                <pre className="text-[10px] font-mono text-slate-600 whitespace-pre-wrap">{JSON.stringify({
                  interfaces: testResult.interfaces, routes: testResult.routes,
                  firewallRules: testResult.firewallRules, natMappings: testResult.natMappings,
                }, null, 1)}</pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
