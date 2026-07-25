CREATE TYPE "MarketplaceAccountStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'REAUTH_REQUIRED', 'ERROR');
CREATE TYPE "AffiliateEligibility" AS ENUM ('ELIGIBLE', 'INELIGIBLE', 'UNKNOWN');
CREATE TYPE "TrackingStrategy" AS ENUM ('INTERNAL_REDIRECT', 'DIRECT_AFFILIATE_LINK');

ALTER TABLE "MarketplaceAccount"
  ALTER COLUMN "encryptedCredentials" SET DEFAULT '',
  ADD COLUMN "externalUserId" TEXT,
  ADD COLUMN "accessTokenEncrypted" TEXT,
  ADD COLUMN "refreshTokenEncrypted" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "scopes" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "status" "MarketplaceAccountStatus" NOT NULL DEFAULT 'DISCONNECTED',
  ADD COLUMN "siteId" TEXT,
  ADD COLUMN "lastRefreshAt" TIMESTAMP(3),
  ADD COLUMN "lastSyncAt" TIMESTAMP(3),
  ADD COLUMN "lastErrorAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT;

ALTER TABLE "Offer"
  ADD COLUMN "affiliateLabel" TEXT,
  ADD COLUMN "affiliateEligibility" "AffiliateEligibility" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "sellerId" TEXT,
  ADD COLUMN "officialStoreId" TEXT,
  ADD COLUMN "trackingStrategy" "TrackingStrategy" NOT NULL DEFAULT 'INTERNAL_REDIRECT';

UPDATE "Offer"
SET "trackingStrategy" = 'DIRECT_AFFILIATE_LINK'
WHERE "marketplace" = 'MERCADO_LIVRE';

CREATE TABLE "MercadoLivreDiscoveryConfig" (
  "id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "siteId" TEXT NOT NULL DEFAULT 'MLB',
  "categoryIds" JSONB NOT NULL DEFAULT '[]',
  "bestSellersEnabled" BOOLEAN NOT NULL DEFAULT true,
  "minimumPrice" DECIMAL(12, 2),
  "maximumPrice" DECIMAL(12, 2),
  "minimumDiscountPercentage" DECIMAL(5, 2),
  "minimumScore" INTEGER NOT NULL DEFAULT 0,
  "maxCandidatesPerCategory" INTEGER NOT NULL DEFAULT 20,
  "refreshIntervalMinutes" INTEGER NOT NULL DEFAULT 360,
  "lastRunAt" TIMESTAMP(3),
  "lastRunSummary" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MercadoLivreDiscoveryConfig_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MarketplaceAccount_marketplace_status_idx" ON "MarketplaceAccount"("marketplace", "status");
CREATE INDEX "Offer_marketplace_affiliateEligibility_idx" ON "Offer"("marketplace", "affiliateEligibility");
CREATE INDEX "Offer_trackingStrategy_idx" ON "Offer"("trackingStrategy");
