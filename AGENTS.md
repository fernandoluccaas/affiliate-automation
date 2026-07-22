# Affiliate Automation Agent Guide

## Scope

This repository implements Affiliate Automation, a monorepo for collecting, validating, scoring, publishing and measuring affiliate offers from officially allowed integrations.

## Guardrails

- Do not add authenticated scraping, marketplace login automation, CAPTCHA bypasses or unofficial WhatsApp Web automation.
- Do not let AI decide whether an offer is valid. Validation and scoring must remain deterministic.
- Do not store secrets in browser state, logs or client-visible bundles.
- Use environment variables for credentials and encrypt credentials persisted in the database.
- Use PostgreSQL `Decimal` fields for monetary values and percentages that affect business rules.
- Mocks are allowed only in tests and local development, and must be clearly identified.

## Phase Workflow

Each phase must:

1. List files to be changed.
2. Implement only the phase scope.
3. Run lint, typecheck and tests.
4. Fix all errors found.
5. Update documentation.
6. Create a small descriptive commit.

Do not start Phase 2 until Phase 1 is complete.

## Local Commands

- `npm install`
- `docker compose up -d`
- `npm run prisma:migrate`
- `npm run db:seed`
- `npm run dev`
- `npm run lint`
- `npm run typecheck`
- `npm run test`
