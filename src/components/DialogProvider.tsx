import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { useLang } from '../i18n';

// In-app replacements for the browser's alert/confirm/prompt: styled like the
// rest of the console, keyboard-friendly (Esc cancels, Enter confirms) and
// promise-based, so callers simply `await dialog.confirm(...)`.

type Tone = 'default' | 'danger';

interface BaseOptions {
  title?: string;
  tone?: Tone;
}

export interface ConfirmOptions extends BaseOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  // Type-to-confirm: the confirm button stays disabled until this exact text is typed.
  requireText?: string;
}

export interface PromptOptions extends BaseOptions {
  confirmLabel?: string;
  inputType?: 'text' | 'password';
  placeholder?: string;
  minLength?: number;
  defaultValue?: string;
}

export interface DialogApi {
  alert: (message: string, opts?: BaseOptions) => Promise<void>;
  confirm: (message: string, opts?: ConfirmOptions) => Promise<boolean>;
  prompt: (message: string, opts?: PromptOptions) => Promise<string | null>;
}

type Request = { id: number } & (
  | { kind: 'alert'; message: string; opts: BaseOptions; resolve: (v: void) => void }
  | { kind: 'confirm'; message: string; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; message: string; opts: PromptOptions; resolve: (v: string | null) => void }
);

let requestSeq = 0;

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error('useDialog must be used inside <DialogProvider>');
  return api;
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  // Requests queue up; the oldest one is shown until answered.
  const [queue, setQueue] = useState<Request[]>([]);
  const enqueue = (req: Request) => setQueue(q => [...q, req]);

  const api = useRef<DialogApi>({
    alert: (message, opts = {}) => new Promise<void>(resolve => enqueue({ id: ++requestSeq, kind: 'alert', message, opts, resolve })),
    confirm: (message, opts = {}) => new Promise<boolean>(resolve => enqueue({ id: ++requestSeq, kind: 'confirm', message, opts, resolve })),
    prompt: (message, opts = {}) => new Promise<string | null>(resolve => enqueue({ id: ++requestSeq, kind: 'prompt', message, opts, resolve })),
  }).current;

  const current = queue[0];
  const settle = (answer: boolean, value?: string) => {
    if (!current) return;
    if (current.kind === 'alert') current.resolve();
    else if (current.kind === 'confirm') current.resolve(answer);
    else current.resolve(answer ? value ?? '' : null);
    setQueue(q => q.slice(1));
  };

  return (
    <DialogContext.Provider value={api}>
      {children}
      {current && <DialogView key={current.id} request={current} onSettle={settle} />}
    </DialogContext.Provider>
  );
}

function DialogView({ request, onSettle }: { request: Request; onSettle: (answer: boolean, value?: string) => void }) {
  const { t } = useLang();
  const { kind, message, opts } = request;
  const danger = opts.tone === 'danger';
  const promptOpts = kind === 'prompt' ? (opts as PromptOptions) : null;
  const confirmOpts = kind === 'confirm' ? (opts as ConfirmOptions) : null;
  const [value, setValue] = useState(promptOpts?.defaultValue ?? '');
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const needsInput = !!promptOpts || !!confirmOpts?.requireText;
  const valid = promptOpts
    ? value.length >= (promptOpts.minLength ?? 1)
    : confirmOpts?.requireText ? value === confirmOpts.requireText : true;

  // Focus the input (or the primary button) on open; give focus back to
  // whatever had it once the dialog closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (needsInput ? inputRef.current : primaryRef.current)?.focus();
    return () => previous?.focus?.();
  }, []);

  const cancel = () => onSettle(false);
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (valid) onSettle(true, value);
  };

  // Esc cancels; Tab stays inside the dialog.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const title = opts.title || (kind === 'alert' ? t('Notice') : kind === 'confirm' ? t('Please confirm') : t('Input required'));
  const confirmLabel = (confirmOpts?.confirmLabel ?? promptOpts?.confirmLabel) || (kind === 'alert' ? t('OK') : t('Confirm'));

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) cancel(); }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role={kind === 'alert' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-message"
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md text-xs"
      >
        <form onSubmit={submit}>
          <div className="p-5 flex gap-3">
            <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${danger ? 'bg-rose-50 text-rose-600' : 'bg-blue-50 text-blue-600'}`}>
              {danger ? <AlertTriangle size={18} /> : <Info size={18} />}
            </div>
            <div className="min-w-0 flex-1">
              <h3 id="dialog-title" className="font-display font-bold text-slate-800 text-sm">{title}</h3>
              <p id="dialog-message" className="text-slate-600 mt-1.5 leading-relaxed whitespace-pre-line break-words">{message}</p>
              {needsInput && (
                <input
                  ref={inputRef}
                  type={promptOpts?.inputType ?? 'text'}
                  value={value}
                  onChange={e => setValue(e.target.value)}
                  placeholder={promptOpts?.placeholder ?? confirmOpts?.requireText ?? ''}
                  autoComplete={promptOpts?.inputType === 'password' ? 'new-password' : 'off'}
                  aria-label={confirmOpts?.requireText ? t('Type {text} to confirm', { text: confirmOpts.requireText }) : title}
                  className="mt-3 w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
              {confirmOpts?.requireText && (
                <p className="text-[10px] text-slate-400 mt-1">{t('Type {text} to confirm', { text: confirmOpts.requireText })}</p>
              )}
              {promptOpts?.minLength && value.length > 0 && !valid && (
                <p className="text-[10px] text-rose-600 mt-1">{t('At least {n} characters.', { n: promptOpts.minLength })}</p>
              )}
            </div>
          </div>
          <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 rounded-b-xl flex justify-end gap-2">
            {kind !== 'alert' && (
              <button type="button" onClick={cancel}
                className="px-4 py-2 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 font-semibold rounded-lg transition">
                {confirmOpts?.cancelLabel || t('Cancel')}
              </button>
            )}
            <button ref={primaryRef} type="submit" disabled={!valid}
              className={`px-4 py-2 text-white font-semibold rounded-lg transition disabled:bg-slate-300 disabled:cursor-not-allowed ${
                danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700'
              }`}>
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
