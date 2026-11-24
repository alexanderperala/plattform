import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import { useAuth } from '../auth';
import { Alert, ErrorBox, Field } from '../ui';

export function LoginPage() {
  const { me, refresh, logout } = useAuth();
  if (me.stage === 'mfa_pending') return <Verify onDone={refresh} onCancel={logout} />;
  if (me.stage === 'mfa_enroll') return <Enroll onDone={refresh} onCancel={logout} />;
  return <Password onDone={refresh} />;
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="auth-wrap"><div className="auth-card"><h1>{title}</h1>{sub && <p className="muted" style={{ margin: 0 }}>{sub}</p>}{children}</div></div>
  );
}

function Password({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api('POST', '/auth/login', { email, password }); await onDone(); } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <Card title="Superadmin" sub="Logga in med ditt administratörskonto.">
      <form onSubmit={submit}>
        <Field label="E-post"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Lösenord"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        {error != null && <ErrorBox error={error} />}
        <button className="btn primary" disabled={busy}>{busy ? 'Loggar in…' : 'Fortsätt'}</button>
      </form>
    </Card>
  );
}

function Verify({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => Promise<void> }) {
  const [code, setCode] = useState(''); const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api<any>('POST', '/auth/mfa/verify', useRecovery ? { recoveryCode: code } : { code });
      if (r.lowRecoveryCodes) setWarn(`Du har bara ${r.recoveryCodesLeft} återställningskoder kvar.`);
      await onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <Card title="Tvåstegsverifiering" sub={useRecovery ? 'Ange en av dina återställningskoder. Varje kod fungerar en gång.' : 'Ange 6-siffrig kod från din autentiseringsapp.'}>
      <form onSubmit={submit}>
        <Field label={useRecovery ? 'Återställningskod' : 'Kod'}>
          <input value={code} onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode={useRecovery ? 'text' : 'numeric'} autoComplete="one-time-code" required autoFocus />
        </Field>
        {warn && <Alert kind="warn">{warn}</Alert>}
        {error != null && <ErrorBox error={error} />}
        <button className="btn primary" disabled={busy}>{busy ? 'Verifierar…' : 'Verifiera'}</button>
        <button type="button" className="btn ghost" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>
          {useRecovery ? 'Använd autentiseringsapp' : 'Använd återställningskod'}
        </button>
        <button type="button" className="btn ghost" onClick={() => void onCancel()}>Avbryt</button>
      </form>
    </Card>
  );
}

function Enroll({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => Promise<void> }) {
  const [info, setInfo] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [qr, setQr] = useState('');
  const [code, setCode] = useState(''); const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<any>('POST', '/auth/mfa/enroll/start').then(async (r) => { setInfo(r); setQr(await QRCode.toDataURL(r.otpauthUri, { width: 200, margin: 1 })); }).catch(setError);
  }, []);
  async function confirm(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { const r = await api<any>('POST', '/auth/mfa/enroll/confirm', { code }); setCodes(r.recoveryCodes); } catch (err) { setError(err); } finally { setBusy(false); }
  }
  if (codes) {
    return (
      <Card title="Spara dina återställningskoder" sub="Koderna visas bara en gång. Förvara dem säkert (t.ex. i en lösenordshanterare). Varje kod fungerar en gång om du tappar bort din enhet.">
        <div className="recovery" style={{ marginTop: '1rem' }}>{codes.map((c) => <span key={c}>{c}</span>)}</div>
        <button className="btn primary" style={{ marginTop: '1rem' }} onClick={() => void onDone()}>Jag har sparat koderna</button>
      </Card>
    );
  }
  return (
    <Card title="Aktivera tvåstegsverifiering" sub="MFA krävs för alla administratörer. Skanna QR-koden i din autentiseringsapp.">
      {info && (
        <form onSubmit={confirm}>
          {qr && <img className="qr" src={qr} alt="QR-kod för autentiseringsappen" />}
          <p className="small muted" style={{ margin: 0 }}>Kan du inte skanna? Ange nyckeln manuellt: <span className="mono">{info.secret}</span></p>
          <Field label="Kod från appen"><input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" required autoComplete="one-time-code" /></Field>
          {error != null && <ErrorBox error={error} />}
          <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? 'Bekräftar…' : 'Bekräfta och aktivera'}</button>
          <button type="button" className="btn ghost" onClick={() => void onCancel()}>Avbryt</button>
        </form>
      )}
      {!info && error != null && <ErrorBox error={error} />}
    </Card>
  );
}
