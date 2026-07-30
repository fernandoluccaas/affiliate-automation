# Integrations

## Marketplaces

Shopee and Mercado Livre connectors must use officially permitted APIs, exports or partner mechanisms. The system must not automate marketplace logins, bypass CAPTCHA or perform authenticated scraping without express authorization.

Marketplace connectors should emit only confirmed facts. The minimum candidate fields are `marketplace`, `externalProductId`, `title`, `productUrl` and `currentPrice`. Enrichment fields such as description, category, image, original price, coupon, affiliate URL, commission, rating, sales count and shipping certainty are optional. Unknown shipping must be normalized as `UNKNOWN`, not `NOT_FREE`.

If a connector cannot provide an affiliate URL yet, ingestion may persist a valid candidate as `READY_FOR_AFFILIATE_LINK`. The worker publishes only `READY_TO_PUBLISH` offers, so missing affiliate URLs are enrichment blockers rather than ingestion blockers.

## Mercado Livre

Phase 3A implements Mercado Livre through official HTTP APIs only:

- OAuth authorization from `/integracoes`.
- Callback at `/api/integrations/mercadolivre/callback` with state/CSRF validation.
- Token exchange and refresh through `https://api.mercadolibre.com/oauth/token`.
- Category lookup through `/categories/{categoryId}`.
- Best sellers/highlights through `/highlights/{siteId}/category/{categoryId}`.
- Catalog product lookup through `/products/{productId}` when highlights return `PRODUCT`.
- Item multiget through `/items?ids=...`.
- Official item prices through `/items/{ITEM_ID}/prices`.
- Manual category-search probe through `/sites/{siteId}/search?category={categoryId}&limit={limit}`.

Required server variables:

```env
MERCADO_LIVRE_CLIENT_ID=""
MERCADO_LIVRE_CLIENT_SECRET=""
MERCADO_LIVRE_REDIRECT_URI="http://localhost:3000/api/integrations/mercadolivre/callback"
MERCADO_LIVRE_SITE_ID="MLB"
```

Tokens are stored in `MarketplaceAccount` as encrypted access and refresh tokens. Refresh uses a Redis lock and treats `refresh_token` as rotating. A process that loses the lock waits briefly for the database token to change and never silently returns the old expired token. Definitive authentication failures (`invalid_grant`, invalid refresh token and authentication-related 401/403) set `REAUTH_REQUIRED`. Transient 429, 5xx, timeout and network failures keep `CONNECTED` and update only operational error fields.

Discovery is configured in `/integracoes/mercado-livre`. Dashboard and worker use the same `MercadoLivreDiscoveryService`; the former duplicated `collectMercadoLivreCandidates` implementations were removed. Category IDs are selected by the operator; the system does not hardcode categories or import the complete category tree. Highlights preserve the Mercado Livre `content[].type`: `ITEM`, `PRODUCT` and `USER_PRODUCT` are not treated as interchangeable IDs. `ITEM` resolves directly to an item with `HIGHLIGHT_ITEM_DIRECT`. `PRODUCT` may represent a catalog parent rather than a purchasable listing; the resolver loads the catalog product, follows `children_ids` with a visited set, depth limit and inspected-product limit, then selects a representative terminal child with `buy_box_winner.item_id` when available. Selection prefers active products, terminal products, higher `sold_quantity`, lower buy-box price and finally stable product ID order. This is a deterministic discovery heuristic for choosing a candidate variant; it is not an assertion that the selected child caused the aggregate parent ranking.

A `PRODUCT` with `buy_box_winner: null` is not automatically an error. If it has children, the resolver attempts child resolution first. When no direct or child winner is usable, it calls the official `GET /products/{PRODUCT_ID}/items`, eliminates entries from another site, used or inactive listings, entries without a marketplace channel and entries without a positive price, and then loads the normal item details and prices. Selection is deterministic: stock, free shipping, official store, seller reputation, lowest final price, available quantity and stable item ID. Success is recorded as `PRODUCT_ITEMS_FALLBACK`; empty, unusable and API-error responses have separate skip reasons. The system never fabricates an item ID. After resolution, the worker deduplicates by final `resolvedItemId`, fetches item details and official prices, normalizes only available facts and passes candidates into `ingestOffer`.

`/products/{PRODUCT_ID}/items` is parsed as a sparse catalog summary, not as a
complete Item. Before hydration, only a valid MLB item ID and explicitly
invalid summary facts are considered; omitted status, condition, price,
quantity and channels remain neutral. The deduplicated IDs are then hydrated
with bounded `/items?ids=...` calls. Both HTTP/row status 200 and 206 are
usable, and a failed row does not cancel its siblings. Full commercial filters
run only after hydration, with Price API, Item price and summary price used in
that order.

Product diagnostics distinguish an empty result, schema mismatch, hydration
failure and hydrated-but-unusable items. They store counts, rejection reasons
and at most three sanitized field-presence samples; raw responses, OAuth
headers and affiliate-session secrets are never stored.

The Mercado Livre integration page also offers a read-only **Diagnosticar
PRODUCT** probe. It calls the official product and product-items resources,
hydrates parsed ITEM IDs, and displays counts, rejection reasons and at most
three sanitized samples. The probe does not generate an affiliate link, ingest
an offer, create an import job or otherwise mutate application data.

A catalog PRODUCT URL is resolved centrally. A valid HTTPS `permalink` returned
by the official `GET /products/{PRODUCT_ID}` response has precedence and is
marked `API_PERMALINK`. When it is absent, an active MLB catalog PRODUCT whose
ID matches the strict `MLB`-plus-digits format uses the fixed canonical route
`https://www.mercadolivre.com.br/p/{PRODUCT_ID}`, marked
`CANONICAL_CATALOG_PDP`. This rule does not accept user hosts, arbitrary IDs,
ITEM-style URLs, seller IDs or generated slugs.

`PRODUCT_CATALOG_CANONICAL_PDP` keeps the catalog PRODUCT ID as the marketplace
identity and uses the deterministically selected product-item summary for
commercial facts such as price, seller and shipping. ITEM detail hydration is
optional enrichment; a per-item 401/403 is recorded as
`DETAIL_ENRICHMENT_UNAVAILABLE` without invalidating an otherwise eligible
catalog PRODUCT. When enrichment exists, its proven Price API/item facts take
precedence over summary facts. The selected ITEM and seller are retained in
import metadata, while offer fingerprinting remains based on material price,
link, shipping and stock facts rather than seller/ranking churn.

The PRODUCT diagnostic shows the sanitized PDP status/name, safe permalink,
resolved catalog URL and source, picture count, selected summary facts, ITEM
hydration availability and resolution eligibility. Its optional affiliate test
submits either the safe API permalink or the strictly derived canonical MLB PDP
to the existing server-side provider. It does not ingest data or create
Product, Offer or ImportJob records, and its browser-visible result is limited
to PRODUCT ID, URL source, endpoint mode, result host and whether the result
uses `https://meli.la/`.

Discovery metrics distinguish canonical candidates/resolutions, affiliate-link
requests/generations/failures and optional detail enrichment failures. A
successful canonical flow remains `SUCCEEDED` when ITEM detail hydration alone
returns 401/403. ImportJobItem metadata records the URL source, resolution
strategy, selected commercial ITEM and seller, and affiliate-link status.

`bestSellersEnabled=true` enables the highlights source. When it is false, discovery returns `DISCOVERY_SOURCE_DISABLED` and does not call highlights. No automatic category-search fallback exists yet.

The manual category-search probe is available only for a validated leaf category and remains `EXPERIMENTAL`. It reports the logical endpoint and parameters, authentication mode, HTTP status, total results, usable item IDs and up to five ID/title samples. Non-2xx responses preserve only the sanitized Mercado Livre fields `error`, `code`, `message`, `cause` and `blocked_by`. Authorization headers, access tokens, refresh tokens and client secrets are never included in the result or logs.

The probe first makes an authenticated request. If it fails, the probe can make the same request without `Authorization` and reports the two attempts separately. A successful authenticated attempt may short-circuit the public comparison. This public request exists only to diagnose endpoint behavior; it does not change the connector's authenticated production requests.

The probe does not call `ingestOffer`, does not create Product, Offer or Publication records and does not change a `CONNECTED` account after a 403. Category search is still not an automatic discovery source or fallback. Its real behavior depends on the permissions and policies Mercado Livre makes available to the application.

Discovery applies zero-valued policies explicitly. `minimumDiscountPercentage=0` means no discount requirement, including when the API did not provide an original price. A positive minimum requires a provable discount. `minimumScore=0` is passed as zero to ingestion and saved in `Offer.minimumScoreApplied`, so adding an affiliate URL later uses the same policy.

Shared discovery metrics are:

- category processing/highlight availability and skip reasons;
- highlight type and Product tree-resolution counts;
- resolved, unresolved and unique candidates;
- `itemsFetched`, `priceApiFetched`, `priceFallbackUsed` and `priceUnavailable`;
- new Products, new Offer versions, reused Offers, affiliate-link-ready Offers, rejections and errors.

Price fallback from the item payload never increments `priceApiFetched`. `SUCCEEDED`, `PARTIAL`, `FAILED` and `SKIPPED` are explicit service outcomes, and the dashboard maps them to different messages.

Affiliate link generation is intentionally manual. Offers that are valid but do not have `affiliateUrl` become `READY_FOR_AFFILIATE_LINK`. Use `/ofertas/affiliate-links` to paste the official affiliate URL and optional label generated by Mercado Livre tools. Mercado Livre uses `DIRECT_AFFILIATE_LINK`; the worker does not generate or use `/go/[slug]` for these offers.

Affiliate URLs must be valid HTTPS URLs and cannot target localhost or private IP ranges. A Mercado Livre-specific domain allowlist is intentionally deferred until links generated by the real affiliate portal have been validated.

Operational alert codes:

- `MELI_AUTH_EXPIRED`
- `MELI_REFRESH_FAILED`
- `MELI_RATE_LIMIT`
- `MELI_API_UNAVAILABLE`
- `MELI_INVALID_RESPONSE`

## Publishers

The publication layer uses a `PublisherAdapter` contract with:

- `validateCredentials`
- `publish`
- `getPublicationStatus`
- `retry`
- `healthCheck`

Prepared adapters:

- `TelegramPublisher` uses the official Telegram Bot API. It sends an image when `imageUrl` is valid and falls back to text when image delivery fails.
- `ManualExportPublisher` stores the generated message as `EXPORTED` and never marks it as an external publication.
- WhatsApp Cloud API and WhatsApp Groups API appear as unavailable channel types in Phase 2B. They do not simulate publication.

## Telegram Setup

Set these variables on the server:

```env
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""
```

Then create a `TELEGRAM` channel in `/canais` and use `Testar Telegram`. The bot token is never stored in client-visible code or logs. Telegram responses are sanitized to keep only status, description and message ID.

## Redis

Production uses Upstash Redis:

```env
UPSTASH_REDIS_REST_URL=""
UPSTASH_REDIS_REST_TOKEN=""
```

Local development uses the Redis container from Docker Compose:

```env
REDIS_URL="redis://localhost:6379"
```

`/api/health` pings whichever Redis configuration is active. When neither is configured, Redis is reported as unavailable without breaking the dashboard.

## AI Copywriter

The AI copywriter is multi-provider. Ollama is the default local provider and OpenAI is optional.

### Ollama

Configure Ollama for local generation:

```env
AI_PROVIDER="ollama"
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_MODEL="qwen3:4b"
AI_COPY_ENABLED="true"
AI_COPY_TIMEOUT_MS="30000"
```

Prepare the default model:

```powershell
ollama pull qwen3:4b
ollama run qwen3:4b
```

The application calls the local Ollama HTTP API at `OLLAMA_BASE_URL` and uses `/api/generate` with `stream: false` and a JSON schema in `format`. It never executes the `ollama` binary or controls a terminal. Running models locally does not create token billing, although local hardware and any cloud infrastructure still have their own costs.

`/integracoes` shows whether Ollama is configured, whether the HTTP service is available, the sanitized base URL, selected model and status. Ollama offline is treated as an integration status, not as an application health failure.

### OpenAI

OpenAI remains available only when explicitly selected:

```env
AI_PROVIDER="openai"
OPENAI_API_KEY=""
OPENAI_MODEL="gpt-4.1-mini"
AI_COPY_TIMEOUT_MS="30000"
```

When `AI_PROVIDER="ollama"`, no OpenAI key is required and no OpenAI provider is selected.

### Structured Copy

Both providers use structured JSON output:

- `headline`
- `body`
- `callToAction`
- `disclosure`
- `hashtags`

The worker sends only confirmed offer facts and the generated tracking URL. Deterministic post-validation rejects inconsistent prices, discounts, coupon claims, free-shipping claims, missing affiliate disclosure, extra URLs and unsupported urgency. Any failure uses the deterministic composer and records `DETERMINISTIC_FALLBACK` on `Publication`.

`/integracoes` can test Ollama or OpenAI server-side without publishing a message. Secrets are never returned to the browser.
