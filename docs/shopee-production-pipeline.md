# Shopee production pipeline

## Controlled publication (Phase 6A.7)

Shopee Offers in `READY_TO_PUBLISH` only enter planning when
`SHOPEE_PUBLICATION_ENABLED=true`. The service accepts exclusively an active
`AffiliateLink` whose destination is an official
`https://s.shopee.com.br/...` URL. Messages contain `/go/[slug]`; that redirect
continues to resolve only `AffiliateLink.destination`. There is no fallback to
`productUrl`, a datafeed link, or `Offer.affiliateUrl`.

Preview is read-only. Creation requires explicit confirmation and stores the
Publication as `AWAITING_MANUAL_PUBLICATION`, with
`distributionState=PLANNED`. The normal publisher does not consume that state.
The key `publication:{channelId}:{offerId}` plus the database unique constraint
makes creation idempotent under concurrent planners.

```dotenv
SHOPEE_PUBLICATION_ENABLED="false"
SHOPEE_PUBLICATION_MAX_PER_CYCLE="2"
```

```powershell
npm run shopee:publication:status
npm run shopee:publication:preview
npm run shopee:publication:preview -- --offer-id <Offer.id>
npm run shopee:publication:create -- --confirm-create-publication
npm run shopee:publication:create -- --offer-id <Offer.id> --confirm-create-publication
```

`status`, `preview`, and `--help` perform no external requests. Without the
confirmation flag, creation performs no writes. None of these commands
dispatches Telegram or WhatsApp. `--offer-id` loads only that immutable Offer
ID, verifies that it is the current Shopee version, and never falls through to
another candidate.

## Automated distribution (Phase 6A.8)

The existing worker scheduler includes Shopee only when both publication and
automatic distribution are explicitly enabled. Telegram and WhatsApp have
independent gates. When every channel gate is false, no external message can be
sent. A planned controlled Telegram Publication is promoted to `SCHEDULED`
only after all gates pass; WhatsApp keeps the existing assisted or experimental
queue and its separate authorization rules.

The Shopee policy layers conservative global limits over each Channel policy:
two plans per cycle, twelve per local day, a sixty-minute minimum interval, and
the channel timezone window from 08:00 through 22:00. The existing Publication
idempotency key, retry attempt ceiling, transient backoff, per-channel
selection, and isolated channel errors remain in force. Turning the flag off
also prevents dispatch and retry of already-scheduled Shopee Publications.

```dotenv
SHOPEE_AUTO_DISTRIBUTION_ENABLED="false"
SHOPEE_PUBLICATION_MAX_PER_DAY="12"
SHOPEE_PUBLICATION_MIN_INTERVAL_MINUTES="60"
SHOPEE_PUBLICATION_WINDOW_START="08:00"
SHOPEE_PUBLICATION_WINDOW_END="22:00"
SHOPEE_PUBLICATION_TELEGRAM_ENABLED="false"
SHOPEE_PUBLICATION_WHATSAPP_ENABLED="false"
```

```powershell
npm run shopee:distribution:status
npm run shopee:distribution:preview
```

Both commands are read-only and make no marketplace or messaging request.

## Advanced ranking (Phase 6A.9)

The deterministic ranking keeps the existing data-quality score and adds an
explainable second layer. It uses percentage discount, absolute savings,
current price, source freshness, persisted click/conversion performance, and
commission only when each signal exists. Missing commission or tracking data
stays `null` and its weight is removed from the denominator.

Explicit penalties cover recent product publication, recent seller use,
duplicate similarity, and category/seller concentration. Product cooldown is
conservative enough to reduce a candidate to zero; the existing round-robin
continues selecting one or two offers per logical category, honoring the total
limit and the per-shop cap. Item ID remains the stable final tie-break.

```dotenv
SHOPEE_PRODUCT_COOLDOWN_HOURS="168"
SHOPEE_SELLER_COOLDOWN_HOURS="24"
```

`npm run shopee:ranking:preview` reads only `READY_TO_PUBLISH` Shopee Offers
that are candidates for the production publication pipeline and their
persisted tracking counts. It excludes already published, scheduled, rejected,
and pending-link history, returns the complete score breakdown, and performs
zero writes or external requests.

## Open API enrichment (Phase 6A.10)

Enrichment is disabled by default and is applied only after cheap feed
normalization and preliminary ranking. The shortlist is deduplicated and
capped at 24 items (hard maximum 50), so the 110,000-item catalog is never
expanded into one request per product. The implementation reuses the existing
signed Open API transport, timeout, rate limiter, sanitized error mapping, and
the confirmed `productOfferV2` single-item contract.

Returned price, sales, rating, and commission values are enrichment metadata.
`offerLink` is retained only as metadata: it never creates, replaces, or updates
the canonical `AffiliateLink.destination`; `generateShortLink` remains the only
canonical link path. Missing availability is left unknown rather than inferred.

The per-cycle cache avoids duplicate item calls. Item failures produce a
partial result, while authentication, systemic GraphQL, schema, and rate-limit
failures stop the remaining shortlist without changing persisted offers.

```dotenv
SHOPEE_ENRICHMENT_ENABLED="false"
SHOPEE_ENRICHMENT_MAX_ITEMS="24"
```

`npm run shopee:enrichment:status` and
`npm run shopee:enrichment:preview` are read-only. Preview reports only the
candidate count and bounded estimate; it performs zero Open API calls.

## Freshness, refresh, and expiration (Phase 6A.11)

Immediately before a Shopee channel adapter runs, the worker validates the
canonical AffiliateLink and the newest of `verifiedAt`/`collectedAt`. Fresh
offers proceed without Open API. Stale offers are refreshed with the same
bounded `productOfferV2` client only when refresh and automatic distribution are
explicitly enabled.

An unchanged price refreshes the verification timestamp. A missing product,
missing canonical link, changed price, duplicate Publication, or refresh error
cancels the pending Publication and marks the Offer `REJECTED_EXPIRED` with a
structured reason. The immutable old message is never rewritten or sent; a
commercial change must return through discovery and ingestion to create the
proper Offer version.

The idempotent maintenance command expires stale ready/scheduled Offers and
cancels their pending Publications. It never deletes Offers, Publications,
AffiliateLinks, clicks, or conversion history.

```dotenv
SHOPEE_PUBLICATION_MAX_OFFER_AGE_HOURS="24"
SHOPEE_REFRESH_BEFORE_PUBLICATION="true"
```

```powershell
npm run shopee:freshness:status
npm run shopee:freshness:expire -- --confirm-expire-stale
npm run shopee:freshness:check -- --publication-id <Publication.id> --confirm-refresh
```

Status is read-only and never calls Open API. Maintenance requires the exact
confirmation flag and sends no message. The single-Publication check reuses the
same pre-dispatch freshness service. Without `--confirm-refresh`, it performs
no database read, write, or Open API request. Every production CLI in this
document treats `--help` and `-h` as globally safe flags regardless of their
argument position.
