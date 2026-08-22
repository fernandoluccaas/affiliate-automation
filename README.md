# Affiliate Automation

Affiliate Automation is a monorepo for collecting, validating, scoring, publishing and measuring affiliate offers from officially allowed integrations.

## Local Setup

```powershell
npm install
docker compose up -d
npm run prisma:migrate
npm run db:seed
npm run dev
```

The dashboard runs at `http://localhost:3000`. Use the admin credentials configured by `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`.

Docker Compose starts PostgreSQL and Redis. For local Redis health and worker locks, set:

```env
REDIS_URL="redis://localhost:6379"
APP_BASE_URL="http://localhost:3000"
```

## Manual Offer Flow

Phase 2A supports manual offer ingestion:

1. Open `/ofertas/nova`.
2. Fill the required candidate fields: marketplace, external product ID, title, product URL and current price.
3. Submit the form.
4. The system calculates the discount internally when original price is available.
5. `ingestOffer` validates facts, calculates score, persists `OfferScore`, creates an affiliate slug when an affiliate URL exists and sets the final status.

External integrations are not required to provide every enrichment field that the manual form exposes. Description, category, image, original price, coupon, affiliate URL, commission, rating, sales count and shipping certainty can be missing. Missing values are stored as `null` or `UNKNOWN`, not as zero or false facts.

Valid offers above the minimum score become `READY_TO_PUBLISH`. Offers without an affiliate URL can be persisted as `READY_FOR_AFFILIATE_LINK` so they can be enriched later, but the worker does not publish them. Invalid, expired, duplicate or low-score offers are rejected with a deterministic reason.

Product, Offer and Publication are intentionally separate:

- `Product`: permanent marketplace identity, keyed by `marketplace + externalProductId`.
- `Offer`: commercial snapshot/version for that product, keyed by a deterministic `offerFingerprint`.
- `Publication`: immutable snapshot of what was scheduled/sent to a channel.

Example: the same `Product` can have `Offer v1` at `R$ 329,90` and later `Offer v2` at `R$ 245,90`. Publishing v2 never rewrites the historical publication for v1.

Scoring normalizes over the components that are actually available and stores `scoreCompletenessPercentage`. A missing rating, sales count, commission, discount or shipping certainty is not treated as zero.

## Publication Flow

Phase 2B adds click tracking, channel configuration and the worker publication loop:

```text
READY_TO_PUBLISH -> SCHEDULED -> PUBLISHED | EXPORTED | PUBLICATION_FAILED
```

To test Telegram:

1. Create a Telegram bot with BotFather.
2. Add the bot to the target chat.
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`.
4. Open `/canais` and create a `TELEGRAM` channel.
5. Click `Testar Telegram`.
6. Create a valid offer in `/ofertas/nova`.
7. Run `npm run worker:once`.

The worker creates `Publication` with historical snapshots, sends the saved message, records `PublicationAttempt`, and updates the dashboard with real publication and click data.

### Grupos do WhatsApp assistidos

Create one or more `WHATSAPP_GROUPS` records in `/canais` with publication mode `ASSISTED`. Each group has independent timezone, daily limit, interval, repeat, score and marketplace policies. The shared scheduler creates one idempotent `AWAITING_MANUAL_PUBLICATION` snapshot per group and Offer version; pending items reserve capacity separately for each group.

Use `/publicacoes-assistidas` to filter by group, status, marketplace or date, copy the exact saved message, download the validated image, open WhatsApp Web and manually publish in the intended group. Confirmation records the snapshotted group name, authenticated user and `publishedAt`; it does not fabricate an external message ID.

`WHATSAPP_CHANNEL` is legacy and can be converted explicitly in `/canais` without changing its ID or Publications. `WHATSAPP_GROUPS_API` remains unused.

### WhatsApp Groups Web experimental

The optional `WEB_EXPERIMENTAL` mode uses Playwright only against the visual WhatsApp Web interface. It is disabled by default, keeps `WHATSAPP_WEB_DRY_RUN=true`, opens an isolated persistent profile under `.local/whatsapp-web`, and requires a manually authenticated session, explicit group-ownership confirmation, exact group-name matching and Redis locks. The dashboard never opens Chromium or receives QR codes, cookies, local storage, profile paths, member lists or conversations.

`npm run worker:once` only plans this mode. It creates an immutable, idempotent `SCHEDULED` Publication with operational state `AWAITING_VISUAL_INSPECTION`, then defers execution. At most one non-terminal Publication is active per Web channel: the oldest `plannedAt` wins, later backlog items wait behind it, and the worker records `ACTIVE_PUBLICATION_EXISTS` instead of growing the queue. The Redis planning lock and a PostgreSQL `Channel` row lock protect that invariant. Telegram and each WhatsApp group remain independent. The worker never opens Playwright for a Web Publication.

Open `/publicacoes` to see the active item, queue position, inspection, preflight and authorization audit. Database-only actions can cancel, archive, authorize one exact fingerprint for up to 60 minutes, or revoke it; they never instantiate Playwright. Use `whatsapp:web:queue-status`, `inspect-draft`, `preflight`, `authorize-send` and `revoke-send-authorization` in that order. Authorization is single-use, expires, is invalidated by snapshot/configuration changes and is atomically claimed before any future publish side effect. No real send is performed by tests.

Phase 5E adds one manual dispatch command for the already authorized active Publication: `npm run whatsapp:web:dispatch-authorized -- --publication-id <ID> --confirm-send`. `whatsapp:web:publish` is only an alias to that same service. The service takes a Redis channel lock, atomically claims the authorization under channel and Publication row locks, then takes profile and Publication locks before invoking the existing visual publisher. `WHATSAPP_WEB_DRY_RUN=true` rejects the command before every lock, claim, attempt, browser or send side effect. Inspect a dispatch with `whatsapp:web:dispatch-status`; an abandoned pre-click claim can only be released with `whatsapp:web:release-dispatch-claim -- --publication-id <ID> --reason "..." --confirm-release`, which invalidates preflight and requires a new authorization. Claims with a click marker can never be released and require delivery review.

### Continuous local production

Phase 5F runs PostgreSQL and Redis in Docker Desktop and the production dashboard plus continuous worker on the Windows host. `npm run production:build`, `npm run ops:preflight`, and `npm run ops:start` are the normal startup path; `ops:status`, `ops:audit-state`, and `/operacoes` are read-only. A PowerShell supervisor restarts only owned processes with bounded backoff, while the worker holds the Redis leader key `affiliate:worker:leader` and fails closed when that leadership is unavailable.

Backups use `npm run ops:backup-db` followed by `ops:backup-status` and explicit `ops:verify-backup`. Task Scheduler installation is optional, preview-first, and requires a confirmation flag. None of the continuous processes, health endpoints, scheduled tasks, or backup scripts opens Playwright or dispatches WhatsApp. See [Windows local production operations](docs/windows-production-operations.md) for startup, shutdown, recovery, retention, restore, and daily/weekly/monthly checklists.

Phase 5G adds an explicit fail-closed burn-in worker that exercises PostgreSQL,
Redis, leadership, heartbeat, timers and shutdown while structurally blocking every
business job and external integration. Use `npm run ops:burn-in:preflight` and the
bounded `npm run ops:burn-in:smoke -- --duration-seconds 60`; the dashboard remains
read-only. See [Operational reliability and safe burn-in](docs/operational-burn-in.md).

Install Chromium explicitly with `npm run whatsapp:web:install-browser`, then use the remaining local commands documented in [docs/whatsapp-groups.md](docs/whatsapp-groups.md). Caption validation resolves an active media surface from preview, media controls, stacking context, geometry and before/after contenteditable fingerprints; it rejects the normal composer. Any failure after click initiation remains `DELIVERY_UNCERTAIN`, blocks the entire channel queue and can be reconciled auditably without resending.

Manual export channels create `EXPORTED` publications. They do not count as external publications and do not update the offer as published.

## AI Copywriter

Phase 2C uses a multi-provider copywriter. Ollama is the default provider and runs locally through HTTP, so local generation has no token billing. OpenAI remains available only when explicitly selected.

```env
AI_PROVIDER="ollama"
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_MODEL="qwen3:4b"
AI_COPY_ENABLED="true"
AI_COPY_TIMEOUT_MS="30000"
OPENAI_API_KEY=""
OPENAI_MODEL="gpt-4.1-mini"
```

Install and prepare the default local model:

```powershell
ollama pull qwen3:4b
ollama run qwen3:4b
```

The worker sends confirmed offer facts to the selected provider using structured JSON output. The system validates the generated copy deterministically before saving the publication. If AI is disabled, Ollama is offline, a provider times out, returns invalid JSON or produces copy with unconfirmed facts, the worker uses the deterministic composer and keeps scheduling/publishing intact.

## Mercado Livre

### Descoberta multicategoria balanceada

A descoberta oficial pode processar várias categorias-folha na mesma sessão, aplicar cotas por categoria, deduplicar produtos e entregar ao scheduler uma ordem round robin. O recurso é desativado por padrão e preserva a geração/reutilização automática de links reais `meli.la`; sem uma sessão afiliada válida, a oferta permanece `READY_FOR_AFFILIATE_LINK` e nunca usa a URL original como fallback.

Use `npm run discovery:multi-category:status`, `preflight`, `preview` e `npm run discovery:multi-category:run -- --dry-run` para inspeção sem chamadas externas ou escrita. A execução real exige `--confirm-discovery`. Configuração, quotas, backfill, canais, auditoria e troubleshooting estão em [docs/multi-category-discovery.md](docs/multi-category-discovery.md).

Phase 3A adds an official Mercado Livre connector. Configure the app credentials only on the server:

```env
MERCADO_LIVRE_CLIENT_ID=""
MERCADO_LIVRE_CLIENT_SECRET=""
MERCADO_LIVRE_REDIRECT_URI="http://localhost:3000/api/integrations/mercadolivre/callback"
MERCADO_LIVRE_SITE_ID="MLB"
```

Use `/integracoes` to connect or reconnect through OAuth 2.0. Tokens are encrypted in `MarketplaceAccount`, refresh tokens are treated as rotating credentials, and Redis locks prevent concurrent refresh.

Use `/integracoes/mercado-livre` to enable discovery, synchronize categories, choose leaf category IDs, set price/discount/score filters and import the best sellers. Dashboard and worker call the same `MercadoLivreDiscoveryService`; the connector is limited to official HTTP access/parsing and `ingestOffer` owns Product/Offer persistence.

The primary ranking source is the official authenticated endpoint `GET /highlights/MLB/category/{categoryId}`. Discovery keeps at most 20 positions per leaf category and resolves `ITEM`, `PRODUCT` and `USER_PRODUCT` into the final item before deduplicating. `PRODUCT` parents are traversed through bounded `children_ids` until a `buy_box_winner.item_id` is found; when no direct or child winner is usable, the official `/products/{PRODUCT_ID}/items` resource supplies candidates for deterministic selection before normal item and price hydration. An individual resolution or ingestion failure is recorded in `ImportJobItem` and does not cancel the other products.

Each Offer stores `sourceCategoryId`, `bestSellerPosition`, `sourceHighlightId`, `sourceHighlightType` and `resolutionStrategy`; Publication copies those values into immutable snapshots. Ranking-only changes are intentionally excluded from the commercial fingerprint, so moving from position 8 to 9 does not create a new Offer version by itself.

## Mercado Livre affiliate links

Link generation remains in the official Mercado Livre Affiliate Portal. The supported import flow does not require or store browser cookies, CSRF values, usernames, passwords, MFA codes or CAPTCHA data. `ManualAffiliateLinkProvider` returns `MANUAL_REQUIRED`; it never fabricates `meli.la` and never substitutes the original product URL.

Therefore the automatic flow is:

```text
discovered -> resolved -> persisted -> READY_FOR_AFFILIATE_LINK
-> user imports meli.la -> new Offer version -> deterministic validation/score
-> READY_TO_PUBLISH or a rejection status
```

Open `/ofertas/affiliate-links` to:

- paste several links directly in the pending-offers table;
- paste `externalId|affiliateUrl` or `productUrl|affiliateUrl` lines;
- upload CSV with `externalId,productUrl,affiliateUrl`, using comma or semicolon.

Only `affiliateUrl` plus one identifier is required. A preview separates valid, not found, duplicate, invalid and already-applied lines. Confirmation uses `ingestOffer`, preserves snapshots and metadata, creates the next Offer version when required and re-runs deterministic validation and scoring. A product URL not yet stored is resolved through the official OAuth connector before ingestion.

Affiliate URLs must be absolute HTTPS URLs without embedded credentials. Mercado Livre accepts only `meli.la`, `mercadolivre.com.br`, `mercadolibre.com` and legitimate subdomains. The original URL and affiliate URL remain separate.

## Tracking and attribution

The hardened `/go/[slug]` route validates marketplace destinations before a
redirect, applies atomic Redis rate limits and short-window deduplication, and
stores only a temporary HMAC fingerprint, referer hostname, and coarse
user-agent category. A valid redirect remains available when tracking is
degraded; unreliable clicks are not written or retried.

Manual canonical CSV inspection and dry-run are available for conversions and
commissions. Confirmed financial imports are disabled by default, require an
explicit flag plus Redis, and use checksum/event idempotency and transactional
ImportJob auditing. The authenticated `/resultados` page is read-only and keeps
currencies separate. Shopee report support remains
`WAITING_FOR_OFFICIAL_REPORT`; no report columns or APIs are invented.

See [Tracking, attribution and financial reports](docs/tracking-attribution.md)
for privacy details, canonical columns, commands, locks, rollback, Sub IDs,
retention, analytics, and troubleshooting.

Shopee Datafeeds support deterministic preview and an explicitly confirmed
operational import. In `HYBRID` mode, server-only App ID/Secret credentials sign
the official `generateShortLink` GraphQL request; individual, manually confirmed
bulk and optional post-import auto-linking all reuse the same validated
Offer/AffiliateLink pipeline. Auto-linking is disabled by default, partial
success keeps failed Offers pending, and the flow stops at `READY_TO_PUBLISH`
without creating a Publication. See
[Shopee Affiliate](docs/shopee-affiliate.md).

Shopee remote discovery now implements the official Explorer V2 contracts
`listItemFeeds(FULL)` and `getItemFeedData` through the existing signed
transport. Stable `referenceId` allowlists resolve the current `datafeedId`,
pages use offsets with a maximum size of 500, and the JSON `columns` records use
the same normalizer, filtering and ranking as local CSV files. `LOCAL_FILE`
remains the safe default, DELTA remains disabled, every live CLI call requires
explicit confirmation, and a remote import additionally requires Redis plus
`--confirm-import`. Remote discovery and import still create zero Publications.

The worker processes queued `AFFILIATE_LINK_BATCH` jobs and isolates expiration, discovery, refresh, scheduling, retries and publication as independent stages. A failed discovery produces `PARTIAL` while refresh and ready publications continue. Refresh records `selected`, `refreshed`, `unchanged`, `newVersions`, `notFound`, `failed` and `affiliateUrlsPreserved`; it never replaces an existing affiliate URL with `null`.

Mercado Livre publications use `DIRECT_AFFILIATE_LINK`. A missing or invalid affiliate URL prevents scheduling and publication; there is no fallback to the original URL.

See [docs/mercado-livre-supported-import.md](docs/mercado-livre-supported-import.md) for formats, validation and versioning details. The current automatic provider is limited to the owner-authorized Mercado Livre affiliate-session resources documented in `AGENTS.md`; any future provider must remain behind `AffiliateLinkProvider` and use an explicitly authorized or officially documented API.

For an end-to-end owner-authorized session check, follow
[docs/mercado-livre-one-click-manual-test.md](docs/mercado-livre-one-click-manual-test.md).

## Tracking

Affiliate links are exposed through `/go/[slug]`. The route records a `Click` with affiliate link, offer, publication when available, channel when available, marketplace, referer and user agent. It never stores raw IP addresses. If tracking fails, the user is still redirected with a temporary HTTP redirect.

To test tracking manually, open the generated tracking URL shown in the publication message or visit `/go/{slug}` for an active `AffiliateLink`.

## Worker Commands

```powershell
npm run worker
npm run worker:once
npm run worker:dev
npm run worker:start
```

`worker` is the official continuous process. `worker:once` remains a controlled
diagnostic cycle. `worker:dev` and `worker:start` are workspace-level aliases.
Continuous jobs use independent conservative cadences:

```env
WORKER_DISCOVERY_INTERVAL_MINUTES="30"
WORKER_PUBLICATION_INTERVAL_MINUTES="5"
WORKER_RETRY_INTERVAL_MINUTES="10"
WORKER_MAINTENANCE_INTERVAL_MINUTES="60"
WORKER_REQUIRE_REDIS="false"
```

The process updates a singleton database heartbeat every 30 seconds. Global
discovery and publication pause flags are persisted separately, so pausing
publication does not stop discovery. Missed intervals are not replayed after a
restart. Affiliate-link batches above `AFFILIATE_LINK_JOB_INLINE_LIMIT` are
queued and processed independently by the worker.

## Quality Commands

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
npx prisma migrate status --schema prisma/schema.prisma
```

## Guardrails

- Do not implement authenticated scraping, marketplace login automation or CAPTCHA bypasses. WhatsApp Web automation is limited to the scoped, owner-administered Groups experiment authorized in `AGENTS.md`.
- Keep offer validation and scoring deterministic.
- Store credentials only in environment variables or encrypted server-side database fields.
- Do not expose secrets to client bundles.
