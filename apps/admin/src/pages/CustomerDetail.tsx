import { Fragment } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { auditLabel, fmtDate, fmtDateTime, label, LABELS, relTime } from '../format';
import { ActionButton, ActionDialog, Alert, Badge, ErrorBox, Field, PageHead, Tabs, useLoad, useToast } from '../ui';

export function CustomerDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useState('overview');
  const { data: d, error, loading, reload } = useLoad(() => api<any>('GET', `/workspaces/${id}`), [id]);
  if (loading && !d) return <div className="loading">Laddar kund…</div>;
  if (error) return <ErrorBox error={error} />;
  if (!d) return null;
  const w = d.workspace;
  const done = () => reload();
  const post = (path: string, extra: object = {}) => (reason: string) => api('POST', `/workspaces/${id}${path}`, { reason, ...extra });
  const tabs = [
    { id: 'overview', label: 'Översikt' },
    ...(d.access ? [{ id: 'products', label: 'Produkter och abonnemang' }] : []),
    ...(can('users.view') ? [{ id: 'members', label: `Användare (${d.memberCount})` }] : []),
    ...(can('support.view') ? [{ id: 'support', label: 'Support' }] : []),
    ...(can('workspaces.notes') ? [{ id: 'notes', label: 'Anteckningar' }] : []),
    ...(can('audit.view') ? [{ id: 'history', label: 'Historik' }] : []),
    ...(can('logs.view') ? [{ id: 'errors', label: 'Tekniska fel' }] : []),
  ];

  return (
    <div className="stack">
      <PageHead title={w.name} subtitle={<><Badge group="workspaceStatus" value={w.status} /> <span className="muted">· {label('kind', w.kind)} · skapad {fmtDate(w.createdAt)}</span></>}>
        <ActionButton allowed={can('workspaces.update')} dialog={(c) => <EditDialog w={w} onClose={c} onDone={() => { c(); done(); }} />}>Redigera uppgifter</ActionButton>
        {w.status === 'Active' && (
          <ActionButton allowed={can('workspaces.suspend')} dialog={(c) => (
            <ActionDialog title="Pausa arbetsytan" description="Användarna kan inte logga in i arbetsytan förrän den återaktiveras. Ingen data raderas." confirmLabel="Pausa" danger run={post('/suspend')} onClose={c} onDone={() => { c(); done(); }} />)}>Pausa</ActionButton>
        )}
        {w.status === 'Suspended' && (
          <ActionButton allowed={can('workspaces.suspend')} dialog={(c) => <ActionDialog title="Återaktivera arbetsytan" confirmLabel="Återaktivera" run={post('/reactivate')} onClose={c} onDone={() => { c(); done(); }} />}>Återaktivera</ActionButton>
        )}
        {w.status !== 'Closed' && (
          <ActionButton allowed={can('workspaces.close')} btnClass="" dialog={(c) => (
            <ActionDialog title="Avsluta arbetsytan" description="Avslutning kräver godkännande av en andra administratör (four-eyes). Data raderas inte automatiskt – kunden får exportera enligt gällande villkor." confirmLabel="Begär avslut" danger run={post('/close')} onClose={c} onDone={() => { c(); done(); }} />)}>Avsluta…</ActionButton>
        )}
      </PageHead>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="grid cols-2">
          <div className="card"><h2>Kunduppgifter</h2>
            <dl className="kv">
              <dt>ID</dt><dd className="mono">{w.id}</dd><dt>Kontaktperson</dt><dd>{w.contactName}</dd><dt>E-post</dt><dd>{w.contactEmail}</dd>
              <dt>Org.nummer</dt><dd>{w.orgNumber ?? '–'}</dd><dt>Moms-ID</dt><dd>{w.vatId ?? '–'}</dd><dt>Land</dt><dd>{w.country}</dd>
              <dt>Senast aktiv</dt><dd>{relTime(w.lastActivityAt)}</dd>
            </dl>
          </div>
          {d.access && (
            <div className="card"><h2>Åtkomst just nu</h2>
              {d.access.subscription && <p style={{ marginTop: 0 }}>Plan <strong>{d.access.subscription.planId}</strong> · <Badge group="subscriptionStatus" value={d.access.subscription.effectiveStatus} /></p>}
              <dl className="kv">{d.access.products.map((p: any) => <Fragment key={p.product}><dt>{label('product', p.product)}</dt><dd><Badge group="access" value={p.mode} /></dd></Fragment>)}</dl>
              <p className="small muted">Åtkomsten är den mest restriktiva kombinationen av arbetsyta, abonnemang och produktlicens.</p>
            </div>
          )}
          {can('workspaces.suspend') && (
            <div className="card"><h2>Säkerhet</h2>
              <p className="muted" style={{ marginTop: 0 }}>Återkalla alla aktiva kundsessioner i arbetsytan (t.ex. vid misstänkt kontoöverlåtelse).</p>
              <ActionButton allowed={can('users.lock')} dialog={(c) => <ActionDialog title="Återkalla alla sessioner" confirmLabel="Återkalla" danger run={post('/revoke-sessions')} onClose={c} onDone={() => { c(); done(); }} />}>Återkalla sessioner</ActionButton>
            </div>
          )}
        </div>
      )}

      {tab === 'products' && d.access && <ProductsTab d={d} id={id!} onDone={done} can={can} />}

      {tab === 'members' && (
        <div className="card flush table-wrap"><table>
          <thead><tr><th>Namn</th><th>E-post</th><th>Roll</th><th>Status</th><th>Senast inloggad</th></tr></thead>
          <tbody>{d.members.map((m: any) => <tr key={m.userId}><td><Link to={`/users/${m.userId}`}>{m.name}</Link></td><td>{m.email}</td><td>{label('memberRole', m.role)}</td><td><Badge group="userStatus" value={m.status} /></td><td>{relTime(m.lastLoginAt)}</td></tr>)}</tbody>
        </table>{d.members.length === 0 && <div className="empty">Inga medlemmar.</div>}</div>
      )}

      {tab === 'support' && <SupportTab d={d} id={id!} can={can} />}
      {tab === 'notes' && <NotesTab d={d} id={id!} onDone={done} />}

      {tab === 'history' && (
        <div className="card"><ul className="timeline">{d.events.map((e: any) => (
          <li key={e.id}><strong>{auditLabel(e.action)}</strong> <span className="muted">· {e.adminEmail ?? 'system'} · {fmtDateTime(e.at)}</span>{e.reason && <div className="small">Orsak: {e.reason}</div>}</li>))}
        </ul>{d.events.length === 0 && <div className="empty">Inga händelser.</div>}<Link to={`/audit?workspaceId=${id}`}>Öppna hela granskningsloggen</Link></div>
      )}

      {tab === 'errors' && (
        <div className="card flush table-wrap"><table><thead><tr><th>Tid</th><th>Kod</th><th>Meddelande</th><th>Rutt</th><th>Referens</th></tr></thead>
          <tbody>{d.errors.map((e: any) => <tr key={e.id}><td className="nowrap">{fmtDateTime(e.at)}</td><td className="mono">{e.code}</td><td>{e.message}</td><td className="mono">{e.route}</td><td className="mono">{e.requestId}</td></tr>)}</tbody></table>
          {d.errors.length === 0 && <div className="empty">Inga fel för den här kunden.</div>}</div>
      )}
    </div>
  );
}

function EditDialog({ w, onClose, onDone }: { w: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: w.name, contactName: w.contactName, contactEmail: w.contactEmail, orgNumber: w.orgNumber ?? '', vatId: w.vatId ?? '', country: w.country });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <ActionDialog title="Redigera kunduppgifter" confirmLabel="Spara" onClose={onClose} onDone={onDone}
      run={(reason) => api('PATCH', `/workspaces/${w.id}`, { reason, name: f.name, contactName: f.contactName, contactEmail: f.contactEmail, orgNumber: f.orgNumber || null, vatId: f.vatId || null, country: f.country })}
      extra={<div className="grid cols-2">
        <Field label="Namn"><input value={f.name} onChange={set('name')} required /></Field>
        <Field label="Kontaktperson"><input value={f.contactName} onChange={set('contactName')} required /></Field>
        <Field label="Kontakt-e-post"><input type="email" value={f.contactEmail} onChange={set('contactEmail')} required /></Field>
        <Field label="Org.nummer"><input value={f.orgNumber} onChange={set('orgNumber')} /></Field>
        <Field label="Moms-ID"><input value={f.vatId} onChange={set('vatId')} /></Field>
        <Field label="Land (2 tecken)"><input value={f.country} maxLength={2} onChange={set('country')} required /></Field>
      </div>} />
  );
}

function ProductsTab({ d, id, onDone, can }: any) {
  const sub = d.access.subscription;
  const plans = useLoad(() => api<any>('GET', '/plans'), []);
  const [planId, setPlanId] = useState('');
  const subAct = (action: string, extra: object = {}) => (reason: string) => api('POST', `/workspaces/${id}/subscription`, { reason, action, ...extra });
  const entAct = (product: string, action: string, extra: object = {}) => (reason: string) => api('POST', `/workspaces/${id}/entitlements/${product}`, { reason, action, ...extra });
  const paid = (plans.data?.items ?? []).filter((p: any) => p.active && !p.isTrial);

  return (
    <div className="stack">
      {sub && (
        <div className="card"><h2>Abonnemang</h2>
          <dl className="kv">
            <dt>Plan</dt><dd>{sub.planId}</dd><dt>Status</dt><dd><Badge group="subscriptionStatus" value={sub.effectiveStatus} /></dd>
            {sub.trialEndsAt && <><dt>Provperiod till</dt><dd>{fmtDateTime(sub.trialEndsAt)}</dd></>}
            {sub.currentPeriodEnd && <><dt>Period slutar</dt><dd>{fmtDateTime(sub.currentPeriodEnd)}</dd></>}
            {sub.pastDueSince && <><dt>Förfallen sedan</dt><dd>{fmtDateTime(sub.pastDueSince)}{sub.graceEndsAt && <> · kulanstid till {fmtDateTime(sub.graceEndsAt)}</>}</dd></>}
          </dl>
          {can('subscriptions.manage') && (
            <div className="row" style={{ marginTop: '1rem' }}>
              {sub.effectiveStatus === 'Trialing' && <ActionButton dialog={(c) => <ActionDialog title="Förläng provperiod" description="Förlänger med 7 dagar." confirmLabel="Förläng" run={subAct('extend_trial', { days: 7 })} onClose={c} onDone={() => { c(); onDone(); }} />}>Förläng provperiod (7 d)</ActionButton>}
              <ActionButton dialog={(c) => (
                <ActionDialog title={sub.status === 'Trialing' ? 'Aktivera betalplan' : 'Byt plan'} confirmLabel="Spara" run={(r) => api('POST', `/workspaces/${id}/subscription`, { reason: r, action: sub.status === 'Trialing' ? 'activate' : 'change_plan', planId })} onClose={c} onDone={() => { c(); onDone(); }}
                  extra={<Field label="Plan"><select value={planId} onChange={(e) => setPlanId(e.target.value)} required><option value="">Välj plan…</option>{paid.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>} />)}>
                {sub.status === 'Trialing' ? 'Aktivera betalplan' : 'Byt plan'}</ActionButton>
              {sub.status === 'Active' && <ActionButton dialog={(c) => <ActionDialog title="Pausa abonnemanget" confirmLabel="Pausa" run={subAct('pause')} onClose={c} onDone={() => { c(); onDone(); }} />}>Pausa</ActionButton>}
              {sub.status === 'Paused' && <ActionButton dialog={(c) => <ActionDialog title="Återuppta abonnemanget" confirmLabel="Återuppta" run={subAct('resume')} onClose={c} onDone={() => { c(); onDone(); }} />}>Återuppta</ActionButton>}
              {sub.status === 'Active' && <ActionButton dialog={(c) => <ActionDialog title="Säg upp vid periodens slut" confirmLabel="Säg upp" danger run={subAct('cancel_at_period_end')} onClose={c} onDone={() => { c(); onDone(); }} />}>Säg upp vid periodslut</ActionButton>}
              {sub.status === 'CanceledAtPeriodEnd' && <ActionButton dialog={(c) => <ActionDialog title="Ångra uppsägning" confirmLabel="Ångra" run={subAct('undo_cancel')} onClose={c} onDone={() => { c(); onDone(); }} />}>Ångra uppsägning</ActionButton>}
              {sub.status === 'Active' && <ActionButton dialog={(c) => <ActionDialog title="Markera som förfallen betalning" description="Startar kulanstiden. Kunden får besked." confirmLabel="Markera" danger run={subAct('mark_past_due')} onClose={c} onDone={() => { c(); onDone(); }} />}>Markera förfallen</ActionButton>}
              {sub.status !== 'Expired' && <ActionButton dialog={(c) => <ActionDialog title="Avsluta abonnemanget direkt" description="Åtkomsten blir endast export. Ingen data raderas." confirmLabel="Avsluta" danger run={subAct('expire')} onClose={c} onDone={() => { c(); onDone(); }} />}>Avsluta direkt</ActionButton>}
            </div>
          )}
        </div>
      )}
      <div className="grid cols-2">
        {d.access.products.map((p: any) => (
          <div className="card" key={p.product}><h2>{label('product', p.product)}</h2>
            <dl className="kv">
              <dt>Licens</dt><dd>{p.entitlementStatus ? <Badge group="entitlementStatus" value={p.entitlementStatus} /> : <span className="muted">Aldrig aktiverad</span>}</dd>
              <dt>Åtkomst</dt><dd><Badge group="access" value={p.mode} /></dd>
              {p.expiresAt && <><dt>Utgår</dt><dd>{fmtDateTime(p.expiresAt)}</dd></>}
              {Object.entries(p.limits).map(([k, lim]: any) => <Fragment key={k}><dt>{(LABELS.limit as any)[k] ?? k}</dt><dd>{p.usage?.[k] ?? 0} / {lim === null ? 'obegränsat' : lim}</dd></Fragment>)}
            </dl>
            {can('entitlements.manage') && (
              <div className="row" style={{ marginTop: '1rem' }}>
                {(p.entitlementStatus === null || p.entitlementStatus === 'Disabled' || p.entitlementStatus === 'Suspended') && <ActionButton dialog={(c) => <ActionDialog title={`Aktivera ${label('product', p.product)}`} description="Befintlig data bevaras. Produkten kan aktiveras och inaktiveras utan dataförlust." confirmLabel="Aktivera" run={entAct(p.product, 'enable')} onClose={c} onDone={() => { c(); onDone(); }} />}>Aktivera</ActionButton>}
                {(p.entitlementStatus === 'Enabled' || p.entitlementStatus === 'LimitExceeded') && <>
                  <ActionButton dialog={(c) => <ActionDialog title="Stäng av tillfälligt" confirmLabel="Stäng av" danger run={entAct(p.product, 'suspend')} onClose={c} onDone={() => { c(); onDone(); }} />}>Stäng av</ActionButton>
                  <ActionButton dialog={(c) => <ActionDialog title="Inaktivera produkt" description="Data raderas inte. Åtkomsten blir endast export." confirmLabel="Inaktivera" danger run={entAct(p.product, 'disable')} onClose={c} onDone={() => { c(); onDone(); }} />}>Inaktivera</ActionButton>
                </>}
                {p.entitlementStatus && <LimitsButton product={p} onSave={(limits) => (reason: string) => api('POST', `/workspaces/${id}/entitlements/${p.product}`, { reason, action: 'set_limits', limits })} onDone={onDone} />}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LimitsButton({ product, onSave, onDone }: { product: any; onSave: (l: Record<string, number | null>) => (r: string) => Promise<any>; onDone: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(Object.entries(product.limits).map(([k, v]) => [k, v === null ? '' : String(v)])));
  return (
    <ActionButton dialog={(c) => (
      <ActionDialog title="Ändra gränser" description="Tomt värde = obegränsat. Gäller som override mot planens gränser." confirmLabel="Spara gränser"
        run={(r) => onSave(Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.trim() === '' ? null : Number(v)])))(r)} onClose={c} onDone={() => { c(); onDone(); }}
        extra={<div className="grid cols-2">{Object.keys(product.limits).map((k) => <Field key={k} label={(LABELS.limit as any)[k] ?? k}><input type="number" min={0} value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></Field>)}</div>} />)}>Ändra gränser</ActionButton>
  );
}

function SupportTab({ d, id, can }: any) {
  const nav = useNavigate();
  const [selCase, setSelCase] = useState('');
  const [pd, setPd] = useState(false); const [mode, setMode] = useState('readonly');
  const [minutes, setMinutes] = useState(30);
  const open = d.cases.filter((c: any) => !['Resolved', 'Closed'].includes(c.status));
  return (
    <div className="stack">
      <div className="card"><div className="row between"><h2 style={{ margin: 0 }}>Ärenden</h2>
        {can('support.manage') && <ActionButton dialog={(c) => <NewCaseDialog workspaceId={id} onClose={c} onDone={(r) => { c(); nav(`/support/cases/${r.id}`); }} />}>Nytt ärende</ActionButton>}</div>
        <ul className="timeline">{d.cases.map((c: any) => <li key={c.id}><Link to={`/support/cases/${c.id}`}>#{c.number} {c.subject}</Link> <Badge group="caseStatus" value={c.status} /> <Badge group="priority" value={c.priority} /><div className="small muted">{fmtDateTime(c.createdAt)}</div></li>)}</ul>
        {d.cases.length === 0 && <div className="empty">Inga ärenden.</div>}
      </div>
      {can('support.access_readonly') && (
        <div className="card"><h2>Supportåtkomst</h2>
          <Alert kind="info">Kräver ett öppet ärende och en orsak. Sessionen är tidsbegränsad, loggas och kunden informeras. Personuppgifter kräver kundens godkännande.</Alert>
          <div className="row" style={{ marginTop: '.8rem' }}>
            <select aria-label="Ärende" value={selCase} onChange={(e) => setSelCase(e.target.value)} style={{ maxWidth: 360 }}><option value="">Välj ärende…</option>{open.map((c: any) => <option key={c.id} value={c.id}>#{c.number} {c.subject}</option>)}</select>
            {can('support.access_assisted') && <label className="row small">Läge <select aria-label="Läge" value={mode} onChange={(e) => { setMode(e.target.value); if (e.target.value === 'assisted') { setPd(false); setMinutes((m) => Math.min(m, 60)); } }} style={{ width: 'auto' }}><option value="readonly">Endast läsning</option><option value="assisted">Assisterad (kräver kundens godkännande)</option></select></label>}
            {mode === 'readonly' && <label className="row small"><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={pd} onChange={(e) => setPd(e.target.checked)} /> Inkludera personuppgifter</label>}
            <label className="row small">Minuter <input type="number" min={5} max={mode === 'assisted' ? 60 : 120} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} style={{ width: 80 }} /></label>
            {selCase && <ActionButton dialog={(c) => <ActionDialog title="Starta supportåtkomst" description={mode === 'assisted' ? 'Kunden måste först ha godkänt assisterad support. Kunden får en notis och informeras om varje åtgärd.' : 'Kunden får en notis om att supportpersonal har fått läsåtkomst.'} confirmLabel="Starta session" run={(reason) => api('POST', '/support/access-sessions', { workspaceId: id, supportCaseId: selCase, reason, minutes, mode, includePersonalData: pd })} onClose={c} onDone={(r) => { c(); nav(`/support/access/${r.id}`); }} />}>Starta session</ActionButton>}
          </div>
        </div>
      )}
      <div className="card"><h2>Tidigare supportsessioner</h2>
        <ul className="timeline">{d.supportAccess.map((s: any) => <li key={s.id}>{s.adminName} · {fmtDateTime(s.startedAt)} → {s.endedAt ? fmtDateTime(s.endedAt) : fmtDateTime(s.expiresAt)}{s.personalData && ' · personuppgifter'}{s.endedReason && <span className="muted"> ({s.endedReason})</span>}</li>)}</ul>
        {d.supportAccess.length === 0 && <div className="empty">Inga sessioner.</div>}
      </div>
    </div>
  );
}

export function NewCaseDialog({ workspaceId, userId, onClose, onDone }: { workspaceId?: string; userId?: string; onClose: () => void; onDone: (r: any) => void }) {
  const [f, setF] = useState({ subject: '', description: '', category: 'other', priority: 'normal' });
  return (
    <ActionDialog title="Nytt supportärende" confirmLabel="Skapa ärende" needReason={false} onClose={onClose} onDone={onDone}
      run={() => api('POST', '/support/cases', { ...f, workspaceId: workspaceId ?? null, userId: userId ?? null })}
      extra={<>
        <Field label="Ämne"><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} required minLength={3} /></Field>
        <Field label="Beskrivning"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid cols-2">
          <Field label="Kategori"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{Object.entries(LABELS.category).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Prioritet"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.entries(LABELS.priority).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        </div></>} />
  );
}

function NotesTab({ d, id, onDone }: any) {
  const [body, setBody] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const toast = useToast();
  async function add(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('POST', `/workspaces/${id}/notes`, { body }); setBody(''); toast('Anteckning sparad.', 'good'); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  return (
    <div className="stack">
      <form className="card stack" onSubmit={add}><Field label="Ny intern anteckning" hint="Syns bara för administratörer."><textarea value={body} onChange={(e) => setBody(e.target.value)} required maxLength={5000} /></Field>
        {err != null && <ErrorBox error={err} />}<div><button className="btn primary" disabled={busy || !body.trim()}>Spara anteckning</button></div></form>
      {d.notes.map((n: any) => <div key={n.id} className="comment internal"><div className="small muted">{n.adminName} · {fmtDateTime(n.createdAt)}</div><div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div></div>)}
    </div>
  );
}
