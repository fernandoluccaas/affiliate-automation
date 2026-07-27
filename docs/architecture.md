# Architecture

Affiliate Automation is a production-oriented monorepo that separates user-facing dashboard code from workers and reusable domain packages.

## Runtime Flow

Shopee and Mercado Livre integrations feed marketplace connectors. Connectors normalize external data into internal products, offers, coupons and affiliate links. Offers are persisted in PostgreSQL, validated deterministically, deduplicated, scored, associated with affiliate links, prepared by the AI copywriter, scheduled, published through channel adapters and measured through tracking and conversion imports.

Phase 2A adds a manual offer pipeline before real marketplace connectors. An administrator can create an offer in `/ofertas/nova`; `ingestOffer` calculates the discount when possible, upserts the product identity, creates or reuses a versioned offer snapshot by fingerprint in a transaction, validates facts with Zod and deterministic rules, calculates and persists an auditable score, creates a tracking slug when an affiliate URL exists and sets the final offer status automatically.

The ingestion boundary now separates candidate identity from enrichment. `marketplace`, `externalProductId`, `title`, `productUrl` and `currentPrice` are the minimum fields required to create an Offer candidate. Description, category, image, original price, discount, coupon, affiliate URL, commission, rating, sales count and shipping certainty are optional inputs. Missing facts remain `null` or `UNKNOWN`; they are not coerced to zero or false.

Phase 2B adds the publication and tracking loop. The worker selects active compatible channels for `READY_TO_PUBLISH` offers, creates idempotent `Publication` rows with deterministic message payloads, publishes scheduled rows through Telegram or manual export adapters, records `PublicationAttempt`, and updates publication status. `/go/[slug]` is public and records clicks before redirecting to the affiliate destination.

Phase 2C adds multi-provider copy generation between channel selection and publication creation. The worker requests structured JSON copy from the configured provider, validates the returned text against confirmed offer facts, persists message metadata on `Publication`, and falls back to the deterministic composer without blocking Telegram, manual export, tracking or Redis locks. Ollama is the default provider and is called over HTTP at the configured `OLLAMA_BASE_URL`; OpenAI remains optional.

Phase 3A adds the official Mercado Livre connector. OAuth starts from `/integracoes`, returns to `/api/integrations/mercadolivre/callback`, validates a server-side `state` cookie, exchanges the code for tokens and stores encrypted rotating credentials in `MarketplaceAccount`. Discovery is configured in `/integracoes/mercado-livre` and uses official categories, `/highlights/{siteId}/category/{categoryId}`, catalog `/products/{PRODUCT_ID}` resolution, multiget `/items?ids=...` and `/items/{ITEM_ID}/prices`.

Phase 3A.1 consolidates orchestration into one shared service:

```text
Dashboard ─┐
           ├─> MercadoLivreDiscoveryService ─> @affiliate/ingestion
Worker ────┘                 │
                             └─> MercadoLivreConnector ─> official HTTP API
```

`MercadoLivreConnector` owns HTTP, response parsing and API-source diagnostics. `MercadoLivreDiscoveryService` owns configuration/account loading, category/highlight resolution, deduplication, filtering, locks, metrics and calls to ingestion. `@affiliate/ingestion` owns Product/Offer persistence, deterministic validation, scoring and versioning. Neither dashboard nor worker contains an independent discovery pipeline.

Mercado Livre highlight `PRODUCT` entries can be catalog parents. A parent catalog product is not necessarily a purchasable item. Product resolution preserves the source highlight identity, resolves direct buy-box winners when present, and otherwise traverses bounded `children_ids` to find a terminal child with `buy_box_winner.item_id`. Terminal products without a winner are skipped with an explicit reason instead of fabricating an item.

Mercado Livre affiliate URLs are not generated automatically. Valid offers without a link become `READY_FOR_AFFILIATE_LINK` and are enriched manually in `/ofertas/affiliate-links`. Mercado Livre uses `TrackingStrategy.DIRECT_AFFILIATE_LINK`, so publication receives the official affiliate URL directly. Other marketplaces keep the internal `/go/[slug]` tracking strategy.

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

Score and completeness are independent. A candidate can score 100 with 10% completeness when novelty is the only available component. Phase 3A.1 records both values but does not add a minimum-completeness policy; that remains a later policy decision.

## Packages

- `packages/database`: Prisma client, persistence utilities and credential encryption boundaries.
- `packages/ingestion`: shared offer ingestion schema, discount calculation, product upsert, offer versioning, validation, scoring and affiliate-link status selection.
- `packages/marketplace-connectors`: official marketplace API connector contracts and implementations.
- `packages/marketplace-discovery`: shared Mercado Livre discovery orchestration, result contract, metrics and highlight resolution.
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

Mercado Livre discovery uses `mercado-livre:discovery:{accountId}` with a ten-minute TTL. A second caller receives `DISCOVERY_ALREADY_RUNNING` as a skipped run. Token refresh uses `mercado-livre:token-refresh:{accountId}`; a loser polls for the rotated token and returns `TOKEN_REFRESH_IN_PROGRESS` on timeout instead of using an expired token.

Marketplace authentication status is separate from operational sync health. `invalid_grant`, an invalid refresh token or an authentication-related 401/403 can set `REAUTH_REQUIRED`. Rate limits, 5xx responses, timeouts, network errors and transient invalid responses keep the account `CONNECTED` while updating `lastErrorAt` and `lastError`.

Manual export is not treated as publication delivery. `ManualExportPublisher` returns an exported-only status so downstream code cannot count a copied/exported message as a published message.

Redis selection is server-only: Upstash is used when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured; otherwise `REDIS_URL` is used for local Redis. If neither is present, dashboard health reports Redis as unavailable/skipped and the worker can still run locally without distributed guarantees.

## AI Boundary

The selected AI provider receives only confirmed offer facts: title, marketplace, category, prices, discount, coupon, shipping flag, rating, sales count and tracking URL. AI output uses Structured Outputs with `headline`, `body`, `callToAction`, `disclosure` and `hashtags`.

The selected AI provider receives only confirmed offer facts. Optional values that are unavailable are passed as unavailable, not as zero. The deterministic validator rejects generated copy that changes prices, discount, coupon, shipping status, affiliate disclosure or tracking URL, or that adds unsupported urgency/promises. Rejected, timed out, errored, disabled or unconfigured AI generation falls back to `deterministicMessageComposer`, which omits coupon, discount, original price and free-shipping lines when those facts are missing. Publication adapters consume the same saved payload regardless of provider.

## Security Boundary

The browser never receives marketplace tokens or publisher credentials. Secrets live in environment variables or encrypted database fields. Logs must redact secrets. Webhooks require signature validation. All externally-triggered writes require idempotency.

Telegram bot tokens are read only on the server. Channel configuration may store operational values such as `chatId`, but tokens are not sent to the browser.
