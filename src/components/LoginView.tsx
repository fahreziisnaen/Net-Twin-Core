import React, { useState } from 'react';
import { Network, LogIn, RefreshCw, AlertCircle, ShieldCheck, Smartphone, ArrowLeft } from 'lucide-react';
import { useLang } from '../i18n';
import { useDialog } from './DialogProvider';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
}

interface LoginViewProps {
  onLogin: (user: AuthUser) => void;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default function LoginView({ onLogin }: LoginViewProps) {
  const { t, lang, setLang } = useLang();
  const dialog = useDialog();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Set once the password was accepted for an account with 2FA.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitPassword = async () => {
    const res = await post('/api/auth/login', { username, password });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${t('Login failed')} (HTTP ${res.status})`);
    if (data.twoFactorRequired) {
      setChallenge(data.challenge);
      setCode('');
      return;
    }
    onLogin(data.user);
  };

  const submitCode = async () => {
    const res = await post('/api/auth/login/2fa', { challenge, code });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.restart) back();
      throw new Error(data.error || `${t('Login failed')} (HTTP ${res.status})`);
    }
    if (typeof data.recoveryCodesLeft === 'number') {
      await dialog.alert(t('You signed in with a recovery code. {n} left — each works only once.', { n: data.recoveryCodesLeft }), {
        title: t('Recovery code used'),
      });
    }
    onLogin(data.user);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await (challenge ? submitCode() : submitPassword());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Back to the password step (also after the challenge expired).
  const back = () => {
    setChallenge(null);
    setCode('');
    setPassword('');
  };

  const field = 'w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500';

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

          {!challenge ? (
            <>
              <div>
                <label className="block text-slate-400 font-semibold mb-1.5 uppercase tracking-wider text-[10px]">{t('Username')}</label>
                <input type="text" value={username} onChange={e => setUsername(e.target.value)}
                  autoFocus autoComplete="username" className={field} required />
              </div>
              <div>
                <label className="block text-slate-400 font-semibold mb-1.5 uppercase tracking-wider text-[10px]">{t('Password')}</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password" className={field} required />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-slate-300 text-xs flex items-start gap-2 leading-relaxed">
                <Smartphone size={15} className="text-blue-400 shrink-0 mt-0.5" />
                {t('Enter the 6-digit code from your authenticator app, or a recovery code.')}
              </p>
              {/* Plain text keyboard: recovery codes contain letters (the lost-phone case). */}
              <input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" autoCapitalize="off" spellCheck={false}
                autoFocus placeholder="123456" aria-label={t('Authentication code')}
                className={`${field} font-mono text-lg text-center tracking-widest`} required />
            </div>
          )}

          {error && (
            <div className="p-2.5 bg-rose-500/10 border border-rose-500/30 text-rose-300 rounded-lg text-xs font-semibold flex items-center gap-2">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          <button type="submit" disabled={loading}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition shadow-md flex items-center justify-center gap-2 text-sm">
            {loading ? <RefreshCw size={15} className="animate-spin" /> : <LogIn size={15} />}
            {challenge ? t('Verify') : t('Sign In')}
          </button>

          {challenge && (
            <button type="button" onClick={() => { back(); setError(null); }}
              className="w-full text-slate-400 hover:text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5">
              <ArrowLeft size={13} /> {t('Back')}
            </button>
          )}
        </form>

        <p className="text-center text-[11px] text-slate-600 mt-4 font-mono">
          RBAC: admin • operator • viewer
        </p>
      </div>
    </div>
  );
}
