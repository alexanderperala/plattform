import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, SESSION_EXPIRED } from './api';

export interface Ws { id: string; name: string; status: string; role: 'owner' | 'admin' | 'member'; subscription?: any; products?: { product: string; mode: string; status: string | null }[] }
export interface Me { user: { id: string; email: string; name: string }; workspaces: Ws[] }
const Ctx = createContext<{ me: Me | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> } | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null); const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => { try { setMe(await api<Me>('GET', '/me')); } catch { setMe(null); } setLoading(false); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const h = () => setMe(null); window.addEventListener(SESSION_EXPIRED, h); return () => window.removeEventListener(SESSION_EXPIRED, h); }, []);
  const v = useMemo(() => ({ me, loading, refresh, logout: async () => { try { await api('POST', '/auth/logout'); } catch { /* redan utloggad */ } setMe(null); } }), [me, loading, refresh]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}
export function useAuth() { const c = useContext(Ctx); if (!c) throw new Error('useAuth utanför AuthProvider'); return c; }
