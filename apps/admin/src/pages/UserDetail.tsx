import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime, label, relTime } from '../format';
import { ActionButton, ActionDialog, Alert, Badge, ErrorBox, PageHead, useLoad } from '../ui';
import { NewCaseDialog } from './CustomerDetail';

export function UserDetail() {
  const { id } = useParams(); const { can } = useAuth(); const nav = useNavigate();
  const { data: d, error, loading, reload } = useLoad(() => api<any>('GET', `/users/${id}`), [id]);
  if (loading && !d) return <div className="loading">Laddar användare…</div>;
  if (error) return <ErrorBox error={error} />;
  if (!d) return null;
  const u = d.user;
  const act = (path: string) => (reason: string) => api('POST', `/users/${id}${path}`, { reason });
  const done = (c: () => void) => () => { c(); reload(); };
  const btn = (text: string, title: string, path: string, opts: { danger?: boolean; desc?: string } = {}) => (
    <ActionButton dialog={(c) => <ActionDialog title={title} description={opts.desc} confirmLabel={text} danger={opts.danger} run={act(path)} onClose={c} onDone={done(c)} />}>{text}</ActionButton>
  );
  return (
    <div className="stack">
      <PageHead title={u.name} subtitle={<>{u.email} · <Badge group="userStatus" value={u.status} /></>}>
        {can('users.lock') && (u.status === 'locked' ? btn('Lås upp', 'Lås upp användaren', '/unlock') : u.status === 'active' ? btn('Lås konto', 'Lås användarens konto', '/lock', { danger: true, desc: 'Användaren kan inte logga in och alla sessioner återkallas.' }) : null)}
        {can('users.lock') && btn('Återkalla sessioner', 'Återkalla alla sessioner', '/revoke-sessions')}
        {can('users.account_actions') && u.status !== 'deleted' && <>
          {btn('Återställ lösenord', 'Skicka lösenordsåterställning', '/reset-password', { desc: 'Användaren får en länk för att välja nytt lösenord. Lösenord visas aldrig för administratörer.' })}
          {!u.emailVerifiedAt && btn('Skicka verifiering', 'Skicka verifieringsmejl', '/send-verification')}
        </>}
        {can('users.delete') && u.status !== 'deleted' && (
          <ActionButton dialog={(c) => <ActionDialog title="Ta bort användare" description="Kräver godkännande av en andra administratör. Användarens personuppgifter anonymiseras enligt GDPR-reglerna." confirmLabel="Begär borttagning" danger run={act('/delete')} onClose={c} onDone={done(c)} />}>Ta bort…</ActionButton>
        )}
        {can('support.manage') && <ActionButton dialog={(c) => <NewCaseDialog userId={id} onClose={c} onDone={(r) => { c(); nav(`/support/cases/${r.id}`); }} />}>Nytt ärende</ActionButton>}
      </PageHead>
      {u.status === 'locked' && <Alert kind="warn">Kontot är låst{u.lockedUntil ? ` till ${fmtDateTime(u.lockedUntil)}` : ''}.</Alert>}
      <div className="grid cols-2">
        <div className="card"><h2>Kontouppgifter</h2><dl className="kv">
          <dt>ID</dt><dd className="mono">{u.id}</dd><dt>Telefon</dt><dd>{u.phone ?? '–'}</dd>
          <dt>E-post verifierad</dt><dd>{u.emailVerifiedAt ? fmtDateTime(u.emailVerifiedAt) : 'Nej'}</dd><dt>Lösenord satt</dt><dd>{u.hasPassword ? 'Ja' : 'Nej (inbjuden)'}</dd>
          <dt>Misslyckade inloggningar</dt><dd>{u.failedLoginCount}</dd><dt>Senast inloggad</dt><dd>{relTime(u.lastLoginAt)}</dd><dt>Skapad</dt><dd>{fmtDateTime(u.createdAt)}</dd></dl></div>
        <div className="card"><h2>Arbetsytor och produktåtkomst</h2>
          <ul className="timeline">{d.memberships.map((m: any) => {
            const pa = d.productAccess.find((a: any) => a.workspaceId === m.workspaceId);
            return <li key={m.workspaceId}><Link to={`/customers/${m.workspaceId}`}><strong>{m.workspaceName}</strong></Link> · {label('memberRole', m.role)} <Badge group="workspaceStatus" value={m.workspaceStatus} />
              <div className="row" style={{ gap: '.3rem', marginTop: '.25rem' }}>{pa?.products.map((p: any) => <Badge key={p.product} group="access" value={p.mode} text={`${label('product', p.product)}: ${label('access', p.mode)}`} />)}</div></li>;
          })}</ul>{d.memberships.length === 0 && <div className="empty">Ingen arbetsyta.</div>}</div>
      </div>
      <div className="grid cols-2">
        <div className="card"><h2>Inloggningshistorik</h2><ul className="timeline">{d.loginHistory.map((h: any) => <li key={h.id}><Badge group="userStatus" value={h.success ? 'active' : 'locked'} text={h.success ? 'Lyckad' : 'Misslyckad'} /> {fmtDateTime(h.createdAt)}<div className="small muted">{h.reason} · {h.ip}</div></li>)}</ul>{d.loginHistory.length === 0 && <div className="empty">Ingen historik.</div>}</div>
        {d.cases && <div className="card"><h2>Ärenden</h2><ul className="timeline">{d.cases.map((c: any) => <li key={c.id}><Link to={`/support/cases/${c.id}`}>#{c.number} {c.subject}</Link> <Badge group="caseStatus" value={c.status} /></li>)}</ul>{d.cases.length === 0 && <div className="empty">Inga ärenden.</div>}</div>}
      </div>
    </div>
  );
}
