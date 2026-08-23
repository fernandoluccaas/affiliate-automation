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
npm run shopee:publication:create -- --confirm-create-publication
```

`status`, `preview`, and `--help` perform no external requests. Without the
confirmation flag, creation performs no writes. None of these commands
dispatches Telegram or WhatsApp.

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

`npm run shopee:ranking:preview` reads the current Shopee Offer versions and
their persisted tracking counts, returns the complete score breakdown, and
performs zero writes or external requests.
