import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime, label } from '../format';
import { ActionButton, ActionDialog, Alert, Badge, ErrorBox, PageHead, useLoad } from '../ui';

export function Approvals() {
  const { can, me } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api<any>('GET', '/approvals'), []);
  return (
    <div className="stack">
      <PageHead title="Godkännanden" subtitle="Four-eyes: destruktiva åtgärder måste godkännas av en annan administratör inom 72 timmar." />
      {error != null && <ErrorBox error={error} />}
      {loading && !data && <div className="loading">Laddar…</div>}
      <div className="card flush table-wrap"><table>
        <thead><tr><th>Åtgärd</th><th>Mål</th><th>Orsak</th><th>Begärd av</th><th>Status</th><th>Giltig till</th><th /></tr></thead>
        <tbody>{data?.items.map((a: any) => (
          <tr key={a.id}>
            <td>{label('approvalAction', a.action)}</td><td>{a.targetName ?? a.targetId}</td><td style={{ maxWidth: 280 }}>{a.reason}</td><td>{a.requestedByName}<div className="small muted">{fmtDateTime(a.requestedAt)}</div></td>
            <td><Badge group="approvalStatus" value={a.status} />{a.selfApproved && <div className="small"><span className="badge warn">Självgodkänd</span></div>}{a.decidedByName && <div className="small muted">{a.decidedByName}</div>}</td>
            <td className="nowrap">{fmtDateTime(a.expiresAt)}</td>
            <td className="nowrap">{a.status === 'pending' && can('approvals.decide') && (<div className="row">
              <ActionButton dialog={(c) => <ActionDialog title="Godkänn och utför" description={<>{label('approvalAction', a.action)}: <strong>{a.targetName}</strong>. Åtgärden utförs direkt. {a.requestedBy === me.admin?.id && <Alert kind="warn">Du är själv initiativtagare. Självgodkännande tillåts bara när färre än två behöriga godkännare finns och flaggas i loggen.</Alert>}</>} confirmLabel="Godkänn" danger needReason={false} run={() => api('POST', `/approvals/${a.id}/approve`, {})} onClose={c} onDone={() => { c(); reload(); }} />}>Godkänn</ActionButton>
              <ActionButton dialog={(c) => <ActionDialog title="Avslå begäran" confirmLabel="Avslå" needReason={false} run={() => api('POST', `/approvals/${a.id}/reject`, {})} onClose={c} onDone={() => { c(); reload(); }} />}>Avslå</ActionButton></div>)}</td>
          </tr>))}</tbody></table>
        {data && data.items.length === 0 && <div className="empty">Inga godkännanden.</div>}</div>
    </div>
  );
}
