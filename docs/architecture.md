# Architecture

Affiliate Automation is a production-oriented monorepo that separates user-facing dashboard code from workers and reusable domain packages.

## Runtime Flow

Shopee and Mercado Livre integrations feed marketplace connectors. Connectors normalize external data into internal products, offers, coupons and affiliate links. Offers are persisted in PostgreSQL, validated deterministically, deduplicated, scored, associated with affiliate links, prepared by the AI copywriter, scheduled, published through channel adapters and measured through tracking and conversion imports.

Phase 2A adds a manual offer pipeline before real marketplace connectors. An administrator can create an offer in `/ofertas/nova`; `ingestOffer` calculates the discount when possible, upserts the product identity, creates or reuses a versioned offer snapshot by fingerprint in a transaction, validates facts with Zod and deterministic rules, calculates and persists an auditable score, creates a tracking slug when an affiliate URL exists and sets the final offer status automatically.

The ingestion boundary now separates candidate identity from enrichment. `marketplace`, `externalProductId`, `title`, `productUrl` and `currentPrice` are the minimum fields required to create an Offer candidate. Description, category, image, original price, discount, coupon, affiliate URL, commission, rating, sales count and shipping certainty are optional inputs. Missing facts remain `null` or `UNKNOWN`; they are not coerced to zero or false.

Phase 2B adds the publication and tracking loop. The worker selects active compatible channels for `READY_TO_PUBLISH` offers, creates idempotent `Publication` rows with deterministic message payloads, publishes scheduled rows through Telegram or manual export adapters, records `PublicationAttempt`, and updates publication status. `/go/[slug]` is public and records clicks before redirecting to the affiliate destination.

Phase 2C adds multi-provider copy generation between channel selection and publication creation. The worker requests structured JSON copy from the configured provider, validates the returned text against confirmed offer facts, persists message metadata on `Publication`, and falls back to the deterministic composer without blocking Telegram, manual export, tracking or Redis locks. Ollama is the default provider and is called over HTTP at the configured `OLLAMA_BASE_URL`; OpenAI remains optional.

## Historical Immutability

`Product`, `Offer` and `Publication` have different ownership:

- `Product` is the marketplace identity. It can update current metadata such as title, category, image and product URL.
- `Offer` is a versioned commercial snapshot for a Product. Material conditions generate an `offerFingerprint`; a new fingerprint creates the next version for the same Product.
- `Publication` is the immutable snapshot of what was scheduled or sent. It stores title, external product ID, marketplace, category, prices, discount, coupon, free shipping, affiliate URL, tracking URL and Offer version at scheduling time.

Historical pages must read publication snapshots for published content. They must not use mutable `Product` or current `Offer` joins to represent what was already sent.

## Applications

- `apps/dashboard`: Next.js 15 administrative dashboard deployed to Vercel.
- `apps/worker`: worker entrypoint for Railway jobs, marketplace imports and automation runs.

The dashboard uses a reusable administrative shell with real navigation for dashboard, offers, products, coupons, channels, integrations, publications, automations, settings and logs. Pages that are not fully implemented show empty states and do not fabricate operational data.

Scoring does not treat unavailable enrichment as zero. It computes the final score from available component weights and persists a separate completeness percentage so publication policy can distinguish a strong sparse candidate from a fully enriched candidate.

## Packages

- `packages/database`: Prisma client, persistence utilities and credential encryption boundaries.
- `packages/marketplace-connectors`: official marketplace API connector contracts and implementations.
- `packages/publisher-connectors`: publication adapters for supported channels.
- `packages/publication`: deterministic message composition and channel policy checks.
- `packages/redis`: Upstash/local Redis health checks and distributed locks.
- `packages/scoring`: deterministic score normalization and weighted scoring.
- `packages/validation`: Zod schemas and deterministic offer validation pipeline.
- `packages/ai-copywriter`: multi-provider structured-output copy generation and post-generation checks.
- `packages/tracking`: click attribution and redirect helpers.
- `packages/shared`: cross-package enums, types and small utilities.

## Automation Boundary

Workers and automation workflows must use locks and idempotency keys before mutating publication or import state. Upstash Redis is the intended distributed coordination layer. Railway runs workers and scheduled automation, with n8n reserved for external workflow orchestration where needed. The dashboard remains a control and observability plane.

Manual export is not treated as publication delivery. `ManualExportPublisher` returns an exported-only status so downstream code cannot count a copied/exported message as a published message.

Redis selection is server-only: Upstash is used when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured; otherwise `REDIS_URL` is used for local Redis. If neither is present, dashboard health reports Redis as unavailable/skipped and the worker can still run locally without distributed guarantees.

## AI Boundary

The selected AI provider receives only confirmed offer facts: title, marketplace, category, prices, discount, coupon, shipping flag, rating, sales count and tracking URL. AI output uses Structured Outputs with `headline`, `body`, `callToAction`, `disclosure` and `hashtags`.

The selected AI provider receives only confirmed offer facts. Optional values that are unavailable are passed as unavailable, not as zero. The deterministic validator rejects generated copy that changes prices, discount, coupon, shipping status, affiliate disclosure or tracking URL, or that adds unsupported urgency/promises. Rejected, timed out, errored, disabled or unconfigured AI generation falls back to `deterministicMessageComposer`, which omits coupon, discount, original price and free-shipping lines when those facts are missing. Publication adapters consume the same saved payload regardless of provider.

## Security Boundary

The browser never receives marketplace tokens or publisher credentials. Secrets live in environment variables or encrypted database fields. Logs must redact secrets. Webhooks require signature validation. All externally-triggered writes require idempotency.

Telegram bot tokens are read only on the server. Channel configuration may store operational values such as `chatId`, but tokens are not sent to the browser.
