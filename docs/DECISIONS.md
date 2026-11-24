# Beslutslogg

| # | Beslut | Motivering / konsekvens |
|---|---|---|
| D1 | Inget befintligt stack fanns. Valt: Node 22, TypeScript, Fastify, PostgreSQL 16, React + Vite. | Ett språk i hela kedjan, stark typning, enkel drift. Frontend, backend och databas är separata. |
| D2 | Egna SQL-migrationer (advisory lock + `schema_migrations`) i stället för ORM. | Full kontroll över constraints, triggers och index; inga dolda skeman-ändringar. |
| D3 | Multi-tenancy på applikationsnivå (medlemskapskontroll, icke-medlem → 404). Row-Level Security införs när produkttabeller finns. | Inga produkttabeller ännu, så RLS skulle bara skydda tomma tabeller. Isolering testas i `tenant-isolation.test.ts`. |
| D4 | Superadmin har egna tabeller, sessioner, cookie (`padm_session`) och CSRF-header, skilda från kundauth. | Spec ARK: separat auth- och behörighetsmodell. |
| D5 | Behörighet deklareras per rutt (fail-closed) mot en matris i kod som testas mot specens tabell. | UI döljer bara; backend avgör. |
| D6 | Four-eyes för `workspace.close` och `user.delete`; självgodkännande bara när <2 behöriga godkännare finns, flaggas i loggen. | Hindrar att en ensam ägare låser sig, utan att tysta undantaget. |
| D7 | Ingen automatisk radering av kunddata vid avslutad licens; `purge_candidates` skapas men raderar aldrig. | Spec avsnitt 3 och 8. |
| D8 | Grace period för förfallen betalning: 14 dagar (inställning `billing.grace_period_days`). | Konfigurerbart per abonnemang. |
| D9 | Stripe Billing som standardval bakom ett `PaymentProvider`-gränssnitt. Planpriser är platshållare. | Implementerat (S2, första snittet; ej provkört mot riktiga Stripe). Priser måste fastställas av ledningen. |
| D10 | Supportåtkomst: skrivskyddad, ärende + orsak krävs, standard 30 min (max 120), personuppgifter kräver kundens godkännande, kunden notifieras alltid. | Spec 5.3. |
| D11 | Retention: tekniska fel 90 dagar, inloggningshistorik 12 månader; granskningslogg behålls (append-only). | Justeras efter juridisk granskning. |
| D12 | Notiser läggs i `notification_outbox`/`workspace_notifications` och skickas av en arbetare med nodemailer (SMTP). | Transaktionell outbox: köas i samma transaktion som åtgärden. Minst-en-gång-leverans med lease och backoff. |
| D13 | Brödtext med engångslänkar rensas efter lyckad leverans. | Minskar exponering av giltiga token i databasen. |
| D14 | Administratörskonton skapas via four-eyes och aktiveras av innehavaren med engångslänk; ingen känner till andras lösenord. | Minskar insiderrisk; MFA-återställning ogiltigförklarar lösenordet. |
| D15 | Self-checks vid four-eyes gäller den som begärde åtgärden. | Annars kan godkännaren (en kollega) användas för att kringgå förbudet mot självändring. |
| D16 | Assisterad support kräver kundens godkännande (scope `assisted`, åtgärdslista, max 72 h) plus admin-session ≤ 60 min med MFA, och varje åtgärd kräver orsak + färsk MFA. | Spec 5.3. Kunden styr vad som får göras; backend nekar allt utanför listan. |
| D17 | I assisterad vy visas medlemmars namn och roll (aldrig e-post/telefon) endast om kunden tillåtit `enable_permission`. | Behövs för att välja rätt medlem; minimerar personuppgifter. |
| D18 | Ändringsbara systeminställningar är en vitlista i backend (typ + min/max). Inga inställningar kan aktivera automatisk radering. | Förhindrar felkonfiguration och ogiltiga värden även från direkta API-anrop. |
| D19 | zod uppgraderat till 4.x; CI avvisar höga sårbarheter i produktionsberoenden (`npm audit --omit=dev --audit-level=high`). | Spec SEC-15. Moderata sårbarheter dokumenteras i STATUS tills de åtgärdats. |
| D20 | Produkttabeller isoleras med RLS (`FORCE`) på sessionsvariabeln `app.workspace_id`, satt av `withWorkspace()`. Användningsräkning sätter samma kontext. | Fail closed och försvar på djupet mot glömda filter. Gäller alla framtida produkttabeller. |
