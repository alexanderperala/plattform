import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { ActionButton, ActionDialog, Alert, Badge, ErrorBox, Field, PageHead, useDebounced, useLoad } from '../ui';

function OverrideDialog({ flagKey, onClose, onDone }: { flagKey: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState(''); const q = useDebounced(text);
  const [ws, setWs] = useState(''); const [enabled, setEnabled] = useState(true);
  const found = useLoad(() => q.length >= 2 ? api<any>('GET', '/workspaces' + qs({ q, pageSize: 8 })) : Promise.resolve({ items: [] }), [q]);
  return (
    <ActionDialog title={`Överstyr ${flagKey} för en kund`} confirmLabel="Spara överstyrning" onClose={onClose} onDone={() => { onClose(); onDone(); }}
      run={(reason) => api('PUT', `/workspaces/${ws}/flags/${flagKey}`, { enabled, reason })}
      extra={<>
        <Field label="Sök kund"><input type="search" value={text} onChange={(e) => { setText(e.target.value); setWs(''); }} placeholder="Minst två tecken" /></Field>
        <Field label="Kund"><select value={ws} onChange={(e) => setWs(e.target.value)} required><option value="">Välj kund…</option>{found.data?.items.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
        <Field label="Värde"><select value={enabled ? 'on' : 'off'} onChange={(e) => setEnabled(e.target.value === 'on')}><option value="on">På</option><option value="off">Av</option></select></Field>
      </>} />
  );
}

export function Flags() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api<any>('GET', '/flags'), []);
  const manage = can('flags.manage');
  return (
    <div className="stack">
      <PageHead title="Funktionsflaggor" subtitle="Standardvärde för alla kunder och överstyrning per kund. Alla ändringar kräver orsak och loggas." />
      {!manage && <Alert kind="info">Din roll kan se flaggorna men inte ändra dem.</Alert>}
      {error != null && <ErrorBox error={error} />}
      {loading && !data && <div className="loading">Laddar…</div>}
      {data?.items.map((f: any) => (
        <div className="card" key={f.key}>
          <div className="row between">
            <div><h2 style={{ margin: 0 }} className="mono">{f.key}</h2><div className="muted small">{f.description}</div></div>
            <div className="row"><span className="small">Standard:</span> <Badge group="entitlementStatus" value={f.defaultEnabled ? 'Enabled' : 'Disabled'} text={f.defaultEnabled ? 'På' : 'Av'} />
              {manage && <ActionButton dialog={(c) => <ActionDialog title={`Ändra standardvärde för ${f.key}`} description={`Påverkar alla kunder utan egen överstyrning. Nytt värde: ${f.defaultEnabled ? 'Av' : 'På'}.`} confirmLabel="Ändra standard" run={(reason) => api('PATCH', `/flags/${f.key}`, { defaultEnabled: !f.defaultEnabled, reason })} onClose={c} onDone={() => { c(); reload(); }} />}>{f.defaultEnabled ? 'Stäng av som standard' : 'Slå på som standard'}</ActionButton>}</div>
          </div>
          <h3 style={{ marginBottom: '.3rem' }}>Överstyrningar per kund ({f.overrides.length})</h3>
          {f.overrides.length === 0 ? <div className="muted small">Inga. Alla kunder följer standardvärdet.</div> : (
            <div className="table-wrap"><table><thead><tr><th>Kund</th><th>Värde</th>{manage && <th></th>}</tr></thead>
              <tbody>{f.overrides.map((o: any) => <tr key={o.workspaceId}><td><Link to={`/customers/${o.workspaceId}`}>{o.workspaceName}</Link></td>
                <td><Badge group="entitlementStatus" value={o.enabled ? 'Enabled' : 'Disabled'} text={o.enabled ? 'På' : 'Av'} /></td>
                {manage && <td><ActionButton dialog={(c) => <ActionDialog title="Ta bort överstyrning" description={`${o.workspaceName} följer därefter standardvärdet.`} confirmLabel="Ta bort" run={(reason) => api('PUT', `/workspaces/${o.workspaceId}/flags/${f.key}`, { enabled: null, reason })} onClose={c} onDone={() => { c(); reload(); }} />}>Ta bort</ActionButton></td>}</tr>)}</tbody></table></div>)}
          {manage && <div style={{ marginTop: '.6rem' }}><ActionButton dialog={(c) => <OverrideDialog flagKey={f.key} onClose={c} onDone={reload} />}>Lägg till överstyrning…</ActionButton></div>}
        </div>))}
    </div>
  );
}
