# Architecture

Affiliate Automation is a production-oriented monorepo that separates user-facing dashboard code from workers and reusable domain packages.

## Runtime Flow

Shopee and Mercado Livre integrations feed marketplace connectors. Connectors normalize external data into internal products, offers, coupons and affiliate links. Offers are persisted in PostgreSQL, validated deterministically, deduplicated, scored, associated with affiliate links, prepared by the AI copywriter, scheduled, published through channel adapters and measured through tracking and conversion imports.

Phase 2A adds a manual offer pipeline before real marketplace connectors. An administrator can create an offer in `/ofertas/nova`; `ingestOffer` calculates the discount when possible, upserts the product identity, creates or reuses a versioned offer snapshot by fingerprint in a transaction, validates facts with Zod and deterministic rules, calculates and persists an auditable score, creates a tracking slug when an affiliate URL exists and sets the final offer status automatically.

The ingestion boundary now separates candidate identity from enrichment. `marketplace`, `externalProductId`, `title`, `productUrl` and `currentPrice` are the minimum fields required to create an Offer candidate. Description, category, image, original price, discount, coupon, affiliate URL, commission, rating, sales count and shipping certainty are optional inputs. Missing facts remain `null` or `UNKNOWN`; they are not coerced to zero or false.

Phase 2B adds the publication and tracking loop. The worker selects active compatible channels for `READY_TO_PUBLISH` offers, creates idempotent `Publication` rows with deterministic message payloads, publishes scheduled rows through Telegram or manual export adapters, records `PublicationAttempt`, and updates publication status. `/go/[slug]` is public and records clicks before redirecting to the affiliate destination.

Phase 5C separates Web planning from browser execution. The shared scheduler persists a `WEB_EXPERIMENTAL` Publication independently for each channel and Offer version, including immutable snapshots and explicit inspection/preflight gates. The normal worker dispatch stage always defers those rows and cannot instantiate the Playwright publisher. Only the explicit local WhatsApp CLI owns browser execution. Planning decisions and aggregate created/existing/executed/deferred/failed counters are stored in sanitized `AutomationRun.metrics`.

Phase 5E keeps a single browser publisher and places a controlled dispatcher in front of it. All pure gates run first, including the default dry-run block. A Redis channel lock serializes the operation; a short PostgreSQL transaction locks Channel then Publication and claims the exact active authorization; only after commit are the isolated profile lock and Publication lock acquired. `sendClickStartedAt` is durably written before the visual click. Any subsequent ambiguity becomes `DELIVERY_UNCERTAIN`; a failure before that marker becomes `PREFLIGHT_REQUIRED`/`FAILED_SAFE`. PostgreSQL transactions are never held while Chromium is open.

Phase 5D adds a channel-scoped operational queue over existing Publication metadata. Queue order is `plannedAt`, `createdAt`, then ID; terminal items are preserved but excluded. An unresolved `DELIVERY_UNCERTAIN` takes precedence and blocks promotion. Worker planning uses `whatsapp:web:planning:{channelId}` plus a transactional PostgreSQL row lock on `Channel`, then repeats the non-terminal check before insert. Visual inspection, preflight, authorization, revocation, claim, cancellation and archive share the same database service. A send authorization belongs to one Publication/channel/fingerprint, expires, is single-use and is claimed atomically before the browser can open.

Phase 4 runs that flow continuously with independent discovery, publication,
retry and maintenance clocks. The publication scheduler chooses at most one
Offer per Channel in a cadence, while the same Offer version may create one
idempotent Publication for each compatible Channel. READY offers are ordered by
never-published state, score, known discount, bestseller position, recency and
stable ID. Scheduled delivery also takes at most one row per Channel per
publication cadence, preventing restart bursts.

Daily limits and allowed publication windows use `Channel.timezone`. The worker
converts the local midnight boundaries to UTC for PostgreSQL queries, so a UTC
server does not reset an `America/Sao_Paulo` channel at UTC midnight.

Operational state is stored in two bounded `SystemSetting` singletons: one for
heartbeat/status/aggregate counters and one for pause controls. This avoids an
unbounded heartbeat table. `/automacoes` derives ONLINE, STALE or OFFLINE from
the saved state through the shared `resolveWorkerHealthStatus` rule and exposes
independent discovery/publication controls. The worker writes every 30 seconds;
three missed heartbeats (90 seconds) are `STALE`. Explicit graceful shutdown is
`OFFLINE`, while missing or invalid heartbeat data fails safely to `STALE`.
The same status JSON retains the last known distributed-lock backend and a
bounded root-cause code. Redis connection failures are
`FAILED / REDIS_UNAVAILABLE`; a healthy backend with an owned lock is
`SKIPPED / LOCK_ALREADY_HELD`. The worker retries acquisition on every cadence,
which enables recovery without restarting the process. AutomationRun reuses
its JSON metrics for these fields, so no schema change is required.

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

Mercado Livre periodic refresh follows the persisted resolution metadata.
ITEM-backed and USER_PRODUCT-resolved Offers refresh the final ITEM identity.
Catalog-PDP Offers keep the PRODUCT identity, reload `/products/{id}` and
`/products/{id}/items`, and reuse discovery's deterministic summary selection.
The optional ITEM detail and Price API enrich summary facts when available;
their absence does not turn a valid catalog PRODUCT into a false not-found.

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

## Phase 5A - Assisted WhatsApp Groups

`WHATSAPP_GROUPS` represents each owner-administered destination group. Its `publicationMode` is stored in `Channel.configuration`; the supported value is `ASSISTED`. The pipeline remains `Offer -> shared scheduler -> PromoMessageBuilder facts -> WhatsAppMessageFormatter -> WhatsAppChannelPublisher`. Scheduler policy, Redis locking, idempotency and immutable Publication snapshots are shared with Telegram. Multiple groups are independent Channels, so the same Offer version may be prepared once in each group.

## Phase 5B - WhatsApp Groups Web experimental

`WEB_EXPERIMENTAL` adds a delivery layer after the shared scheduler: `WhatsAppGroupsDeliveryService -> WhatsAppGroupsWebPublisher -> WhatsAppWebSessionManager/launcher -> WhatsAppWebPageAdapter -> Playwright Page`. Scheduler and dashboard contain no DOM selectors and never open a browser. Selectors and multilingual accessible aliases are centralized in `whatsapp-web-selectors.ts`.

The publisher dynamically loads Playwright only for an explicit local operation, launches one persistent context per sanitized logical profile key and requires `whatsapp-web:profile:{key}` plus the publication lock in Redis. Dry-run calls only draft preparation/inspection/cleanup. Real delivery calls the separate send operation and marks `PUBLISHED` only after visual outgoing-message confirmation. Inconclusive state after a click is terminal `PUBLICATION_FAILED` with `deliveryUncertain=true`, blocked retry and group-only pause.

The assisted publisher returns `AWAITING_MANUAL_PUBLICATION`, never `PUBLISHED`. Those rows reserve daily capacity, participate in interval/repeat checks and are excluded from automatic delivery. `imageUrlSnapshot` and `messagePayload` keep the preview stable. Manual confirmation is a separate authenticated dashboard transition.

`WHATSAPP_CHANNEL` is a deprecated enum value retained for the already-applied migration and existing data; it cannot schedule new assisted rows. The dashboard provides an explicit same-record conversion to `WHATSAPP_GROUPS`. `WHATSAPP_GROUPS_API` is not used. The Web experimental implementation remains an inert group-oriented adapter with no browser/session code.

Redis selection is server-only: Upstash is used when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured; otherwise `REDIS_URL` is used for local Redis. If neither is present, dashboard health reports Redis as unavailable/skipped and the worker can still run locally without distributed guarantees.

## AI Boundary

The selected AI provider can suggest only `headline` and an optional
`optionalHook`. It cannot provide prices, coupons, shipping claims or URLs.
`PromoMessageBuilder` reconstructs the final message from persisted facts.
Rejected, repeated, timed out, errored, disabled or unconfigured generation
falls back to the local marketplace-aware headline pool. Publication adapters
consume the same saved payload regardless of provider.

## Security Boundary

The browser never receives marketplace tokens or publisher credentials. Secrets live in environment variables or encrypted database fields. Logs must redact secrets. Webhooks require signature validation. All externally-triggered writes require idempotency.

Telegram bot tokens are read only on the server. Channel configuration may store operational values such as `chatId`, but tokens are not sent to the browser.
