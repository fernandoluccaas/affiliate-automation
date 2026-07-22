# Architecture

Affiliate Automation is a production-oriented monorepo that separates user-facing dashboard code from workers and reusable domain packages.

## Runtime Flow

Shopee and Mercado Livre integrations feed marketplace connectors. Connectors normalize external data into internal products, offers, coupons and affiliate links. Offers are persisted in PostgreSQL, validated deterministically, deduplicated, scored, associated with affiliate links, prepared by the AI copywriter, scheduled, published through channel adapters and measured through tracking and conversion imports.

## Applications

- `apps/dashboard`: Next.js 15 administrative dashboard deployed to Vercel.
- `apps/worker`: worker entrypoint for Railway jobs, marketplace imports and automation runs.

## Packages

- `packages/database`: Prisma client, persistence utilities and credential encryption boundaries.
- `packages/marketplace-connectors`: official marketplace API connector contracts and implementations.
- `packages/publisher-connectors`: publication adapters for supported channels.
- `packages/scoring`: deterministic score normalization and weighted scoring.
- `packages/validation`: Zod schemas and deterministic offer validation pipeline.
- `packages/ai-copywriter`: OpenAI structured-output copy generation and post-generation checks.
- `packages/tracking`: click attribution and redirect helpers.
- `packages/shared`: cross-package enums, types and small utilities.

## Automation Boundary

Workers and automation workflows must use locks and idempotency keys before mutating publication or import state. Upstash Redis is the intended distributed coordination layer. Railway runs workers and scheduled automation, with n8n reserved for external workflow orchestration where needed. The dashboard remains a control and observability plane.

## AI Boundary

OpenAI receives only confirmed offer facts. AI output is structured JSON and cannot invent prices, discounts, stock, ratings, commissions, shipping status or coupons. A deterministic validator compares generated copy against the persisted offer before publication.

## Security Boundary

The browser never receives marketplace tokens or publisher credentials. Secrets live in environment variables or encrypted database fields. Logs must redact secrets. Webhooks require signature validation. All externally-triggered writes require idempotency.
