# Tracking, attribution and financial reports

## Scope and safety model

This phase adds a local foundation for click tracking, deterministic attribution,
manual conversion and commission reports, and read-only analytics. It does not
call Mercado Livre or Shopee, publish messages, or change a `Publication`.
Confirmed financial imports are disabled by default and require both
`ATTRIBUTION_IMPORT_ENABLED=true` and Redis.

The public surface remains limited to `GET /go/[slug]`. Analytics and operational
pages use `AdminShell`, which requires an authenticated administrative session.
There is no public metrics API and no dashboard mutation for imports.

## Previous tracking audit

Before this phase, `/go/[slug]` could fall back from `AffiliateLink.destination`
to an Offer or Product URL, did not validate the destination against a
marketplace allowlist, used a two-second optional Redis lock, and stored complete
user-agent and referer values. The fingerprint used only user-agent and referer.
The route selected the most recent Publication even when one Offer had multiple
eligible Publications. Redis failure did not provide a reliable boundary for
deduplication.

`AffiliateLink` is created by the existing ingestion path only when an Offer has
a valid affiliate URL and internal tracking is selected. Its stable base slug is
derived from sanitized product title, marketplace, and external product ID;
collisions receive the existing deterministic suffix. Existing links and slugs
are not rewritten by this phase.

The existing `Conversion` and `Commission` models had monetary values and basic
Offer/Publication relationships, but no event-level idempotency, normalized
currency, Click/AffiliateLink/Channel attribution, attribution explanation, or
financial-import audit contract. An Offer can have several Publications, so a
redirect no longer guesses one when more than one eligible candidate exists.

## Redirect and destination validation

`validateTrackingDestination` runs without network access and requires an
absolute URL, no embedded credentials, and HTTPS. Exact hosts and legitimate
subdomains are accepted using `host === domain || host.endsWith('.' + domain)`.

The allowlist is deliberately small:

- Mercado Livre: `meli.la`, `mercadolivre.com.br`, `mercadolibre.com`;
- Shopee: `shopee.com.br` and its legitimate subdomains.

The Mercado Livre list is consistent with the existing affiliate URL validator
and connector. The Shopee entries are limited to hosts already represented by
the project; this phase does not claim compatibility with an official Shopee
financial report. Unknown tracking domains stay blocked until documented and
reviewed.

Local HTTP is allowed only outside production when
`TRACKING_ALLOW_LOCAL_HTTP=true`. Same-origin internal redirects additionally
require `TRACKING_ALLOW_INTERNAL_REDIRECT=true` and a valid `APP_BASE_URL`;
`/go/` loops are blocked.

An invalid or inactive destination returns a generic 404. Once a destination is
valid, tracking, Redis, metrics, or database failures do not block its redirect.

## Rate limiting, deduplication and degraded mode

Redis uses an atomic fixed-window Lua operation (`INCR` plus initial `PEXPIRE`).
Defaults are 30 requests per anonymized client per minute and 300 per slug per
minute. Client and slug keys contain only HMAC/hash material. The click dedup
window defaults to 30 seconds and is keyed by AffiliateLink, temporary
fingerprint, and time window.

If Redis is unavailable, the valid redirect continues but the click is not
written and is not queued for retry. This is
`ALLOW_REDIRECT_WITHOUT_TRACKING`: it prevents later duplication while keeping
published links useful. Daily counters record redirects, persisted clicks,
deduplicated clicks, rate-limited clicks, degraded tracking, and blocked
destinations on a best-effort basis.

## Temporary fingerprint and privacy

`TRACKING_FINGERPRINT_SECRET` must contain at least 32 characters. The temporary
fingerprint is HMAC-SHA-256 over a version marker, trusted client address,
normalized/truncated user-agent, slug, and time-window boundary. The raw address
is never returned or persisted. Proxy headers are ignored unless
`TRACKING_TRUST_PROXY_HEADERS=true`; deploy this only behind a trusted proxy that
replaces those headers.

The fingerprint changes between windows and is not a permanent user identifier.
Rotate the secret during a controlled period; rotation intentionally ends
deduplication continuity. Do not reuse `AUTH_SECRET`: authentication and tracking
have different compromise and rotation boundaries.

New clicks store only:

- the temporary fingerprint hash and window start;
- referer hostname, without path, query, fragment, or credentials;
- a coarse user-agent category (`BOT`, `MOBILE`, `TABLET`, `DESKTOP`, `UNKNOWN`);
- the unambiguous business relationships.

Legacy `Click.userAgent`, `Click.referer`, and `Conversion.rawPayload` remain for
schema compatibility but are written as null by the hardened route. No historic
rows are rewritten and no automatic purge is performed.

`TRACKING_CLICK_RETENTION_DAYS` defaults to 180 and currently powers reporting
and policy documentation only. A future purge requires a separate, explicit,
tested phase.

## Attribution

Attribution is deterministic and explainable. The priority is:

1. explicit Click reference;
2. deterministic Sub ID;
3. AffiliateLink slug;
4. Publication reference;
5. Offer/external product reference;
6. last click only when the candidate set contains exactly one click;
7. no attribution.

Multiple equivalent candidates produce `UNATTRIBUTED_AMBIGUOUS`; they are never
silently reduced to the most recent row. Decisions store the method, match
quality, window, time, a reason code, and only boolean/count metadata. Existing
attributed conversions are not automatically reprocessed.

The default window is 168 hours. A canonical conversion row may supply a bounded
explicit window. Changing the environment value affects future imports only.

### Internal Sub ID

`createAttributionSubId` creates a versioned `aa1` value with marketplace code,
HMAC-derived channel and Publication tokens, and a checksum. It contains no
channel name, title, personal data, or complete internal ID. The parser verifies
format and checksum using `ATTRIBUTION_SUB_ID_SECRET`. It is groundwork only:
existing affiliate URLs are not altered, and marketplace-specific Sub IDs must
not be injected until official rules are confirmed.
Canonical rows containing a Sub ID are rejected unless the dedicated secret is
configured and the checksum is valid.

## Conversion and Commission records

Both models preserve `Decimal` monetary fields and now store currency without
performing exchange. Analytics never sums different currencies together.
`marketplace + externalEventId` is unique, which allows multiple item events in
one order while preventing duplicate event ingestion. `externalItemId` supports
multi-item orders. Commission status accepts the canonical import states
`PENDING`, `APPROVED`, `CANCELLED`, `REVERSED`, and `ADJUSTED`; adjustments and
reversals remain distinct events. A commission may be orphaned and a conversion
may have no commission.

## Canonical CSV contract

This branch deliberately does not copy the separate Shopee phase. The Mercado
Livre and generic fixtures implement an internal canonical contract only; they
are not represented as official marketplace exports. The Shopee adapter returns
`WAITING_FOR_OFFICIAL_REPORT` until an official report and column contract are
available.

Supported canonical columns use explicit English and Portuguese aliases:

- required conversions: `externalEventId`, `occurredAt`, `amount`, `currency`;
- optional conversions: `externalOrderId`, `externalItemId`, `clickReference`,
  `subId`, `affiliateSlug`, `publicationReference`, `offerReference`,
  `attributionWindowHours`;
- required commissions: conversion required columns plus `status`;
- optional commissions: `externalOrderId`, `externalItemId`, `percentage`,
  `conversionExternalEventId`, `affiliateSlug`.

Aliases are normalized for camelCase, spaces, underscores, hyphens, case, and
Portuguese accents. Ambiguous aliases and duplicate headers are rejected.
Parsing supports UTF-8/BOM, comma or semicolon, quoted fields, escaped quotes,
ISO timestamps, and explicitly requested Brazilian dates/decimals. It rejects
empty or oversized files, excessive rows, formulas, invalid dates/amounts,
unknown currencies/statuses, unsafe slugs, missing event IDs, and duplicates.
Errors contain line and code only.

All repository fixtures under `packages/tracking/fixtures` are fictitious and
sanitized.

## Safe CLI workflow

Inspect and dry-run are read-only and create no ImportJob:

```text
npm run tracking:status
npm run tracking:preflight
npm run tracking:retention-report
npm run attribution:status
npm run attribution:preflight
npm run conversions:inspect-csv -- --file packages/tracking/fixtures/mercado-livre-conversions-sanitized.csv --marketplace MERCADO_LIVRE
npm run conversions:import-csv -- --file packages/tracking/fixtures/mercado-livre-conversions-sanitized.csv --marketplace MERCADO_LIVRE --dry-run
npm run commissions:inspect-csv -- --file packages/tracking/fixtures/mercado-livre-commissions-sanitized.csv --marketplace MERCADO_LIVRE
npm run commissions:import-csv -- --file packages/tracking/fixtures/mercado-livre-commissions-sanitized.csv --marketplace MERCADO_LIVRE --dry-run
```

Brazilian format requires `--date-format BR --decimal-format BR`. Without
exactly one of `--dry-run` or `--confirm-import`, import exits before inspection
or writes. Confirmed import additionally requires
`ATTRIBUTION_IMPORT_ENABLED=true` and Redis.

Confirmed imports acquire owner-token Redis locks for file checksum and
marketplace/type. Extension and release use atomic Lua checks. The business
records and ImportJobItems are one database transaction. A failure rolls back
business rows and leaves a sanitized failed ImportJob. Repeated files become an
explicit `DUPLICATE` job; repeated event IDs in different files are skipped.
The database never stores the CSV itself.

## Analytics, health and operations

`/resultados` is authenticated and read-only. It has bounded server-side period,
marketplace, and channel filters; shows no fingerprint, raw headers, full order
identifier, raw payload, secret, or affiliate URL. Empty periods render zero/no
data. Revenue and commission values are grouped by currency.

`/operacoes`, `/api/health/ready`, `ops:status`, and `ops:audit-state` report only
sanitized tracking configuration and aggregate findings: Redis/rate-limiter
state, fingerprint-secret boolean, last financial imports, unattributed
conversions, orphan commissions, and abandoned/failed/duplicate jobs.
`/api/health/live` remains process-only.

## Configuration and troubleshooting

Safe placeholders are documented in `.env.example`; `.env` is never modified.
Key controls are `TRACKING_ENABLED`, rate limits, dedup window,
`TRACKING_FINGERPRINT_SECRET`, proxy trust, retention, attribution window,
`ATTRIBUTION_SUB_ID_SECRET`, import limits, and
`ATTRIBUTION_IMPORT_ENABLED`.

- `DEGRADED_MISSING_FINGERPRINT_SECRET`: configure a dedicated 32+ character
  secret; redirects continue and Click writes stop.
- `TRACKING_REDIS_UNAVAILABLE`: restore Redis; redirects continue with no Click
  write or retry.
- `UNATTRIBUTED_AMBIGUOUS`: inspect the sanitized report and source references;
  do not guess.
- `SHOPEE_OFFICIAL_REPORT_NOT_CONFIRMED`: wait for a documented official report
  contract; do not rename columns speculatively.
- `FINANCIAL_IMPORT_LOCK_OWNERSHIP_LOST`: no continued import is permitted;
  inspect Redis/process health before a new explicit attempt.

Set `TRACKING_ENABLED=false` to disable click writes and rate limiting while
preserving validated redirects and aggregate redirect counts. Confirmed imports
remain independently fail-closed.
