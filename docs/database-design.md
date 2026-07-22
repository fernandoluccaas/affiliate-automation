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

`Offer` has a unique constraint on `(marketplace, externalProductId)`. `Product` has the same external identity constraint. `AffiliateLink.slug` is unique. Additional duplicate checks will be layered in validation and publication history rules.
