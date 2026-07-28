-- Extend the import lifecycle so a mixed Mercado Livre batch can finish
-- successfully while retaining isolated item failures.
ALTER TYPE "ImportJobStatus" ADD VALUE 'SUCCEEDED_WITH_ERRORS';

CREATE TYPE "ImportJobItemStage" AS ENUM (
  'DISCOVERY',
  'RESOLUTION',
  'AFFILIATE_LINK',
  'INGESTION'
);

CREATE TYPE "ImportJobItemStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'PENDING_AFFILIATE_LINK',
  'INELIGIBLE',
  'FAILED',
  'SKIPPED'
);

-- Ranking is operational discovery metadata. These columns intentionally do
-- not participate in Offer.offerFingerprint.
ALTER TABLE "Offer"
  ADD COLUMN "affiliateFailure" JSONB,
  ADD COLUMN "sourceCategoryId" TEXT,
  ADD COLUMN "bestSellerPosition" INTEGER,
  ADD COLUMN "sourceHighlightId" TEXT,
  ADD COLUMN "sourceHighlightType" TEXT,
  ADD COLUMN "resolutionStrategy" TEXT;

ALTER TABLE "ImportJob"
  ADD COLUMN "categoryId" TEXT,
  ADD COLUMN "totalFound" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalResolved" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalLinksGenerated" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalReadyToPublish" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalPendingAffiliateLink" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalIneligible" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalCreated" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalUpdated" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalFailed" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ImportJobItem" (
  "id" TEXT NOT NULL,
  "importJobId" TEXT NOT NULL,
  "sourceId" TEXT,
  "sourceType" TEXT,
  "position" INTEGER,
  "externalItemId" TEXT,
  "offerId" TEXT,
  "stage" "ImportJobItemStage" NOT NULL,
  "status" "ImportJobItemStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ImportJobItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Offer_marketplace_sourceCategoryId_bestSellerPosition_idx"
  ON "Offer"("marketplace", "sourceCategoryId", "bestSellerPosition");

CREATE INDEX "ImportJob_marketplace_categoryId_createdAt_idx"
  ON "ImportJob"("marketplace", "categoryId", "createdAt");

CREATE INDEX "ImportJob_marketplaceAccountId_createdAt_idx"
  ON "ImportJob"("marketplaceAccountId", "createdAt");

CREATE INDEX "ImportJobItem_importJobId_idx"
  ON "ImportJobItem"("importJobId");

CREATE INDEX "ImportJobItem_importJobId_status_idx"
  ON "ImportJobItem"("importJobId", "status");

CREATE INDEX "ImportJobItem_importJobId_stage_idx"
  ON "ImportJobItem"("importJobId", "stage");

CREATE INDEX "ImportJobItem_offerId_idx"
  ON "ImportJobItem"("offerId");

CREATE INDEX "ImportJobItem_externalItemId_idx"
  ON "ImportJobItem"("externalItemId");

ALTER TABLE "ImportJobItem"
  ADD CONSTRAINT "ImportJobItem_importJobId_fkey"
  FOREIGN KEY ("importJobId") REFERENCES "ImportJob"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ImportJobItem"
  ADD CONSTRAINT "ImportJobItem_offerId_fkey"
  FOREIGN KEY ("offerId") REFERENCES "Offer"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
