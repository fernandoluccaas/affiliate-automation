# Database Design

PostgreSQL is the source of truth. Prisma owns schema evolution.

## Core Entities

- `User`: dashboard users with password hashes and roles.
- `MarketplaceAccount`: encrypted marketplace credentials and capability metadata.
- `Channel`: publication destination and scheduling policy.
- `Product`: normalized marketplace product identity.
- `Offer`: validated commercial offer facts and lifecycle status.
- `Coupon`: coupon details associated with offers.
- `AffiliateLink`: internal tracking slug and original affiliate URL.
- `OfferScore`: auditable scoring components.
- `Publication` and `PublicationAttempt`: scheduling, publishing and retry history.
- `Click`, `Conversion`, `Commission`: attribution and revenue measurement.
- `ImportJob`, `AutomationRun`, `SystemAlert`, `SystemSetting`: operations and observability.

## Monetary Values

Monetary and percentage values use Prisma `Decimal`. Discount percentage is calculated internally from original and current prices and is not accepted from AI output.

## Duplicate Controls

`Product` has the marketplace identity constraint on `(marketplace, externalProductId)`. `Offer` is versioned per Product with unique constraints on `(productId, version)` and `(productId, offerFingerprint)`. `AffiliateLink.slug` is unique and belongs to one Offer version. Phase 2A also rejects manual offers with the same marketplace and URL when the external product ID is different.

## Product, Offer And Publication

`Product` is identity. It can update current product metadata without rewriting historical publications.

`Offer` is a commercial snapshot/version. `offerFingerprint` is a SHA-256 hash over normalized material condition fields:

- `productId`
- `originalPrice` with two decimal places
- `currentPrice` with two decimal places
- normalized `couponCode`
- UTC `couponExpiration`
- normalized `affiliateUrl`
- `freeShipping`
- `stockStatus`

`collectedAt`, `createdAt`, `updatedAt`, score and operational status are not part of the fingerprint.

The first Offer for a Product is `version = 1`. A new material condition for the same Product receives the next version. A published Offer, exported Offer or any Offer with a `Publication` is treated as historical and is not overwritten by later ingestion.

`Publication` is an immutable historical snapshot. At scheduling time it stores `offerTitleSnapshot`, `productExternalIdSnapshot`, `marketplaceSnapshot`, `categorySnapshot`, price snapshots, coupon snapshots, `freeShippingSnapshot`, `affiliateUrlSnapshot`, `trackingUrlSnapshot` and `offerVersionSnapshot`. `/publicacoes` reads these fields to show what was actually sent.

Backfill for old rows uses the best deterministic data available at migration time. For historical rows already semantically mixed before the migration, the system does not invent missing facts or use AI reconstruction. The title snapshot can be extracted from the saved message when the first message line is deterministic; other fields fall back to the then-current related Offer.

## Offer Lifecycle

Offers default to `PENDING_VALIDATION`. The manual ingestion service then sets one final deterministic status:

- `READY_TO_PUBLISH`: valid facts and score greater than or equal to the minimum score.
- `REJECTED_INVALID_DATA`: schema, price, image or stock facts fail deterministic validation.
- `REJECTED_EXPIRED`: coupon expiration is in the past.
- `REJECTED_DUPLICATE`: duplicate URL in the same marketplace.
- `REJECTED_LOW_SCORE`: valid facts with score below the minimum.

`Offer.statusReason` stores the deterministic reason shown in the operational panel. `OfferScore` keeps each scoring component and the weights used for auditability.

## Channel Configuration

`Channel` stores publication policy:

- `timezone`, `allowedStartTime`, `allowedEndTime`
- `dailyPublicationLimit`
- `minimumIntervalMinutes`
- `minimumScore`
- `minDiscountPercentage`
- `productRepeatIntervalDays`
- `allowedMarketplaces`
- `allowedCategories`
- `configuration` for server-side non-client channel settings

Phase 2B supports functional `TELEGRAM` and `MANUAL_EXPORT` channels. WhatsApp API channel types are present but unavailable until a future official integration phase.

## Publication And Tracking

`Publication.idempotencyKey` is unique and uses `publication:{channelId}:{offerId}` to prevent duplicate scheduling. Redis locks use the same channel/offer pair while the worker schedules or publishes.

Publication statuses:

- `SCHEDULED`: ready for the worker.
- `PUBLISHED`: sent through an external channel such as Telegram.
- `EXPORTED`: generated for manual export only.
- `FAILED`: retryable failure.
- `PUBLICATION_FAILED`: definitive failure after configured attempts.

`PublicationAttempt` stores every attempt with sanitized request/response payloads and no secrets. `AffiliateLink.active` controls whether `/go/[slug]` can redirect. `Click` stores referer and user agent, but never raw IP.

## AI Message Metadata

Phase 2C stores copy-generation metadata directly on `Publication`:

- `messageSource`: `AI_GENERATED` or `DETERMINISTIC_FALLBACK`.
- `aiProvider`: `OLLAMA`, `OPENAI` or `DETERMINISTIC`.
- `aiModel`: configured provider model used for the attempt.
- `aiGenerationDurationMs`: elapsed generation time when available.
- `aiValidationPassed`: whether the generated AI copy passed deterministic checks.
- `aiValidationReasons`: JSON list of validation or fallback reasons.
- `generatedAt`: timestamp when message generation ran.

The published/exported text remains in `messagePayload`. These fields do not store prompts, API keys or raw provider responses.
