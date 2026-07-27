ALTER TABLE "Offer"
ADD COLUMN "minimumScoreApplied" INTEGER;

UPDATE "Offer"
SET "minimumScoreApplied" = COALESCE(
  (
    SELECT "minimumScore"
    FROM "MercadoLivreDiscoveryConfig"
    ORDER BY "updatedAt" DESC
    LIMIT 1
  ),
  70
)
WHERE "marketplace" = 'MERCADO_LIVRE';

UPDATE "Offer"
SET "minimumScoreApplied" = 70
WHERE "minimumScoreApplied" IS NULL;

ALTER TABLE "Offer"
ALTER COLUMN "minimumScoreApplied" SET NOT NULL,
ALTER COLUMN "minimumScoreApplied" SET DEFAULT 70;
