import { useState } from 'react';
import { Billing } from './Billing';
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { Alert, ErrorBox, Field } from './ui';
import { Overview, Members, SupportAccess } from './pages';

function AuthCard({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return <div className="auth-wrap"><div className="auth-card"><h1>{title}</h1>{sub && <p className="muted" style={{ margin: 0 }}>{sub}</p>}{children}</div></div>;
}

function useSubmit(fn: () => Promise<void>) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  return { busy, error, submit: async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setError(null); try { await fn(); } catch (x) { setError(x); } finally { setBusy(false); } } };
}

function Login() {
  const { refresh } = useAuth(); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const { busy, error, submit } = useSubmit(async () => { await api('POST', '/auth/login', { email, password }); await refresh(); });
  return (
    <AuthCard title="Logga in" sub="Till ditt konto och din arbetsyta.">
      <form onSubmit={submit}>
        <Field label="E-post"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Lösenord"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        {error != null && <ErrorBox error={error} />}
        <button className="btn primary" disabled={busy}>{busy ? 'Loggar in…' : 'Logga in'}</button>
        <div className="small"><Link to="/forgot-password">Glömt lösenord?</Link> · <Link to="/register">Skapa konto</Link></div>
      </form>
    </AuthCard>
  );
}

function Register() {
  const { refresh } = useAuth();
  const [f, setF] = useState({ name: '', email: '', password: '', workspaceName: '', kind: 'association', orgNumber: '' });
  const [products, setProducts] = useState<string[]>(['association_portal']); const [terms, setTerms] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const toggle = (p: string) => setProducts(products.includes(p) ? products.filter((x) => x !== p) : [...products, p]);
  const { busy, error, submit } = useSubmit(async () => {
    await api('POST', '/auth/register', { ...f, orgNumber: f.orgNumber || undefined, products, acceptTerms: terms }); await refresh();
  });
  return (
    <AuthCard title="Skapa konto" sub="Du får en provperiod. Du kan aktivera den andra produkten när som helst.">
      <form onSubmit={submit}>
        <Field label="Ditt namn"><input value={f.name} onChange={set('name')} required /></Field>
        <Field label="E-post"><input type="email" value={f.email} onChange={set('email')} required /></Field>
        <Field label="Lösenord" hint="Minst 10 tecken."><input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required minLength={10} /></Field>
        <Field label="Förening eller organisation"><input value={f.workspaceName} onChange={set('workspaceName')} required /></Field>
        <Field label="Typ"><select value={f.kind} onChange={set('kind')}><option value="association">Förening</option><option value="organizer">Arrangör</option><option value="other">Annan</option></select></Field>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ fontWeight: 600 }}>Produkter</legend>
          {([['association_portal', 'Föreningsportal'], ['tournament_system', 'Turneringssystem']] as [string, string][]).map(([k, l]) => <label key={k} className="row small"><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={products.includes(k)} onChange={() => toggle(k)} /> {l}</label>)}</fieldset>
        <label className="row small"><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={terms} onChange={(e) => setTerms(e.target.checked)} required /> Jag godkänner villkoren och personuppgiftsbiträdesavtalet</label>
        {error != null && <ErrorBox error={error} />}
        <button className="btn primary" disabled={busy || products.length === 0}>{busy ? 'Skapar…' : 'Skapa konto'}</button>
        <div className="small"><Link to="/login">Har du redan ett konto? Logga in</Link></div>
      </form>
    </AuthCard>
  );
}

function Forgot() {
  const [email, setEmail] = useState(''); const [done, setDone] = useState(false);
  const { busy, error, submit } = useSubmit(async () => { await api('POST', '/auth/forgot-password', { email }); setDone(true); });
  return (
    <AuthCard title="Glömt lösenord" sub="Vi skickar en länk om kontot finns.">
      {done ? <Alert kind="good">Om adressen finns hos oss har vi skickat en länk. Den gäller i 60 minuter.</Alert> : (
        <form onSubmit={submit}><Field label="E-post"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
          {error != null && <ErrorBox error={error} />}<button className="btn primary" disabled={busy}>Skicka länk</button></form>)}
      <div className="small" style={{ marginTop: '1rem' }}><Link to="/login">Tillbaka till inloggning</Link></div>
    </AuthCard>
  );
}

function TokenPage({ kind }: { kind: 'reset-password' | 'accept-invite' | 'verify-email' }) {
  const [sp] = useSearchParams(); const token = sp.get('token') ?? ''; const nav = useNavigate(); const { refresh } = useAuth();
  const [password, setPassword] = useState(''); const [done, setDone] = useState(false);
  const needsPassword = kind !== 'verify-email';
  const { busy, error, submit } = useSubmit(async () => {
    await api('POST', `/auth/${kind}`, needsPassword ? { token, password } : { token });
    if (kind === 'accept-invite') { await refresh(); nav('/'); } else setDone(true);
  });
  const title = { 'reset-password': 'Välj nytt lösenord', 'accept-invite': 'Aktivera ditt konto', 'verify-email': 'Bekräfta e-postadress' }[kind];
  return (
    <AuthCard title={title}>
      {done ? <Alert kind="good">{kind === 'verify-email' ? 'Din e-postadress är bekräftad.' : 'Lösenordet är ändrat.'} <Link to="/login">Logga in</Link></Alert> : (
        <form onSubmit={submit}>
          {!token && <Alert>Länken saknar token. Använd länken från mejlet.</Alert>}
          {needsPassword && <Field label="Nytt lösenord" hint="Minst 10 tecken."><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} /></Field>}
          {error != null && <ErrorBox error={error} />}
          <button className="btn primary" disabled={busy || !token}>{kind === 'verify-email' ? 'Bekräfta' : 'Spara'}</button>
        </form>)}
    </AuthCard>
  );
}

function Shell() {
  const { me, logout } = useAuth(); const nav = useNavigate(); const params = useParams(); const wid = params.wid; const sub = (params['*'] ?? '').replace(/\/$/, '');
  if (!me) return null;
  const ws = me.workspaces.find((w) => w.id === wid) ?? me.workspaces[0];
  if (!ws) return <AuthCard title="Ingen arbetsyta" sub="Ditt konto tillhör ingen arbetsyta ännu."><button className="btn" onClick={() => void logout()}>Logga ut</button></AuthCard>;
  const isAdmin = ws.role === 'owner' || ws.role === 'admin';
  return (
    <div className="shell">
      <a href="#main" className="skip">Hoppa till innehåll</a>
      <aside className="sidebar" aria-label="Meny">
        <div className="brand"><span className="dot" />Mitt konto</div>
        {me.workspaces.length > 1 && <select aria-label="Arbetsyta" value={ws.id} onChange={(e) => nav(`/w/${e.target.value}`)} style={{ marginBottom: '.5rem' }}>{me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}
        <nav className="nav">
          <NavLink to={`/w/${ws.id}`} end>Översikt</NavLink>
          <NavLink to={`/w/${ws.id}/members`}>Medlemmar</NavLink>
          {isAdmin && <NavLink to={`/w/${ws.id}/billing`}>Fakturering</NavLink>}
          {isAdmin && <NavLink to={`/w/${ws.id}/support-access`}>Supportåtkomst</NavLink>}
        </nav>
        <div className="who"><strong>{me.user.name}</strong><span>{me.user.email}</span><div style={{ marginTop: '.6rem' }}><button className="btn small" onClick={() => void logout()}>Logga ut</button></div></div>
      </aside>
      <div className="main"><main id="main" className="content">
        {sub === 'members' ? <Members wid={ws.id} canAdd={isAdmin} />
          : sub === 'billing' ? (isAdmin ? <Billing wid={ws.id} /> : <Navigate to={`/w/${ws.id}`} replace />)
          : sub === 'support-access' ? (isAdmin ? <SupportAccess wid={ws.id} /> : <Navigate to={`/w/${ws.id}`} replace />)
          : <Overview wid={ws.id} />}
      </main></div>
    </div>
  );
}


export function App() {
  const { me, loading } = useAuth();
  if (loading) return <div className="loading">Laddar…</div>;
  if (!me) {
    return <Routes><Route path="/login" element={<Login />} /><Route path="/register" element={<Register />} /><Route path="/forgot-password" element={<Forgot />} />
      <Route path="/reset-password" element={<TokenPage kind="reset-password" />} /><Route path="/accept-invite" element={<TokenPage kind="accept-invite" />} />
      <Route path="/verify-email" element={<TokenPage kind="verify-email" />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes>;
  }
  return <Routes><Route path="/verify-email" element={<TokenPage kind="verify-email" />} /><Route path="/login" element={<Navigate to="/" replace />} /><Route path="/w/:wid/*" element={<Shell />} /><Route path="*" element={<Shell />} /></Routes>;
}
