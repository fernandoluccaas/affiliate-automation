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
