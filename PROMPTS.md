# AI Prompts and Development Journey – LedgerLine

## About this document

This document summarizes how I used AI assistance while developing LedgerLine for the Snovyas Round 2 assignment. I used AI as a development assistant to understand requirements, plan the implementation, debug issues, improve security, review code, and prepare project documentation.

The entries below are written as retrospective summaries of the prompts and discussions used throughout development. They are not claimed to be exact verbatim copies of the original conversations.



## 1. Understanding the project and planning the application

**Prompt summary:**

I wanted to understand the assignment properly and plan a finance and ledger management application. Help me decide the project structure, technologies, database design, and the main features needed to build a working application.

**What I worked on:**
- Planned the LedgerLine application.
- Used Node.js and Express for the backend.
- Used PostgreSQL for persistent data storage.
- Planned authentication, role-based access, account management, transfers, and audit verification.
- Organized the application into source code, scripts, tests, documentation, and frontend files.

## 2. Setting up the project and database

**Prompt summary:**

Help me set up the Node.js project and connect it to PostgreSQL. Explain the database configuration, environment variables, migrations, and seed data step by step. Make sure I can run the application locally.

**What I worked on:**
- Set up the project dependencies and scripts.
- Configured PostgreSQL.
- Created separate development and test database configurations.
- Worked on database migrations and sample data.
- Added an `.env.example` file with placeholder configuration.

## 3. Implementing authentication

**Prompt summary:**

Help me implement user login and authentication properly. I need password hashing, JWT-based authentication, token validation, and role-based access. Explain how the backend should verify users instead of trusting information sent by the frontend.

**What I worked on:**
- Implemented password hashing with bcrypt.
- Added JWT authentication and expiration.
- Added middleware for protected routes.
- Ensured the backend retrieves the current user's role from the database.
- Added authorization checks for different user roles.

## 4. Implementing account management and money transfers

**Prompt summary:**

Help me build account and transfer functionality. I want the application to prevent unauthorized transfers, insufficient-balance transactions, duplicate requests, and inconsistent ledger entries.

**What I worked on:**
- Implemented account retrieval and ownership checks.
- Used integer paise for monetary calculations.
- Added database transactions.
- Used ordered account locking to reduce concurrency problems.
- Implemented idempotency handling.
- Added paired ledger entries for transfers.
- Added database constraints to protect account balances.

## 5. Implementing role-based functionality

**Prompt summary:**

Review the roles in my application and help me make sure each user can access only the features permitted for that role. The frontend should show appropriate controls, but the backend must enforce the actual permissions.

**What I worked on:**
- Added role-aware frontend controls.
- Restricted deposit functionality to administrators.
- Allowed administrators and auditors to perform ledger verification.
- Prevented auditors from accessing money movement forms.
- Kept authorization checks on the server side.

## 6. Building and improving the frontend

**Prompt summary:**

My frontend looks too basic. Help me improve the presentation and make it easier to use without changing my existing API routes or breaking the backend. Keep the interface consistent with the user roles.

**What I worked on:**
- Improved the sign-in and application interface.
- Added role-specific controls.
- Connected the frontend to existing API endpoints.
- Checked that the frontend did not become the only layer responsible for security.

## 7. Troubleshooting PostgreSQL connection problems

**Prompt summary:**

I am getting database connection and DNS resolution errors while working with my PostgreSQL setup. Help me identify whether the problem is related to the database configuration, network DNS, or application code. Give me safe troubleshooting steps.

**What I worked on:**
- Investigated PostgreSQL connectivity.
- Identified a DNS resolution problem affecting the Neon connection.
- Corrected the local network DNS configuration.
- Verified the database setup before proceeding with later development.

## 8. Writing backend tests

**Prompt summary:**

Help me review and improve my automated tests. I want to test authentication, authorization, transfers, insufficient balances, account ownership, idempotency, and ledger integrity. Avoid changing application behavior just to make tests pass.

**What I worked on:**
- Added backend integration tests.
- Tested permitted and refused operations.
- Checked transfer and ledger behavior.
- Improved test server startup and shutdown handling.
- Kept test database configuration separate from the main database.

## 9. Improving test reliability

**Prompt summary:**

My tests are passing, but Node.js is showing MaxListenersExceededWarning messages. Help me identify the actual lifecycle issue instead of hiding the warnings or increasing listener limits.

**What I worked on:**
- Investigated repeated server listener registration.
- Improved the test server lifecycle.
- Ensured the server is started and closed in a controlled way.
- Verified that the test suite completed without the earlier listener warnings.

## 10. Developing mutation testing

**Prompt summary:**

I want to check whether my tests can detect important security and transaction bugs. Help me create a mutation-check script that temporarily introduces controlled defects, runs targeted tests, and restores the original source safely.

**What I worked on:**
- Added mutation checks for row locking.
- Tested insufficient-funds validation.
- Tested account ownership enforcement.
- Tested idempotency handling.
- Tested role authorization.
- Improved mutation result classification and source restoration.

## 11. Correcting mutation-test problems

**Prompt summary:**

One of my mutation attempts was inconclusive because unrelated tests and database constraints affected the result. Help me distinguish a genuinely killed mutant from an unrelated test failure or infrastructure error. Do not count an inconclusive result as a successful test.

**What I worked on:**
- Improved targeted test selection.
- Reviewed TAP output classification.
- Added checks for expected test execution and assertion markers.
- Improved error handling and restoration safeguards.
- Verified that the original ledger source was restored after mutation testing.

## 12. Improving security documentation

**Prompt summary:**

Review the security controls in my project and help me document what is actually implemented. Do not claim that a feature is secure unless the code and configuration support that claim. Include limitations as well.

**What I worked on:**
- Prepared the README.
- Prepared the threat model in `THREATS.md`.
- Documented authentication and authorization controls.
- Documented transaction and ledger protections.
- Explained the limitations of audit logging and ledger verification.
- Documented the risks of browser token storage and demo credentials.

## 13. Reviewing environment files and submission safety

**Prompt summary:**

Review the files that may be submitted to GitHub. Make sure environment secrets, database files, backups, and temporary artifacts are excluded. Keep `.env.example` available as a safe configuration template.

**What I worked on:**
- Reviewed `.gitignore`.
- Kept `.env` out of version control.
- Added ignore rules for environment variants and local database artifacts.
- Preserved `.env.example`.
- Checked the submission candidates without exposing credentials.

## 14. Final project review

**Prompt summary:**

Perform a final read-only review of my entire project. Check the code, tests, security documentation, environment configuration, Git status, and submission files. Do not modify files, run database commands, or push anything.

**What I worked on:**
- Reviewed the backend and frontend.
- Checked the documentation against the implementation.
- Reviewed the previously obtained test and mutation results.
- Identified remaining documentation and assignment-compliance questions.
- Confirmed that no files were staged, committed, or pushed during the final audit.

---

## Mistakes and AI Suggestions I Identified and Corrected

During development, I did not accept every AI suggestion without checking it. Some initial suggestions or approaches needed improvement after reviewing the actual code and test results.

### 1. Database safety and environment separation

Some troubleshooting approaches could have risked using the main Neon database for testing. I clarified the database separation and required the test scripts to use only the disposable local `ledgerline_test` database.

**Correction:** Added stricter test database validation and avoided using the main `DATABASE_URL` as a test fallback.

### 2. Incorrect interpretation of mutation results

An early mutation attempt was inconclusive because unrelated test failures and database constraints affected the result.

**Correction:** Improved targeted test execution and result classification. A mutant is not counted as killed merely because some test failed.

### 3. Hiding Node.js listener warnings

Increasing listener limits or suppressing warnings would have hidden the problem rather than fixing it.

**Correction:** Improved the test server lifecycle so it starts once and is properly closed during teardown.

### 4. Overstating application security

The original frontend wording suggested that access was encrypted by the application itself. However, HTTPS depends on the actual deployment and hosting configuration.

**Correction:** Replaced the unsupported encryption claim with neutral sign-in wording and documented that HTTPS must be configured at deployment.

### 5. Treating audit logging as guaranteed

An initial description could have given the impression that every refused or replayed transaction always produces a persistent audit record.

**Correction:** Reviewed the implementation and documented that attempt logging is best-effort and that a logging failure may leave an audit record missing.

### 6. Reconstructed AI prompts presented as original history

Some earlier prompt examples were reconstructed summaries rather than verified original messages.

**Correction:** Removed those entries instead of presenting them as genuine historical prompts. This document also clearly identifies its entries as retrospective summaries.

### 7. Demo credentials and public deployment

The seeded demo accounts are useful for local development, but predictable credentials should not be treated as production credentials.

**Correction:** Clearly documented that the seeded credentials are intended only for local development and testing.

---

## Final Verification Evidence

The following results were obtained during earlier development and verification sessions. They are recorded here as historical evidence, not as newly executed checks.

| Verification | Previously reported result |
|---|---|
| Automated test suite | 26 passed, 0 failed, 0 skipped |
| MaxListenersExceededWarning | 0 warnings after the lifecycle correction |
| Mutation testing | 5 attempted, 5 killed |
| Survived mutants | 0 |
| Inconclusive mutations | 0 |
| Mutation errors | 0 |
| Source restoration | Original SHA-256 matched before and after |

## Conclusion

AI assistance helped me throughout the development process, but I reviewed the generated code and suggestions, corrected issues, and used test results to improve the application.

The final project includes authentication, role-based authorization, account management, money transfers, ledger verification, database protections, automated tests, mutation testing, and security documentation.

I used AI as a supporting development tool rather than relying on its suggestions without verification.