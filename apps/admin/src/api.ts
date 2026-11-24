export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

const BASE = '/api/platform-admin';
export const SESSION_EXPIRED_EVENT = 'admin-session-expired';

export async function api<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-requested-with': 'platform-admin' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Det gick inte att nå servern. Kontrollera anslutningen och försök igen.');
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* icke-JSON */ }
  if (!res.ok) {
    const e = json?.error;
    if (res.status === 401 && e?.code === 'SESSION_REQUIRED') window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Fel ${res.status}`, e?.requestId, e?.details);
  }
  return json as T;
}

export const qs = (params: Record<string, string | number | undefined | null>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
