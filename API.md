# BalanceVault API

The API is served from the same origin as the static page. JSON errors use `{ "error": { "code", "message" } }`. Authenticated requests send `Authorization: Bearer <JWT>`. JWTs expire after eight hours; the server reloads the current role and active status from PostgreSQL on each request.

## Authentication and accounts

| Method and path | Access | Behavior |
|---|---|---|
| `GET /health` | Public | Runs `SELECT 1`; returns `{ "ok": true }` when PostgreSQL is reachable. |
| `POST /auth/bootstrap-admin` | One-time secret | Requires `X-Bootstrap-Secret` matching configured `BOOTSTRAP_SECRET` (at least 32 characters), valid email, and password of at least 12 characters (maximum 72 UTF-8 bytes). Creates the first admin only when no admin exists. Returns `201` with user and token; `409` when already initialized. |
| `POST /auth/register` | Public | Body requires `fullName` (1–80 characters), valid email, and password of at least 8 characters (maximum 72 UTF-8 bytes). Always creates a `holder`, ignoring a client-supplied role. Duplicate email returns `409`. Returns the user and a sign-in message, never a token. |
| `POST /auth/login` | Public | Requires email and password. Invalid credentials and disabled accounts return a generic `401`. Returns the user, full name, and eight-hour JWT on success. |
| `GET /me` | Authenticated | Returns the current user's id, full name, email, and database role. |
| `GET /signin`, `GET /register`, `GET /dashboard`, `GET /admin`, `GET /auditor` | Public page shell | Serve the existing static page from Express; the client redirects successful logins by database role. API authorization remains server-side. |
| `POST /accounts` | Admin or holder | Holder owns the new account; admin must provide a valid holder `ownerId`. |
| `GET /accounts`, `GET /accounts/:id`, `GET /accounts/:id/statement` | Authenticated | Holder results are ownership scoped. Admin and auditor can read all accounts. |

## Administration and audit

| Method and path | Access | Behavior |
|---|---|---|
| `GET /admin/users` | Admin | Lists up to 500 users with full name, email, role, active/disabled status, and creation time. |
| `POST /admin/users` | Admin | Creates an account with role `admin`, `holder`, or `auditor`; password must have at least 12 characters and at most 72 UTF-8 bytes. |
| `PATCH /admin/users/:id/status` | Admin | Body is `{ "active": true|false }`. Prevents disabling the caller or the last active admin. |
| `GET /admin/audit-events` | Admin | Returns up to 200 newest authentication, user-management, and successful transaction audit events. |
| `GET /audit/verify`, `GET /audit/attempts` | Admin or auditor | Verifies ledger integrity or reads refused/replayed movement attempts. |

Audit records omit passwords, tokens, and secrets. Audit events, ledger entries, transactions, and movement attempts reject ordinary update, delete, and truncate operations through database triggers. As with other PostgreSQL triggers, a database owner can bypass these controls.

## Synthetic money movement

Money amounts are positive integer paise, capped per operation at `1e12`. Requests require an `Idempotency-Key` of 8–64 letters, digits, `_`, or `-`.

| Method and path | Access |
|---|---|
| `POST /accounts/:id/deposit` | Admin |
| `POST /accounts/:id/withdraw` | Owning holder |
| `POST /transfers` | Holder owning the source account |

These operations only move synthetic balances in the demo database; they do not connect to real accounts or payment rails.
