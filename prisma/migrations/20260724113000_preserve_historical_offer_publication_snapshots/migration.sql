CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "Offer"
  ADD COLUMN "version" INTEGER,
  ADD COLUMN "offerFingerprint" TEXT;

WITH versioned AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE("productId", "id")
      ORDER BY "collectedAt" ASC, "createdAt" ASC, "id" ASC
    ) AS "version"
  FROM "Offer"
)
UPDATE "Offer" AS offer
SET "version" = versioned."version"
FROM versioned
WHERE offer."id" = versioned."id";

UPDATE "Offer"
SET "offerFingerprint" = encode(
  digest(
    concat_ws(
      '|',
      COALESCE("productId", ''),
      to_char("originalPrice", 'FM999999999999990.00'),
      to_char("currentPrice", 'FM999999999999990.00'),
      lower(trim(COALESCE("couponCode", ''))),
      COALESCE(to_char(("couponExpiration" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
      lower(regexp_replace(regexp_replace(trim(COALESCE("affiliateUrl", '')), '#.*$', ''), '/+$', '')),
      CASE WHEN "freeShipping" THEN 'true' ELSE 'false' END,
      "stockStatus"::text
    ),
    'sha256'
  ),
  'hex'
);

ALTER TABLE "Offer"
  ALTER COLUMN "version" SET NOT NULL,
  ALTER COLUMN "version" SET DEFAULT 1,
  ALTER COLUMN "offerFingerprint" SET NOT NULL;

DROP INDEX IF EXISTS "Offer_marketplace_externalProductId_key";

CREATE UNIQUE INDEX "Offer_productId_version_key" ON "Offer"("productId", "version");
CREATE UNIQUE INDEX "Offer_productId_offerFingerprint_key" ON "Offer"("productId", "offerFingerprint");
CREATE INDEX "Offer_marketplace_externalProductId_idx" ON "Offer"("marketplace", "externalProductId");

ALTER TABLE "Publication"
  ADD COLUMN "offerTitleSnapshot" TEXT,
  ADD COLUMN "productExternalIdSnapshot" TEXT,
  ADD COLUMN "marketplaceSnapshot" "Marketplace",
  ADD COLUMN "categorySnapshot" TEXT,
  ADD COLUMN "originalPriceSnapshot" DECIMAL(12, 2),
  ADD COLUMN "currentPriceSnapshot" DECIMAL(12, 2),
  ADD COLUMN "discountPercentageSnapshot" DECIMAL(5, 2),
  ADD COLUMN "couponCodeSnapshot" TEXT,
  ADD COLUMN "couponExpirationSnapshot" TIMESTAMP(3),
  ADD COLUMN "freeShippingSnapshot" BOOLEAN,
  ADD COLUMN "affiliateUrlSnapshot" TEXT,
  ADD COLUMN "trackingUrlSnapshot" TEXT,
  ADD COLUMN "offerVersionSnapshot" INTEGER;

WITH snapshot AS (
  SELECT
    publication."id" AS "publicationId",
    NULLIF(
      trim(
        regexp_replace(
          regexp_replace(
            split_part(COALESCE(publication."messagePayload"->>'message', ''), E'\n', 1),
            '^(🔥|ðŸ”¥)\s*',
            ''
          ),
          '^[^[:alnum:]]+',
          ''
        )
      ),
      ''
    ) AS "messageTitle",
    offer."title",
    offer."externalProductId",
    offer."marketplace",
    offer."category",
    offer."originalPrice",
    offer."currentPrice",
    offer."discountPercentage",
    offer."couponCode",
    offer."couponExpiration",
    offer."freeShipping",
    offer."affiliateUrl",
    offer."version",
    publication."messagePayload"->>'trackingUrl' AS "trackingUrl"
  FROM "Publication" AS publication
  INNER JOIN "Offer" AS offer ON offer."id" = publication."offerId"
)
UPDATE "Publication" AS publication
SET
  "offerTitleSnapshot" = COALESCE(snapshot."messageTitle", snapshot."title"),
  "productExternalIdSnapshot" = snapshot."externalProductId",
  "marketplaceSnapshot" = snapshot."marketplace",
  "categorySnapshot" = snapshot."category",
  "originalPriceSnapshot" = snapshot."originalPrice",
  "currentPriceSnapshot" = snapshot."currentPrice",
  "discountPercentageSnapshot" = snapshot."discountPercentage",
  "couponCodeSnapshot" = snapshot."couponCode",
  "couponExpirationSnapshot" = snapshot."couponExpiration",
  "freeShippingSnapshot" = snapshot."freeShipping",
  "affiliateUrlSnapshot" = snapshot."affiliateUrl",
  "trackingUrlSnapshot" = COALESCE(snapshot."trackingUrl", ''),
  "offerVersionSnapshot" = snapshot."version"
FROM snapshot
WHERE publication."id" = snapshot."publicationId";

ALTER TABLE "Publication"
  ALTER COLUMN "offerTitleSnapshot" SET NOT NULL,
  ALTER COLUMN "productExternalIdSnapshot" SET NOT NULL,
  ALTER COLUMN "marketplaceSnapshot" SET NOT NULL,
  ALTER COLUMN "originalPriceSnapshot" SET NOT NULL,
  ALTER COLUMN "currentPriceSnapshot" SET NOT NULL,
  ALTER COLUMN "discountPercentageSnapshot" SET NOT NULL,
  ALTER COLUMN "freeShippingSnapshot" SET NOT NULL,
  ALTER COLUMN "trackingUrlSnapshot" SET NOT NULL,
  ALTER COLUMN "offerVersionSnapshot" SET NOT NULL;
