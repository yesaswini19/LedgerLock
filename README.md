# BalanceVault

BalanceVault (formerly LedgerLine) is a Node.js, Express, and PostgreSQL money-movement demo. It stores amounts as integer paise and uses raw SQL so that transaction and row-locking behavior is explicit.

## Live demo

URL:https://ledgerlock-4yx2.onrender.com/

`scripts/seed.js` creates predictable demo accounts for **local development and testing only**. Do not use seeded credentials for real accounts or on a public or otherwise untrusted instance. Do not seed a public deployment.

Alice and Bob receive opening balances when the seed script runs. Anyone can register as a holder through the Register screen or `POST /auth/register`; public registration ignores any supplied role.

## Demo Login Credentials

| Role           | Email                                                     | Password      |
| -------------- | --------------------------------------------------------- | ------------- |
| Admin          | [admin@ledgerline.test](mailto:admin@ledgerline.test)     | Admin@12345   |
| Holder (Alice) | [alice@ledgerline.test](mailto:alice@ledgerline.test)     | Alice@12345   |
| Holder (Bob)   | [bob@ledgerline.test](mailto:bob@ledgerline.test)         | Bob@12345     |
| Auditor        | [auditor@ledgerline.test](mailto:auditor@ledgerline.test) | Auditor@12345 |

- These credentials are intended only for evaluating the demonstration application.
- They work only if the corresponding accounts have been provisioned in the live demo database.
- All data is synthetic demonstration data.
- Do not use these credentials for personal accounts or real financial transactions.
- Since these are shared demo credentials, other visitors may also access the accounts and modify demonstration data.

## Requirements

- Node.js 20 or newer
- PostgreSQL (local PostgreSQL is recommended for development and testing)
- A local PostgreSQL database named `ledgerline_test` for tests and mutation testing

## Environment configuration

Copy `.env.example` to `.env` and replace the placeholder username and password with credentials configured for your own local PostgreSQL instance. These are placeholders, not real credentials; URL-encode special characters in passwords. Never commit `.env` or share its contents.

Required settings:

- `DATABASE_URL`: application PostgreSQL connection used by `npm start`, `npm run migrate`, and `npm run seed`. The example points to a local development database named `ledgerline_dev`. For deployment, configure the intended application database separately in the hosting environment.
- `TEST_DATABASE_URL`: a separate connection required by the test and mutation-check scripts. Replace its placeholder credentials with your own local PostgreSQL credentials. It must point to a **disposable local PostgreSQL database** at `localhost`, `127.0.0.1`, or `::1`, with the exact database name `ledgerline_test`. Tests validate this setting and use it instead of `DATABASE_URL`; they never fall back to the application URL.
- `JWT_SECRET`: a private random signing secret of at least 32 bytes; do not use the example placeholder. Startup validates it and checks that `DATABASE_URL` is a PostgreSQL URL.
- `PORT`: optional HTTP port (defaults to `3000`).

The example URLs use `YOUR_LOCAL_USER` and `YOUR_LOCAL_PASSWORD` only as placeholders; replace both with a valid local PostgreSQL role and its password. `DATABASE_URL` selects the application database; `TEST_DATABASE_URL` selects the separate test database. Do not point `TEST_DATABASE_URL` at Neon, production, or any other remote database. Tests and mutation checks create and modify data, so `ledgerline_test` must contain no data you need to preserve.

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

The audit index is named `audit_events_id_idx` in the current schema. `CREATE INDEX IF NOT EXISTS` checks the index name and does not rename an equivalent index left by an earlier schema version (`audit_events_created_idx`); applying this schema to such a database can leave both indexes present. Review any old index separately when planning a database migration.

Seeding is a separate, optional operation that uses `DATABASE_URL`, creates demo users/accounts, and posts opening deposits through the ledger. Only run it after verifying that `DATABASE_URL` points to the intended development/demo database:

```powershell
npm run seed
```

## Run the application

```powershell
npm start
```

Open `http://localhost:3000`. The server expects `DATABASE_URL` and `JWT_SECRET` to be configured.

The page provides separate Sign In and Register pages. Registration collects full name, email, password, and confirmation; it creates a holder account but does not sign the user in. After registration, sign in with the new credentials. Successful login routes admins, auditors, and holders to their role-specific page path. Holders can open their own account. Balances and transfers are synthetic demonstration data only.

## First administrator setup

Do not use the predictable seeded admin credentials on a public deployment. For a fresh deployment, configure `BOOTSTRAP_SECRET` as a random value of at least 32 characters in the hosting environment, apply the schema migration, and call `POST /auth/bootstrap-admin` with the value in `X-Bootstrap-Secret` plus a valid email and a password of at least 12 characters (maximum 72 UTF-8 bytes). The endpoint creates an administrator only if no admin row exists; a PostgreSQL advisory lock makes concurrent calls safe. It returns a bearer token once. Remove `BOOTSTRAP_SECRET` from the deployment immediately after initialization. Subsequent administrators can be created only by an authenticated administrator through `POST /admin/users`.

See [API.md](./API.md) for request details. `/health` checks PostgreSQL connectivity. Redis is not part of this application. The static frontend and API are same-origin; no cross-origin browser access is needed.

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

This project is one Express web service: `src/app.js` serves `public/` with `express.static` and defines the API routes in the same application. The browser uses relative URLs, so frontend requests go to the same origin. No separate static-site service or CORS configuration is required for this deployment shape.

### Create the PostgreSQL database

1. In Render, create a PostgreSQL database in the same account and region as the web service.
2. Use the database's **internal connection URL** for the web service's `DATABASE_URL`. Keep the URL in Render's environment settings; never paste it into source control, this README, or logs. Render recommends internal URLs for same-region services because they use Render's private network. If migrating from outside Render with its external URL, keep TLS enabled with `sslmode=require`. See [Render's PostgreSQL connection guide](https://render.com/docs/postgresql-creating-connecting).
3. Keep a separate, disposable local `ledgerline_test` database for tests. Do not configure `TEST_DATABASE_URL` on the Render service.

### Create the Render Web Service

Apply the database schema first as described below. Do not route users to a new release until its schema migration has succeeded.

In Render, choose **New > Web Service**, connect the repository, and use:

| Setting | Value |
|---|---|
| Runtime | Node |
| Root Directory | Repository root (the directory containing `package.json`) |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

Render supplies `PORT` (currently defaults to `10000` for web services). The server binds to `0.0.0.0` and listens on that port. Do not set a fixed production port. See [Render Web Services](https://render.com/docs/web-services) and [Render Health Checks](https://render.com/docs/health-checks).

### Environment variables

Set these in the web service's Render **Environment** settings. Enter values there; do not commit them:

| Name | Required | Validation / purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection URL. Startup validates the URL scheme and host. Use the Render internal URL for a same-region Render Postgres database. |
| `JWT_SECRET` | Yes | At least 32 UTF-8 bytes; use a randomly generated private value. |
| `PORT` | Render provides it | Must be an integer from 1 through 65535. Locally it defaults to `3000`. |
| `BOOTSTRAP_SECRET` | Temporarily, for first admin only | At least 32 characters. Set it only for initial administrator creation, then remove it and save/redeploy. It is not required for normal operation. |
| `TEST_DATABASE_URL` | No; local tests only | Must be a disposable local PostgreSQL database named `ledgerline_test`. Never point it to Render or another production database. |

`NODE_ENV`, Redis settings, and CORS-origin settings are not required or read by this application. Render environment variables and secrets can be managed in the dashboard; see [Render Environment Variables and Secrets](https://render.com/docs/configure-environment-variables).

### Apply the schema safely

Do this before routing users to the newly deployed version:

1. Confirm the selected Render database in its dashboard and take a backup or snapshot first.
2. Review `db/schema.sql` for the exact release being deployed. It uses `CREATE ... IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, creates audit objects and triggers, and inserts the EXTERNAL account only when absent. It contains no `DROP TABLE` or `DELETE FROM` statements and performs no database reset. It does drop and recreate named triggers so their definitions match the application version.
3. Run `npm run migrate` once with `DATABASE_URL` set to the intended Render database. The command uses `DATABASE_URL`; it does not select `TEST_DATABASE_URL`. Run it from a protected local shell with the Render **external** database URL (TLS required via `sslmode=require`) before the first web-service deploy, or use an in-network migration shell/command if your Render setup provides one. Never print or save the URL in shell history. If a web service is already running, keep it unavailable to users until migration succeeds; do not rely on `/health` passing before the schema exists.
4. Confirm the migration exits successfully. If it fails, stop rollout and inspect the sanitized error before retrying; the schema is designed to be rerun after correcting a failure.
5. Create/deploy or enable the web service only after migration, then confirm `/health` returns `200` before directing users to the app. Do not run `npm run seed` against a public database.

The schema migration can change the database selected by `DATABASE_URL`. There is no automatic migration in the server start command. The `/health` endpoint runs `SELECT 1`; it returns success only when PostgreSQL is reachable, and errors are returned without database credentials or stack traces.

### Initialize the first administrator

Do not use the predictable local seed credentials on a public service. After the schema is applied and the service is reachable:

1. Set `BOOTSTRAP_SECRET` in Render's Environment settings to a random value of at least 32 characters. Save it as a secret; do not put it in a URL, source file, shell history, or support message.
2. Send one HTTPS `POST` request to `/auth/bootstrap-admin` with header `X-Bootstrap-Secret` and JSON body containing the administrator `email` and `password`. The password must be at least 12 characters and no more than 72 UTF-8 bytes. Use a trusted API client with secret fields hidden from request history/export.
3. Expect `201` and a response containing the new admin and bearer token. Store the token securely, call `GET /me`, and confirm the role is `admin`.
4. Before removing the secret, a second bootstrap request should return `409 BOOTSTRAP_COMPLETE` and must not create another admin. Do not send the request unless an admin already exists.
5. Remove `BOOTSTRAP_SECRET` from Render Environment settings and save/redeploy. Bootstrap is unavailable without the secret, and the database's existing admin check prevents repeated initialization even if a secret is later configured again.

The endpoint uses a PostgreSQL advisory lock so simultaneous bootstrap calls cannot both create the first admin. Later admin accounts must be created through the authenticated admin endpoint `POST /admin/users`.

### Startup, health, and logs

Startup requires a valid PostgreSQL `DATABASE_URL` and `JWT_SECRET` of at least 32 bytes; invalid configuration exits without printing values. `PORT`, when set by Render, is validated before the server binds. The process logs structured JSON events to stdout/stderr; request logs omit bodies, credentials, and tokens. On `SIGTERM` or `SIGINT`, it stops accepting new HTTP connections, closes the server, and then closes the PostgreSQL pool. Render's health check should use `/health`, which checks database connectivity as well as the HTTP process.

### Local verification before deployment

Run these from a development environment only after confirming `TEST_DATABASE_URL` is a disposable local `ledgerline_test` database. The test file rejects remote hosts. It also writes fixtures and performs synthetic ledger movements, so never point it at the Render database.

```powershell
npm ci
npm test
npm run mutation-check
```

The project has no separate frontend build step; Render's `npm ci` installs the existing locked dependencies. Local success is not evidence that a Render deployment is live or healthy.

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
- Database triggers reject ordinary updates, deletes, and truncates on ledger entries, transactions, attempts, and audit events. A per-account hash chain and `GET /audit/verify` help detect inconsistencies and some privileged edits.
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
| `GET /admin/users`, `POST /admin/users`, `PATCH /admin/users/:id/status`, `GET /admin/audit-events` | Admin only |
| `POST /auth/bootstrap-admin` | Public route requiring the one-time secret and no existing administrator |
| `GET /health` | Public |

## Not implemented

Overdrafts, holds, reversals/refunds, scheduled or batch transfers, multi-currency support, rate limiting, password reset, and email verification are out of scope. No deployed URL or browser automation setup is configured in this repository, so local tests do not verify a live instance.
