# Plattform – Superadmin MVP (spec v0.4, Fas 0 + S0)

Monorepo (npm workspaces):

| Katalog | Innehåll | Status |
|---|---|---|
| `apps/api` | Fastify 5 + TypeScript + PostgreSQL, migrationer, auth, behörigheter, Superadmin-API, kund-API (grund) | Implementerad |
| `apps/admin` | React + Vite Superadmin-gränssnitt | Implementerad (S0) |
| `apps/customer-account` | Kundens kontoområde (konto, medlemmar, supportåtkomst) | Implementerad (grund) |
| `apps/association-portal` | Föreningsportal | Medlemsregister, import, nyheter, kalender, port 5175 |
| `apps/tournament-system` | Turneringssystem | Serier, utslagning, gruppspel + slutspel: lag, spelschema/bracket, resultat, tabell, port 5176 |
| `docs/` | `kravspecifikation-v0.4.md`, `STATUS.md`, `DECISIONS.md`, skärmdumpar |

## Kom igång

Krav: Node 22, PostgreSQL 16.

```bash
npm install
export DATABASE_URL=postgres://...        # se apps/api/src/config.ts för alla variabler
npm run migrate -w apps/api               # versionerade SQL-migrationer
npm run seed -w apps/api                  # DEV: 7 admins, 30 demokunder, ärenden, fel
npm run dev -w apps/api                   # API på :4000
npm run dev -w apps/admin                 # Superadmin på http://127.0.0.1:5173 (proxar /api/platform-admin)
npm run dev -w apps/customer-account      # Kundkonto på http://127.0.0.1:5174 (proxar /api/v1)
```

Dev-inloggning (endast seed): `super@example.test` / `DevAdminPassword!2026`, TOTP-hemlighet `JBSWY3DPEHPK3PXP`
(läggs in i valfri autentiseringsapp). Övriga roller: `owner@`, `support@`, `billing@`, `tech@`, `readonly@example.test`.
**Dessa konton och hemligheten får aldrig finnas i produktion.** Skapa riktiga admins med `npm run admin:create -w apps/api`.

`ADMIN_BASE_URL` (standard `http://127.0.0.1:5173`) styr länkar i administratörsmejl.

Produktion kräver bl.a. `ADMIN_ALLOWED_HOSTS` och krypteringsnycklar (se `config.ts`, appen vägrar starta annars).

## Test
```bash
npm test -w apps/api          # 189 tester mot riktig PostgreSQL (schemat återskapas)
npm run typecheck -w apps/api && npm run typecheck -w apps/admin
```

## E-post
`MAIL_TRANSPORT` = `smtp` | `file` (dev, skriver `.eml` till `MAIL_FILE_DIR`, standard utanför test) | `none`.
SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `MAIL_FROM`. `file` är förbjudet i produktion.
