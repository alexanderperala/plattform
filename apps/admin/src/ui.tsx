import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { label, tone } from './format';
import { LABELS } from './format';

/* ---------- Toasts ---------- */
interface ToastItem { id: number; text: string; kind: 'good' | 'bad' | 'info' }
const ToastCtx = createContext<(text: string, kind?: ToastItem['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, kind: ToastItem['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((i) => [...i, { id, text, kind }]);
    setTimeout(() => setItems((i) => i.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Små byggstenar ---------- */
export function Badge({ group, value, text }: { group: keyof typeof LABELS; value: string | null | undefined; text?: string }) {
  return <span className={`badge ${tone(group, value)}`}>{text ?? label(group, value)}</span>;
}

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'warn' | 'info' | 'good'; children: ReactNode }) {
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : undefined}>{children}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const e = error as ApiError;
  return (
    <Alert>
      {e?.message ?? 'Något gick fel.'}
      {e?.requestId && <div className="small mono">Referens: {e.requestId}</div>}
    </Alert>
  );
}

export function PageHead({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  return (
    <div className="pager">
      <span>{from}–{Math.min(total, page * pageSize)} av {total}</span>
      <span className="row">
        <button className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>Föregående</button>
        <span>Sida {page} / {pages}</span>
        <button className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)}>Nästa</button>
      </span>
    </div>
  );
}

export function SortTh({ col, sort, dir, onSort, children }: { col: string; sort: string; dir: string; onSort: (c: string) => void; children: ReactNode }) {
  const active = sort === col;
  return (
    <th aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className="sort" onClick={() => onSort(col)}>{children}{active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>
    </th>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}>{t.label}</button>)}
    </div>
  );
}

export function Field({ label: l, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field">{l}{children}{hint && <span className="hint">{hint}</span>}</label>;
}

/* ---------- Datahämtning ---------- */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const my = ++seq.current;
    setLoading(true);
    fn().then((d) => { if (my === seq.current) { setData(d); setError(null); } })
      .catch((e) => { if (my === seq.current) setError(e); })
      .finally(() => { if (my === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload };
}

export function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/* ---------- Modal ---------- */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,textarea,select,button')?.focus();
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => { window.removeEventListener('keydown', h); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/**
 * Standarddialog för känsliga åtgärder. Hanterar orsak (min 10 tecken), MFA-omautentisering
 * (REAUTH_REQUIRED → fråga efter kod → försök igen) samt 202 "godkännande krävs".
 */
export interface ActionDialogProps {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  needReason?: boolean;
  extra?: ReactNode;
  run: (reason: string) => Promise<any>;
  onClose: () => void;
  onDone: (result: any) => void;
}
export function ActionDialog({ title, description, confirmLabel, danger, needReason = true, extra, run, onClose, onDone }: ActionDialogProps) {
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (needCode) await api('POST', '/auth/reauth', { code });
      const r = await run(reason.trim());
      if (r?.approvalRequired) toast('Åtgärden kräver godkännande av en annan administratör (four-eyes). Begäran är skickad.', 'info');
      onDone(r);
    } catch (err) {
      const ae = err as ApiError;
      if (ae.code === 'REAUTH_REQUIRED') { setNeedCode(true); setCode(''); setError(null); }
      else setError(err);
    } finally { setBusy(false); }
  }

  const reasonOk = !needReason || reason.trim().length >= 10;
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="stack" style={{ gap: '.9rem' }}>
        {description && <div className="muted">{description}</div>}
        {extra}
        {needReason && (
          <Field label="Orsak (loggas)" hint="Minst 10 tecken. Orsaken sparas i granskningsloggen.">
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} maxLength={1000} />
          </Field>
        )}
        {needCode && (
          <>
            <Alert kind="info">Bekräfta din identitet med en MFA-kod för att fortsätta.</Alert>
            <Field label="MFA-kod (6 siffror)">
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required />
            </Field>
          </>
        )}
        {error != null && <ErrorBox error={error} />}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Avbryt</button>
          <button type="submit" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy || !reasonOk || (needCode && code.length !== 6)}>
            {busy ? 'Arbetar…' : needCode ? 'Bekräfta och utför' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Knapp som öppnar en ActionDialog – döljs inte, men inaktiveras om behörighet saknas. */
export function ActionButton({ allowed = true, btnClass = '', children, dialog }: {
  allowed?: boolean; btnClass?: string; children: ReactNode;
  dialog: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!allowed) return null;
  return (
    <>
      <button className={`btn small ${btnClass}`} onClick={() => setOpen(true)}>{children}</button>
      {open && dialog(() => setOpen(false))}
    </>
  );
}
