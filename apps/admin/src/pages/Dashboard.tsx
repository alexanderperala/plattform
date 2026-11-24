import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtDate, fmtDateTime, relTime } from '../format';
import { Alert, Badge, ErrorBox, PageHead, useLoad } from '../ui';

function Kpi({ v, l, kind, to }: { v: React.ReactNode; l: string; kind?: 'warn' | 'bad'; to?: string }) {
  const inner = <><div className="v">{v}</div><div className="l">{l}</div></>;
  return to ? <Link to={to} className={`kpi ${kind ?? ''}`} style={{ color: 'inherit', textDecoration: 'none' }}>{inner}</Link> : <div className={`kpi ${kind ?? ''}`}>{inner}</div>;
}

export function Dashboard() {
  const { data: d, error, loading, reload } = useLoad(() => api<any>('GET', '/dashboard'), []);
  if (loading && !d) return <div className="loading">Laddar översikt…</div>;
  if (error) return <ErrorBox error={error} />;
  if (!d) return null;
  return (
    <div className="stack">
      <PageHead title="Översikt" subtitle={`Uppdaterad ${fmtDateTime(d.generatedAt)}`}><button className="btn" onClick={reload}>Uppdatera</button></PageHead>
      {d.breakGlassOpen && <Alert kind="error"><strong>Break-glass-kontot är öppet.</strong> Kontrollera granskningsloggen omedelbart.</Alert>}
      {d.pendingApprovals > 0 && <Alert kind="warn"><Link to="/approvals">{d.pendingApprovals} godkännande(n) väntar</Link></Alert>}

      <section aria-label="Kunder och produkter"><h2>Kunder och produkter</h2>
        <div className="kpis">
          <Kpi v={d.customers.total} l="Kunder totalt" to="/customers" />
          <Kpi v={d.customers.activeWorkspaces} l="Aktiva arbetsytor" to="/customers?workspaceStatus=Active" />
          <Kpi v={d.customers.suspendedWorkspaces} l="Pausade arbetsytor" kind={d.customers.suspendedWorkspaces ? 'warn' : undefined} to="/customers?workspaceStatus=Suspended" />
          <Kpi v={d.customers.closedWorkspaces} l="Avslutade arbetsytor" />
          <Kpi v={d.customers.newLast30d} l="Nya senaste 30 dagarna" />
          <Kpi v={d.products.associationPortals} l="Aktiva Föreningsportaler" to="/customers?product=association_portal" />
          <Kpi v={d.products.tournamentSystems} l="Aktiva Turneringssystem" to="/customers?product=tournament_system" />
          <Kpi v={d.bothProducts} l="Kunder med båda produkterna" />
          {d.activeUsers !== undefined && <Kpi v={d.activeUsers} l="Aktiva användare (30 dagar)" to="/users?status=active" />}
          {d.lockedUsers !== undefined && <Kpi v={d.lockedUsers} l="Låsta användare" kind={d.lockedUsers ? 'warn' : undefined} to="/users?status=locked" />}
        </div>
      </section>

      {d.subscriptions && (
        <section aria-label="Abonnemang"><h2>Abonnemang</h2>
          <div className="kpis">
            <Kpi v={d.subscriptions.trials} l="Pågående provperioder" to="/customers?subscriptionStatus=Trialing" />
            <Kpi v={d.subscriptions.paying} l="Betalande kunder" />
            <Kpi v={d.subscriptions.pastDue} l="Förfallen betalning" kind={d.subscriptions.pastDue ? 'bad' : undefined} to="/customers?subscriptionStatus=PastDue" />
            <Kpi v={d.subscriptions.ended} l="Avslutade/uppsagda" />
          </div>
        </section>
      )}

      <div className="grid cols-3">
        <div className="card"><h2>Nya registreringar</h2>
          {d.recentRegistrations.length === 0 ? <div className="muted">Inga ännu.</div> :
            <ul className="timeline">{d.recentRegistrations.map((w: any) => <li key={w.id}><Link to={`/customers/${w.id}`}>{w.name}</Link><div className="small muted">{fmtDate(w.createdAt)}</div></li>)}</ul>}
        </div>
        {d.expiringTrials && (
          <div className="card"><h2>Provperioder som snart går ut</h2>
            {d.expiringTrials.length === 0 ? <div className="muted">Inga närmaste 7 dagarna.</div> :
              <ul className="timeline">{d.expiringTrials.map((w: any) => <li key={w.workspaceId}><Link to={`/customers/${w.workspaceId}`}>{w.name}</Link><div className="small muted">Går ut {relTime(w.trialEndsAt)} ({fmtDate(w.trialEndsAt)})</div></li>)}</ul>}
          </div>
        )}
        {d.pastDueList && (
          <div className="card"><h2>Förfallna betalningar</h2>
            {d.pastDueList.length === 0 ? <div className="muted">Inga.</div> :
              <ul className="timeline">{d.pastDueList.map((w: any) => <li key={w.workspaceId}><Link to={`/customers/${w.workspaceId}`}>{w.name}</Link><div className="small muted">Sedan {fmtDate(w.pastDueSince)}</div></li>)}</ul>}
          </div>
        )}
      </div>

      {d.support && (
        <section aria-label="Support"><h2>Support</h2>
          <div className="kpis">
            <Kpi v={d.support.newCases} l="Nya ärenden" to="/support?status=New" />
            <Kpi v={d.support.openCases} l="Öppna ärenden" to="/support?open=true" />
            <Kpi v={d.support.urgentCases} l="Brådskande (hög/kritisk)" kind={d.support.urgentCases ? 'bad' : undefined} to="/support?open=true&priority=critical" />
          </div>
        </section>
      )}

      {d.system && (
        <section aria-label="System"><h2>Systemstatus</h2>
          <div className="grid cols-2">
            <div className="card">
              <dl className="kv">
                <dt>API</dt><dd><Badge group="entitlementStatus" value={d.system.api === 'ok' ? 'Enabled' : 'Disabled'} text={d.system.api === 'ok' ? 'OK' : 'Fel'} /></dd>
                <dt>Databas</dt><dd><Badge group="entitlementStatus" value={d.system.database === 'ok' ? 'Enabled' : 'Disabled'} text={d.system.database === 'ok' ? 'OK' : 'Fel'} /></dd>
                <dt>E-postkö</dt><dd>{d.system.emailQueue.pending} väntar · {d.system.emailQueue.failed} misslyckade</dd>
                <dt>Fel senaste 24 h</dt><dd><Link to="/logs">{d.system.errors24h}</Link></dd>
                <dt>Ej övervakat ännu</dt><dd className="muted">{d.system.notYetMonitored.join(', ')}</dd>
              </dl>
            </div>
            <div className="card"><h3>Senaste tekniska fel</h3>
              {d.system.recentErrors.length === 0 ? <div className="muted">Inga fel registrerade.</div> :
                <ul className="timeline">{d.system.recentErrors.map((e: any) => <li key={e.id}><span className="mono">{e.code ?? e.statusCode}</span> {e.message}<div className="small muted">{fmtDateTime(e.at)} · {e.route}</div></li>)}</ul>}
            </div>
          </div>
        </section>
      )}
      {d.selfApprovedLast30d > 0 && <Alert kind="warn">{d.selfApprovedLast30d} åtgärd(er) självgodkändes de senaste 30 dagarna (sole-owner-undantag). <Link to="/audit?action=approval.approved">Visa</Link></Alert>}
    </div>
  );
}
