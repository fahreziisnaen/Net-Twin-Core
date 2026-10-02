import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ShieldCheck, ShieldOff, Smartphone, Copy, Download, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useLang } from '../i18n';
import { copyText } from '../clipboard';

interface Status {
  enabled: boolean;
  pending: boolean;
  recoveryCodesLeft: number;
}

type Step = 'idle' | 'password' | 'scan' | 'codes' | 'disable';

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Account Security: any signed-in user turns authenticator-app two-factor
// authentication on or off for their own account.
export default function TwoFactorCard({ username }: { username: string }) {
  const { t } = useLang();
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    const res = await fetch('/api/auth/2fa').catch(() => null);
    if (res?.ok) setStatus(await res.json());
  };
  useEffect(() => { void load(); }, []);

  const goTo = (next: Step) => {
    setStep(next);
    setPassword('');
    setCode('');
    setError(null);
  };

  // One API call; the server's error message is shown in the card.
  const run = async (call: () => Promise<Response>, onOk: (data: any) => Promise<void> | void) => {
    setBusy(true);
    setError(null);
    try {
      const res = await call();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t('Request failed (HTTP {status}).', { status: res.status }));
        return;
      }
      await onOk(data);
    } catch {
      setError(t('Cannot reach the server. Check your connection and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const startSetup = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => post('/api/auth/2fa/setup', { password }), async data => {
      setSecret(data.secret);
      setQr(await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 200 }));
      goTo('scan');
    });
  };

  const confirmSetup = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => post('/api/auth/2fa/enable', { code }), async data => {
      setRecoveryCodes(data.recoveryCodes);
      setSecret('');
      setQr('');
      goTo('codes');
      await load();
    });
  };

  const turnOff = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => post('/api/auth/2fa/disable', { password, code }), async () => {
      goTo('idle');
      await load();
    });
  };

  const codesText = () => `NetTwin Core — ${t('recovery codes for')} ${username}\n\n${recoveryCodes.join('\n')}\n`;
  const copyCodes = async () => {
    if (await copyText(codesText())) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  const downloadCodes = () => {
    const url = URL.createObjectURL(new Blob([codesText()], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `nettwin-recovery-codes-${username}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const input = 'w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500';
  const label = 'block font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1';
  const secondary = 'px-4 py-2 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 font-semibold rounded-lg transition flex items-center gap-1.5';
  const primary = 'px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-semibold rounded-lg transition flex items-center gap-1.5';
  const danger = 'px-4 py-2 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white font-semibold rounded-lg transition flex items-center gap-1.5';

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display font-bold text-slate-800 text-sm flex items-center gap-1.5">
            <Smartphone size={16} className="text-blue-500" /> {t('Account Security (2FA)')}
          </h3>
          <p className="text-slate-500 text-[11px] mt-0.5">
            {t('Protect your account with a 6-digit code from Google Authenticator or a compatible app.')}
          </p>
        </div>
        {status && (
          <span className={`text-[10px] px-2 py-1 rounded-full font-bold uppercase shrink-0 border ${
            status.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-slate-100 text-slate-500 border-slate-200'
          }`}>
            {status.enabled ? t('2FA on') : t('2FA off')}
          </span>
        )}
      </div>

      {error && (
        <div className="p-2.5 bg-rose-50 border border-rose-100 text-rose-800 rounded-lg font-semibold flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {step === 'idle' && status && (status.enabled ? (
        <div className="space-y-3">
          {status.recoveryCodesLeft <= 3 && (
            <div className="p-2.5 bg-amber-50 border border-amber-100 text-amber-800 rounded-lg text-[11px]">
              {t('Only {n} recovery codes left. Turn two-factor authentication off and on again to get new ones.', { n: status.recoveryCodesLeft })}
            </div>
          )}
          <p className="text-slate-600">{t('{n} unused recovery codes.', { n: status.recoveryCodesLeft })}</p>
          <button onClick={() => goTo('disable')} className="px-4 py-2 bg-white hover:bg-rose-50 border border-rose-300 text-rose-700 font-semibold rounded-lg transition flex items-center gap-1.5">
            <ShieldOff size={14} /> {t('Turn off 2FA')}
          </button>
        </div>
      ) : (
        <button onClick={() => goTo('password')} className={primary}>
          <ShieldCheck size={14} /> {t('Turn on 2FA')}
        </button>
      ))}

      {step === 'password' && (
        <form onSubmit={startSetup} className="space-y-3 max-w-sm">
          <div>
            <label className={label}>{t('Current password')}</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" autoFocus required className={input} />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => goTo('idle')} className={secondary}>{t('Cancel')}</button>
            <button type="submit" disabled={busy || !password} className={primary}>
              {busy && <RefreshCw size={14} className="animate-spin" />} {t('Continue')}
            </button>
          </div>
        </form>
      )}

      {step === 'scan' && (
        <form onSubmit={confirmSetup} className="grid md:grid-cols-2 gap-5 items-start">
          <div className="space-y-2">
            <p className="text-slate-600">{t('1. Scan this QR code with Google Authenticator (or add the key manually).')}</p>
            {qr && <img src={qr} alt={t('QR code for the authenticator app')} className="w-48 h-48 border border-slate-200 rounded-lg" />}
            <div data-testid="totp-secret" className="font-mono text-[11px] bg-slate-50 border border-slate-200 rounded-lg p-2 break-all select-all">
              {secret.match(/.{1,4}/g)?.join(' ')}
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label className={label}>{t('2. Enter the 6-digit code shown in the app.')}</label>
              <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code"
                placeholder="123456" autoFocus required className={`${input} font-mono text-base text-center tracking-widest`} />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => goTo('idle')} className={secondary}>{t('Cancel')}</button>
              <button type="submit" disabled={busy || !code.trim()} className={primary}>
                {busy && <RefreshCw size={14} className="animate-spin" />} {t('Verify & turn on')}
              </button>
            </div>
          </div>
        </form>
      )}

      {step === 'codes' && (
        <div className="space-y-3">
          <div className="p-2.5 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg font-semibold flex items-center gap-2">
            <CheckCircle2 size={14} /> {t('Two-factor authentication is on.')}
          </div>
          <p className="text-slate-600">{t('Save these recovery codes somewhere safe. Each works once if you lose your phone. They will not be shown again.')}</p>
          <div data-testid="recovery-codes" className="grid grid-cols-2 gap-1.5 font-mono text-sm bg-slate-50 border border-slate-200 rounded-lg p-3 max-w-sm">
            {recoveryCodes.map(c => <span key={c}>{c}</span>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={copyCodes} className={secondary}><Copy size={13} /> {copied ? t('Copied') : t('Copy')}</button>
            <button onClick={downloadCodes} className={secondary}><Download size={13} /> {t('Download .txt')}</button>
            <button onClick={() => { setRecoveryCodes([]); goTo('idle'); }} className={primary}>{t('Done')}</button>
          </div>
        </div>
      )}

      {step === 'disable' && (
        <form onSubmit={turnOff} className="space-y-3 max-w-sm">
          <div>
            <label className={label}>{t('Current password')}</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" autoFocus required className={input} />
          </div>
          <div>
            <label className={label}>{t('Authenticator code or recovery code')}</label>
            <input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" required className={`${input} font-mono`} />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => goTo('idle')} className={secondary}>{t('Cancel')}</button>
            <button type="submit" disabled={busy || !password || !code.trim()} className={danger}>
              {busy && <RefreshCw size={14} className="animate-spin" />} {t('Turn off 2FA')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
