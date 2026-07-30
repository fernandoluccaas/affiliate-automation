# Promotional messages

Published copy is assembled from two deliberately separate layers:

- **Promo content** contains immutable offer facts: title, marketplace, prices,
  confirmed coupon data, confirmed free shipping and the final affiliate URL.
- **Promo template** selects an allowed marketplace-aware headline and renders
  those facts in a fixed order.

`PromoMessageBuilder` is the only component that assembles the final message.
It never derives prices, coupons, shipping claims or URLs from AI output.

## Default template

The default order is headline, persisted product title, valid original price,
current price, confirmed free shipping, confirmed coupon data and purchase
link. `De:` appears only when the original price is positive and greater than
the current price. Currency uses `pt-BR`. The message ends at the affiliate URL
unless the channel has an explicit custom footer.

The former automatic `#publi - link de afiliado` footer was removed. No
automatic disclosure, hashtag or text is appended after the purchase link.

## Headline rotation

The initial banks contain 10 Mercado Livre headlines, 10 Shopee headlines and
9 generic headlines. A stable seed makes selection reproducible in tests.
Marketplace-specific and generic headlines may be used, but headlines from a
different marketplace are never eligible.

The selector receives the five most recent headlines for a channel and excludes
them while alternatives exist. It also avoids immediately repeating the last
headline. No new database table is required; publication message snapshots
provide the history.

## AI boundary

AI providers may suggest only a headline from the eligible local bank. The
builder always reconstructs the final message from persisted offer facts.
The structured AI response contains only `headline` and an optional short
`optionalHook`; the hook is currently ignored by the fixed template. Prices,
discounts, coupon data, shipping claims and URLs are not sent as mutable
copy fields and cannot be returned in the strict response schema.
Timeouts, unavailable providers and invalid output use the same deterministic
template with a locally selected headline.

The worker reads the five latest publication snapshots for the target channel
before composing a new message. A custom footer is opt-in through
`Channel.configuration.messageFooter` (with `footer` accepted as a
compatibility alias). Without either key, the affiliate URL is the last line.

The publications dashboard continues to preview the immutable message snapshot
already produced by the normal scheduler. A separate pre-scheduling preview was
intentionally deferred because it would require changing the existing
selection/scheduling flow, which is outside this copy-only change.

The builder already accepts separate `couponUrl` and purchase URL values for a
future Shopee flow, but this does not implement Shopee discovery or
authentication.
