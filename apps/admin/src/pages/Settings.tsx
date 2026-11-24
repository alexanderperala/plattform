import { useState } from 'react';
import { api } from '../api';
import { fmtDateTime } from '../format';
import { ActionButton, ActionDialog, Alert, ErrorBox, Field, PageHead, useLoad } from '../ui';

function EditDialog({ s, onClose, onDone }: { s: any; onClose: () => void; onDone: () => void }) {
  const [val, setVal] = useState<string>(String(s.value));
  const parsed = s.type === 'bool' ? val === 'true' : Number(val);
  return (
    <ActionDialog title={s.label} description={s.description} confirmLabel="Spara" onClose={onClose} onDone={() => { onClose(); onDone(); }}
      run={(reason) => api('PATCH', `/settings/${s.key}`, { value: parsed, reason })}
      extra={s.type === 'bool'
        ? <Field label="Värde"><select value={val} onChange={(e) => setVal(e.target.value)}><option value="true">På</option><option value="false">Av</option></select></Field>
        : <Field label={`Värde (${s.min}–${s.max} ${s.unit})`}><input type="number" min={s.min} max={s.max} step={1} value={val} onChange={(e) => setVal(e.target.value)} required /></Field>} />
  );
}

export function Settings() {
  const { data, error, loading, reload } = useLoad(() => api<any>('GET', '/settings'), []);
  return (
    <div className="stack">
      <PageHead title="Systeminställningar" subtitle="Plattformsövergripande inställningar. Varje ändring kräver orsak och ny MFA-bekräftelse, och loggas med gammalt och nytt värde." />
      <Alert kind="info">Ingen inställning kan göra att kunddata raderas automatiskt. Gallring skapar bara kandidater och kräver four-eyes-godkännande.</Alert>
      {error != null && <ErrorBox error={error} />}
      {loading && !data && <div className="loading">Laddar…</div>}
      {data && <div className="card flush table-wrap"><table><thead><tr><th>Inställning</th><th>Värde</th><th>Senast ändrad</th><th></th></tr></thead>
        <tbody>{data.items.map((s: any) => <tr key={s.key}>
          <td><strong>{s.label}</strong><div className="muted small">{s.description}</div><div className="mono small muted">{s.key}</div></td>
          <td className="nowrap">{s.type === 'bool' ? (s.value ? 'På' : 'Av') : `${s.value} ${s.unit}`}</td>
          <td className="small">{s.updatedAt ? <>{fmtDateTime(s.updatedAt)}<div className="muted">{s.updatedByName ?? ''}</div></> : <span className="muted">Standardvärde</span>}</td>
          <td><ActionButton dialog={(c) => <EditDialog s={s} onClose={c} onDone={reload} />}>Ändra</ActionButton></td></tr>)}</tbody></table></div>}
    </div>
  );
}
