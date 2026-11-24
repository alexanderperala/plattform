# Status – Fas 0 och Superadmin MVP + S1 e-post (2026-11-24)

## Verifierat
- **318 automatiska tester passerar** mot riktig PostgreSQL: behörighetsmatrisen per roll (mot specens tabell), tenant-isolering, MFA/sessioner/lockout, tillståndsmaskiner (abonnemang, ärenden), four-eyes, supportåtkomst (tidsgräns, grants, notiser), append-only-granskning, maskning av hemligheter, retention-jobb.
- Typecheck (API och admin) och produktionsbygge av admin är rena.
- **Webbläsartest (Playwright, Chromium) mot körande API + databas:** inloggning → MFA → alla huvudvyer navigerar → kunddetalj → *pausa* och *återaktivera* en arbetsyta med orsak (skrivs i granskningsloggen) → mobilvy med utfällbar meny. Skärmdumpar i `docs/screenshots/`. Inga JS-fel i konsolen (endast väntade 401 före inloggning).

## S1 – e-postleverans (ny)
- `notification_outbox` skickas nu av en arbetare (var 15:e s) via SMTP (`MAIL_TRANSPORT=smtp`) eller `.eml`-filer i dev (`file`); `none` skickar inget. Omförsök med exponentiell backoff (max 6 försök, sedan `failed` som syns på översikten), `skip locked` + 5 min lease mot dubbelutskick, minst-en-gång vid krasch. Engångslänkar (återställning, verifiering, inbjudan) rensas ur utkorgen efter lyckad leverans.
- Kundsynliga ärendesvar fungerar (API + UI): kräver mottagare, nekas på stängda ärenden, flyttar ärendet till "Väntar på kund", mottagarens adress hamnar inte i granskningsloggen.
- Verifierat mot en riktig SMTP-server (lokal sink): kundsvaret och 10 tidigare köade kundnotiser levererades. Testet avslöjade och rättade ett riktigt fel (dubbelutskick vid parallella arbetare).
- **Ej verifierat:** TLS/autentisering mot en riktig leverantör, studsar/avregistreringar, SPF/DKIM (driftfråga), mallar utöver ren text.

## S1 – kundens godkännande av supportåtkomst (ny)
- Ny app `apps/customer-account` (port 5174): inloggning, registrering, glömt lösenord, inbjudan/verifiering, översikt (abonnemang, produktåtkomst, aktivera produkt, notiser), medlemmar (bjud in) och **Supportåtkomst** där arbetsytans ägare/administratörer ger, ser och återkallar tidsbegränsat godkännande (1–72 h) för personuppgifter samt ser historik över all supportåtkomst.
- Backend: godkännande och återkallelse revisionsloggas (`support.grant.*`) och notifierar arbetsytans administratörer (notis + e-post). Nytt godkännande ersätter tidigare. **Återkallelse avslutar pågående supportsessioner direkt** (`grant_revoked`). Annan kunds försök att läsa/ge/återkalla ger 404.
- Verifierat i webbläsaren med två parallella sessioner: supportadmin nekas personuppgifter → kunden godkänner → admin ser medlemmar → kunden återkallar → adminens session är avslutad vid nästa anrop. Skriptet: `apps/admin/e2e/grant.py`.
- Webbläsartestet hittade ett riktigt fel i båda gränssnitten: anrop utan body (t.ex. `DELETE`, `activate`, `logout`) skickades med `content-type: json` och avvisades av Fastify med 400. Rättat i båda klienterna.
- Tester avslöjade även en saknad migration (006) för den nya avslutsorsaken; en 500 fångades innan release.
- **Begränsningar:** kundappen är ett kontoområde, inte Föreningsportalen. Inga MFA/2FA för kundkonton, ingen e-postbyte/profil-sida, ingen UI för att byta roll på medlemmar eller ta bort dem. Godkännandet gäller hela arbetsytan (inte per ärende). Kundapp har ingen Playwright-täckning utöver supportflödet och är inte tillgänglighetsgranskad.

## S1 – adminhantering (ny)
- Sida **Administratörer** (endast Platform Owner): bjud in, byt roll, återställ MFA, inaktivera, aktivera. Skapande, rollbyte, aktivering och MFA-återställning går via four-eyes och utförs först när en annan administratör godkänner. Inaktivering sker direkt (skyddande) med orsak + omautentisering.
- Kontoinnehavaren får en engångslänk (48 h) per e-post och väljer eget lösenord (min 14 tecken) på `/setup`; MFA registreras vid första inloggningen. Ingen administratör ser eller sätter någon annans lösenord. Länkens token rensas ur utkorgen efter leverans.
- Skydd: minst en aktiv Platform Owner finns alltid kvar; ingen kan ändra roll/MFA/konto på sig själv (kontrolleras både vid begäran och vid utförande mot den som *begärde*, inte godkännaren); break-glass kan inte hanteras via UI/API; MFA-återställning ogiltigförklarar även lösenordet så att stulet lösenord inte räcker för att registrera egen MFA-enhet; rollbyte, inaktivering och MFA-återställning avslutar adminens sessioner.
- Tester (8 nya) hittade ett riktigt fel: självändringskontrollen jämförde med godkännaren i stället för begäraren, så en ägare kunde ändra sin egen roll med en kollegas godkännande. Rättat. `created_by` pekar nu på begäraren.
- Verifierat i webbläsaren: owner begär → super godkänner → länk i e-post → lösenord → MFA-registrering → inloggad som Billing Admin med rätt meny → owner inaktiverar → nya adminens session är avslutad direkt (`apps/admin/e2e/admins.py`).
- **Begränsningar:** ingen ändring av namn/e-post, ingen "skicka länk igen" (gör MFA-återställning), ingen lista över en admins historik i UI (finns i granskningsloggen), inget skydd mot att två ägare tillsammans missbrukar four-eyes (organisatorisk kontroll).

## S1 – assisterad support (ny)
- Kunden (ägare/admin) godkänner i kundappen: tillåtna åtgärdstyper (*ändra felaktig inställning*, *aktivera behörighet*, *konfigurera funktion*), 1–72 h, valfritt bundet till ett ärende. Ett aktivt assisterat godkännande i taget. Databasen avvisar andra åtgärdstyper.
- Admin startar assisterad session: kräver `support.access_assisted` (PO/SA/SU), orsak, MFA inom 5 min, ärende, max 60 min och aldrig längre än godkännandet. Kunden notifieras (inkl. e-post).
- Åtgärder (`POST /support/access-sessions/:id/actions`): varje anrop kräver orsak + färsk MFA, kontrollerar att godkännandet gäller och att åtgärdstypen är tillåten, loggar före/efter med ärende och notifierar kunden. Ägarens roll kan inte ändras. Abonnemang, betalning, lösenord, MFA, radering och ägarbyte finns inte som åtgärder.
- Återkallelse avslutar sessionen direkt; utgånget godkännande nekar åtgärder (GRANT_REVOKED). Read-only-session kan inte utföra åtgärder.
- Verifierat: 9 nya API-tester och ett Playwright-flöde med två webbläsarsessioner (`apps/admin/e2e/assisted.py`): nekas utan godkännande → kund godkänner → admin slår på flagga och ändrar kontaktperson → kunden ser notiser och historik (antal åtgärder) → återkallelse stoppar åtgärder.

## S2 – funktionsflaggor och systeminställningar (ny)
- **Flaggor** (`/flags`, sidan Funktionsflaggor): standardvärde per flagga (`flags.manage`, orsak) och överstyrning per kund, inklusive borttagning. Överstyrningar som supporten sätter i assisterad session syns här. Alla ändringar loggas med före/efter. Technical Admin får ändra, Read-only ser men kan inte ändra (backend avgör, 403).
- **Inställningar** (`/settings`, sidan Inställningar): fem inställningar (respitperiod, provperiod, två retentionstider, självgodkännande för ensam ägare). Kräver `settings.manage` (orsak + MFA), validering av typ och gränser i backend, okända nycklar nekas, vem/när visas. Retention kan inte sättas så att data raderas automatiskt (gallring kräver fortfarande four-eyes).
- Verifierat: 7 nya API-tester (+ 5 rader i rollmatristestet), testisoleringen återställer nu flaggor och inställningar, samt Playwright (`apps/admin/e2e/config.py`) med Superadmin, Technical Admin och Read-only.
- **Ärligt:** inga produkter läser flaggorna ännu (produktapparna finns inte), och ändrade retentionsinställningar läses bara av retention-jobbet. Respit- och provlängd används vid beräkning respektive nya prov enligt tidigare implementation.

## Browser-E2E, CI och beroenden (ny)
- `apps/admin/e2e/run-all.sh` (`npm run e2e`) kör fyra självständiga Playwright-flöden med riktiga assertioner (exit 1 vid avvikelse): kundens godkännande, assisterad support, flaggor/inställningar och roller. Senaste körning: alla OK.
- `roles2.py` täcker Billing Admin, Technical Admin och Read-only (meny, dolda knappar och 403 direkt mot API:t) samt **avslag av four-eyes**: kunden förblir Active, begäran blir `rejected`, avslaget loggas och en avslagen begäran kan inte godkännas efteråt (409).
- `.github/workflows/ci.yml`: typecheck, API-tester mot PostgreSQL, build av båda frontendarna, `npm audit --omit=dev --audit-level=high` och ett E2E-jobb. **Workflowen är inte körd på GitHub** (projektet ligger inte i ett git-repo här); den är YAML-validerad och varje kommando är körd lokalt.
- Beroendeskanningen hittade en hög sårbarhet i zod 3 (minnesutmattning vid stora arrayer). Uppgraderat till zod 4.6.7 (en rad ändrades), alla 223 tester och E2E gröna, och `audit --audit-level=high` ger nu exit 0. React Router är uppgraderat till 7.18.6 (öppen omdirigering åtgärdad). `npm audit --omit=dev` är nu helt ren; kvarvarande fynd gäller bara utvecklingsverktyg (vitest/esbuild) och påverkar inte driftsatt kod.

## Föreningsportal – första snittet: medlemsregister (ny)
- Egen frontend `apps/association-portal` (port 5175, `npm run dev:portal`) och API under `/workspaces/:wid/association/members`: lista med sök/filter/paginering, skapa, ändra, ta bort, export (CSV med BOM och skydd mot formelinjektion, samt JSON).
- **Row-Level Security** (D3 infriat): `association_members` har `ENABLE` + `FORCE ROW LEVEL SECURITY` med policy på `app.workspace_id`. Allt åtkomst går via `withWorkspace()`; utan kontext ser man 0 rader (fail closed). Testat på databasnivå: en fråga utan `where` ser bara den egna arbetsytan, skrivning mot annan arbetsyta nekas av `with check`, och kontexten läcker inte mellan poolens anslutningar.
- Backend tillämpar de fyra åtkomstlägena: Suspended = bara läsning, Closed = bara export, inaktiverad licens = 403 `PRODUCT_NOT_AVAILABLE` (data bevaras), `LimitExceeded` = ändra/ta bort men inte skapa. `max_members` kontrolleras atomärt (8 samtidiga skapanden mot gräns 3 ger exakt 3) och licensen återgår till Enabled vid radering (ENT-3).
- Läsning för alla arbetsytans medlemmar, skrivning/export för ägare/admin. Icke-medlemmar får 404. Radering och export loggas utan personuppgifter.
- Verifierat: 10 nya API-tester och Playwright `portal.py` (register, sök, ändring, dubblettnummer, CSV-nedladdning, gräns, radering, isolering mellan två kunder, 404 direkt mot annan arbetsyta).
- **Ärligt:** RLS skyddar mot glömda filter och buggar, inte mot SQL-injektion (samma kod sätter kontexten). Ingen import av medlemmar, inga fält utöver grunduppgifter, inget forum/kalender/dokument ännu. Inloggning i portalen delar kundkontots cookie; i produktion på olika underdomäner kräver det en gemensam cookie-domän eller token-utväxling (inte gjort). Superadmin visar inte medlemsdata (endast antal via användning).

## Föreningsportal – import av medlemmar (ny)
- **CSV-import med förhandsgranskning** (`POST …/association/members/import/preview` och `…/import`): komma eller semikolon, BOM, citattecken och radbrytningar i fält. Svenska och engelska rubriker (Medlemsnummer, Namn, E-post, Telefon, Status, Medlem sedan, Anteckningar). Okända kolumner ignoreras och rapporteras.
- Förhandsgranskningen skriver ingenting och visar antal giltiga/felaktiga rader, felorsak per rad (max 100 visas), dubbletter i filen och mot registret samt om importen skulle överskrida `max_members`.
- Importen är atomär: har någon rad fel avbryts allt (409 `IMPORT_INVALID`) om man inte uttryckligen väljer att hoppa över felrader. Överskrids gränsen importeras inget (`LIMIT_EXCEEDED`). Högst 5 000 rader / cirka 900 kB per fil. Endast ägare/admin, endast skrivbart läge. Loggen innehåller bara antal.
- UI: dialog med mall att ladda ned, varning om filen inte är UTF-8, felrader i tabell och bekräftelse. Verifierat med 7 nya tester (inkl. 1 000 rader i en transaktion) och Playwright `portal_import.py` (blandad fil, överhoppade rader, å/ä/ö, gräns).
- **Ärligt:** ingen uppdatering av befintliga medlemmar via import (nya rader läggs bara till), ingen automatisk teckenkodsdetektering (användaren ombeds spara som UTF-8), inget bakgrundsjobb för mycket stora filer.

## Föreningsportal – nyheter (ny)
- Nyheter med **utkast och publicering** (`/workspaces/:wid/association/news`, sidan Nyheter som är portalens startsida): skapa, redigera, fästa överst, publicera/avpublicera (ursprungligt publiceringsdatum bevaras), ta bort, paginering. Egen tabell `association_news` med samma RLS-mönster (migration 010, D20).
- **Synlighet avgörs i backend:** utkast syns bara för ägare/admin; vanliga arbetsytemedlemmar ser endast publicerat, även om de ber om `?status=draft`, och kan inte skriva (403). Publicering sker bara via `publish` (status kan inte sättas vid skapande).
- Innehållet är ren text och renderas som text, aldrig HTML (testat: `<img onerror>` och `<script>` lagras och visas ordagrant). Audit för publicera/avpublicera/radera utan innehåll. Nyheter räknas inte mot `max_members`; åtkomstlägena gäller (pausad = läsa, avslutad/inaktiverad = nekad).
- Ett riktigt fel hittades av testerna under bygget: ett standardvärde i schemat följde med in i PATCH så att en ändring av enbart rubriken skulle ha raderat texten. Rättat med eget PATCH-schema och regressionstest.
- Verifierat: 8 nya API-tester och Playwright `portal_news.py` (admin och vanlig medlem i två sessioner, utkast/publicering/avpublicering/XSS/radering).
- **Ärligt:** "synlighet för medlemmar" betyder arbetsytans inloggade användare. Föreningens medlemmar i registret har inga konton, så **ingen publik nyhetssida eller e-postutskick till medlemmar** finns ännu (kräver publik adress/slug, moderering av publikt innehåll och utskickskö med samtycke/avregistrering). Ingen rik text, inga bilagor/bilder, inga kommentarer.

## Föreningsportal – kalender/aktiviteter (ny)
- Migration 011: `association_events` och `association_event_attendees` med RLS (ENABLE + FORCE) och sammansatta FK (workspace_id, id) – en anmälan kan aldrig peka på en medlem eller aktivitet i annan arbetsyta.
- Aktiviteter har titel, beskrivning, start, valfri slut, plats och kapacitet; utkast syns bara för ägare/admin. Anmälan görs av ägare/admin för medlemmar ur medlemsregistret (ingen självanmälan ännu). Kapacitet kontrolleras med radlås (EVENT_FULL), dubbletter nekas, inaktiva medlemmar nekas. Kapacitet kan inte sänkas under antal anmälda.
- Vanliga medlemmar ser publicerade aktiviteter och antal anmälda, men inte deltagarnas namn (personuppgifter). Åtkomstlägen följer samma regler som medlemmar/nyheter (Suspended = läs, Closed = export, ej licens = 403).
- Verifierat: 256 API-tester gröna, typecheck/build rena, `npm audit` 0 sårbarheter, alla browser-E2E-flöden (inkl. `portal_events.py`) gröna lokalt.
- Rättat i samband med detta: E2E-kontroller som läste RLS-tabeller via appens roll gav alltid 0 rader (RLS), alltså tomma bevis. De körs nu via superuser (kontroller) respektive med arbetsyte-kontext (inskrivning); gäller portal, import, nyheter och kalender.
- Begränsningar: ingen återkommande aktivitet, inga påminnelser/e-post, ingen väntelista, ingen självanmälan, ingen iCal-export. CI är fortfarande inte körd på GitHub.

## Turneringssystem – första snittet: serie (ny)
- Egen app (`apps/tournament-system`, port 5176), egen produktlicens (`tournament_system`), delar bara basfunktioner (auth, arbetsyta, åtkomstlägen, audit) med Föreningsportalen.
- Migration 012: `tournaments`, `tournament_teams`, `tournament_matches` med RLS (ENABLE + FORCE) och sammansatta FK. Ren domänlogik i `domain/tournament.ts` (cirkelmetoden, frilag vid udda antal, dubbelserie, tabell med poäng/målskillnad/gjorda mål/inbördes möte, delad placering när allt är lika).
- Flöde: utkast (lag kan läggas till/tas bort) → start (spelschemat genereras och låser lagen) → resultat rapporteras/rättas (ägare/admin) → avsluta (kräver att alla matcher har resultat). Vanliga medlemmar läser tabell och matcher men kan inte ändra något.
- Gränsen `max_tournaments` räknar ej avslutade turneringar, kontrolleras atomärt (radlås på arbetsytan) och licensen återgår till Enabled när en turnering avslutas eller raderas (ENT-3). Åtkomstlägen enligt avsnitt 4.4 (Suspended = läs, Closed/ej licens = 403).
- Verifierat: 265 API-tester (inkl. parallella skapanden, tenant-isolering, RLS mot rå SQL), typecheck/build rena, `npm audit` 0, browser-E2E `tournament.py` grön lokalt.
- **Utslagning (cup)** (migration 013): bracket för 2–64 lag, seedning efter lagens ordning (ettan och tvåan möts först i finalen), frilotter till högst seedade vid ojämnt antal, vinnare flyttas automatiskt fram, rondnamn (final/semifinal/kvartsfinal…). Oavgjort tillåts inte. Rättning är möjlig tills nästa match har spelats (annars RESULT_LOCKED); rensning tömmer platsen. Verifierat med enhets-, API- (270 tester) och browsertest (`tournament_ko.py`).
- **Gruppspel + slutspel** (migration 014): 2, 4 eller 8 grupper, 1 eller 2 lag går vidare per grupp. Lagen fördelas med snake-seedning efter den ordning de lades till (jämnstarka grupper), varje grupp spelar en serie. Slutspelet startas manuellt när alla gruppmatcher har resultat; seedningen är gjord så att lag från samma grupp inte möts i första slutspelsomgången (1A–2B, 1B–2A …). Gruppresultat låses när slutspelet startat. Delad placering som påverkar slutspelsplats (exakt lika på poäng, målskillnad, gjorda mål och inbördes möte) avgörs uttryckligen av administratören (`TIE_AT_CUTOFF`) – inget slumpas. Verifierat med enhets-, API- (275 tester) och browsertest (`tournament_groups.py`).
- **Export** (`GET /workspaces/:wid/tournaments/export?format=csv|json`, ägare/admin): alla turneringar med lag och matcher, formelinjektionsskydd i CSV, loggas i audit och fungerar även när arbetsytan är Closed (export_only). Verifierat i API-test (276 tester). Ärlig begränsning: UI:t visar exportlänken bara när listan går att läsa, så för en avslutad arbetsyta nås exporten i dagsläget bara direkt via API:t.
- Begränsningar: ingen bronsmatch, bara 2/4/8 grupper, ojämn gruppstorlek hanteras genom snake-fördelning utan särskild jämkning av poäng mellan grupper, ingen förlängning/straffar (matchen måste ha en vinnare på resultatet), seedning kan inte ändras manuellt, inga spelartrupper, ingen publik resultatsida, ingen tidsplanering av matcher (datum/bana), ingen export, inga notiser. CI är fortfarande inte körd på GitHub.

## Processpunkt
- Migration 011 ändrades en gång efter att den körts lokalt, vilket gav avvikelse mellan dev-databasen och testschemat. Dev-databasen återskapades från migreringarna. Regel framåt: körda migreringar ändras aldrig, nya ändringar blir nya migreringar.

## Betalning och fakturering (Stripe) (ny)
- `PaymentProvider`-gränssnitt (D9/PAY-1) med `StripeProvider` (REST via fetch, ingen SDK), `FakeProvider` (utveckling/test) och val via `STRIPE_SECRET_KEY`. Kortdata hanteras aldrig av plattformen – kunden skickas till Stripe Checkout/kundportal; vi lagrar bara kund-/prenumerations-ID.
- Webhook `POST /api/webhooks/stripe`: signaturverifierad (HMAC-SHA256, 5 min tolerans, flera v1 för nyckelrotation, ingen hemlighet = alltid nej), idempotent per händelse-ID, hela hanteringen i en transaktion. Mappning enligt 4.2: betalning genomförd → Active (plan, intervall, ID:n), `invoice.payment_failed` → PastDue (respitklockan startar en gång), `invoice.paid` → Active + fakturaspegling, uppsägning/ångrad uppsägning → CanceledAtPeriodEnd/Active, avslutat → Expired. Ogiltiga övergångar och okända planer ändrar inget; okopplade händelser loggas som `unmatched`. Ingen arbetsyta eller data raderas av något betalflöde; ägare/admin notifieras (kan inte stängas av).
- Kund (ägare/admin): sida **Fakturering** med plan, status, planväljare (priser exkl. moms), faktureringsuppgifter (land, orgnr, VAT-ID; MOMS-1), betalsätt via Stripes portal och fakturalista (belopp, moms, länk/PDF). Köp kräver faktureringsuppgifter. Fakturaunderlag har ingen FK mot arbetsytan och raderas aldrig automatiskt (PAY-7).
- Verifierat: 286 API-tester (signaturvarianter, idempotens, alla statusövergångar, rollkontroll, isolering, Stripe-adapterns parametrar och felöversättning), browser-E2E `billing.py` (signerade webhooks mot dev-API).
- **Ej verifierat mot riktiga Stripe** (ingen nyckel/nätåtkomst här): anrop mot api.stripe.com, att Stripe Tax är aktiverat, att pris-ID:n i `plans.provider_price_monthly/yearly` är satta, samt att Stripes verkliga händelsepayload matchar de fält vi läser. Måste provköras i Stripes testläge. Priser/årsrabatt är platshållare (D9). Momslogiken (MOMS-2/3) ligger hos Stripe Tax och är inte testad mot momsfallstabellen; VIES-kontroll av VAT-ID saknas. Kredit/återbetalning (PAY-6) och faktura som betalsätt (PAY-5) är inte byggda. Kundportalen visar inte Stripes uppsägning i vår UI förrän webhooken kommit.
- För test mot Stripe: sätt `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_BASE_URL`, fyll `provider_price_*` och peka webhooken på `/api/webhooks/stripe` (händelser: checkout.session.completed, invoice.paid, invoice.payment_failed, customer.subscription.updated/deleted).

## Föreningsportal – medlemsutskick (ny)
- Migration 016: `association_mailings` (utkast/skickat) och `association_mailing_recipients` med RLS (D20) och sammansatta FK, `email_opt_out` på medlemmar, samt kolumnen `notification_outbox.unsubscribe_url`.
- Ägare/admin skriver utskick (ämne utan radbrytningar – skydd mot header-injektion – och ren text), ser före sändning hur många som nås och hur många som hoppas över (saknar e-post / avanmälda / inaktiva) och skickar. Mottagare = aktiva medlemmar med e-postadress som inte avanmält sig. Skickade utskick kan varken ändras eller raderas; mottagarlistan (vem som fått vad) sparas och visas. Audit loggar utskick och avanmälningar utan e-postadresser.
- Skydd mot missbruk: högst 5 utskick per dygn och arbetsyta, högst 5000 mottagare, sändning är serialiserad (parallella klick ger exakt en sändning), kräver skrivbar arbetsyta.
- Varje meddelande har en egen avanmälningslänk (HMAC-signerad, domänseparerad nyckel, ingen databasuppslagning) och `List-Unsubscribe`/One-Click-header. Länken öppnar en publik sida som kräver bekräftelse (POST) – skannrar kan inte avanmäla av misstag. Förfalskade eller omflyttade länkar mellan arbetsytor avvisas (testat).
- Leverans går via den befintliga utkorgen (SMTP-transport, återförsök). **Leverantör ej vald:** Postmark/SES m.fl. fungerar via SMTP-inställningarna (`MAIL_TRANSPORT=smtp`, `SMTP_*`), men avsändardomän, SPF/DKIM/DMARC och leverantörens avanmälnings-/studsregler är inte konfigurerade eller provade här.
- Verifierat: 292 API-tester, browser-E2E `portal_mailings.py`.
- Begränsningar: ingen studs-/klagomålshantering, ingen HTML-mall eller bilagor, ingen personalisering, ingen mottagarsegmentering, ingen schemalagd sändning, och en avanmäld medlem kan inte återanmälas i UI (kräver databasingrepp/support). Meddelandetext sparas i klartext i databasen.

## Publik sida (opt-in) (ny)
- Beslut: publik visning är **avstängd som standard**, väljs aktivt per förening och per turnering, visar bara **lagnamn och resultat** (aldrig medlemsuppgifter) och föreningen ansvarar för samtycket.
- Migration 017: `public_pages` (plattformstabell utan RLS, uppslag via adress; inga personuppgifter) och `tournaments.is_public default false`.
- Admin (ägare/admin): `GET/PUT /workspaces/:wid/public-page`. Påslagning kräver `consent: true` (409 CONSENT_REQUIRED), samtyckets tid, användare och version sparas; adressen valideras (3–40 tecken, reserverade ord) och är unik (SLUG_TAKEN). Avstängning döljer allt direkt och återställer alla turneringars `is_public`. Turnering kan bara publiceras när sidan är på (409 PUBLIC_PAGE_DISABLED). Audit-logg på på/av.
- Publikt utan inloggning (rate-limitat per IP): `GET /api/v1/public/pages/:slug` och `…/tournaments/:id`. Bara publicerade nyheter (aldrig utkast) och turneringar som uttryckligen valts; 404 om sidan är av, arbetsytan inte är Active eller produkten saknas. Svaret innehåller inget arbetsyte-id eller användar-id.
- UI: Föreningsportalen "Publik sida" (admin) och publika vyer `/p/:slug`, `/p/:slug/t/:id` (noindex); Turneringssystemet har kryssrutan "Visa publikt".
- Verifierat: 299 API-tester (7 nya), browser-E2E `portal_public.py` (+ tournament*-E2E körda om efter refaktoreringen).
- Ej verifierat/ej gjort: kryssrutan i Turneringssystemet är bara typkontrollerad (E2E sätter flaggan via API); samtyckestexten bör granskas juridiskt; ingen cachning/CDN framför de publika endpoints; ingen robots.txt/sitemap (avsiktligt noindex); egen domän per förening finns inte.

## Turneringssystem – flipper (ny)
- Nytt format `pinball` (migration 018): spelare (inte lag), maskiner, **steg** som kedjas (varje steg tar topp N från föregående) och spelas i ordning. Stegtyper: **kval med försök** (best game: bästa poäng eller summa av bästa per maskin, max försök), **matchplay** (grupper om 3–4, placeringspoäng 7-5-3-1 eller 4-2-1-0, delad placering vid lika poäng, omgång för omgång med färre omatch och olika maskiner), **Swiss** (2–4 per bord, par efter ställning, ingen omatch när det går, frirunda med poäng och aldrig två gånger), **serie** (alla möter alla, 1 mot 1), **enkel utslagning** och **dubbel utslagning** (bäst av 1/3/5, frilottning, grand final med eller utan omspel).
- Spelplansmatris (rader = omgång/matchsteg, kolumner = maskiner, plus "ej tilldelad/väntar"), maskinöversikt (ledig/upptagen med vilka som spelar), bordsstatus (ej igång/pågår/klart; en maskin kan bara ha en pågående match), resultatinmatning per spel, utskriftsvänlig. Samma vy är publik, skrivskyddad och uppdateras automatiskt var 10:e sekund när turneringen pågår (kräver publik sida + "Visa publikt" per turnering).
- Regler: resultat kan rättas tills nästa omgång/match som beror på det har resultat (RESULT_LOCKED); oavgjort förbjudet i utslagning; steg kan bara startas när föregående är avslutat; seedning följer rankingen från föregående steg.
- Samtyckestexten för publika sidor är uppdaterad (version 2026-11b) och omfattar nu spelarnamn. **Spelarnamn visas publikt** när turneringen valts – föreningen ansvarar för samtycke (alias/smeknamn kan användas som namn).
- Verifierat: 318 API-tester (domänlogik inkl. simulering av enkel/dubbel utslagning för 2–17 spelare, API-flöden, behörighet, isolering), browser-E2E `pinball.py` (skapa, spelare, maskiner, matchplay, matris, resultat, omgång 2, publik live-vy) och hela `run-all.sh` (154 kontroller OK).
- Ej gjort/begränsningar: sena anmälningar efter start, utslagning med 4-spelargrupper ("grupper där två går vidare"), bronsmatch, handicap/lag-flipper (lagturnering), egna poängtabeller (bara två förval), tidsstyrda kval (tid per försök/kö), kortkval (card qualifying), tider/schema för bord, strikes/amazing-format, Herb-/ladder-format, omstart av utgången spelares match (manuell rättning krävs), import av spelare från CSV/medlemsregister, realtidsuppdatering via websockets (nu polling), tilt/avbrutna spel som egen status, och riktiga användarprov på surfplatta vid spelplatsen. Bracketens droppordning i förlorarsidan är inte verifierad mot en etablerad turneringsregel; den är bara testad för att alla spelare får en placering och inga omatcher av samma match.

## Levererat
**Fas 0:** monorepo, DB-modell + migrationer, auth och användarkonton, arbetsytor, tenant-isolering, roller/behörigheter, produktlicenser, abonnemangsstruktur, granskningslogg, API-struktur, designsystem, separat adminyta.

**Superadmin (8 krävda vyer, alla mot riktig data):** Översikt, Kunder (sök/filter/sortering/paginering), Kunddetalj (uppgifter, produkter och abonnemang, användare, support, anteckningar, historik, fel), Användare, Användardetalj, Produkter och licenser, Support (ärenden + skrivskyddad supportvy med nedräkning), Granskningslogg. Dessutom: Godkännanden (four-eyes), Tekniska fel, MFA-registrering med återställningskoder.

## Inte gjort / begränsningar (ärligt)
- Föreningsportal och Turneringssystem är bara platshållare. 
- Assisterad support: endast tre åtgärdstyper och inga bulkåtgärder; grant gäller per arbetsyta (valfritt ärende), inte per enskild åtgärd. Inkommande e-post/svar från kund till ärenden hanteras inte (envägs utskick).
- Ingen betalleverantör, fakturor, återbetalning eller moms (S2). Planpriser är platshållare.
- Ingen feature-flag-UI eller inställnings-UI.
- Anonymisering av granskningslogg vid retention är inte implementerad.
- RLS används ännu inte. Rate limiter är i minnet (en instans). 
- "Visa som kund" är en skrivskyddad ögonblicksbild, inte kundens riktiga gränssnitt.
- Dashboard övervakar inte bakgrundsjobb, fillagring, realtid eller integrationer (visas som "ej övervakat").
- Webbläsartest av roller och four-eyes: Support Admin ser inga destruktiva knappar och får 403 vid direktanrop av `close`. Superadmin begär avslut → 202 → begäran i inkorgen. Platform Owner godkänner: MFA-omautentisering krävs och dialogen visas (sessionens `reauth_at` gjordes gammal via SQL), åtgärden utförs, arbetsytan blir `Closed` och granskningsloggen får `approval.approved` + `workspace.close`. Skripten ligger i `apps/admin/e2e/` (Python/Playwright, körs manuellt mot dev-miljön, ingår inte i CI).
- Ej webbläsartestat: Billing/Technical/Read-only-rollerna, avslag på godkännande.
- Ingen tillgänglighetsrevision gjord utöver grundläggande semantik (etiketter, fokusringar, skip-länk, aria).

## Nästa steg
1. Kör CI på riktigt i GitHub (lägg koden i ett repo).
2. S1 funktionellt klart utom bifogade filer. S2: flaggor och inställningar klara; kvar betalning/fakturor (beslut om Stripe krävs) och e-postmallar.
3. Föreningsportal: kalender/aktiviteter, publik nyhetssida och utskick till medlemmar (kräver beslut om samtycke), uppdatering via import; gemensam cookie-/SSO-lösning över underdomäner; ta fram Turneringssystemet på samma mönster (`withWorkspace` + RLS).
