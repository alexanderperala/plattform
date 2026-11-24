import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { LABELS, fmtDateTime, label, relTime } from '../format';
import { ActionButton, ActionDialog, Alert, Badge, ErrorBox, Field, PageHead, useLoad } from '../ui';

const ROLE_OPTIONS = Object.entries(LABELS.role);

export function Admins() {
  const { me } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api<any>('GET', '/admins'), []);
  const [f, setF] = useState({ email: '', name: '', role: 'support_admin' });
  const [newRole, setNewRole] = useState<Record<string, string>>({});
  const done = (c: () => void) => () => { c(); reload(); };
  const call = (path: string, body: object = {}) => (reason: string) => api('POST', path, { reason, ...body });

  return (
    <div className="stack">
      <PageHead title="Administratörer" subtitle="Konton för Superadmin. Skapande, rollbyte, aktivering och MFA-återställning kräver godkännande av en annan administratör (four-eyes).">
        <ActionButton btnClass="primary" dialog={(c) => (
          <ActionDialog title="Skapa administratör" confirmLabel="Begär skapande" onClose={c} onDone={done(c)}
            description="Kontot skapas när en annan administratör godkänner. Kontoinnehavaren får en engångslänk för att välja eget lösenord, och registrerar MFA vid första inloggningen."
            run={(reason) => api('POST', '/admins', { reason, ...f })}
            extra={<><Field label="Namn"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} /></Field>
              <Field label="E-post"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
              <Field label="Roll"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLE_OPTIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field></>} />)}>Bjud in administratör</ActionButton>
      </PageHead>
      {error != null && <ErrorBox error={error} />}
      <Alert kind="info">Break-glass-kontot visas här men hanteras uteslutande via CLI. Minst en aktiv Platform Owner måste alltid finnas.</Alert>
      <div className="card flush table-wrap"><table>
        <thead><tr><th>Administratör</th><th>Roll</th><th>Status</th><th>MFA</th><th>Senast inloggad</th><th>Sessioner</th><th /></tr></thead>
        <tbody>{data?.items.map((a: any) => {
          const self = a.id === me.admin?.id; const locked = a.isBreakGlass;
          return (
            <tr key={a.id}>
              <td><strong>{a.name}</strong>{self && <span className="badge info" style={{ marginLeft: '.4rem' }}>Du</span>}{a.isBreakGlass && <span className="badge bad" style={{ marginLeft: '.4rem' }}>break-glass</span>}<div className="small muted">{a.email}</div></td>
              <td>{label('role', a.role)}</td>
              <td><Badge group="userStatus" value={a.status === 'active' ? 'active' : 'deleted'} text={a.status === 'active' ? 'Aktiv' : 'Inaktiverad'} />{a.setupPending && <div className="small muted">Väntar på aktivering</div>}{a.lockedUntil && new Date(a.lockedUntil) > new Date() && <div className="small">Låst till {fmtDateTime(a.lockedUntil)}</div>}</td>
              <td>{a.mfaEnrolledAt ? 'Registrerad' : 'Ej registrerad'}</td>
              <td>{relTime(a.lastLoginAt)}</td><td>{a.activeSessions}</td>
              <td className="nowrap">{!locked && <div className="row" style={{ gap: '.4rem' }}>
                {!self && <ActionButton dialog={(c) => (
                  <ActionDialog title={`Ändra roll – ${a.name}`} confirmLabel="Begär rollbyte" onClose={c} onDone={done(c)} description="Kräver godkännande. Administratörens sessioner avslutas när ändringen utförs."
                    run={call(`/admins/${a.id}/role`, { role: newRole[a.id] ?? a.role })}
                    extra={<Field label="Ny roll"><select value={newRole[a.id] ?? a.role} onChange={(e) => setNewRole({ ...newRole, [a.id]: e.target.value })}>{ROLE_OPTIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>} />)}>Byt roll</ActionButton>}
                {!self && <ActionButton dialog={(c) => <ActionDialog title={`Återställ MFA – ${a.name}`} confirmLabel="Begär återställning" danger onClose={c} onDone={done(c)}
                  description="Tar bort MFA och återhämtningskoder, ogiltigförklarar lösenordet och avslutar sessioner. Kontoinnehavaren får en ny länk. Kräver godkännande." run={call(`/admins/${a.id}/reset-mfa`)} />}>Återställ MFA</ActionButton>}
                {!self && a.status === 'active' && <ActionButton dialog={(c) => <ActionDialog title={`Inaktivera – ${a.name}`} confirmLabel="Inaktivera" danger onClose={c} onDone={done(c)}
                  description="Sker direkt. Alla sessioner avslutas och kontot kan inte logga in." run={call(`/admins/${a.id}/disable`)} />}>Inaktivera</ActionButton>}
                {a.status === 'disabled' && <ActionButton dialog={(c) => <ActionDialog title={`Aktivera – ${a.name}`} confirmLabel="Begär aktivering" onClose={c} onDone={done(c)} description="Kräver godkännande." run={call(`/admins/${a.id}/enable`)} />}>Aktivera</ActionButton>}
              </div>}</td>
            </tr>);
        })}</tbody></table>
        {loading && !data && <div className="loading">Laddar…</div>}
      </div>
    </div>
  );
}
