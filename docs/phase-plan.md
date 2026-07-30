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

- Added multi-provider AI copy generation with Ollama as the default local provider and OpenAI as an optional provider.
- Added Ollama HTTP integration through configurable `OLLAMA_BASE_URL` and `OLLAMA_MODEL`.
- Added deterministic post-validation for prices, discounts, coupon, free shipping, disclosure, unsupported urgency and tracking URL.
- Added automatic fallback to the deterministic composer when AI is disabled, unavailable, invalid or times out.
- Persisted message source, provider, model, duration, validation status, validation reasons and generation timestamp on `Publication`.
- Added Ollama and OpenAI operational status plus server-side test actions in `/integracoes`.
- Added real provider/fallback metrics to `/automacoes`.
- Added unit tests for schema validation, provider selection, Ollama HTTP mocks, factual validation, successful generation and fallback scenarios.

### Phase 2C Maintenance - Historical Immutability

Status: implemented.

- Split Product identity, Offer commercial version and Publication historical snapshot semantics.
- Added `Offer.version` and deterministic `offerFingerprint`.
- Removed destructive Offer upsert by marketplace/external product ID.
- Added immutable Publication snapshot fields and refactored `/publicacoes` to read them.
- Preserved per-Offer AffiliateLink tracking so later Offer versions do not rewrite earlier tracking.
- Added migration/backfill for existing Offers and Publications with documented limitations for already-corrupted historical rows.

### Phase 2C Maintenance - Optional External Ingestion Fields

Status: implemented.

- Decoupled the manual form from the connector ingestion contract.
- Defined minimum ingestion, valid-offer and publication data levels.
- Allowed candidate Offers with missing enrichment fields such as original price, coupon, affiliate URL, image, commission, rating and sales count.
- Added `READY_FOR_AFFILIATE_LINK` for valid offers that still need an official affiliate URL before publication.
- Added tri-state shipping with `FREE`, `NOT_FREE` and `UNKNOWN`.
- Updated scoring to normalize over available components and persist score completeness.
- Updated deterministic and AI copy validation so missing facts are omitted instead of invented.

## Phase 3 - Marketplace Ingestion

- Implement officially permitted Shopee and Mercado Livre collection adapters.
- Normalize products, offers, campaigns and coupons.
- Add integration health checks and import jobs.

### Phase 3A - Mercado Livre Official Integration

Status: implemented.

- Added Mercado Livre OAuth 2.0 connection and callback routes with server-side state validation.
- Added encrypted, rotating token storage in `MarketplaceAccount` and refresh through Redis lock.
- Added `MercadoLivreConnector`, API client, price service, category lookup, highlights/best sellers, item multiget and normalization.
- Added persistent discovery configuration in `/integracoes/mercado-livre`.
- Added worker jobs for candidate discovery and offer refresh with `AutomationRun` metrics and `SystemAlert` codes.
- Added `AffiliateEligibility` and `TrackingStrategy` fields for offers.
- Added `READY_FOR_AFFILIATE_LINK` handling for Mercado Livre offers without official affiliate URL.
- Added `/ofertas/affiliate-links` to paste official affiliate URLs manually.
- Preserved Telegram, Ollama, deterministic fallback, channel filters, scoring, tracking and publication snapshots.
- No Shopee connector, WhatsApp automation, scraping or browser automation was added.

### Phase 3A.1 - Mercado Livre Discovery Consolidation

Status: implemented.

- Consolidated dashboard and worker discovery into `@affiliate/marketplace-discovery`.
- Restricted `MercadoLivreConnector` to official API access, response parsing and source diagnostics.
- Added structured `SUCCEEDED`, `PARTIAL`, `FAILED` and `SKIPPED` discovery results with one metrics contract.
- Corrected zero-valued minimum discount and score policies and persisted `Offer.minimumScoreApplied`.
- Preserved known Product metadata when later API responses omit enrichment.
- Preserved case-sensitive affiliate URL path, query and fragment values in fingerprints.
- Separated Price API success, item-price fallback and unavailable-price metrics.
- Added discovery locking and refresh-token loser polling without expired-token reuse.
- Kept transient API errors separate from OAuth reauthentication status.
- Added central baseline affiliate URL validation and blocked explicitly ineligible Offers.
- Added an experimental category-search probe with separate authenticated/public diagnostics, sanitized API errors, no persistence and no automatic fallback.
- Documented score versus completeness; no minimum-completeness policy was added.
- Did not add Shopee, scraping, WhatsApp or automatic category-search fallback.

## Phase 4 - Continuous Worker Operations

Status: implemented.

- Added the official `npm run worker` continuous command while preserving
  `worker:once`.
- Added independent discovery, publication, retry and maintenance cadences.
- Added timezone-correct daily boundaries and publication windows.
- Added deterministic priority, one-publication-per-channel cadence and
  multi-channel Offer scheduling.
- Added restart-safe backlog distribution, bounded Telegram retry/backoff,
  `Retry-After` support and permanent failure classification.
- Added component Redis locks and `WORKER_REQUIRE_REDIS`.
- Added cooperative SIGINT/SIGTERM shutdown.
- Added singleton heartbeat, ONLINE/OFFLINE/STALE status, pause/resume and
  bounded operational counters in `/automacoes`.
- Reused the existing Mercado Livre service and valid affiliate links.
- Did not add Shopee, WhatsApp or new marketplace authentication.

## Phase 5 - Tracking and Attribution

- Implement `/go/[slug]` redirects with click tracking and rate limiting.
- Import conversions, orders and commissions when official APIs or reports permit it.

## Phase 6 - Admin Dashboard

- Complete operational pages, charts, logs, settings and integration controls.
- Add production observability, audit trails and deployment runbooks.
