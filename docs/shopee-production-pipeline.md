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
