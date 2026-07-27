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

Discovery is configured in `/integracoes/mercado-livre`. Dashboard and worker use the same `MercadoLivreDiscoveryService`; the former duplicated `collectMercadoLivreCandidates` implementations were removed. Category IDs are selected by the operator; the system does not hardcode categories or import the complete category tree. Highlights preserve the Mercado Livre `content[].type`: `ITEM`, `PRODUCT` and `USER_PRODUCT` are not treated as interchangeable IDs. `ITEM` resolves directly to an item. `PRODUCT` may represent a catalog parent rather than a purchasable listing; the resolver loads the catalog product, follows `children_ids` with a visited set, depth limit and inspected-product limit, then selects a representative terminal child with `buy_box_winner.item_id` when available. Selection prefers active products, terminal products, higher `sold_quantity`, lower buy-box price and finally stable product ID order. This is a deterministic discovery heuristic for choosing a candidate variant; it is not an assertion that the selected child caused the aggregate parent ranking.

A `PRODUCT` with `buy_box_winner: null` is not automatically an error. If it has children, the resolver attempts child resolution first. If it is terminal and still lacks a winner, the skip reason is `PRODUCT_LEAF_NO_BUY_BOX_WINNER`. The system never invents an item for a terminal product without a buy-box winner. After resolution, the worker deduplicates by final `resolvedItemId`, fetches item details and official prices, normalizes only available facts and passes candidates into `ingestOffer`.

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
