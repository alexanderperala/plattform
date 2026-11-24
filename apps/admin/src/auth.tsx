import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, SESSION_EXPIRED_EVENT } from './api';

export interface Me {
  stage: 'mfa_pending' | 'mfa_enroll' | 'active' | 'anonymous';
  email?: string;
  admin?: { id: string; email: string; name: string; role: string; breakGlass: boolean };
  permissions?: string[];
  requirements?: Record<string, { reason: boolean; reauth: boolean; fourEyes: boolean }>;
  session?: { expiresAt: string; idleExpiresAt: string; reauthValidUntil: string | null };
}

interface AuthCtx {
  me: Me;
  loading: boolean;
  refresh: () => Promise<void>;
  can: (perm: string) => boolean;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me>({ stage: 'anonymous' });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try { setMe(await api<Me>('GET', '/auth/me')); } catch { setMe({ stage: 'anonymous' }); }
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const h = () => setMe({ stage: 'anonymous' });
    window.addEventListener(SESSION_EXPIRED_EVENT, h);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, h);
  }, []);

  const value = useMemo<AuthCtx>(() => ({
    me, loading, refresh,
    can: (p) => !!me.permissions?.includes(p),
    logout: async () => { try { await api('POST', '/auth/logout'); } catch { /* sessionen kan redan vara borta */ } setMe({ stage: 'anonymous' }); },
  }), [me, loading, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth utanför AuthProvider');
  return c;
}
