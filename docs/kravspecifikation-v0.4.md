# PRODUKTKRAVSPECIFIKATION v0.4
## Tre separata miljöer – två självständiga SaaS-produkter och en Superadmin-portal

**Version:** 0.4
**Datum:** 24 november 2026
**Ersätter:** v0.3
**Status:** Låst arkitektur. Implementation pågår (se `STATUS.md`).

### Ändringar mot v0.3

| # | Ändring |
|---|---|
| 1 | Prioriteringar, faser och acceptanskriterier är nu konsekventa. Acceptanskriterierna är uppdelade per lansering och fas (avsnitt 9). |
| 2 | Statusmodell för arbetsyta, abonnemang och produktlicens är definierad med exakt åtkomstpåverkan (avsnitt 4). |
| 3 | Komplett behörighetsmatris för Superadmin (avsnitt 6). |
| 4 | GDPR, personuppgiftshantering och gallring (avsnitt 8). |
| 5 | Kundnotifiering vid supportåtkomst (avsnitt 5.3). |
| 6 | Fyra-ögon-princip för känsliga åtgärder (avsnitt 6.3). |
| 7 | MFA-återställning och break-glass-konto (avsnitt 7.2 och 7.3). |
| 8 | Säkerhetskrav för Superadmin-portalen skärpta och mätbara (avsnitt 7). |
| 9 | Betalningshantering, fakturering och moms (avsnitt 10). |
| 10 | Icke-funktionella krav för prestanda, backup och tillgänglighet (avsnitt 11). |
| 11 | Entitlement-modell för abonnemang och funktionsbegränsningar (avsnitt 5.4). |
| 12 | Diskussionsformuleringar (t.ex. "jag rekommenderar") ersatta av krav. Organisationsnummer tillagt i kundlistan. "Ta bort användare" tillagt i funktionslistan. Överlappet mellan Platform Owner och Superadmin är avgränsat. |
| 13 | Adress- och API-struktur justerad: Superadmin körs på egen värd, så frontend-sökvägarna har inget `/admin`-prefix. |

---

# 1. Produktstruktur och arkitekturprinciper (låsta)

Plattformen består av tre separata applikationsmiljöer.

| Miljö | Användare | Syfte |
|---|---|---|
| **A. Föreningsportal** | Föreningar och medlemmar | Medlemsregister, forum, nyheter, kalender, aktiviteter, dokument och föreningsadministration |
| **B. Turneringssystem** | Tävlingsarrangörer och spelare | Spelregister, turneringar, spelare, matcher, resultat, ranking och egna tävlingsformat |
| **C. Superadmin** | Plattformsägaren och plattformens administratörer | Kunder, användare, abonnemang, produktlicenser, support, tekniska problem och hela plattformen |

**Principer**

- **ARK-1.** Föreningsportalen och Turneringssystemet är självständiga produkter. De kan köpas och användas var för sig eller tillsammans.
- **ARK-2.** En kund kan när som helst aktivera den andra produkten utan att förlora befintlig data.
- **ARK-3.** Produkterna delar endast gemensamma bastjänster: Identity, Workspace, Authorization, Billing, Product Entitlements, Notifications, Logging och File Storage.
- **ARK-4.** Produkterna får inte läsa varandras databastabeller. Integration sker via definierade gränssnitt (API eller händelser) och är valfri.
- **ARK-5.** Superadmin har egen autentisering, egen sessionshantering, egen behörighetsmodell, egen värd och egna API-rutter. Superadmin-rutter nås aldrig med kundsessioner och kundrutter nås aldrig med adminsessioner.
- **ARK-6.** Alla behörighetskontroller görs i backend. Frontend döljer endast det användaren inte får göra.
- **ARK-7.** Multi-tenancy: all kunddata tillhör exakt en arbetsyta (`workspace_id`). Ingen kundanvändare kan nå en annan arbetsytas data.
- **ARK-8.** Alla tidsstämplar lagras i UTC och visas i Europe/Stockholm.

## 1.1 Teknikval (dokumenterade beslut)

Inget befintligt projekt eller teknikstack fanns när implementationen startade. Följande standardval gäller och kan bytas först efter ett dokumenterat tekniskt skäl.

| Område | Val | Motivering |
|---|---|---|
| Backend | Node.js 22, TypeScript, Fastify | Typad, snabb, tydlig plugin- och rutt-isolering. Stödjer att Superadmin-rutter registreras i egen skyddad kontext. |
| Databas | PostgreSQL 16 | Transaktioner, constraints, JSONB, möjlighet till Row Level Security. |
| Migrationer | Versionerade SQL-filer med eget minimalt körverktyg | Ingen ORM-inlåsning och full kontroll över constraints och index. Körs i transaktion och loggas i `schema_migrations`. |
| Validering | Zod | En källa för indata-validering och typer. |
| Lösenordshash | scrypt (Node `crypto`), N=2^15, r=8, p=1 | Inga native-beroenden. Parametrarna lagras i hashsträngen så att de kan höjas. |
| MFA | TOTP (RFC 6238, SHA-1, 6 siffror, 30 s) plus engångsåterställningskoder | Kompatibelt med alla autentiseringsappar. |
| Sessioner | Opaka slumptoken, SHA-256-hashade i databasen, `HttpOnly` + `SameSite=Strict` cookie | Direkt återkallningsbara. Inget JWT-återkallningsproblem. |
| Frontend (Superadmin) | React 18, TypeScript, Vite, React Router | Separat applikation med eget bygge. |
| Tester | Vitest (enhet och integration mot riktig PostgreSQL), Playwright (UI-rök) | Behörighet och tenant-isolering testas mot riktig databas. |

---

# 2. Superadmin-portalen – syfte och omfattning

Superadmin är plattformsägarens centrala administrationsverktyg. Den är en separat applikation och inte en kundvy med extra menyval.

**Adress:** `admin.<plattformsdomän>` (värdnamnet konfigureras i `ADMIN_ALLOWED_HOSTS`). API:t för Superadmin ligger under `/api/platform-admin/*` och accepterar endast förfrågningar med giltigt värdnamn och, om konfigurerat, IP-adress i `ADMIN_IP_ALLOWLIST`.

Plattformsägaren ska kunna:

- se alla kunder och söka och hantera alla arbetsytor,
- se alla användare och hjälpa dem med kontoproblem,
- aktivera och inaktivera produkter samt hantera begränsningar,
- se och administrera abonnemang och provperioder,
- hantera supportärenden och använda säker supportåtkomst,
- se administrativa loggar och relevanta tekniska fel,
- hantera plattformsinställningar och funktionsflaggor.

---

# 3. Funktionskrav Superadmin

Prioritet: **P0** = krävs för Lansering 1, **P1** = krävs för Lansering 2 (betalande kunder), **P2** = senare. Kolumnen *Fas* anger i vilken fas kravet levereras (avsnitt 9).

| ID | Krav | Prio | Fas |
|---|---|---|---|
| SA-DASH | Dashboard med nyckeltal, systemstatus och aktuella händelser | P0 | S0 |
| SA-CUST | Kundlista, sökning, filtrering och kunddetaljvy | P0 | S0 |
| SA-CUST-ACT | Administrativa åtgärder på arbetsyta (kontaktuppgifter, status, anteckningar, återkalla sessioner) | P0 | S0 |
| SA-USER | Användarlista, sökning, detaljvy och kontoåtgärder | P0 | S0 |
| SA-ENT | Produktlicenser (entitlements), gränser och abonnemangsstatus per kund | P0 | S0 |
| SA-SUB-BASIC | Byte av plan, förlängning av provperiod, paus, uppsägning vid periodens slut (utan betalleverantör) | P0 | S0 |
| SA-SUP | Supportärenden med kommentarer, interna anteckningar, status, prioritet och koppling till kund och användare | P0 | S0 |
| SA-ACCESS-RO | Read-only supportåtkomst (se 5.3) | P0 | S0 |
| SA-AUDIT | Audit log för alla administrativa åtgärder och supportåtkomst | P0 | S0 |
| SA-ERR | Tekniska fel kopplade till arbetsyta och användare, med maskerade hemligheter | P0 | S0 |
| SA-4EYES | Godkännandeflöde (fyra-ögon) | P0 | S0 |
| SA-MFA | MFA, återställningskoder, MFA-återställning, break-glass | P0 | S0 |
| SA-NOTIF | E-postutskick till enskild kund och automatiska notiser (supportåtkomst, betalning) | P1 | S1 |
| SA-ACCESS-AS | Assisterad support (se 5.3) | P1 | S1 |
| SA-BILL | Betalleverantör, fakturahistorik, rabatt, återbetalning, betalningsproblem (avsnitt 10) | P1 | S2 |
| SA-FLAGS | Funktionsflaggor (globalt och per arbetsyta) med administrationsgränssnitt | P1 | S2 |
| SA-SYS | Systeminställningar, e-postmallar, underhållsmeddelanden, policyversioner | P1 | S2 |
| SA-LOGS | Avancerad felsökningsvy, bakgrundsjobb, integrationsövervakning, systemincidenter | P1 | S3 |
| SA-BULK | Massutskick med godkännande och skydd mot oavsiktliga utskick | P2 | S4 |
| SA-ANALYTICS | Kundtillväxt, bortfall, produktanvändning, supportstatistik, export | P2 | S4 |

## 3.1 Dashboard (SA-DASH)

Första sidan visar:

- **Nyckeltal:** antal kunder, aktiva arbetsytor, aktiva användare, aktiva föreningsportaler, aktiva turneringssystem, kunder med båda produkterna, provkonton, betalande kunder, nyregistreringar senaste 30 dagarna, avslutade abonnemang, förfallna betalningar (`PastDue`).
- **Systemstatus:** API, databas, bakgrundsjobb, e-postutskick (utkorgens köstatus), senaste tekniska fel. Övriga tjänster (fillagring, realtid, externa integrationer) visas när respektive tjänst finns (Fas S3).
- **Händelser som kräver uppmärksamhet:** nya registreringar, öppna och nya supportärenden, väntande godkännanden, abonnemang i `PastDue`, provperioder som löper ut inom 7 dagar, låsta konton.

Kortens innehåll beror på rollens behörigheter. Ett kort som rollen inte får se skickas inte från servern.

## 3.2 Kundhantering (SA-CUST, SA-CUST-ACT)

**Kundlista – fält:** kundnamn, kundtyp (förening, arrangör, annan), organisationsnummer, kontaktperson, e-post, registreringsdatum, aktiva produkter, plan, arbetsytestatus, abonnemangsstatus, senaste aktivitet.

**Sökning:** organisationsnamn, arbetsytans ID, organisationsnummer, kontaktperson, e-postadress. **Filter:** produkt, arbetsytestatus, abonnemangsstatus, plan, registreringsdatum (från/till). Filter kombineras. Resultat sidindelas (max 100 per sida) och sorteras serverside.

**Kundens detaljvy:** grundinformation, arbetsytans administratörer, registrerade användare, produktlicenser med gränser och användning, abonnemang, supportärenden, administrativa händelser (audit för arbetsytan), tekniska fel, interna anteckningar.

**Åtgärder (behörighet och krav enligt avsnitt 6):** ändra kontaktuppgifter, ändra arbetsytestatus (suspend, återaktivera, avsluta med fyra-ögon), aktivera/inaktivera/pausa produkt, ändra gränser, byta plan, förlänga provperiod, lägga till intern anteckning, återkalla alla kundsessioner i arbetsytan. Alla åtgärder loggas.

## 3.3 Användarhantering (SA-USER)

**Sökning:** namn, e-post, användar-ID, arbetsyta, telefonnummer (om registrerat).

**Detaljvy:** namn, e-post, kontostatus, registreringsdatum, senaste inloggning, kopplade arbetsytor med roller, produktåtkomst, säkerhetsstatus (e-post verifierad, låst, antal misslyckade inloggningar), inloggningshistorik, relevanta supportärenden.

**Åtgärder:** skicka om inbjudan, skicka verifieringsmeddelande, initiera lösenordsåterställning, låsa och låsa upp konto, återkalla sessioner, ta bort användare (fyra-ögon, avsnitt 8.4).

- **KRAV-U1.** Ett lösenord kan aldrig läsas, visas eller sättas av en administratör.
- **KRAV-U2.** Lösenordsåterställning sker alltid genom en engångslänk som skickas till användarens verifierade e-postadress. Länken gäller 60 minuter och kan användas en gång.
- **KRAV-U3.** Administratörens svar på en återställning avslöjar aldrig länken eller token.

## 3.4 Supporthantering (SA-SUP)

- Ärendefält: nummer, ämne, beskrivning, kategori, prioritet (låg, normal, hög, kritisk), status, tilldelad administratör, kopplad arbetsyta, kopplad användare, tidsstämplar.
- **Statusar:** Nytt, Pågående, Väntar på kund, Väntar internt, Löst, Stängt. Tillåtna övergångar: Nytt → Pågående → (Väntar på kund | Väntar internt) → Löst → Stängt. Ett löst eller stängt ärende kan öppnas igen (→ Pågående).
- **Kategorier:** Konto och inloggning, Medlemsadministration, Forum och kommunikation, Turneringssystem, Resultat och poängberäkning, Betalningar, Abonnemang, Tekniska fel, Övrigt.
- **Kommentarer** är antingen *kundsynliga* eller *interna*. Interna kommentarer och interna kundanteckningar exponeras aldrig i något kundgränssnitt eller kund-API. Kundsynlig kommunikation skickas via e-post (SA-NOTIF).
- Supporthistorik per kund och användare visas i respektive detaljvy.
- Bifogade filer levereras med File Storage-tjänsten (Fas S3). Tills dess hänvisas till länkar i kommentaren.

---

# 4. Statusmodell

Tre statusar hålls helt separerade och lagras i separata tabeller. Åtkomst beräknas av en enda funktion, `resolveAccess`, vars logik motsvarar tabellerna nedan och som täcks av automatiska tester.

## 4.1 Arbetsyta (Workspace)

| Status | Betydelse | Åtkomst för kundanvändare |
|---|---|---|
| `Active` | Normal drift | Enligt prenumeration och produktlicens |
| `Suspended` | Pausad av plattformsadmin (t.ex. missbruk eller utredning). Kan återaktiveras direkt. | Skrivskyddad. Inloggning och dataexport tillåts. Tydlig notis visas. |
| `Closed` | Avslutad. Data bevaras under retentionstiden (8.2). | Endast dataexport och begäran om återaktivering. Ingen ordinarie åtkomst. |

Tillåtna övergångar: Active ↔ Suspended, Active → Closed, Suspended → Closed, Closed → Active (endast inom retentionstiden, kräver orsak). **Closed kräver fyra-ögon.**

## 4.2 Abonnemang (Subscription)

| Status | Betydelse | Åtkomst |
|---|---|---|
| `Trialing` | Provperiod (standard 30 dagar) | Full, enligt provplanens gränser |
| `Active` | Betalande eller manuellt aktiverat | Full |
| `PastDue` | Förfallen betalning | Full under respitperioden (standard 14 dagar, konfigurerbar `billing.grace_period_days`). Därefter skrivskyddad. |
| `Paused` | Pausat av admin eller kund | Skrivskyddad |
| `CanceledAtPeriodEnd` | Uppsagt, löper till periodens slut | Full till `current_period_end`, därefter blir statusen `Expired` |
| `Expired` | Slut på period eller provperiod | Ingen åtkomst till produkterna. Data bevaras (8.2). Återaktivering möjlig. |

Tillåtna övergångar:

```
Trialing  → Active | Expired | Paused
Active    → PastDue | Paused | CanceledAtPeriodEnd | Expired
PastDue   → Active | Paused | Expired
Paused    → Active | Expired
CanceledAtPeriodEnd → Active (ångrad uppsägning) | Expired
Expired   → Active | Trialing (återaktivering)
```

**Respitperiod och notiser (P1, S1):** vid övergång till `PastDue` startar respitperioden. Kunden notifieras dag 0, 3, 7 och 12 samt när respitperioden löper ut. Notisen visas som banner i produkten och skickas som e-post till arbetsytans administratörer.

## 4.3 Produktlicens (Product Entitlement)

Per arbetsyta och produkt (`association_portal`, `tournament_system`).

| Status | Betydelse | Åtkomst till produkten |
|---|---|---|
| `Enabled` | Aktiv inom gränser | Full |
| `Disabled` | Inaktiverad. Ingen data raderas. | Ingen. Produkten kan återaktiveras och data finns kvar. |
| `Suspended` | Tillfälligt avstängd av admin | Skrivskyddad |
| `LimitExceeded` | En eller flera gränser överskrids | Läsning och ändring av befintliga objekt tillåts. Skapande av nya objekt i den överskridna dimensionen blockeras. |

## 4.4 Effektiv åtkomst

`resolveAccess(workspace, subscription, entitlement, nu)` returnerar ett av lägena nedan. Det mest restriktiva läget av de tre statusarna gäller.

Ordning, från minst till mest restriktivt: `full` → `limited` → `read_only` → `export_only` → `none`.

| Workspace | Subscription | Entitlement | Läge |
|---|---|---|---|
| Closed | – | – | `export_only` |
| Suspended | – | – | `read_only` |
| – | Expired | – | `none` |
| – | Paused | – | `read_only` |
| – | PastDue efter respit | – | `read_only` |
| – | PastDue inom respit, Trialing, Active, CanceledAtPeriodEnd (före periodens slut) | – | `full` |
| – | – | Disabled | `none` |
| – | – | Suspended | `read_only` |
| – | – | LimitExceeded | `limited` |
| – | – | Enabled | `full` |

- **KRAV-S1.** Ingen statusändring raderar data. Radering sker endast genom gallring enligt avsnitt 8.2 och 8.3.
- **KRAV-S2.** En trial som passerat `trial_ends_at` behandlas som `Expired` även om bakgrundsjobbet ännu inte hunnit uppdatera raden.
- **KRAV-S3.** Åtkomstläget beräknas i backend vid varje förfrågan till en kundprodukt. Åtkomsten till en produkt kontrolleras mot just den produktens licens.
- **KRAV-S4.** Varje statusändring skrivs till audit log med tidigare och ny status samt orsak.

---

# 5. Support, supportåtkomst och licensmodell

## 5.1 Interna anteckningar

Administratörer kan skriva privata anteckningar om en kund eller ett ärende. De visas aldrig för kunden.

## 5.2 Produkt- och modulhantering (SA-ENT)

Administratören kan per kund aktivera, inaktivera och pausa en produkt, ändra gränser, ge tillfällig åtkomst (med utgångsdatum) och tilldela testfunktioner. Funktionsflaggor (SA-FLAGS) möjliggör att en ny funktion aktiveras för en enskild arbetsyta utan att publiceras till alla.

## 5.3 Supportåtkomst – "Visa som kund"

**Grundregler (gäller båda lägena)**

- **SUP-1.** Varje supportsession kräver ett kopplat supportärende och en angiven orsak.
- **SUP-2.** Sessioner är tidsbegränsade: standard 30 minuter, max 120 minuter (read-only) eller 60 minuter (assisterad). Sessionen kan inte förlängas, bara startas om med ny orsak.
- **SUP-3.** Allt som visas eller görs loggas i `support_access_sessions` och `admin_audit_log` (administratör, arbetsyta, användare, tidpunkt, ärende, åtgärd).
- **SUP-4.** Aktiv supportåtkomst markeras tydligt i gränssnittet (permanent banner med återstående tid).
- **SUP-5.** Hemligheter är aldrig åtkomliga: lösenord, lösenordshash, MFA-hemligheter, sessionstoken, betalkort, API-nycklar och andra autentiseringsuppgifter.
- **SUP-6.** När sessionen löper ut eller avslutas upphör åtkomsten omedelbart. Servern kontrollerar giltighet vid varje förfrågan.

**Läge 1 – Visa som kund (read-only, standard).** Administratören ser kundens konfiguration, produktlicenser, roller och behörigheter, användningsstatistik och aggregerad information. Inga ändringar kan göras.

- Åtkomst till *personnära data* (enskilda medlemmars personuppgifter, spelares personuppgifter, meddelanden, dokumentinnehåll) kräver att arbetsytans administratör har godkänt det i ett `support_access_grant`. "Relevant" definieras alltså som: allt som innehåller personuppgifter om arbetsytans medlemmar eller spelare kräver godkännande. Konfiguration och aggregerad statistik kräver det inte.

**Läge 2 – Assisterad support (P1, S1).** Administratören kan utföra särskilt angivna åtgärder för kundens räkning. Läget kräver alltid:

1. ett `support_access_grant` som arbetsytans administratör har godkänt (giltighet max 72 timmar, anger tillåtna åtgärdstyper),
2. orsak och supportärende,
3. att åtgärden finns på listan över tillåtna åtgärder: *ändra felaktig inställning*, *aktivera behörighet*, *hjälpa till med konfiguration av funktion eller turnering*.

Förbjudet i assisterat läge: betalningar, ändring av abonnemang, borttagning av data, ändring av lösenord eller MFA, ändring av arbetsyteägare.

**Kundnotifiering (SUP-N).** Kunden meddelas varje gång supportåtkomst startas:

- Vid start av en supportsession skapas en notis till alla arbetsytans administratörer (e-post via utkorg och notis i produkten). Innehåll: tidpunkt, läge, administratörens visningsnamn, supportärendets nummer, orsak och sessionens längd.
- Efter avslutad session finns en kundsynlig sammanfattning av åtkomsthistoriken (vem, när, hur länge, läge).
- Notisen kan inte stängas av av kunden eller av administratören.

---

# 6. Behörigheter, roller och godkännande

Superadmin har egna roller som är helt skilda från kundernas roller. Administratörer lagras i egen tabell (`platform_admins`).

## 6.1 Roller

| Roll | Syfte |
|---|---|
| **Platform Owner** | Fullständig kontroll. Enda rollen som hanterar administratörer, break-glass och gallring (data.purge). |
| **Superadmin** | Global administration av kunder, användare, licenser, abonnemang och inställningar. Hanterar inte administratörskonton och kan inte exekvera gallring. |
| **Support Admin** | Kund- och användarsupport. Ingen åtkomst till betalningar, fakturor, prissättning eller destruktiva åtgärder. |
| **Billing Admin** | Abonnemang och betalningar. Ingen användar- eller supportåtkomst utöver läsning av ärenden. |
| **Technical Admin** | Systemstatus, loggar och felsökning. |
| **Read-only Admin** | Läsåtkomst till administrativa uppgifter och rapporter, utan känsliga betaluppgifter. |

I början kan plattformsägaren inneha alla behörigheter, men modellen är färdig för fler administratörer.

## 6.2 Behörighetsmatris

Tabellen är den auktoritativa definitionen. Ett automatiskt test jämför den mot koden och misslyckas vid avvikelse. ✔ = beviljad, – = nekad.

Kolumnen *Krav* anger extra villkor vid utförande: **O** = orsak krävs, **R** = nylig åter-autentisering (MFA-kod senaste 5 minuterna), **4** = fyra-ögon-godkännande (6.3).

<!-- PERMISSION-MATRIX-START -->
| Behörighet | Platform Owner | Superadmin | Support Admin | Billing Admin | Technical Admin | Read-only Admin | Krav |
|---|---|---|---|---|---|---|---|
| `dashboard.view` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `workspaces.view` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `workspaces.update` | ✔ | ✔ | ✔ | – | – | – | O |
| `workspaces.notes` | ✔ | ✔ | ✔ | ✔ | – | – | |
| `workspaces.suspend` | ✔ | ✔ | – | – | – | – | O R |
| `workspaces.close` | ✔ | ✔ | – | – | – | – | O R 4 |
| `users.view` | ✔ | ✔ | ✔ | – | ✔ | ✔ | |
| `users.account_actions` | ✔ | ✔ | ✔ | – | – | – | O |
| `users.lock` | ✔ | ✔ | ✔ | – | – | – | O |
| `users.delete` | ✔ | ✔ | – | – | – | – | O R 4 |
| `entitlements.view` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `entitlements.manage` | ✔ | ✔ | – | – | – | – | O R |
| `flags.manage` | ✔ | ✔ | – | – | ✔ | – | O |
| `subscriptions.view` | ✔ | ✔ | ✔ | ✔ | – | ✔ | |
| `subscriptions.manage` | ✔ | ✔ | – | ✔ | – | – | O R |
| `billing.view` | ✔ | ✔ | – | ✔ | – | – | |
| `billing.refund` | ✔ | ✔ | – | ✔ | – | – | O R 4 |
| `support.view` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | |
| `support.manage` | ✔ | ✔ | ✔ | – | – | – | |
| `support.access_readonly` | ✔ | ✔ | ✔ | – | – | – | O |
| `support.access_assisted` | ✔ | ✔ | ✔ | – | – | – | O R |
| `logs.view` | ✔ | ✔ | ✔ | – | ✔ | ✔ | |
| `audit.view` | ✔ | ✔ | – | – | ✔ | ✔ | |
| `analytics.view` | ✔ | ✔ | – | ✔ | – | ✔ | |
| `messaging.send_single` | ✔ | ✔ | ✔ | – | – | – | O |
| `messaging.send_bulk` | ✔ | ✔ | – | – | – | – | O R 4 |
| `settings.manage` | ✔ | ✔ | – | – | – | – | O R |
| `approvals.decide` | ✔ | ✔ | – | – | – | – | R |
| `admins.manage` | ✔ | – | – | – | – | – | O R 4 |
| `data.purge` | ✔ | – | – | – | – | – | O R 4 |
<!-- PERMISSION-MATRIX-END -->

**Särskilda regler**

- **BEH-1.** Support Admin ser abonnemangets *status* men aldrig fakturor, betalningar eller priser (`billing.view` saknas).
- **BEH-2.** Support Admin kan inte ändra arbetsytestatus, produktlicenser, abonnemang eller ta bort användare.
- **BEH-3.** Behörigheter kontrolleras per rutt i backend med ett uttryckligt krav per rutt. En rutt utan deklarerat krav avvisas vid uppstart av servern (fail closed).
- **BEH-4.** En administratör kan aldrig utöka sina egna behörigheter eller godkänna sin egen begäran (6.3).

## 6.3 Fyra-ögon-princip

Åtgärder markerade med **4** i matrisen skapar en *godkännandebegäran* (`approval_requests`) i stället för att utföras direkt.

- **FYRA-1.** Begäran innehåller åtgärdstyp, mål, parametrar, orsak, beställare och tidpunkt. Den gäller i 72 timmar och förfaller därefter.
- **FYRA-2.** Godkännare måste ha `approvals.decide`, vara en annan administratör än beställaren och göra en åter-autentisering (MFA) inom 5 minuter innan beslutet.
- **FYRA-3.** Vid godkännande utförs åtgärden direkt av servern i samma transaktion som beslutet. Vid avslag eller utgång utförs ingenting.
- **FYRA-4.** Begäran, godkännande, avslag och utförande loggas i audit log.
- **FYRA-5. Ensam ägare.** Om färre än två aktiva administratörer har `approvals.decide` får Platform Owner godkänna sin egen begäran, men endast efter åter-autentisering. Audit-posten markeras `self_approved=true` och visas på Dashboard och i audit log. Inställningen `security.allow_sole_owner_self_approval` (standard `true`) kan stängas av när fler administratörer finns.

Åtgärder med fyra-ögon i första versionen: avsluta arbetsyta, ta bort användare, återbetalning (S2), gallring/radering av data, ändring av administratörsroller, massutskick (S4).

---

# 7. Säkerhet för Superadmin

## 7.1 Krav

| ID | Krav |
|---|---|
| SEC-1 | Egen administratörsinloggning (`platform_admins`) skild från kundkonton och med egen cookie och sessionstabell. |
| SEC-2 | MFA (TOTP) är obligatoriskt. Ett konto utan registrerad MFA kan endast slutföra MFA-registrering, inget annat. |
| SEC-3 | Lösenord: minst 12 tecken. Kontrolleras mot en lista med vanliga lösenord. Lagras med scrypt. |
| SEC-4 | Sessioner: inaktivitetstimeout 30 minuter, absolut livslängd 8 timmar, cookie `HttpOnly`, `SameSite=Strict`, `Secure` i produktion. |
| SEC-5 | Åter-autentisering (MFA-kod) krävs för åtgärder markerade **R**. Giltig i 5 minuter. |
| SEC-6 | Kontolåsning: 5 misslyckade inloggningar eller MFA-försök ger 15 minuters låsning. Alla försök loggas. Samma felmeddelande oavsett om kontot finns. |
| SEC-7 | CSRF-skydd: tillståndsändrande rutter kräver headern `X-Requested-With: platform-admin` och kontrollerar `Origin` mot tillåtna värdar. |
| SEC-8 | Värdnamnsbegränsning (`ADMIN_ALLOWED_HOSTS`) och valfri IP-begränsning (`ADMIN_IP_ALLOWLIST`) för alla Superadmin-rutter. |
| SEC-9 | Rate limiting på inloggning, MFA och åter-autentisering per IP och konto. |
| SEC-10 | Alla administrativa ändringar och all supportåtkomst loggas i en separat, append-only audit log. Databasroll och triggers förhindrar `UPDATE` och `DELETE` på audit-tabellen. |
| SEC-11 | Möjlighet att återkalla alla administratörssessioner (alla, en administratör, eller alla utom den egna). |
| SEC-12 | Ingen åtkomst till användarlösenord. Hemligheter (lösenord, token, MFA-hemligheter, kortdata, API-nycklar) maskeras i alla loggar och API-svar. |
| SEC-13 | Säkerhetsrubriker: `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` för API-svar. |
| SEC-14 | Tenant-isolering: kundrutter slår upp arbetsyta via kontots medlemskap, aldrig via ett ID som klienten kan välja fritt. Superadmin åtkomst till kunddata sker endast via supportsessioner (5.3) eller via aggregerade administrativa vyer. |
| SEC-15 | Beroenden skannas (`npm audit`) i CI och lösenordshashens parametrar kan höjas utan migration. |

**Orsak krävs** (markerat **O**) med minst 10 tecken. Orsaken lagras i audit log.

## 7.2 MFA-återställning

- Vid registrering skapas 10 engångsåterställningskoder. De visas en gång och lagras som hash.
- En återställningskod ersätter TOTP-koden vid inloggning och förbrukas. Antal kvarvarande koder visas i kontoinställningar. Vid 3 eller färre återstående koder uppmanas administratören att skapa nya.
- Har en administratör tappat både enhet och koder återställer en Platform Owner kontots MFA (`admins.manage`, orsak, åter-autentisering och fyra-ögon). Kontots sessioner återkallas, MFA-hemligheten rensas och kontot måste registrera MFA vid nästa inloggning.
- MFA-återställning för Platform Owner när den är ensam administratör sker med break-glass (7.3).

## 7.3 Break-glass-konto

Break-glass är ett särskilt Platform Owner-konto (`is_break_glass = true`) som är **förseglat** (`status = sealed`) och inte kan logga in i normalt läge.

- **BG-1.** Konto förseglas vid skapande. Lösenordet förvaras offline (utanför systemet) av plattformsägaren.
- **BG-2.** Öppnas endast med serverkommandot `npm run breakglass -- enable --reason "<orsak>" --minutes 60` som körs med serverns miljöhemlighet `BREAKGLASS_UNSEAL_KEY`. Kontot öppnas högst 60 minuter.
- **BG-3.** Vid öppning skapas en audit-post med allvarlighet `critical`, och en notis läggs i utkorgen till alla aktiva Platform Owners. Dashboarden visar en röd varning så länge kontot är öppet.
- **BG-4.** Inloggning med break-glass kräver både lösenord och MFA. Alla åtgärder markeras `break_glass=true` i audit log.
- **BG-5.** Kontot förseglas automatiskt när tiden löper ut (kontroll vid varje inloggning och vid varje förfrågan) eller med `breakglass -- disable`.

---

# 8. GDPR, personuppgifter och gallring

## 8.1 Roller och rättslig grund

- För kundernas medlems- och spelardata är **kunden personuppgiftsansvarig** och plattformsägaren **personuppgiftsbiträde**. Ett personuppgiftsbiträdesavtal (PUB-avtal) ingår i användarvillkoren och accepteras vid registrering. Versionen av villkoren och PUB-avtalet lagras per arbetsyta (`terms_version`, `dpa_version`, `accepted_at`).
- För plattformens egna kontodata (administratörer, kundadministratörer, fakturakontakt) är **plattformsägaren personuppgiftsansvarig**. Rättslig grund: avtal och berättigat intresse (säkerhet och missbruksskydd).
- Underbiträden (hosting, e-post, betalleverantör) förtecknas i en publik lista och ändringar meddelas kunder minst 30 dagar i förväg.

## 8.2 Gallring och retention

| Data | Retention | Hantering |
|---|---|---|
| Kunddata i produkter efter att arbetsytan **avslutats** (Closed) | 90 dagar för export och återaktivering | Därefter gallringskandidat |
| Kunddata efter att en **produktlicens inaktiverats** eller **abonnemanget gått ut** (`Disabled`/`Expired`) | 12 månader (`retention.product_data_months`) | Data bevaras orörd och kan återaktiveras. Därefter gallringskandidat. |
| Admin audit log och supportåtkomstlogg | 24 månader | Anonymiseras därefter (administratörens ID behålls) |
| Tekniska felloggar | 90 dagar | Raderas automatiskt. Hemligheter är maskerade redan vid skrivning. |
| Inloggningshistorik | 12 månader | Raderas automatiskt |
| Supportärenden | 24 månader efter att de stängts | Anonymiseras |
| Utkorg (skickade e-postmeddelanden) | 90 dagar | Brödtext raderas, status behålls |
| Fakturaunderlag | 7 år (bokföringslagen) | Kan inte raderas före utgång. Personuppgifter minimeras. |

- **GALL-1.** Raderingsjobb körs dagligen. Jobbet **skapar gallringskandidater** (`purge_candidates`) men raderar inte kunddata själv.
- **GALL-2.** Kunden får notis 60, 30 och 7 dagar före gallring med information om hur data återaktiveras eller exporteras.
- **GALL-3.** Faktisk radering av kunddata kräver en godkänd begäran med fyra-ögon (`data.purge`). Den utförs som en loggad åtgärd. Endast loggen över att radering skett behålls, inte innehållet.
- **GALL-4.** Retentionstiderna är konfigurerbara per plattform i systeminställningarna. Ändringar loggas.

## 8.3 Registrerades rättigheter

- Tillgång och dataportabilitet: arbetsytans administratör kan exportera arbetsytans data (JSON och CSV) i läget `export_only`. Export är tillgänglig även för avslutade arbetsytor under retentionstiden.
- Radering och rättelse av enskild medlem eller spelare hanteras av kunden i produkterna. Begäran som inkommer till plattformsägaren vidarebefordras till kunden som personuppgiftsansvarig inom 5 arbetsdagar.
- Begäran om radering av ett plattformskonto hanteras enligt 8.4.

## 8.4 Borttagning av användare

"Ta bort användare" kräver fyra-ögon och orsak, och innebär:

1. kontot inaktiveras och alla sessioner återkallas,
2. personuppgifter (namn, e-post, telefon) ersätts med anonymiserade värden (`Raderad användare`, `deleted+<id>@invalid`),
3. arbetsytemedlemskap tas bort. Objekt som användaren skapat i produkter behålls med anonymiserad upphovsperson,
4. audit-poster behåller användar-ID men inga personuppgifter.

Om användaren är ensam ägare till en aktiv arbetsyta nekas borttagningen tills ägarskapet överförts.

## 8.5 Dataminimering och maskering

- Superadmin ser endast de personuppgifter som krävs för support: namn, e-post, telefon, roller, inloggningshistorik. Adress och födelsedatum visas inte.
- Telefonnummer och e-post i listor kan maskeras för roller som inte behöver dem (`users.view` utan `users.account_actions` får maskerad telefon).
- Hemligheter och personnummer maskeras i alla loggar och felmeddelanden (`[REDACTED]`).

---

# 9. Faser, prioritet och acceptanskriterier

Superadmin byggs från start och parallellt med plattformsgrunden. Lanseringarna:

- **Lansering 1 (testperiod, ej betalande):** Fas S0 och S1 är klara.
- **Lansering 2 (betalande kunder):** Fas S2 är klar.

## Fas S0 – Plattformsgrund och Superadmin MVP (P0)

Leverans:

- Projektstruktur, migrationer, databasmodell, multi-tenancy.
- Kundautentisering, användarkonton, arbetsytor, medlemskap, tenant-isolerat API.
- Administratörsautentisering med MFA, återställningskoder, break-glass, roller och behörighetsmatris.
- Produktlicenser (entitlements), planer och abonnemang med statusmaskin och `resolveAccess`.
- Audit log, godkännandeflöde (fyra-ögon), tekniska fel med maskering.
- Superadmin-vyer: Dashboard, Kundlista, Kunddetaljer, Användarlista, Användardetaljer, Produkt- och licenshantering, Supporthantering (ärenden, kommentarer, interna anteckningar), Godkännanden, Audit log.
- Read-only supportåtkomst med tidsbegränsning, kundgodkännande för personnära data och kundnotifiering.
- Utkorg för e-postnotiser (transport: loggad utkorg, riktig SMTP i S1).
- Designsystem och responsiv layout.

**Acceptans S0**
- [ ] Endast aktiva administratörer med MFA kan logga in. Konto utan MFA kan bara registrera MFA.
- [ ] Alla arbetsytor och användare kan visas, sökas och filtreras med kombinerade filter.
- [ ] Produkter kan aktiveras, inaktiveras och pausas per kund. Åtkomstläget följer avsnitt 4.4 (täcks av tester).
- [ ] Abonnemangsstatus kan ändras enligt tillåtna övergångar. Otillåtna övergångar nekas.
- [ ] Support Admin nekas (HTTP 403) alla åtgärder som matrisen förbjuder, kontrollerat mot servern.
- [ ] Åtgärder med **4** skapar godkännandebegäran och utförs först när en annan administratör godkänt.
- [ ] Alla administrativa ändringar finns i audit log med administratör, mål, orsak, före och efter.
- [ ] Kundanvändare kan inte nå en annan arbetsytas data (täcks av tester).
- [ ] Read-only supportsession är tidsbegränsad, kräver ärende och orsak, loggas och skapar kundnotis. Efter utgång nekas åtkomst.
- [ ] Personnära data i supportvyn kräver kundgodkännande.
- [ ] Hemligheter förekommer inte i API-svar eller loggar.
- [ ] Tekniska fel kan sökas per arbetsyta och användare.
- [ ] Break-glass kan öppnas via serverkommando, loggas som `critical` och förseglas automatiskt.
- [ ] Gränssnittet fungerar på desktop, surfplatta och mobil.

## Fas S1 – Support och kundkommunikation (P1)

- Assisterad supportåtkomst med kundgrant och åtgärdslista.
- Riktig SMTP-transport och e-postmallar. Kundkommunikation till enskild kund (SA-NOTIF).
- Respitnotiser vid `PastDue` (dag 0, 3, 7, 12).
- Kundgränssnitt för godkännande av supportåtkomst i respektive produkt.
- Bifogade filer via File Storage.

**Acceptans S1:** Superadmin kan hjälpa kunder med vanliga konto- och konfigurationsproblem utan externa verktyg, och kunden informeras om all åtkomst.

## Fas S2 – Kommersiell administration (P1)

- Betalleverantör (avsnitt 10), fakturahistorik, betalningsstatus, rabatt och manuella prisjusteringar, återbetalning (fyra-ögon).
- Funktionsflaggor med administrationsgränssnitt, systeminställningar, e-postmallar, policyversioner.

**Acceptans S2:** Superadmin kan hantera hela kundens produkt- och abonnemangssituation, inklusive betalningsproblem, och moms är korrekt på alla fakturor.

## Fas S3 – Avancerad systemadministration (P1/P2)

- Avancerad felsökningsvy, bakgrundsjobb, integrationsövervakning, systemincidenter, fillagring och realtidsstatus på dashboarden.

**Acceptans S3:** Vanliga tekniska ärenden kan felsökas från Superadmin utan externa verktyg.

## Fas S4 – Verksamhetsanalys och massutskick (P2)

- Kundtillväxt, bortfall, produktanvändning, supportstatistik, automatiska varningar, rapporter, export, massutskick med fyra-ögon.

**Acceptans S4:** Plattformsägaren kan följa verksamheten från en samlad vy och skicka massutskick med skydd mot oavsiktliga utskick.

## Kundprodukter

Föreningsportalen och Turneringssystemet byggs som egna faser efter S0 och är ej del av detta dokuments leverans. De ansluter till de gemensamma bastjänsterna (Identity, Workspace, Entitlements, Notifications, Logging) som levereras i S0.

---

# 10. Betalning, fakturering och moms

Beslut (standardval, kan ersättas):

- **PAY-1.** Betalleverantör: **Stripe Billing**, bakom ett eget gränssnitt `PaymentProvider` så att leverantören kan bytas. Plattformen lagrar **aldrig** kortnummer, CVC eller kortdata. Endast leverantörens kund-ID, prenumerations-ID, kortets sista fyra siffror och betalstatus lagras.
- **PAY-2.** Valutor: SEK (standard), samt NOK, DKK och EUR. Belopp lagras i minsta enhet (öre) som heltal.
- **PAY-3.** Abonnemang debiteras månadsvis eller årsvis i förskott. Årsbetalning kan ge rabatt enligt plan.
- **PAY-4.** Betalningsstatus synkas från leverantören via webhook (signaturverifierad). Statusändringen mappas till prenumerationsstatus enligt avsnitt 4.2 (`invoice.payment_failed` → `PastDue`, `invoice.paid` → `Active`).
- **PAY-5.** Faktura: varje debitering ger en faktura med löpnummer, säljarens och köparens uppgifter, organisationsnummer, momsregistreringsnummer, specifikation, momsbelopp och förfallodatum. Kunden kan välja kortbetalning eller faktura (30 dagar) enligt plan.
- **PAY-6.** Återbetalningar och krediteringar kräver `billing.refund`, orsak, åter-autentisering och fyra-ögon, och loggas.
- **PAY-7.** Kundens fakturaunderlag lagras i 7 år.

## 10.1 Moms

- **MOMS-1.** Kundens land, organisationsnummer och i förekommande fall momsregistreringsnummer (VAT-ID) registreras vid köp.
- **MOMS-2.** Sverige: 25 % moms. Övriga EU-länder med giltigt VAT-ID (kontrolleras mot VIES): omvänd skattskyldighet, 0 % moms med hänvisning till omvänd skattskyldighet. Privatperson eller utan giltigt VAT-ID i andra EU-länder: momssats enligt kundens land (OSS). Norge och andra länder utanför EU: enligt gällande regler, hanteras i leverantörens skatteberäkning.
- **MOMS-3.** Momsberäkning utförs av betalleverantörens skattemodul (Stripe Tax) och verifieras av tester mot en tabell över momsfall.
- **MOMS-4.** Priser i administrationsgränssnittet och på planer visas exklusive moms.
- **MOMS-5.** Plattformsägaren ansvarar för att bekräfta bokföringsupplägg och momsregistrering med sin redovisningskonsult innan Lansering 2.

---

# 11. Entitlement-modell och gränser

## 11.1 Modell

```
Plan ──(1..n)── PlanEntitlement(produkt, gränser, funktioner)
Workspace ──(1)── Subscription(plan, status, period, trial, respit)
Workspace ──(0..n)── ProductEntitlement(produkt, status, gränsöverstyrning, källa, utgångsdatum)
Workspace ──(0..n)── FeatureFlagOverride(flagga, värde)
```

- Planen definierar standardgränser och funktioner per produkt.
- Admin kan överstyra gränser per arbetsyta (`limits_override`) och ge tillfällig åtkomst via `expires_at`.
- **Effektiv gräns** = överstyrning om den finns, annars planens gräns.
- Produktlicens (`ProductEntitlement`) skapas när en produkt aktiveras. Planen avgör vilka produkter som får aktiveras.

## 11.2 Gränser

| Nyckel | Betydelse |
|---|---|
| `max_users` | Antal användare med medlemskap i arbetsytan |
| `max_members` | Antal medlemmar i medlemsregistret (Föreningsportal) |
| `max_tournaments` | Antal aktiva turneringar (Turneringssystem) |
| `storage_mb` | Lagringsutrymme |

Värdet `null` betyder obegränsat.

## 11.3 Kontroll och påverkan

- **ENT-1.** Backend kontrollerar vid varje skapande av ett objekt mot effektiv gräns och mot `resolveAccess`.
- **ENT-2.** Överskrids gränsen sätts licensen till `LimitExceeded` och kunden notifieras. Skapande i den dimensionen blockeras med felkod `LIMIT_EXCEEDED` och ett begripligt meddelande. Befintlig data påverkas inte.
- **ENT-3.** När användningen åter ligger under gränsen återgår licensen till `Enabled` automatiskt.
- **ENT-4.** En nedgradering som skulle ge `LimitExceeded` är tillåten men kräver bekräftelse i gränssnittet och noteras för kunden.
- **ENT-5.** Aktivering av den andra produkten rör inte den första produktens data.

---

# 12. Icke-funktionella krav

## 12.1 Prestanda

Måttet gäller med 10 000 arbetsytor, 100 000 användare och 1 000 000 audit-poster.

| Operation | p95 |
|---|---|
| Listor med sökning och filter (sidindelade) | ≤ 300 ms |
| Detaljvyer | ≤ 400 ms |
| Dashboard | ≤ 500 ms |
| Skrivande administrativa åtgärder | ≤ 500 ms |

- Alla listor är sidindelade serverside (max 100 poster). Sök- och filterkolumner har index.
- Dashboard-nyckeltal beräknas med aggregerande frågor och får cachas upp till 30 sekunder.

## 12.2 Tillgänglighet och drift

- Målsättning vid Lansering 1: **99,5 %** tillgänglighet per månad. Vid Lansering 2: **99,9 %**.
- Planerat underhåll meddelas kunder minst 48 timmar i förväg.
- Hälsokontroll `/healthz` (liveness) och `/readyz` (databas nåbar).

## 12.3 Backup och återställning

- **RPO** (maximal dataförlust): 15 minuter. **RTO** (återställningstid): 4 timmar.
- Dagliga fulla databasbackuper med kontinuerlig WAL-arkivering (point-in-time recovery). Backuper lagras krypterat och i en annan region än databasen. Retention 35 dagar.
- Återställning testas minst var tredje månad och resultatet dokumenteras.

## 12.4 Tillgänglighet (användare)

- Superadmin-gränssnittet följer **WCAG 2.2 nivå AA**: tangentbordsnavigering, synlig fokusmarkering, kontrast minst 4,5:1, semantiska landmärken, formulär med etiketter och felmeddelanden kopplade till fält, `aria-live` för statusmeddelanden.
- Responsiv layout: mobil (≥ 360 px), surfplatta (≥ 768 px), desktop (≥ 1200 px).
- Språk: svenska. Alla texter hämtas från en central textfil för framtida översättning.
- Stödda webbläsare: de två senaste huvudversionerna av Chrome, Edge, Firefox och Safari.

## 12.5 Observerbarhet och loggning

- Strukturerad loggning (JSON) med korrelations-ID per förfrågan. Samma ID returneras till klienten i felsvar (`requestId`) så att supporten kan koppla ett kundproblem till en loggpost.
- Alla ohanterade fel sparas i `system_errors` med arbetsyta, användare, rutt och maskerade detaljer.
- Larm för förhöjd felfrekvens, misslyckade bakgrundsjobb och fullt e-postkö.

## 12.6 Felhantering

- API-fel returneras som `{ "error": { "code": "...", "message": "...", "requestId": "..." } }` med begripliga svenska meddelanden. Interna detaljer (stacktrace, SQL) exponeras aldrig.

---

# 13. Datamodell (översikt)

**Plattformskärna:** `users`, `user_sessions`, `workspaces`, `workspace_members`, `plans`, `plan_entitlements`, `subscriptions`, `product_entitlements`, `feature_flags`, `feature_flag_overrides`, `notification_outbox`, `system_errors`, `platform_settings`, `schema_migrations`.

**Superadmin:** `platform_admins`, `platform_admin_sessions`, `platform_admin_recovery_codes`, `admin_audit_log`, `approval_requests`, `support_cases`, `support_case_comments`, `support_access_grants`, `support_access_sessions`, `workspace_notes`, `purge_candidates`, `system_incidents` (S3). Kundnotiser och utgående e-post hanteras via `workspace_notifications` och `notification_outbox` (kärntabeller); någon separat `admin_notifications`-tabell finns inte.

Ytterligare krav: alla tabeller har `created_at`. Tabeller med föränderlig data har `updated_at`. Främmande nycklar har index. Audit-tabellen är append-only.

---

# 14. Slutlig produktstruktur

**1. Föreningsportal.** Fristående SaaS-produkt för medlemsregister, forum, nyheter, kalender, aktiviteter, dokument och föreningsadministration.

**2. Turneringssystem.** Fristående SaaS-produkt för spelregister, turneringar, spelare, matcher, resultat, ranking och egna tävlingsformat.

**3. Superadmin.** Separat administrationsportal för kundhantering, användarhantering, abonnemang, produktlicenser, support, säkerhet, systemövervakning och plattformsadministration.

Produkterna kan användas var för sig eller tillsammans. Superadmin administrerar båda oavsett kundens val.

**Grundprincip: Två fristående kundprodukter, en gemensam plattform och ett separat Superadmin-system för fullständig kontroll och kundsupport.**
