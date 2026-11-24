import { useState } from 'react';
import { api } from '../api';
import { Alert, ErrorBox, Field } from '../ui';

/** Offentlig sida: kontoinnehavaren väljer lösenord via engångslänk. MFA registreras vid första inloggningen. */
export function SetupPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState(''); const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null); const [done, setDone] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api('POST', '/auth/setup', { token, password }); setDone(true); } catch (x) { setError(x); } finally { setBusy(false); }
  }
  return (
    <div className="auth-wrap"><div className="auth-card">
      <h1>Aktivera administratörskonto</h1>
      <p className="muted" style={{ margin: 0 }}>Välj ett lösenord. Därefter loggar du in och registrerar tvåstegsverifiering.</p>
      {done ? (
        <div style={{ marginTop: '1rem' }} className="stack"><Alert kind="good">Lösenordet är sparat.</Alert><a className="btn primary" href="/">Fortsätt till inloggning</a></div>
      ) : (
        <form onSubmit={submit}>
          {!token && <Alert>Länken saknar token. Använd länken från mejlet.</Alert>}
          <Field label="Nytt lösenord" hint="Minst 14 tecken."><input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={14} /></Field>
          <Field label="Upprepa lösenord"><input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></Field>
          {again && again !== password && <Alert kind="warn">Lösenorden är inte lika.</Alert>}
          {error != null && <ErrorBox error={error} />}
          <button className="btn primary" disabled={busy || !token || password.length < 14 || password !== again}>{busy ? 'Sparar…' : 'Spara lösenord'}</button>
        </form>
      )}
    </div></div>
  );
}
