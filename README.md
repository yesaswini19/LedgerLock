# LedgerLine

LedgerLine is a Node.js, Express, and PostgreSQL money-movement demo. It stores amounts as integer paise and uses raw SQL so that transaction and row-locking behavior is explicit.

## Live demo

URL:https://ledgerlock-4yx2.onrender.com/

The credentials below are seeded for **local development and testing only** by `scripts/seed.js`. They are predictable demo credentials: never use them for real accounts or deploy them on a public or otherwise untrusted instance. Do not seed a public deployment with these accounts.

| Role | Email | Password |
|---|---|---|
| Admin | `admin@ledgerline.test` | `Admin@12345` |
| Account holder (Alice) | `alice@ledgerline.test` | `Alice@12345` |
| Account holder (Bob) | `bob@ledgerline.test` | `Bob@12345` |
| Auditor (read-only) | `auditor@ledgerline.test` | `Auditor@12345` |

Alice and Bob receive opening balances when the seed script runs. Anyone can register as a holder through `POST /auth/register`.

## Requirements

- Node.js 20 or newer
- PostgreSQL (local PostgreSQL is recommended for development and testing)
- A local PostgreSQL database named `ledgerline_test` for tests and mutation testing

## Environment configuration

Copy `.env.example` to `.env` and replace the example values with credentials configured for your own local PostgreSQL instance. The example username and password are placeholders, not real credentials; URL-encode special characters in passwords. Never commit `.env` or share its contents.

Required settings:

- `DATABASE_URL`: application PostgreSQL connection used by `npm start`, `npm run migrate`, and `npm run seed`. The example points to a local development database named `ledgerline_dev`. For deployment, configure the intended application database separately in the hosting environment.
- `TEST_DATABASE_URL`: a separate connection required by the test and mutation-check scripts. It must point to a **disposable local PostgreSQL database** at `localhost`, `127.0.0.1`, or `::1`, with the exact database name `ledgerline_test`. The example uses that local database. Tests validate this setting and use it instead of `DATABASE_URL`; they never fall back to the application URL.
- `JWT_SECRET`: a private, sufficiently long random signing secret; do not use the example placeholder.
- `PORT`: optional HTTP port (defaults to `3000`).

The example URLs use `ledgerline_user` and `replace_me` only as placeholders; replace both with a valid local PostgreSQL role and its password. Do not put Neon or any other remote connection in `TEST_DATABASE_URL`. Tests and mutation checks create and modify data, so the `ledgerline_test` database must contain no data you need to preserve.

`DATABASE_URL` and `TEST_DATABASE_URL` have different purposes: the former selects the application/migration/seed database, while the latter is exclusively for tests and mutation checks. A remote application URL must never be copied into `TEST_DATABASE_URL`.

## Install and initialize

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Create the local development database and the separate disposable `ledgerline_test` database if needed (using your local PostgreSQL tools), then set each URL in `.env` as described above.

The migration script uses **`DATABASE_URL`**, not `TEST_DATABASE_URL`. Before running `npm run migrate`, deliberately confirm that `DATABASE_URL` selects the database you intend. To initialize the local test database, temporarily set the current PowerShell session's `DATABASE_URL` to the verified local `TEST_DATABASE_URL`, run the migration, then restore or remove that session variable. Do not run `npm run migrate` while `DATABASE_URL` points to Neon unless you intentionally mean to apply the schema there.

```powershell
# Load TEST_DATABASE_URL from .env without printing it, and reject non-local targets.
$testDatabaseUrl = node -e "require('dotenv').config(); const value=process.env.TEST_DATABASE_URL; if(!value) process.exit(2); const u=new URL(value); const hosts=['localhost','127.0.0.1','::1','[::1]']; const db=decodeURIComponent(u.pathname.replace(/^\//,'')); const overrides=u.searchParams.getAll('host'); if(!['postgres:','postgresql:'].includes(u.protocol) || !hosts.includes(u.hostname.toLowerCase()) || overrides.some(h=>!hosts.includes(h.toLowerCase())) || u.searchParams.has('hostaddr') || db!=='ledgerline_test') process.exit(2); process.stdout.write(value)"
if ($LASTEXITCODE -ne 0 -or -not $testDatabaseUrl) { throw 'Refusing migration: TEST_DATABASE_URL must target local ledgerline_test.' }

$previousDatabaseUrl = $env:DATABASE_URL
try {
    $env:DATABASE_URL = $testDatabaseUrl
    npm run migrate
    if ($LASTEXITCODE -ne 0) { throw 'Local test database migration failed.' }
} finally {
    if ($null -eq $previousDatabaseUrl) {
        Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    } else {
        $env:DATABASE_URL = $previousDatabaseUrl
    }
}

```

For any other intentional target, set `DATABASE_URL` explicitly and verify it before running `npm run migrate`.

The migration creates the schema, triggers, and EXTERNAL account; it is intended to be repeatable. It can change the selected database.

Seeding is a separate, optional operation that uses `DATABASE_URL`, creates demo users/accounts, and posts opening deposits through the ledger. Only run it after verifying that `DATABASE_URL` points to the intended development/demo database:

```powershell
npm run seed
```

## Run the application

```powershell
npm start
```

Open `http://localhost:3000`. The server expects `DATABASE_URL` and `JWT_SECRET` to be configured.

## Test safely

Tests create users/accounts and perform deposits, withdrawals, and transfers. They also temporarily disable a ledger trigger during the tamper-detection test. They do not clean their fixtures up. Use only a disposable local `ledgerline_test` database with a role that can perform the test's trigger operation. Never use Neon, another remote database, or a database containing data you need to preserve.

Before testing, verify that `TEST_DATABASE_URL` is configured for local `ledgerline_test`. The test file validates the URL and sets `DATABASE_URL` to the validated test URL before importing the application/database.

```powershell
npm test
```

Mutation testing runs the ledger test file repeatedly while temporarily changing `src/ledger.js`. It performs a read-only database identity preflight and refuses non-loopback hosts or databases other than `ledgerline_test`. Source is restored after each mutant and on normal errors; forced termination, power loss, or filesystem failure can still prevent restoration.

```powershell
npm run mutation-check
```

Do not run either command against Neon or any database containing data you need to preserve.

## Deploy (Render and PostgreSQL)

1. Configure the deployment's `DATABASE_URL` and a private `JWT_SECRET` in the hosting provider's environment settings.
2. Apply the migration deliberately to the deployment database before serving traffic.
3. Configure the start command as `npm start`; check `/health` and the application page.
4. Seed only if demo accounts are intended for that deployment, and only after verifying the selected database.

Never put database credentials or JWT secrets in source control or build logs.

## Roles

| Role | Can | Cannot |
|---|---|---|
| Admin | Create accounts for holders; deposit into customer accounts; see all accounts/statements; verify the ledger; view attempts | Withdraw or transfer holder funds |
| Holder | Open own accounts; withdraw from and transfer out of own accounts; view own accounts/statements | Deposit; access another holder's account |
| Auditor | Read accounts, statements, attempts, and ledger verification | Move money or create accounts |

Role and ownership restrictions are enforced by the backend; hiding a frontend control is not an authorization boundary.

## Integrity model

- Each movement records one transaction and a debit/credit pair. Deposits and withdrawals use a single EXTERNAL account as counterparty.
- A request uses one database transaction. Idempotency is claimed first, accounts are locked in ascending ID order, authorization and available funds are checked against the locked rows, and postings/balances/response are committed together.
- Successful requests are cached by `(user_id, idempotency_key)`. Reusing a key with a different request is rejected.
- Refused-movement and replay audit attempts are written separately from the money transaction. This logging is best-effort: a logging failure is caught and reported to server logs but does not change the movement or replay result, so the corresponding attempt record may be missing.
- Database triggers reject ordinary updates, deletes, and truncates on ledger entries, transactions, and attempts. A per-account hash chain and `GET /audit/verify` help detect inconsistencies and some privileged edits.
- See [THREATS.md](./THREATS.md) for assumptions and known limitations.

## API overview

Amounts sent to money endpoints are integer paise. Authenticated requests carry a bearer JWT in the `Authorization` header. Money requests require `Idempotency-Key` with 8–64 letters, digits, underscores, or hyphens.

| Endpoint | Access |
|---|---|
| `POST /auth/register`, `POST /auth/login` | Public |
| `GET /me` | Authenticated |
| `POST /accounts` | Admin or holder |
| `GET /accounts`, `GET /accounts/:id`, `GET /accounts/:id/statement` | Authenticated; holder data is ownership-scoped |
| `POST /accounts/:id/deposit` | Admin only |
| `POST /accounts/:id/withdraw`, `POST /transfers` | Holder, subject to ownership checks |
| `GET /audit/verify`, `GET /audit/attempts` | Admin or auditor |
| `GET /health` | Public |

## Not implemented

Overdrafts, holds, reversals/refunds, scheduled or batch transfers, multi-currency support, rate limiting, password reset, and email verification are out of scope.
