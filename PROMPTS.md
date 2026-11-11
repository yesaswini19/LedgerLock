# Representative Development Prompts

These are representative prompts based on the areas covered by this project. They are written as examples, not as exact transcripts or a verified record of previous conversations.

## 1. Understanding the requirements

I want to understand the project requirements before I build anything. Please help me break them into features and plan a simple application that uses a ledger to track money movement.

## 2. Backend and database setup

I want to build the backend with Node.js, Express and PostgreSQL. Please help me organize the code and set up the database connection and schema without making the project harder to maintain.

## 3. Authentication and user roles

I want users to register and sign in, with different access for admins, holders and auditors. Please check how authentication and permissions should work so users cannot give themselves a different role.

## 4. Accounts and money transfers

I want users to open and view accounts and make the transfers allowed for their role. Please check my existing code for ownership and balance problems, and help me handle transfers safely.

## 5. Ledger and idempotency

I want each movement to be recorded with matching debit and credit entries. Please help me make retries safe so sending the same request again does not move the money twice.

## 6. Audit records and protected data

I want to keep useful audit records and prevent important ledger data from being changed or deleted by mistake. Please review the database triggers and audit code and point out any gaps.

## 7. Frontend and role-based pages

I want the sign-in, registration and account pages to be clear and work for each user role. Please check that the controls shown in the frontend match the permissions enforced by the backend.

## 8. Security and limitations

I want to review the security of this application and explain its limits honestly. Please compare the documentation with the code and help me avoid claiming protections that are not actually implemented.

## 9. Tests

I want tests for registration, permissions, transfers, retries and ledger integrity. Please help me check the tests and make sure they use a separate disposable local test database.

## 10. Local setup and Render deployment

I want to run the project locally and prepare it for Render. Please check the setup instructions and help me keep the application database separate from the disposable test database, especially when running migrations.
