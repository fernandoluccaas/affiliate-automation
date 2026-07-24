# Architecture

Affiliate Automation is a production-oriented monorepo that separates user-facing dashboard code from workers and reusable domain packages.

## Runtime Flow

Shopee and Mercado Livre integrations feed marketplace connectors. Connectors normalize external data into internal products, offers, coupons and affiliate links. Offers are persisted in PostgreSQL, validated deterministically, deduplicated, scored, associated with affiliate links, prepared by the AI copywriter, scheduled, published through channel adapters and measured through tracking and conversion imports.

Phase 2A adds a manual offer pipeline before real marketplace connectors. An administrator can create an offer in `/ofertas/nova`; `ingestOffer` calculates the discount, upserts the product and offer in a transaction, validates facts with Zod and deterministic rules, calculates and persists an auditable score, creates a tracking slug and sets the final offer status automatically.

Phase 2B adds the publication and tracking loop. The worker selects active compatible channels for `READY_TO_PUBLISH` offers, creates idempotent `Publication` rows with deterministic message payloads, publishes scheduled rows through Telegram or manual export adapters, records `PublicationAttempt`, and updates publication status. `/go/[slug]` is public and records clicks before redirecting to the affiliate destination.

## Applications

- `apps/dashboard`: Next.js 15 administrative dashboard deployed to Vercel.
- `apps/worker`: worker entrypoint for Railway jobs, marketplace imports and automation runs.

The dashboard uses a reusable administrative shell with real navigation for dashboard, offers, products, coupons, channels, integrations, publications, automations, settings and logs. Pages that are not fully implemented show empty states and do not fabricate operational data.

## Packages

- `packages/database`: Prisma client, persistence utilities and credential encryption boundaries.
- `packages/marketplace-connectors`: official marketplace API connector contracts and implementations.
- `packages/publisher-connectors`: publication adapters for supported channels.
- `packages/publication`: deterministic message composition and channel policy checks.
- `packages/redis`: Upstash/local Redis health checks and distributed locks.
- `packages/scoring`: deterministic score normalization and weighted scoring.
- `packages/validation`: Zod schemas and deterministic offer validation pipeline.
- `packages/ai-copywriter`: OpenAI structured-output copy generation and post-generation checks.
- `packages/tracking`: click attribution and redirect helpers.
- `packages/shared`: cross-package enums, types and small utilities.

## Automation Boundary

Workers and automation workflows must use locks and idempotency keys before mutating publication or import state. Upstash Redis is the intended distributed coordination layer. Railway runs workers and scheduled automation, with n8n reserved for external workflow orchestration where needed. The dashboard remains a control and observability plane.

Manual export is not treated as publication delivery. `ManualExportPublisher` returns an exported-only status so downstream code cannot count a copied/exported message as a published message.

Redis selection is server-only: Upstash is used when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured; otherwise `REDIS_URL` is used for local Redis. If neither is present, dashboard health reports Redis as unavailable/skipped and the worker can still run locally without distributed guarantees.

## AI Boundary

OpenAI receives only confirmed offer facts. AI output is structured JSON and cannot invent prices, discounts, stock, ratings, commissions, shipping status or coupons. A deterministic validator compares generated copy against the persisted offer before publication.

## Security Boundary

The browser never receives marketplace tokens or publisher credentials. Secrets live in environment variables or encrypted database fields. Logs must redact secrets. Webhooks require signature validation. All externally-triggered writes require idempotency.

Telegram bot tokens are read only on the server. Channel configuration may store operational values such as `chatId`, but tokens are not sent to the browser.
