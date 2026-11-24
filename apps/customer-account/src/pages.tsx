import { useState } from 'react';
import { api } from './api';
import { Alert, badge, ErrorBox, Field, LABEL, Modal, fmtDateTime, useLoad } from './ui';

export function Overview({ wid }: { wid: string }) {
  const ws = useLoad(() => api<any>('GET', `/workspaces/${wid}`), [wid]);
  const notes = useLoad(() => api<any>('GET', `/workspaces/${wid}/notifications`), [wid]);
  const [msg, setMsg] = useState<unknown>(null);
  if (ws.error) return <ErrorBox error={ws.error} />;
  if (!ws.data) return <div className="loading">Laddar…</div>;
  const { workspace: w, role, access } = ws.data;
  const canAct = role === 'owner' || role === 'admin';
  async function activate(product: string) {
    setMsg(null);
    try { await api('POST', `/workspaces/${wid}/products/${product}/activate`); ws.reload(); } catch (e) { setMsg(e); }
  }
  return (
    <div className="stack">
      <div className="page-head"><div><h1>{w.name}</h1><p>{LABEL.role[role]} · arbetsyta {LABEL.ws[w.status] ?? w.status}</p></div></div>
      {w.status !== 'Active' && <Alert kind="warn">Arbetsytan är {LABEL.ws[w.status]?.toLowerCase()}. Din data är bevarad. Kontakta supporten om du har frågor.</Alert>}
      {access?.subscription && <div className="card"><h2>Abonnemang</h2><p style={{ margin: 0 }}>Plan <strong>{access.subscription.planId}</strong> · {LABEL.sub[access.subscription.effectiveStatus] ?? access.subscription.effectiveStatus}
        {access.subscription.trialEndsAt && <> · provperioden slutar {fmtDateTime(access.subscription.trialEndsAt)}</>}
        {access.subscription.graceEndsAt && access.subscription.effectiveStatus === 'PastDue' && <> · betala senast {fmtDateTime(access.subscription.graceEndsAt)} för att behålla full åtkomst</>}</p></div>}
      {msg != null && <ErrorBox error={msg} />}
      <div className="grid cols-2">
        {access?.products.map((p: any) => (
          <div className="card" key={p.product}><h2>{LABEL.product[p.product]}</h2>
            <p style={{ marginTop: 0 }}><span className={`badge ${badge(p.mode)}`}>{LABEL.mode[p.mode]}</span></p>
            {Object.entries(p.limits).map(([k, lim]: any) => <div key={k} className="small muted">{k}: {p.usage?.[k] ?? 0} / {lim ?? 'obegränsat'}</div>)}
            {(p.entitlementStatus === null || p.entitlementStatus === 'Disabled') && canAct && <button className="btn small primary" style={{ marginTop: '.8rem' }} onClick={() => void activate(p.product)}>Aktivera</button>}
            {p.entitlementStatus === 'Suspended' && <div className="small muted" style={{ marginTop: '.6rem' }}>Avstängd av plattformen. Kontakta supporten.</div>}
          </div>))}
      </div>
      <div className="card"><h2>Notiser</h2>
        {notes.data?.items.length === 0 && <div className="muted">Inga notiser.</div>}
        <ul className="timeline">{notes.data?.items.map((n: any) => <li key={n.id}><strong>{n.title}</strong><div>{n.body}</div><div className="small muted">{fmtDateTime(n.createdAt)}</div></li>)}</ul></div>
    </div>
  );
}

export function Members({ wid, canAdd }: { wid: string; canAdd: boolean }) {
  const { data, error, reload } = useLoad(() => api<any>('GET', `/workspaces/${wid}/members`), [wid]);
  const [f, setF] = useState({ name: '', email: '' }); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  async function add(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api('POST', `/workspaces/${wid}/members`, f); setF({ name: '', email: '' }); reload(); } catch (x) { setErr(x); } finally { setBusy(false); }
  }
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Medlemmar</h1><p>Personer med tillgång till arbetsytan.</p></div></div>
      {error != null && <ErrorBox error={error} />}
      <div className="card flush table-wrap"><table><thead><tr><th>Namn</th><th>E-post</th><th>Roll</th><th>Konto</th></tr></thead>
        <tbody>{data?.items.map((m: any) => <tr key={m.userId}><td>{m.name}</td><td>{m.email}</td><td>{LABEL.role[m.role]}</td><td>{m.activated ? 'Aktiverat' : 'Inbjuden'}</td></tr>)}</tbody></table></div>
      {canAdd && <form className="card stack" onSubmit={add}><h2 style={{ margin: 0 }}>Bjud in medlem</h2>
        <div className="grid cols-2"><Field label="Namn"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field><Field label="E-post"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field></div>
        {err != null && <ErrorBox error={err} />}<div><button className="btn primary" disabled={busy}>Skicka inbjudan</button></div></form>}
    </div>
  );
}

export function SupportAccess({ wid }: { wid: string }) {
  const grants = useLoad(() => api<any>('GET', `/workspaces/${wid}/support-grants`), [wid]);
  const hist = useLoad(() => api<any>('GET', `/workspaces/${wid}/support-access`), [wid]);
  const [open, setOpen] = useState(false); const [hours, setHours] = useState(24); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const now = Date.now();
  const active = grants.data?.items.find((g: any) => g.scope === 'personal_data' && !g.revokedAt && new Date(g.expiresAt).getTime() > now);
  const reloadAll = () => { grants.reload(); hist.reload(); };
  async function grant() { setBusy(true); setErr(null); try { await api('POST', `/workspaces/${wid}/support-grants`, { hours }); setOpen(false); reloadAll(); } catch (e) { setErr(e); } finally { setBusy(false); } }
  async function revoke(id: string) { setErr(null); try { await api('DELETE', `/workspaces/${wid}/support-grants/${id}`); reloadAll(); } catch (e) { setErr(e); } }
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Supportåtkomst</h1><p>Du bestämmer om vår support får se personuppgifter i din arbetsyta.</p></div></div>
      <Alert kind="info">Supportpersonal har aldrig åtkomst till personuppgifter om du inte har gett ett tidsbegränsat godkännande. All supportåtkomst loggas och du informeras. Du kan återkalla godkännandet när som helst, och pågående sessioner avslutas direkt.</Alert>
      {err != null && <ErrorBox error={err} />}
      <div className="card"><h2>Godkännande för personuppgifter</h2>
        {active ? (<>
          <p style={{ marginTop: 0 }}><span className="badge good">Aktivt</span> till {fmtDateTime(active.expiresAt)} · godkänt av {active.grantedByName ?? 'okänd'}</p>
          <button className="btn danger" onClick={() => void revoke(active.id)}>Återkalla godkännandet</button></>) : (<>
          <p style={{ marginTop: 0 }}><span className="badge">Inget aktivt godkännande</span> Supporten kan bara se icke-personliga uppgifter (status, inställningar, tekniska fel).</p>
          <button className="btn primary" onClick={() => setOpen(true)}>Ge godkännande…</button></>)}
      </div>
      <AssistedGrant wid={wid} grants={grants.data?.items ?? []} onChange={reloadAll} onError={setErr} />
      <div className="card flush"><div style={{ padding: '1rem 1.25rem 0' }}><h2>Historik över supportåtkomst</h2></div>
        <div className="table-wrap"><table><thead><tr><th>Start</th><th>Supportpersonal</th><th>Ärende</th><th>Läge</th><th>Personuppgifter</th><th>Åtgärder</th><th>Slut</th></tr></thead>
          <tbody>{hist.data?.items.map((s: any) => <tr key={s.id}><td className="nowrap">{fmtDateTime(s.startedAt)}</td><td>{s.adminName}</td><td>#{s.caseNumber}</td><td>{s.mode === 'readonly' ? 'Endast läsning' : 'Assisterad'}</td><td>{s.personalData ? 'Ja' : 'Nej'}</td><td>{s.mode === 'assisted' ? s.actions : '–'}</td><td className="nowrap">{fmtDateTime(s.endedAt ?? s.expiresAt)}</td></tr>)}</tbody></table>
          {hist.data?.items.length === 0 && <div className="empty">Ingen supportåtkomst har skett.</div>}</div></div>
      <div className="card flush"><div style={{ padding: '1rem 1.25rem 0' }}><h2>Tidigare godkännanden</h2></div>
        <div className="table-wrap"><table><thead><tr><th>Skapat</th><th>Typ</th><th>Av</th><th>Giltigt till</th><th>Status</th></tr></thead>
          <tbody>{grants.data?.items.map((g: any) => <tr key={g.id}><td className="nowrap">{fmtDateTime(g.createdAt)}</td><td>{g.scope === 'assisted' ? 'Assisterad' : 'Personuppgifter'}</td><td>{g.grantedByName ?? '–'}</td><td className="nowrap">{fmtDateTime(g.expiresAt)}</td>
            <td>{g.revokedAt ? <span className="badge bad">Återkallat {fmtDateTime(g.revokedAt)}</span> : new Date(g.expiresAt).getTime() > now ? <span className="badge good">Aktivt</span> : <span className="badge">Utgånget</span>}</td></tr>)}</tbody></table>
          {grants.data?.items.length === 0 && <div className="empty">Inga godkännanden.</div>}</div></div>
      {open && <Modal title="Ge godkännande" onClose={() => setOpen(false)}>
        <p className="muted" style={{ marginTop: 0 }}>Supportpersonal får, endast läsande, se namn, e-post och (maskerade) telefonnummer för arbetsytans medlemmar under den tid du väljer.</p>
        <Field label="Giltighetstid"><select value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[1, 4, 24, 72].map((h) => <option key={h} value={h}>{h} {h === 1 ? 'timme' : 'timmar'}</option>)}</select></Field>
        {err != null && <ErrorBox error={err} />}
        <div className="actions"><button className="btn" onClick={() => setOpen(false)}>Avbryt</button><button className="btn primary" disabled={busy} onClick={() => void grant()}>Ge godkännande</button></div></Modal>}
    </div>
  );
}

const ACTION_CHOICES: [string, string][] = [
  ['change_setting', 'Ändra felaktig inställning (arbetsytans namn och kontaktuppgifter)'],
  ['enable_permission', 'Aktivera behörighet (göra en medlem till administratör eller tvärtom, aldrig ägare)'],
  ['configure_feature', 'Hjälpa till med konfiguration av funktion (slå på/av beta-funktioner)'],
];

function AssistedGrant({ wid, grants, onChange, onError }: { wid: string; grants: any[]; onChange: () => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false); const [hours, setHours] = useState(4); const [caseNo, setCaseNo] = useState('');
  const [actions, setActions] = useState<string[]>(['configure_feature']); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const active = grants.find((g) => g.scope === 'assisted' && !g.revokedAt && new Date(g.expiresAt).getTime() > Date.now());
  async function save() {
    setBusy(true); setErr(null);
    try { await api('POST', `/workspaces/${wid}/support-grants/assisted`, { hours, actions, ...(caseNo ? { supportCaseNumber: Number(caseNo) } : {}) }); setOpen(false); onChange(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function revoke(id: string) { try { await api('DELETE', `/workspaces/${wid}/support-grants/${id}`); onChange(); } catch (e) { onError(e); } }
  return (
    <div className="card"><h2>Godkännande för assisterad support</h2>
      <p className="muted" style={{ marginTop: 0 }}>Låter supportpersonal utföra särskilt angivna åtgärder åt dig. Betalningar, abonnemang, lösenord, MFA, radering och ägarbyte kan aldrig utföras. Du informeras om varje åtgärd.</p>
      {active ? (<>
        <p><span className="badge good">Aktivt</span> till {fmtDateTime(active.expiresAt)}{active.supportCaseId ? ' · bundet till ett ärende' : ''}</p>
        <ul>{(active.allowedActions as string[]).map((a) => <li key={a}>{ACTION_CHOICES.find((c) => c[0] === a)?.[1] ?? a}</li>)}</ul>
        <button className="btn danger" onClick={() => void revoke(active.id)}>Återkalla godkännandet</button></>) : (
        <button className="btn" onClick={() => setOpen(true)}>Godkänn assisterad support…</button>)}
      {open && <Modal title="Godkänn assisterad support" onClose={() => setOpen(false)}>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="muted">Tillåtna åtgärder</legend>
          {ACTION_CHOICES.map(([k, t]) => <label key={k} className="row small" style={{ alignItems: 'flex-start' }}><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={actions.includes(k)} onChange={(e) => setActions((a) => e.target.checked ? [...a, k] : a.filter((x) => x !== k))} /> {t}</label>)}
        </fieldset>
        <Field label="Giltighetstid"><select value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[1, 4, 24, 72].map((h) => <option key={h} value={h}>{h} {h === 1 ? 'timme' : 'timmar'}</option>)}</select></Field>
        <Field label="Ärendenummer (valfritt)" hint="Begränsar godkännandet till ett specifikt supportärende."><input value={caseNo} onChange={(e) => setCaseNo(e.target.value.replace(/\D/g, ''))} inputMode="numeric" /></Field>
        {err != null && <ErrorBox error={err} />}
        <div className="actions"><button className="btn" onClick={() => setOpen(false)}>Avbryt</button><button className="btn primary" disabled={busy || actions.length === 0} onClick={() => void save()}>Ge godkännande</button></div></Modal>}
    </div>
  );
}
