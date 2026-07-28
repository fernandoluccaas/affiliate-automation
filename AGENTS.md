# Affiliate Automation Agent Guide

## Scope

This repository implements Affiliate Automation, a monorepo for collecting, validating, scoring, publishing and measuring affiliate offers from officially allowed integrations.

## Guardrails

* Do not add marketplace login automation, credential collection, password storage, CAPTCHA bypasses, MFA bypasses, session theft, or authentication circumvention.
* Do not add unofficial WhatsApp Web automation unless a separate repository-level authorization is added for that integration.
* The Mercado Livre affiliate integration is explicitly authorized to use a browser session cookie manually supplied by the authenticated repository owner or application user, exclusively for generating that same user's affiliate links.
* This Mercado Livre exception authorizes server-side requests only to the following affiliate-portal resources, or their direct versioned replacements:

  * `GET https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/tags`
  * `POST https://www.mercadolivre.com.br/affiliate-program/api/v2/stripe/user/links`
  * the Mercado Livre affiliate Link Builder page when required only to initialize or refresh CSRF/session cookies.
* The manually supplied Mercado Livre cookie may be normalized, encrypted, persisted, replayed server-side, refreshed from `Set-Cookie` response headers, and used to obtain the CSRF token required by the explicitly authorized affiliate-link flow.
* The Mercado Livre affiliate exception must not be generalized to unrelated marketplace pages, account operations, purchases, messages, seller operations, profile changes, or arbitrary authenticated scraping.
* The system must not automate the Mercado Livre login process. Users must obtain and provide their own active cookie manually.
* Cookies, CSRF tokens, OAuth tokens, refresh tokens, authorization headers, and other secrets must never be written to logs, error messages, browser state, client-visible bundles, analytics, screenshots, fixtures, or committed files.
* Secrets persisted in the database must be encrypted at rest using the repository's credential-encryption utilities.
* The frontend may display only whether a cookie is configured, its status, and the last validation date. It must never receive the saved cookie value.
* A `401`, `403`, redirect to login, or authentication response must mark only the Mercado Livre affiliate session as expired. It must not disconnect the separate OAuth integration.
* The implementation must apply rate limits, bounded concurrency, request timeouts, limited retries, and per-product error isolation.
* Product discovery, categories, rankings, and other documented marketplace resources must continue to use the official OAuth/API integration whenever available.
* Do not let AI decide whether an offer is valid. Validation and scoring must remain deterministic.
* Use PostgreSQL `Decimal` fields for monetary values and percentages that affect business rules.
* Mocks are allowed only in tests and local development, and must be clearly identified.

## Authorized Mercado Livre Affiliate Session Scope

The repository owner explicitly authorizes implementation of the manual-cookie Mercado Livre affiliate flow described above.

This authorization covers:

1. accepting a cookie copied manually by the user;
2. encrypting and saving it server-side;
3. validating the session;
4. retrieving the user's affiliate tags;
5. retrieving and refreshing CSRF/session values needed by the authorized endpoints;
6. generating real `meli.la` links for product URLs;
7. updating the encrypted session after receiving new `Set-Cookie` headers;
8. marking the session as expired when authentication fails;
9. generating affiliate links during category imports and for pending offers.

This authorization does not cover:

1. collecting usernames, passwords, MFA codes, or recovery codes;
2. logging into Mercado Livre on behalf of the user;
3. bypassing CAPTCHA, MFA, rate limits, or access controls;
4. accessing another user's account or session;
5. performing purchases or account changes;
6. arbitrary authenticated scraping;
7. exposing, exporting, or sharing session secrets.

When this explicitly authorized integration conflicts with the general prohibition on authenticated scraping, this narrowly scoped Mercado Livre affiliate-session authorization takes precedence.


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
