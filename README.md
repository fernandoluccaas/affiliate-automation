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

Phase 3A adds an official Mercado Livre connector. Configure the app credentials only on the server:

```env
MERCADO_LIVRE_CLIENT_ID=""
MERCADO_LIVRE_CLIENT_SECRET=""
MERCADO_LIVRE_REDIRECT_URI="http://localhost:3000/api/integrations/mercadolivre/callback"
MERCADO_LIVRE_SITE_ID="MLB"
```

See [docs/mercado-livre-affiliate-session.md](docs/mercado-livre-affiliate-session.md)
for the separately encrypted Affiliate Portal session, its server-side
configuration and the opt-in real integration test.

Use `/integracoes` to connect or reconnect through OAuth 2.0. Tokens are encrypted in `MarketplaceAccount`, refresh tokens are treated as rotating credentials, and Redis locks prevent concurrent refresh.

Use `/integracoes/mercado-livre` to enable discovery, choose official category IDs, set price/discount/score filters and run manual sync. Dashboard and worker call the same `MercadoLivreDiscoveryService`; the connector is limited to official HTTP access/parsing and `ingestOffer` owns Product/Offer persistence. Discovery and pending-link enrichment share the renewable distributed lock `mercado-livre:affiliate-link-operations:{accountId}`. Session updates also use the loaded `updatedAt` value as an optimistic concurrency guard, so a batch cannot overwrite a cookie that the user replaced while it was running.

Discovery uses official categories, highlights/best sellers, catalog product resolution, multiget item details and the official item prices endpoint. Highlight `PRODUCT` entries may be catalog parents; the resolver follows bounded `children_ids` to a child with `buy_box_winner.item_id` before deduplicating by final item ID. Missing original price, shipping certainty, image, rating, sales count or commission stays `null`/`UNKNOWN`. A configured minimum discount of zero means no discount requirement, and a minimum score of zero is passed explicitly to ingestion and stored on the Offer version for later affiliate-link enrichment.

The integration screen also provides an experimental manual category-search probe using `/sites/{siteId}/search?category={categoryId}&limit={limit}`. It first uses the connected account's Bearer token and, when that attempt fails, repeats the same request without `Authorization` strictly for comparison. HTTP failures retain only sanitized Mercado Livre fields (`error`, `code`, `message`, `cause` and `blocked_by`); credentials and sensitive headers are never returned. A successful authenticated attempt short-circuits the public comparison.

The probe returns at most five diagnostic samples and never calls `ingestOffer` or creates Product, Offer or Publication rows. A probe 403 does not change a connected account's status. Category search is not an automatic discovery source or fallback in Phase 3A.1 because its real behavior depends on the permissions and policies Mercado Livre makes available to the application. When `bestSellersEnabled=false`, normal discovery returns `DISCOVERY_SOURCE_DISABLED`.

For a configured Affiliate Portal session, discovery generates the official
affiliate URL after highlight resolution and before `ingestOffer`, with at most
four products in flight. Product-level failures do not abort the batch:
ineligible products are rejected deterministically, transient failures remain
`READY_FOR_AFFILIATE_LINK`, and an expired cookie stops new link attempts while
the resolved products are still persisted. Existing pending offers can be
enriched in bounded batches; `/ofertas/affiliate-links` remains the manual
fallback. Mercado Livre publications use `DIRECT_AFFILIATE_LINK`, so the worker
sends the official affiliate URL directly instead of `/go/[slug]`.

Every import persists ranking origin on `Offer` and real counters plus
per-product diagnostics in `ImportJob`/`ImportJobItem`. Ranking-only changes do
not alter the offer fingerprint. Affiliate URLs are validated centrally:
HTTPS is required, local/private hosts are rejected, and Mercado Livre accepts
only `meli.la`, `mercadolivre.com.br`, `mercadolibre.com`, and legitimate
subdomains of those domains.

## Tracking

Affiliate links are exposed through `/go/[slug]`. The route records a `Click` with affiliate link, offer, publication when available, channel when available, marketplace, referer and user agent. It never stores raw IP addresses. If tracking fails, the user is still redirected with a temporary HTTP redirect.

To test tracking manually, open the generated tracking URL shown in the publication message or visit `/go/{slug}` for an active `AffiliateLink`.

## Worker Commands

```powershell
npm run worker:once
npm run worker:dev
npm run worker:start
```

`worker:once` runs one cycle. `worker:dev` and `worker:start` poll continuously using `WORKER_POLL_INTERVAL_MS`, defaulting to 60000 ms.

## Quality Commands

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
npx prisma migrate status --schema prisma/schema.prisma
```

## Guardrails

- Do not implement authenticated scraping, marketplace login automation, CAPTCHA bypasses or WhatsApp Web automation.
- Keep offer validation and scoring deterministic.
- Store credentials only in environment variables or encrypted server-side database fields.
- Do not expose secrets to client bundles.
