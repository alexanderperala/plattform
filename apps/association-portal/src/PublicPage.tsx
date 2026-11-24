import { useEffect, useState } from 'react';
import { PinballBoard } from './PinballBoard';
import { api } from './api';
import { Alert, ErrorBox, Field, fmtDateTime, useLoad } from './ui';

/** Admininställning: publik sida för föreningen. Avstängd som standard; samtycke krävs innan den kan slås på. */
export function PublicPageSettings({ wid }: { wid: string }) {
  const { data, error, reload } = useLoad(() => api<any>('GET', `/workspaces/${wid}/public-page`), [wid]);
  const [slug, setSlug] = useState<string | null>(null); const [showNews, setShowNews] = useState<boolean | null>(null); const [consent, setConsent] = useState(false);
  const [err, setErr] = useState<unknown>(null); const [saved, setSaved] = useState(false);
  if (error != null) return <ErrorBox error={error} />;
  if (!data) return <div className="loading">Laddar…</div>;
  const page = data.page; const curSlug = slug ?? page?.slug ?? ''; const curNews = showNews ?? page?.showNews ?? true;
  const needsConsent = page?.consentVersion !== data.consentVersion;
  async function save(enabled: boolean) {
    setErr(null); setSaved(false);
    try { await api('PUT', `/workspaces/${wid}/public-page`, { enabled, slug: curSlug, showNews: curNews, ...(enabled && needsConsent ? { consent } : {}) }); setSaved(true); setSlug(null); setShowNews(null); reload(); } catch (x) { setErr(x); }
  }
  const url = `${window.location.origin}/p/${curSlug}`;
  return (
    <>
      <h1>Publik sida</h1>
      <p className="muted">En öppen sida där vem som helst, utan inloggning, kan läsa föreningens publicerade nyheter och resultat från turneringar som du själv valt att visa. Sidan är avstängd tills du slår på den. Lagnamn visas – aldrig medlemsuppgifter.</p>
      {err != null && <ErrorBox error={err} />}{saved && <Alert kind="good">Sparat.</Alert>}
      <section className="card">
        <div className="row between"><h2>Status</h2><span className={`badge ${page?.enabled ? 'good' : 'warn'}`}>{page?.enabled ? 'På – synlig för alla' : 'Av'}</span></div>
        <Field label="Adress" hint="3–40 tecken: a–z, 0–9 och bindestreck."><input value={curSlug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="min-forening" /></Field>
        {curSlug && <div className="muted small">Adress: {page?.enabled ? <a href={`/p/${page.slug}`} target="_blank" rel="noreferrer">{url}</a> : url}</div>}
        <label className="row"><input type="checkbox" checked={curNews} onChange={(e) => setShowNews(e.target.checked)} /> Visa publicerade nyheter (utkast visas aldrig)</label>
        {(!page?.enabled && needsConsent) && <label className="row"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> <span>{data.consentText}</span></label>}
        {page?.consentAt && <div className="muted small">Ansvaret bekräftades {fmtDateTime(page.consentAt)}.</div>}
        <div className="row">
          <button className="btn primary" disabled={!curSlug || (!page?.enabled && needsConsent && !consent)} onClick={() => void save(true)}>{page?.enabled ? 'Spara' : 'Slå på publik sida'}</button>
          {page?.enabled && <button className="btn danger" onClick={() => void save(false)}>Stäng av (döljer allt direkt)</button>}
        </div>
        <div className="muted small">Turneringar publiceras en och en i Turneringssystemet (”Visa publikt”). Stänger du av sidan blir alla turneringar icke-publika igen.</div>
      </section>
    </>
  );
}

/** Publik, skrivskyddad vy (ingen inloggning). Texten renderas alltid som text, aldrig som HTML. */
export function PublicSite({ slug, tournamentId }: { slug: string; tournamentId?: string }) {
  // index.html sätter redan noindex,nofollow för hela appen.
  return <div className="auth-wrap"><div className="auth-card" style={{ maxWidth: 1100, width: '100%' }}>{tournamentId ? <PublicTournament slug={slug} id={tournamentId} /> : <PublicHome slug={slug} />}</div></div>;
}

function PublicHome({ slug }: { slug: string }) {
  const { data, error } = useLoad(() => api<any>('GET', `/public/pages/${encodeURIComponent(slug)}`), [slug]);
  if (error != null) return <Alert kind="info">Sidan finns inte.</Alert>;
  if (!data) return <div className="loading">Laddar…</div>;
  return (
    <>
      <h1>{data.name}</h1>
      {data.tournaments.length > 0 && <section><h2>Turneringar</h2><ul className="timeline">{data.tournaments.map((t: any) => <li key={t.id}><a href={`/p/${slug}/t/${t.id}`}>{t.name}</a> <span className="muted small">{t.status === 'finished' ? 'Avslutad' : 'Pågår'}</span></li>)}</ul></section>}
      {data.news.length > 0 && <section><h2>Nyheter</h2>{data.news.map((n: any) => <article key={n.id} className="card"><h3>{n.title}</h3><div className="muted small">{fmtDateTime(n.publishedAt)}</div><p style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p></article>)}</section>}
      {data.tournaments.length === 0 && data.news.length === 0 && <div className="muted">Inget publicerat ännu.</div>}
    </>
  );
}

function PublicTournament({ slug, id }: { slug: string; id: string }) {
  const { data: t, error, reload } = useLoad(() => api<any>('GET', `/public/pages/${encodeURIComponent(slug)}/tournaments/${encodeURIComponent(id)}`), [slug, id]);
  const running = t?.status === 'running';
  useEffect(() => { if (!running) return; const i = setInterval(reload, 10000); return () => clearInterval(i); }, [running, reload]); // live: uppdateras var 10:e sekund
  if (error != null && !t) return <Alert kind="info">Turneringen finns inte.</Alert>;
  if (!t) return <div className="loading">Laddar…</div>;
  if (t.format === 'pinball') return <><a href={`/p/${slug}`} className="small">← {t.associationName}</a><h1>{t.name}</h1><div className="row between"><span className="muted small">{running ? 'Pågår – uppdateras automatiskt' : t.status === 'finished' ? 'Avslutad' : ''}</span><button className="btn noprint" onClick={() => window.print()}>Skriv ut</button></div><PinballBoard t={t} /></>;
  const name = (tid: string | null) => t.teams.find((x: any) => x.id === tid)?.name ?? '–';
  const Tbl = ({ rows }: { rows: any[] }) => <table className="table"><thead><tr><th>#</th><th>Lag</th><th>S</th><th>V</th><th>O</th><th>F</th><th>+/-</th><th>P</th></tr></thead><tbody>{rows.map((r) => <tr key={r.teamId}><td>{r.rank}</td><td>{name(r.teamId)}</td><td>{r.played}</td><td>{r.won}</td><td>{r.drawn}</td><td>{r.lost}</td><td>{r.goalDiff}</td><td><strong>{r.points}</strong></td></tr>)}</tbody></table>;
  const played = t.matches.filter((m: any) => !m.bye && m.homeScore !== null);
  return (
    <>
      <a href={`/p/${slug}`} className="small">← {t.associationName}</a><h1>{t.name}</h1>
      {t.championTeamId && <Alert kind="good">Vinnare: {name(t.championTeamId)}</Alert>}
      {t.format === 'round_robin' && <section><h2>Tabell</h2><Tbl rows={t.standings} /></section>}
      {t.format === 'groups_knockout' && t.groups.map((g: any) => <section key={g.groupNo}><h2>Grupp {String.fromCharCode(64 + g.groupNo)}</h2><Tbl rows={g.standings} /></section>)}
      <section><h2>Resultat</h2>{played.length === 0 ? <div className="muted">Inga matcher spelade ännu.</div> : <ul className="timeline">{played.map((m: any) => <li key={m.id}>{name(m.homeTeamId)} <strong>{m.homeScore}–{m.awayScore}</strong> {name(m.awayTeamId)}</li>)}</ul>}</section>
    </>
  );
}
