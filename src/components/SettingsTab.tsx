import React, { useEffect, useRef, useState } from 'react';
import { SimulationSettings } from '../types';
import { Role, ROLES } from '../rbac';
import { useLang } from '../i18n';
import { useDialog } from './DialogProvider';
import TwoFactorCard from './TwoFactorCard';
import { Sliders, RefreshCw, Save, Download, Upload, CheckCircle2, AlertCircle, Users, Plus, Trash2, KeyRound, Eraser, ShieldOff } from 'lucide-react';

interface ManagedUser {
  id: number;
  username: string;
  role: Role;
  twoFactorEnabled?: boolean;
}

interface SettingsTabProps {
  onResetTopology: () => Promise<boolean>;
  onFactoryReset: () => Promise<boolean>;
  currentUser: { id: number; username: string; role: Role };
}

// Word the admin must type to enable the factory reset (the API requires it too).
const FACTORY_RESET_WORD = 'RESET';

// Parse a JSON response body, tolerating empty/non-JSON bodies (e.g. a proxy's
// HTML error page) so the server's error message or a sane fallback is shown.
const bodyOf = (res: Response): Promise<any> => res.json().catch(() => ({}));

export default function SettingsTab({ onResetTopology, onFactoryReset, currentUser }: SettingsTabProps) {
  const { t } = useLang();
  const dialog = useDialog();
  const isAdmin = currentUser.role === 'admin';
  const [maxHops, setMaxHops] = useState('10');
  const [implicitDeny, setImplicitDeny] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // User management state (admin only)
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('viewer');

  const loadUsers = async () => {
    try {
      const res = await fetch('/api/users');
      if (res.ok) setUsers(await res.json());
    } catch (err) {
      console.error('Error loading users:', err);
    }
  };

  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin]);

  // Load current engine settings from the server
  useEffect(() => {
    fetch('/api/twin/settings')
      .then(res => (res.ok ? res.json() : null))
      .then((s: SimulationSettings | null) => {
        if (!s) return;
        setMaxHops(String(s.maxHops));
        setImplicitDeny(Boolean(s.implicitDeny));
      })
      .catch(err => console.error('Error loading settings:', err));
  }, []);

  const flash = (kind: 'ok' | 'error', text: string) => {
    setMessage({ kind, text });
    setTimeout(() => setMessage(null), 4000);
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/twin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxHops: parseInt(maxHops, 10), implicitDeny }),
      });
      const data = await bodyOf(res);
      if (!res.ok) throw new Error(data.error || t('Failed to save settings'));
      flash('ok', t('Simulation engine settings saved. All future traces use these values.'));
    } catch (err: any) {
      flash('error', err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    const ok = await dialog.confirm(
      t('Reset the entire topology, rules, NAT, audits, and change requests back to the initial (seed) state? Your changes will be lost.'),
      { title: t('Revert to Certified State'), tone: 'danger', confirmLabel: t('Revert') },
    );
    if (!ok) return;
    setResetting(true);
    try {
      if (await onResetTopology()) flash('ok', t('Digital twin successfully reset to the certified seed state.'));
    } finally {
      setResetting(false);
    }
  };

  const handleFactoryReset = async () => {
    const ok = await dialog.confirm(
      t('Permanently delete ALL twin data: devices, cables, routes, firewall rules, NAT, audits, change requests and IPAM reservations. User accounts, SSH connections, parser profiles and engine settings are kept. This cannot be undone — export a snapshot first if you may need the data.'),
      { title: t('Factory Reset'), tone: 'danger', confirmLabel: t('Delete everything'), requireText: FACTORY_RESET_WORD },
    );
    if (!ok) return;
    setResetting(true);
    try {
      if (await onFactoryReset()) flash('ok', t('Factory reset complete. The digital twin is now empty.'));
    } finally {
      setResetting(false);
    }
  };

  const handleExport = () => {
    // Server streams the full state as a JSON download
    window.open('/api/twin/export', '_blank');
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }),
      });
      const data = await bodyOf(res);
      if (!res.ok) throw new Error(data.error || t('Failed to create user'));
      flash('ok', t('User "{name}" ({role}) created.', { name: newUsername, role: newRole }));
      setNewUsername('');
      setNewPassword('');
      setNewRole('viewer');
      await loadUsers();
    } catch (err: any) {
      flash('error', err.message);
    }
  };

  const handleChangeRole = async (user: ManagedUser, role: Role) => {
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      const data = await bodyOf(res);
      if (!res.ok) throw new Error(data.error || t('Failed to change role'));
      flash('ok', t('Role for "{name}" changed to {role}.', { name: user.username, role }));
      await loadUsers();
    } catch (err: any) {
      flash('error', err.message);
      await loadUsers();
    }
  };

  const handleResetPassword = async (user: ManagedUser) => {
    const password = await dialog.prompt(t('New password for "{name}" (min. 6 chars):', { name: user.username }), {
      title: t('Change password'),
      inputType: 'password',
      minLength: 6,
      confirmLabel: t('Save'),
    });
    if (!password) return;
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await bodyOf(res);
      if (!res.ok) throw new Error(data.error || t('Failed to change password'));
      flash('ok', t('Password for "{name}" changed.', { name: user.username }));
    } catch (err: any) {
      flash('error', err.message);
    }
  };

  const handleDeleteUser = async (user: ManagedUser) => {
    const ok = await dialog.confirm(t('Delete user "{name}"?', { name: user.username }), { title: t('Delete user'), tone: 'danger', confirmLabel: t('Delete') });
    if (!ok) return;
    try {
      const res = await fetch(`/api/users/${user.id}`, { method: 'DELETE' });
      const data = await bodyOf(res);
      if (!res.ok) throw new Error(data.error || t('Failed to delete user'));
      flash('ok', t('User "{name}" deleted.', { name: user.username }));
      await loadUsers();
    } catch (err: any) {
      flash('error', err.message);
    }
  };

  const handleResetTwoFactor = async (user: ManagedUser) => {
    const ok = await dialog.confirm(
      t('Turn off two-factor authentication for "{name}"? They can sign in with their password only until they set it up again.', { name: user.username }),
      { title: t('Reset 2FA'), tone: 'danger', confirmLabel: t('Reset 2FA') },
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/users/${user.id}/2fa`, { method: 'DELETE' });
      const data = await bodyOf(res);
      if (!res.ok) throw new Error(data.error || t('Failed to reset 2FA'));
      flash('ok', t('Two-factor authentication for "{name}" was reset.', { name: user.username }));
      await loadUsers();
    } catch (err: any) {
      flash('error', err.message);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const res = await fetch('/api/twin/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await bodyOf(res);
      if (!res.ok) throw new Error(data.error || t('Import failed'));
      flash('ok', t('Snapshot imported. Reloading the page for full sync.'));
      setTimeout(() => window.location.reload(), 1200);
    } catch (err: any) {
      flash('error', t('Import failed: {msg}', { msg: err.message }));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-6 text-xs">
      {message && (
        <div className={`p-3 rounded-lg border font-semibold flex items-center gap-2 ${
          message.kind === 'ok'
            ? 'bg-emerald-50 border-emerald-150 text-emerald-800'
            : 'bg-rose-50 border-rose-150 text-rose-800'
        }`}>
          {message.kind === 'ok' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          {message.text}
        </div>
      )}

      <TwoFactorCard username={currentUser.username} />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Simulation Engine Parameters */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4">
          <h3 className="font-display font-bold text-slate-800 text-sm flex items-center gap-1.5">
            <Sliders size={16} className="text-blue-500" /> {t('Simulation Engine Constraints')}
          </h3>
          <p className="text-slate-500 leading-relaxed text-[11px]">
            {t('These parameters are stored on the server and used by all path simulations, compliance audits, and change-request what-ifs.')}
          </p>

          <div className="space-y-3 font-mono">
            <div>
              <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px] font-sans">
                {t('Maximum Path Hop Limit (TTL)')}
              </label>
              <input
                type="number"
                min="1"
                max="64"
                value={maxHops}
                onChange={e => setMaxHops(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-bold"
              />
            </div>

            <div>
              <label className="block text-slate-500 font-semibold mb-1 uppercase tracking-wider text-[9px] font-sans">
                {t('Default-Deny Policy Action')}
              </label>
              <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg font-sans">
                <span className="font-medium text-slate-700">{t('Implicit Drop on Firewall No-match')}</span>
                <input
                  type="checkbox"
                  checked={implicitDeny}
                  onChange={e => setImplicitDeny(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
                />
              </div>
            </div>

            <button
              onClick={handleSaveSettings}
              disabled={saving || !isAdmin}
              title={isAdmin ? '' : t('Only admins can change settings')}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-sans font-semibold rounded-lg transition shadow-sm flex items-center justify-center gap-2"
            >
              {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
              {t('Save Engine Settings')}
            </button>
          </div>
        </div>

        {/* Snapshot Export / Import */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4">
          <h3 className="font-display font-bold text-slate-800 text-sm flex items-center gap-1.5">
            <Download size={16} className="text-blue-500" /> {t('Twin Snapshot (Export / Import)')}
          </h3>
          <p className="text-slate-500 leading-relaxed text-[11px]">
            {t('Twin state is auto-saved to the storage backend on every change. Use snapshots for backup, versioning, or sharing topology with teammates.')}
          </p>

          <div className="space-y-2 pt-1">
            <button
              onClick={handleExport}
              className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-semibold rounded-lg transition shadow-sm flex items-center justify-center gap-2"
            >
              <Download size={14} /> {t('Export Snapshot (JSON)')}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!isAdmin}
              title={isAdmin ? '' : t('Only admins can import snapshots')}
              className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed border border-slate-200 text-slate-700 font-semibold rounded-lg transition flex items-center justify-center gap-2"
            >
              <Upload size={14} /> {t('Import Snapshot (JSON)')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleImportFile}
              className="hidden"
            />
          </div>
        </div>

        {/* Sandbox Synchronization and Reset */}
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4">
          <h3 className="font-display font-bold text-slate-800 text-sm flex items-center gap-1.5">
            <RefreshCw size={16} className="text-amber-500" /> {t('Twin Synchronization Center')}
          </h3>
          <p className="text-slate-500 leading-relaxed text-[11px]">
            {t('Restore all routes, firewall rules, NAT mappings, audits, and change requests to the initial enterprise reference (seed state) on the server.')}
          </p>

          <div className="pt-2">
            <button
              onClick={handleReset}
              disabled={resetting || !isAdmin}
              title={isAdmin ? '' : t('Only admins can reset')}
              className="w-full py-2.5 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition shadow-sm flex items-center justify-center gap-2"
            >
              <RefreshCw size={14} className={resetting ? 'animate-spin' : ''} /> {t('Revert to Certified State')}
            </button>
          </div>

          <div className="pt-4 border-t border-slate-100 space-y-2">
            <p className="text-slate-500 leading-relaxed text-[11px]">
              {t('Factory reset empties the twin completely (no demo data), so you can model your own network from scratch.')}
            </p>
            <button
              onClick={handleFactoryReset}
              disabled={resetting || !isAdmin}
              title={isAdmin ? '' : t('Only admins can reset')}
              className="w-full py-2.5 bg-white hover:bg-rose-50 border border-rose-300 text-rose-700 disabled:border-slate-200 disabled:text-slate-400 disabled:bg-white disabled:cursor-not-allowed font-semibold rounded-lg transition flex items-center justify-center gap-2"
            >
              <Eraser size={14} /> {t('Factory Reset (Empty Twin)')}
            </button>
          </div>
        </div>
      </div>

      {/* User Management (RBAC) — admin only */}
      {isAdmin && (
        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
            <h3 className="font-display font-bold text-slate-800 text-sm flex items-center gap-1.5">
              <Users size={16} className="text-blue-500" /> {t('User Management (RBAC)')}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              <strong>admin</strong>: {t('full control')} • <strong>operator</strong>: {t('edit twin & draft changes (no approve/settings)')} • <strong>viewer</strong>: {t('view & simulate only')}.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-600">
              <thead className="bg-slate-100/50 text-slate-500 font-bold uppercase text-[9px] border-b border-slate-150">
                <tr>
                  <th className="py-3 px-6">{t('Username')}</th>
                  <th className="py-3 px-6">{t('Role')}</th>
                  <th className="py-3 px-6 text-right">{t('Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-150">
                {users.map(u => (
                  <tr key={u.id} className="hover:bg-slate-50/50">
                    <td className="py-3 px-6 font-semibold text-slate-800">
                      {u.username}
                      {u.id === currentUser.id && (
                        <span className="ml-2 text-[9px] bg-blue-50 text-blue-700 border border-blue-100 px-1.5 py-0.5 rounded-full font-bold uppercase">{t('You')}</span>
                      )}
                      {u.twoFactorEnabled && (
                        <span className="ml-2 text-[9px] bg-emerald-50 text-emerald-700 border border-emerald-100 px-1.5 py-0.5 rounded-full font-bold uppercase">2FA</span>
                      )}
                    </td>
                    <td className="py-3 px-6">
                      <select
                        value={u.role}
                        onChange={e => handleChangeRole(u, e.target.value as Role)}
                        disabled={u.id === currentUser.id}
                        className="px-2 py-1 bg-white border border-slate-200 rounded-lg font-semibold text-slate-700 disabled:opacity-60"
                      >
                        {ROLES.map(r => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-6 text-right space-x-1">
                      {u.twoFactorEnabled && u.id !== currentUser.id && (
                        <button
                          onClick={() => handleResetTwoFactor(u)}
                          className="p-1.5 text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded transition"
                          title={t('Reset 2FA')}
                        >
                          <ShieldOff size={13} />
                        </button>
                      )}
                      <button
                        onClick={() => handleResetPassword(u)}
                        className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded transition"
                        title={t('Change password')}
                      >
                        <KeyRound size={13} />
                      </button>
                      <button
                        onClick={() => handleDeleteUser(u)}
                        disabled={u.id === currentUser.id}
                        className="p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                        title={t('Delete user')}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form onSubmit={handleAddUser} className="p-5 border-t border-slate-150 bg-slate-50/50 grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div>
              <label className="block font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">{t('New Username')}</label>
              <input
                type="text"
                value={newUsername}
                onChange={e => setNewUsername(e.target.value)}
                placeholder="e.g. budi.netops"
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                required
              />
            </div>
            <div>
              <label className="block font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">{t('Password (min. 6)')}</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                minLength={6}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                required
              />
            </div>
            <div>
              <label className="block font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1">{t('Role')}</label>
              <select
                value={newRole}
                onChange={e => setNewRole(e.target.value as Role)}
                className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg font-semibold text-slate-700"
              >
                {ROLES.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="py-2 bg-slate-900 hover:bg-slate-800 text-white font-semibold rounded-lg transition flex items-center justify-center gap-1.5"
            >
              <Plus size={14} /> {t('Add User')}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
