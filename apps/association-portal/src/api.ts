export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) { super(message); }
}
export const SESSION_EXPIRED = 'portal-session-expired';
export async function api<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api/v1' + path, { method, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-requested-with': 'platform-customer' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new ApiError(0, 'NETWORK', 'Det gick inte att nå servern. Kontrollera anslutningen och försök igen.'); }
  const text = await res.text(); let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* icke-JSON */ }
  if (!res.ok) {
    const e = json?.error;
    if (res.status === 401 && e?.code === 'SESSION_REQUIRED') window.dispatchEvent(new Event(SESSION_EXPIRED));
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Fel ${res.status}`, e?.requestId);
  }
  return json as T;
}
