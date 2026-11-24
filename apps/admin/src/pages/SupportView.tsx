import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { label, relTime, fmtDateTime } from '../format';
import { ActionButton, ActionDialog, Alert, Badge, ErrorBox, PageHead, useLoad } from '../ui';

function useCountdown(seconds: number | undefined) {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => { setLeft(seconds ?? 0); const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000); return () => clearInterval(t); }, [seconds]);
  return left;
}

const ACTION_TEXT: Record<string, string> = {
  change_setting: 'Ändra felaktig inställning', enable_permission: 'Aktivera behörighet', configure_feature: 'Konfigurera funktion',
};

function AssistedPanel({ sessionId, d, onDone }: { sessionId: string; d: any; onDone: () => void }) {
  const allowed: string[] = d.allowedActions ?? [];
  const [flag, setFlag] = useState(d.featureFlags[0]?.key ?? ''); const [enabled, setEnabled] = useState(true);
  const [userId, setUserId] = useState(''); const [role, setRole] = useState('admin');
  const [contactName, setContactName] = useState(''); const [contactEmail, setContactEmail] = useState(''); const [name, setName] = useState('');
  const act = (body: Record<string, unknown>) => (reason: string) => api('POST', `/support/access-sessions/${sessionId}/actions`, { ...body, reason });
  const settingParams: Record<string, string> = {};
  if (name.trim()) settingParams.name = name.trim();
  if (contactName.trim()) settingParams.contactName = contactName.trim();
  if (contactEmail.trim()) settingParams.contactEmail = contactEmail.trim();
  return (
    <div className="card"><h2>Åtgärder för kundens räkning</h2>
      <Alert kind="info">Kunden har tillåtit: {allowed.map((a) => ACTION_TEXT[a] ?? a).join(', ')}. Varje åtgärd kräver orsak och MFA, loggas och kunden informeras. Betalning, abonnemang, lösenord/MFA, radering och ägarbyte är förbjudna i assisterat läge.</Alert>
      <div className="stack" style={{ marginTop: '.8rem' }}>
        {allowed.includes('configure_feature') && <div className="row"><strong style={{ minWidth: 190 }}>Konfigurera funktion</strong>
          <select aria-label="Funktionsflagga" value={flag} onChange={(e) => setFlag(e.target.value)} style={{ width: 'auto' }}>{d.featureFlags.map((f: any) => <option key={f.key} value={f.key}>{f.key}</option>)}</select>
          <select aria-label="Läge för flagga" value={enabled ? 'on' : 'off'} onChange={(e) => setEnabled(e.target.value === 'on')} style={{ width: 'auto' }}><option value="on">På</option><option value="off">Av</option></select>
          <ActionButton dialog={(c) => <ActionDialog title="Konfigurera funktion" confirmLabel="Utför" run={act({ action: 'configure_feature', params: { flagKey: flag, enabled } })} onClose={c} onDone={() => { c(); onDone(); }} />}>Utför</ActionButton></div>}
        {allowed.includes('enable_permission') && <div className="row"><strong style={{ minWidth: 190 }}>Aktivera behörighet</strong>
          <select aria-label="Medlem" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ width: 'auto' }}><option value="">Välj medlem…</option>{(d.assistedMembers ?? []).filter((m: any) => m.role !== 'owner').map((m: any) => <option key={m.userId} value={m.userId}>{m.name} ({label('memberRole', m.role)})</option>)}</select>
          <select aria-label="Ny roll" value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 'auto' }}><option value="admin">Administratör</option><option value="member">Medlem</option></select>
          {userId && <ActionButton dialog={(c) => <ActionDialog title="Ändra medlemmens roll" confirmLabel="Utför" run={act({ action: 'enable_permission', params: { userId, role } })} onClose={c} onDone={() => { c(); onDone(); }} />}>Utför</ActionButton>}</div>}
        {allowed.includes('change_setting') && <div className="row"><strong style={{ minWidth: 190 }}>Ändra inställning</strong>
          <input aria-label="Arbetsytans namn" placeholder="Namn" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 160 }} />
          <input aria-label="Kontaktperson" placeholder="Kontaktperson" value={contactName} onChange={(e) => setContactName(e.target.value)} style={{ width: 160 }} />
          <input aria-label="Kontakt-e-post" placeholder="Kontakt-e-post" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} style={{ width: 200 }} />
          {Object.keys(settingParams).length > 0 && <ActionButton dialog={(c) => <ActionDialog title="Ändra arbetsytans uppgifter" confirmLabel="Utför" run={act({ action: 'change_setting', params: settingParams })} onClose={c} onDone={() => { c(); setName(''); setContactName(''); setContactEmail(''); onDone(); }} />}>Utför</ActionButton>}</div>}
      </div>
    </div>
  );
}

export function SupportView() {
  const { sessionId } = useParams(); const nav = useNavigate();
  const { data: d, error, loading, reload } = useLoad(() => api<any>('GET', `/support/access-sessions/${sessionId}/view`), [sessionId]);
  const left = useCountdown(d?.session.remainingSeconds);
  if (loading && !d) return <div className="loading">Öppnar supportvy…</div>;
  if (error) return <div className="stack"><ErrorBox error={error} /><button className="btn" onClick={() => nav('/support')}>Tillbaka</button></div>;
  if (!d) return null;
  const mm = String(Math.floor(left / 60)).padStart(2, '0'); const ss = String(left % 60).padStart(2, '0');
  return (
    <div className="stack">
      <div className="banner-support" role="alert">
        <span>{d.session.mode === 'assisted' ? 'ASSISTERAD SUPPORTSESSION' : 'SKRIVSKYDDAD SUPPORTVY'} · {d.workspace.name} · Åtkomsten loggas och kunden är informerad</span>
        <span className="row"><strong>{left > 0 ? `Tid kvar ${mm}:${ss}` : 'Sessionen har löpt ut'}</strong>
          <ActionButton dialog={(c) => <ActionDialog title="Avsluta supportsession" confirmLabel="Avsluta" run={(reason) => api('POST', `/support/access-sessions/${sessionId}/end`, { reason })} onClose={c} onDone={() => nav('/support')} />}>Avsluta session</ActionButton></span>
      </div>
      <PageHead title={d.workspace.name} subtitle={d.notice} />
      <div className="grid cols-2">
        <div className="card"><h2>Arbetsyta</h2><dl className="kv"><dt>Typ</dt><dd>{label('kind', d.workspace.kind)}</dd><dt>Status</dt><dd><Badge group="workspaceStatus" value={d.workspace.status} /></dd><dt>Land</dt><dd>{d.workspace.country}</dd>
          <dt>Senast aktiv</dt><dd>{relTime(d.workspace.lastActivityAt)}</dd><dt>Villkorsversion</dt><dd>{d.workspace.termsVersion ?? '–'}</dd></dl></div>
        <div className="card"><h2>Abonnemang och produkter</h2>
          {d.subscription && <p style={{ marginTop: 0 }}>Plan <strong>{d.subscription.planId}</strong> · <Badge group="subscriptionStatus" value={d.subscription.effectiveStatus} /></p>}
          {d.products.map((p: any) => <div key={p.product} className="row between"><span>{label('product', p.product)}</span><span><Badge group="entitlementStatus" value={p.entitlementStatus} /> <Badge group="access" value={p.mode} /></span></div>)}</div>
        <div className="card"><h2>Roller</h2>{d.roleCounts.map((r: any) => <div key={r.role}>{label('memberRole', r.role)}: {r.n}</div>)}</div>
        <div className="card"><h2>Funktionsflaggor</h2>{d.featureFlags.map((f: any) => <div key={f.key} className="row between"><span className="mono">{f.key}</span><Badge group="entitlementStatus" value={f.enabled ? 'Enabled' : 'Disabled'} text={f.enabled ? 'På' : 'Av'} /></div>)}</div>
      </div>
      {d.session.mode === 'assisted' && <AssistedPanel sessionId={sessionId!} d={d} onDone={reload} />}
      {d.members ? (
        <div className="card flush table-wrap"><table><thead><tr><th>Namn</th><th>E-post</th><th>Telefon</th><th>Roll</th><th>Senast inloggad</th></tr></thead>
          <tbody>{d.members.map((m: any) => <tr key={m.userId}><td>{m.name}</td><td>{m.email}</td><td>{m.phone ?? '–'}</td><td>{label('memberRole', m.role)}</td><td>{relTime(m.lastLoginAt)}</td></tr>)}</tbody></table></div>
      ) : <Alert kind="info">Personuppgifter visas inte i den här sessionen (kunden har inte godkänt åtkomst eller så valdes det bort).</Alert>}
      <div className="card"><h2>Senaste tekniska fel</h2>
        {d.recentErrors.length === 0 ? <div className="muted">Inga fel.</div> : <ul className="timeline">{d.recentErrors.map((e: any, i: number) => <li key={i}><span className="mono">{e.code}</span> {e.message}<div className="small muted">{fmtDateTime(e.at)} · {e.route}</div></li>)}</ul>}</div>
    </div>
  );
}
