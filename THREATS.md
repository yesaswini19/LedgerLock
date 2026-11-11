# BalanceVault threat model and limitations

## Protected invariants

- Each account balance is intended to equal its ledger credits minus debits, including the single EXTERNAL account.
- A successful movement records one transaction and corresponding debit/credit ledger entries within one database transaction.
- Customer accounts cannot have a negative balance under the schema's check constraint.
- `GET /audit/verify` checks aggregate balance and ledger sums, per-account hash links and running balances, and the final ledger balance against each stored account balance.

These are application and database controls, not protection against every database-owner action.


## Threats considered and controls

| Threat | Control in the implementation | Test coverage |
|---|---|---|
| Concurrent withdrawals overspend an account | Lock accounts with `SELECT ... FOR UPDATE`, then check the locked balance; database also checks customer balances | `NO DOUBLE-SPEND` tests and `DB BACKSTOP` |
| Opposite transfers deadlock | Lock distinct account IDs in ascending order | `NO DEADLOCK` |
| A retry posts money twice | Claim `(user_id, idempotency_key)` inside the same transaction and return the stored successful response | Sequential and concurrent `IDEMPOTENCY` tests |
| A key is reused for different request details | Store and compare a request hash | `IDEMPOTENCY: same key, different body...` |
| A holder moves another user's funds | Check source ownership on the server against the authenticated user | `AUTHORISATION: a user cannot move another user's money` |
| A role performs a forbidden money movement | Enforce allowed movement roles in ledger logic; reread the current role from the database for each authenticated request | Role authorization test |
| Invalid account IDs or amounts reach money logic | Validate positive safe-integer IDs and bounded integer-paise amounts at the API boundary | `VALIDATION` |
| A rejected movement leaves partial postings | Roll back the transaction; attempt logging is separate and best-effort | Refused-attempt test |
| Ordinary SQL edits change append-only records | Triggers reject update/delete/truncate on ledger entries, transactions, and attempts | `APPEND-ONLY` |
| A privileged edit changes ledger history | Per-account hash chain and ledger verification can detect changed entries | `TAMPER-EVIDENCE` |
| A holder sees other users' account data | Account reads are ownership-scoped; holder statements mask other actors' identities | No dedicated identity-masking test is currently present |
| A client supplies a forged or stale role | JWT contains the user ID; authentication reloads role from the database | No dedicated stale-role-token test is currently present |
| Public registration escalates to administrator | Registration SQL fixes the role to `holder`, regardless of request fields | `REGISTRATION and ADMIN` integration test |
| First administrator bootstrap is repeated or raced | Secret of at least 32 characters, constant-time comparison, admin-existence check under a PostgreSQL advisory transaction lock | `BOOTSTRAP` tests cover wrong secret, invalid fields, repeat, and concurrent initialization using a serialized database test double |
| An unauthenticated/non-admin user reads administrative records | Admin routes check role on the backend | `REGISTRATION and ADMIN` integration test |
| Disabled user reuses an issued token | Authentication reloads active status from PostgreSQL for each request | `REGISTRATION and ADMIN` integration test |
| Audit records are changed through ordinary SQL paths | Database triggers reject update, delete, and truncate for audit events | Append-only DB test covers audit update/delete |

`scripts/mutation-check.js` is intended to remove one ledger safeguard at a time and count a mutant as killed only when its designated test fails with an assertion failure. It requires `TEST_DATABASE_URL` for local PostgreSQL database `ledgerline_test`, checks the connected database identity before editing `src/ledger.js`, and restores the source between mutants. Run it only against a disposable local test database.

## Assumptions and accepted limitations

- **A database owner can bypass triggers.** A sufficiently privileged database role can disable/drop triggers and alter data. Hash verification can detect some edits, but does not prevent them. Use a least-privilege application role and retain independent backups/audit evidence where appropriate.
- **The hash chain has no external anchor.** Coordinated deletion of newest ledger rows and corresponding balance changes may evade the current checks. The verifier does not independently prove that every transaction has exactly its required postings, and the chain head is not anchored outside the database.
- **Successful idempotency records are retained indefinitely.** Failed requests are not cached under their key; a retry may be evaluated again if circumstances change.
- **Attempt logging is best-effort.** Refused movements and successful replays are logged outside the money transaction. If an attempt-log insert fails, the error is logged server-side and the original movement/replay result is preserved; the audit record may therefore be absent.
- **The EXTERNAL account is a contention point.** Deposits and withdrawals serialize on its row.
- **Test and seed scripts write data.** Tests leave fixture records in the selected database. The seed script creates demo users/accounts and posts opening deposits. Use only a disposable local database for tests and mutation testing; verify the destination before seeding.
- **Migration uses `DATABASE_URL`.** Running the migration can change whichever database that variable selects. It does not automatically choose `TEST_DATABASE_URL`.
- **Demo credentials are predictable.** The seed script contains credentials for local development/testing only. Do not use them for real users or seed a public/untrusted deployment with those accounts.
- **Authentication limitations:** no login rate limiting/lockout, email verification, password reset, or individual JWT revocation; tokens last eight hours.
- **Browser token and inline-content trade-offs:** the bearer JWT remains in `sessionStorage` to preserve the existing frontend/API authentication flow. Any successful same-origin script injection could read that token until it expires. A future move to `HttpOnly`, `Secure`, `SameSite` cookies should include CSRF protection and explicit logout/session handling. The app now sends CSP and common browser security headers, but its CSP permits inline scripts and styles to keep the single-file page working; this limits CSP's ability to block injected inline script. Extracting the inline code or using per-response nonces/hashes would allow a stricter policy.
- **Login throttling recommendation:** login attempts are not rate-limited in this app. For production, enforce throttling at a trusted edge or add a shared limiter with a verified proxy/client-IP configuration. A process-local limiter is not sufficient across multiple instances and can incorrectly throttle unrelated users behind a shared proxy.
- **Audit delivery is best-effort for application-level auth and admin events.** Successful money movement audit rows are inserted by a database trigger in the same transaction as the transaction row. The audit view is admin-only and returns the latest 200 events. Failed audit writes for auth/admin events are reported without sensitive request data, but the original action may still complete without its audit row.
- **Bootstrap secret management is operational.** `BOOTSTRAP_SECRET` must be configured securely for first initialization and removed afterward. Removing it does not invalidate an already initialized administrator. The repository cannot verify secrets configured in a hosting provider.
- **Frontend and deployment verification are not automated here.** There is no browser test runner or configured deployed URL. The local node tests do not establish that a deployed build is current or reachable.
- **No overdraft, holds, reversals, scheduled transfers, multi-currency, or per-account/aggregate balance cap is implemented.** The per-operation paise maximum does not itself impose a lifetime cap on an account balance.
- **Timestamps use application-server time.** Ledger timestamps are included in hashes; there is no external time authority.
- **No AI anomaly detection is implemented.** It is not part of the money-movement authorization path.
