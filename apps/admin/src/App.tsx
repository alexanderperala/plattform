import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { label } from './format';
import { useLoad } from './ui';
import { LoginPage } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Customers } from './pages/Customers';
import { CustomerDetail } from './pages/CustomerDetail';
import { Users } from './pages/Users';
import { UserDetail } from './pages/UserDetail';
import { Products } from './pages/Products';
import { Support } from './pages/Support';
import { SupportCase } from './pages/SupportCase';
import { SupportView } from './pages/SupportView';
import { Approvals } from './pages/Approvals';
import { Audit } from './pages/Audit';
import { Logs } from './pages/Logs';
import { Admins } from './pages/Admins';
import { Flags } from './pages/Flags';
import { Settings } from './pages/Settings';
import { SetupPage } from './pages/Setup';

const NAV: { to: string; text: string; perm: string }[] = [
  { to: '/dashboard', text: 'Översikt', perm: 'dashboard.view' },
  { to: '/customers', text: 'Kunder', perm: 'workspaces.view' },
  { to: '/users', text: 'Användare', perm: 'users.view' },
  { to: '/products', text: 'Produkter och licenser', perm: 'entitlements.view' },
  { to: '/flags', text: 'Funktionsflaggor', perm: 'entitlements.view' },
  { to: '/support', text: 'Support', perm: 'support.view' },
  { to: '/approvals', text: 'Godkännanden', perm: 'dashboard.view' },
  { to: '/audit', text: 'Granskningslogg', perm: 'audit.view' },
  { to: '/logs', text: 'Tekniska fel', perm: 'logs.view' },
  { to: '/settings', text: 'Inställningar', perm: 'settings.manage' },
  { to: '/admins', text: 'Administratörer', perm: 'admins.manage' },
];

function Shell() {
  const { me, can, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const pending = useLoad(() => api<any>('GET', '/approvals?status=pending'), [loc.pathname]);
  const pendingCount = (pending.data?.items ?? []).length;

  return (
    <div className="shell">
      <a href="#main" className="skip">Hoppa till innehåll</a>
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Huvudmeny">
        <div className="brand"><span className="dot" />Plattform · Superadmin</div>
        <nav className="nav">
          {NAV.filter((n) => can(n.perm)).map((n) => (
            <NavLink key={n.to} to={n.to}>
              {n.text}
              {n.to === '/approvals' && pendingCount > 0 && <span className="count">{pendingCount}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="who">
          <strong>{me.admin?.name}</strong>
          <span>{label('role', me.admin?.role)}</span>
          <div style={{ marginTop: '.6rem' }}><button className="btn small" onClick={() => void logout()}>Logga ut</button></div>
        </div>
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <div className="main">
        <div className="topbar">
          <button className="btn small" aria-label="Öppna meny" onClick={() => setOpen(true)}>☰ Meny</button>
          <strong>Superadmin</strong>
        </div>
        {me.admin?.breakGlass && <div className="banner-bg">BREAK-GLASS-SESSION – alla åtgärder loggas som kritiska</div>}
        <main id="main" className="content">
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/customers/:id" element={<CustomerDetail />} />
            <Route path="/users" element={<Users />} />
            <Route path="/users/:id" element={<UserDetail />} />
            <Route path="/products" element={<Products />} />
            <Route path="/support" element={<Support />} />
            <Route path="/support/cases/:id" element={<SupportCase />} />
            <Route path="/support/access/:sessionId" element={<SupportView />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/flags" element={<Flags />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/admins" element={<Admins />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export function App() {
  const { me, loading } = useAuth();
  if (window.location.pathname === '/setup') return <SetupPage />;
  if (loading) return <div className="loading">Laddar…</div>;
  if (me.stage !== 'active') return <LoginPage />;
  return <Shell />;
}
