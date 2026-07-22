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

`Offer` has a unique constraint on `(marketplace, externalProductId)`. `Product` has the same external identity constraint. `AffiliateLink.slug` is unique. Phase 2A also rejects manual offers with the same marketplace and URL when the external product ID is different.

## Offer Lifecycle

Offers default to `PENDING_VALIDATION`. The manual ingestion service then sets one final deterministic status:

- `READY_TO_PUBLISH`: valid facts and score greater than or equal to the minimum score.
- `REJECTED_INVALID_DATA`: schema, price, image or stock facts fail deterministic validation.
- `REJECTED_EXPIRED`: coupon expiration is in the past.
- `REJECTED_DUPLICATE`: duplicate URL in the same marketplace.
- `REJECTED_LOW_SCORE`: valid facts with score below the minimum.

`Offer.statusReason` stores the deterministic reason shown in the operational panel. `OfferScore` keeps each scoring component and the weights used for auditability.
