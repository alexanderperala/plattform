import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiError } from './api';

export const fmtDateTime = (v?: string | null) => v ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' }).format(new Date(v)) : '–';
export const LABEL = {
  product: { association_portal: 'Föreningsportal', tournament_system: 'Turneringssystem' } as Record<string, string>,
  mode: { full: 'Full åtkomst', limited: 'Begränsad', read_only: 'Skrivskyddad', export_only: 'Endast export', none: 'Ingen åtkomst' } as Record<string, string>,
  role: { owner: 'Ägare', admin: 'Administratör', member: 'Medlem' } as Record<string, string>,
  ws: { Active: 'Aktiv', Suspended: 'Pausad', Closed: 'Avslutad' } as Record<string, string>,
  sub: { Trialing: 'Provperiod', Active: 'Aktivt', PastDue: 'Förfallen betalning', Paused: 'Pausat', CanceledAtPeriodEnd: 'Uppsagt', Expired: 'Utgånget' } as Record<string, string>,
};
export const badge = (mode: string) => (mode === 'full' ? 'good' : mode === 'none' || mode === 'export_only' ? 'bad' : 'warn');

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'info' | 'warn' | 'good'; children: ReactNode }) {
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : undefined}>{children}</div>;
}
export function ErrorBox({ error }: { error: unknown }) {
  const e = error as ApiError;
  return <Alert>{e?.message ?? 'Något gick fel.'}{e?.requestId && <div className="small mono">Referens: {e.requestId}</div>}</Alert>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field">{label}{children}{hint && <span className="hint">{hint}</span>}</label>;
}
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<unknown>(null); const [loading, setLoading] = useState(true); const seq = useRef(0);
  const reload = useCallback(() => {
    const my = ++seq.current; setLoading(true);
    fn().then((d) => { if (my === seq.current) { setData(d); setError(null); } }).catch((e) => { if (my === seq.current) setError(e); }).finally(() => { if (my === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload };
}
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2>{children}</div></div>;
}
