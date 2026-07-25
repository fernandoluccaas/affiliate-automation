ALTER TYPE "OfferStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_AFFILIATE_LINK';

CREATE TYPE "ShippingStatus" AS ENUM ('FREE', 'NOT_FREE', 'UNKNOWN');

ALTER TABLE "Offer"
  ALTER COLUMN "originalPrice" DROP NOT NULL,
  ALTER COLUMN "discountPercentage" DROP NOT NULL,
  ADD COLUMN "shippingStatus" "ShippingStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "scoreCompletenessPercentage" DECIMAL(5, 2);

UPDATE "Offer"
SET
  "shippingStatus" = CASE
    WHEN "freeShipping" = true THEN 'FREE'::"ShippingStatus"
    ELSE 'NOT_FREE'::"ShippingStatus"
  END,
  "scoreCompletenessPercentage" = 100
WHERE "scoreCompletenessPercentage" IS NULL;

ALTER TABLE "OfferScore"
  ADD COLUMN "completenessPercentage" DECIMAL(5, 2);

UPDATE "OfferScore"
SET "completenessPercentage" = 100
WHERE "completenessPercentage" IS NULL;

ALTER TABLE "Publication"
  ALTER COLUMN "originalPriceSnapshot" DROP NOT NULL,
  ALTER COLUMN "discountPercentageSnapshot" DROP NOT NULL,
  ADD COLUMN "shippingStatusSnapshot" "ShippingStatus" NOT NULL DEFAULT 'UNKNOWN';

UPDATE "Publication"
SET "shippingStatusSnapshot" = CASE
  WHEN "freeShippingSnapshot" = true THEN 'FREE'::"ShippingStatus"
  ELSE 'NOT_FREE'::"ShippingStatus"
END;
