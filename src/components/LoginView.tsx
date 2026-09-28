import React, { useState } from 'react';
import { Network, LogIn, RefreshCw, AlertCircle, ShieldCheck } from 'lucide-react';
import { useLang } from '../i18n';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
}

interface LoginViewProps {
  onLogin: (user: AuthUser) => void;
}

export default function LoginView({ onLogin }: LoginViewProps) {
  const { t, lang, setLang } = useLang();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `${t('Login failed')} (HTTP ${res.status})`);
      onLogin(data.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
            <Network size={22} />
          </div>
          <div>
            <h1 className="font-display font-bold text-xl text-white tracking-tight">NetTwin Core</h1>
            <p className="text-[10px] text-slate-500 font-mono tracking-wider uppercase font-bold">{t('Control Plane Twin')}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="bg-slate-800/60 border border-slate-700 rounded-2xl p-6 space-y-4 shadow-xl">
          <div className="flex items-center justify-between gap-2 text-slate-300 pb-2 border-b border-slate-700">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-emerald-400" />
              <span className="font-display font-bold text-sm">{t('Sign in to Digital Twin Console')}</span>
            </div>
            <div className="flex gap-1">
              {(['en', 'id'] as const).map(l => (
                <button key={l} type="button" onClick={() => setLang(l)}
                  className={`px-2 py-0.5 rounded font-bold uppercase text-[9px] tracking-wider transition ${lang === l ? 'bg-blue-600 text-white' : 'bg-slate-900 text-slate-500 hover:bg-slate-700'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-slate-400 font-semibold mb-1.5 uppercase tracking-wider text-[10px]">
              {t('Username')}
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          <div>
            <label className="block text-slate-400 font-semibold mb-1.5 uppercase tracking-wider text-[10px]">
              {t('Password')}
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          {error && (
            <div className="p-2.5 bg-rose-500/10 border border-rose-500/30 text-rose-300 rounded-lg text-xs font-semibold flex items-center gap-2">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition shadow-md flex items-center justify-center gap-2 text-sm"
          >
            {loading ? <RefreshCw size={15} className="animate-spin" /> : <LogIn size={15} />}
            {t('Sign In')}
          </button>
        </form>

        <p className="text-center text-[11px] text-slate-600 mt-4 font-mono">
          RBAC: admin • operator • viewer
        </p>
      </div>
    </div>
  );
}
