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

## Phase 3 - Validation, Deduplication and Scoring

- Complete the deterministic validation pipeline.
- Add duplicate detection and recent publication checks.
- Persist auditable scoring components with configurable weights.

## Phase 4 - AI Copywriter and Publication

- Generate structured OpenAI JSON output from confirmed offer data only.
- Validate generated copy against offer values.
- Implement publisher adapters and scheduling locks.

## Phase 5 - Tracking and Attribution

- Implement `/go/[slug]` redirects with click tracking and rate limiting.
- Import conversions, orders and commissions when official APIs or reports permit it.

## Phase 6 - Admin Dashboard

- Complete operational pages, charts, logs, settings and integration controls.
- Add production observability, audit trails and deployment runbooks.
