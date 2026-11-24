import { useState } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { Alert, ErrorBox, Field, LABEL } from './ui';
import { Tournaments, TournamentView } from './Tournaments';

const ACCOUNT_URL = import.meta.env.VITE_ACCOUNT_URL ?? 'http://127.0.0.1:5174';

function Login() {
  const { refresh } = useAuth(); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  async function submit(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(null); try { await api('POST', '/auth/login', { email, password }); await refresh(); } catch (x) { setError(x); } finally { setBusy(false); } }
  return (
    <div className="auth-wrap"><div className="auth-card"><h1>Turneringssystemet</h1><p className="muted" style={{ margin: 0 }}>Logga in med ditt konto.</p>
      <form onSubmit={submit}>
        <Field label="E-post"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Lösenord"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        {error != null && <ErrorBox error={error} />}
        <button className="btn primary" disabled={busy}>{busy ? 'Loggar in…' : 'Logga in'}</button>
        <div className="small">Saknar du konto? <a href={ACCOUNT_URL}>Skapa konto i kontoportalen</a></div>
      </form></div></div>
  );
}

function Shell() {
  const { me, logout } = useAuth();
  const [wid, setWid] = useState<string>(() => localStorageSafe());
  if (!me) return null;
  const ws = me.workspaces.find((w) => w.id === wid) ?? me.workspaces[0];
  if (!ws) return <div className="auth-wrap"><div className="auth-card"><h1>Ingen arbetsyta</h1><button className="btn" onClick={() => void logout()}>Logga ut</button></div></div>;
  const mode = ws.products?.find((p) => p.product === 'tournament_system')?.mode ?? 'none';
    return (
    <div className="shell">
      <a href="#main" className="skip">Hoppa till innehåll</a>
      <aside className="sidebar" aria-label="Meny">
        <div className="brand"><span className="dot" />Turneringssystem</div>
        {me.workspaces.length > 1 && <select aria-label="Arbetsyta" value={ws.id} onChange={(e) => { setWid(e.target.value); try { localStorage.setItem('tournament-ws', e.target.value); } catch { /* ignorera */ } }} style={{ marginBottom: '.5rem' }}>{me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}
        <nav className="nav"><NavLink to="/tournaments">Turneringar</NavLink><a href={ACCOUNT_URL}>Mitt konto ↗</a></nav>
        <div className="who"><strong>{me.user.name}</strong><span>{ws.name} · {LABEL.role[ws.role]}</span><div style={{ marginTop: '.6rem' }}><button className="btn small" onClick={() => void logout()}>Logga ut</button></div></div>
      </aside>
      <div className="main"><main id="main" className="content">
        {mode === 'none' ? <Alert kind="warn">Turneringssystemet är inte aktiverad för {ws.name}. Aktivera produkten i <a href={ACCOUNT_URL}>kontoportalen</a>.</Alert>
          : <Routes><Route path="/tournaments" element={<Tournaments key={ws.id} wid={ws.id} />} /><Route path="/tournaments/:id" element={<TournamentView key={ws.id} wid={ws.id} />} /><Route path="*" element={<Navigate to="/tournaments" replace />} /></Routes>}
      </main></div>
    </div>
  );
}
function localStorageSafe(): string { try { return localStorage.getItem('tournament-ws') ?? ''; } catch { return ''; } }

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <div className="loading">Laddar…</div>;
  return me ? <Shell /> : <Login />;
}
