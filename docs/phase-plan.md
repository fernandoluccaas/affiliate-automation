# Affiliate Automation Phase Plan

## Phase 1 - Foundation

- Initialize the npm workspace monorepo.
- Configure Next.js 15, React 19, TypeScript, TailwindCSS and initial Shadcn-style UI primitives.
- Configure Prisma with the initial PostgreSQL schema.
- Add Docker Compose for PostgreSQL and Redis.
- Add dashboard authentication foundation.
- Add base packages for database, validation, scoring, connectors, tracking and shared code.
- Add basic tests, lint, typecheck and GitHub Actions.

## Phase 2 - Marketplace Ingestion

- Implement officially permitted Shopee and Mercado Livre collection adapters.
- Normalize products, offers, campaigns and coupons.
- Add integration health checks and import jobs.

### Phase 2A - Manual Operational Pipeline

Status: implemented.

- Added the reusable administrative layout and real navigation.
- Added `/ofertas` with pagination and filters by marketplace, status and category.
- Added `/ofertas/nova` with React Hook Form, Zod and Server Action.
- Added `ingestOffer` for manual deterministic ingestion without real marketplace, OpenAI or WhatsApp integrations.
- Added automatic discount calculation, product upsert, offer upsert, validation, score persistence, affiliate slug generation and status selection.
- Replaced dashboard demonstration values with PostgreSQL metrics.
- Added health checks for application, PostgreSQL and configured Redis.
- Corrected manual export publication semantics.
- Added tests for discount calculation, validation, scoring, ingestion and route protection.

### Phase 2B - Tracking, Channels And Worker

Status: implemented.

- Added Redis abstraction for Upstash and local `REDIS_URL`.
- Added functional channel CRUD for Telegram and manual export.
- Added deterministic promotional message composition.
- Added idempotent publication scheduling and worker jobs.
- Added Telegram publishing through the official Bot API with image fallback.
- Added manual export as `EXPORTED`, not external publication.
- Added `/go/[slug]` click tracking and temporary redirects.
- Added publication, automation and alert log admin views.
- Added tests for message composition, channel policy, Redis locks, Telegram mock publishing, idempotent scheduling, route protection and tracking redirects.

### Phase 2C - AI Copywriter

Status: implemented.

- Added OpenAI SDK integration using the Responses API with structured JSON output.
- Added deterministic post-validation for prices, discounts, coupon, free shipping, disclosure, unsupported urgency and tracking URL.
- Added automatic fallback to the deterministic composer when OpenAI is disabled, unavailable, invalid or times out.
- Persisted message source, model, duration, validation status, validation reasons and generation timestamp on `Publication`.
- Added OpenAI operational status and a server-side test action in `/integracoes`.
- Added real AI/fallback metrics to `/automacoes`.
- Added unit tests for schema validation, factual validation, successful AI generation and fallback scenarios.

## Phase 3 - Marketplace Ingestion

- Implement officially permitted Shopee and Mercado Livre collection adapters.
- Normalize products, offers, campaigns and coupons.
- Add integration health checks and import jobs.

## Phase 4 - Publication Expansion

- Add additional official publisher adapters when credentials and APIs are available.
- Expand scheduling controls and approval-free retry observability.

## Phase 5 - Tracking and Attribution

- Implement `/go/[slug]` redirects with click tracking and rate limiting.
- Import conversions, orders and commissions when official APIs or reports permit it.

## Phase 6 - Admin Dashboard

- Complete operational pages, charts, logs, settings and integration controls.
- Add production observability, audit trails and deployment runbooks.
