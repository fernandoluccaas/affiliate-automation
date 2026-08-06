ALTER TYPE "ImportJobStatus" ADD VALUE IF NOT EXISTS 'DUPLICATE';
ALTER TYPE "ImportJobItemStage" ADD VALUE IF NOT EXISTS 'PARSING';
ALTER TYPE "ImportJobItemStage" ADD VALUE IF NOT EXISTS 'VALIDATION';
ALTER TYPE "ImportJobItemStage" ADD VALUE IF NOT EXISTS 'ATTRIBUTION';
ALTER TYPE "ImportJobItemStage" ADD VALUE IF NOT EXISTS 'PERSISTENCE';

CREATE TYPE "AttributionStatus" AS ENUM (
  'ATTRIBUTED_EXACT',
  'ATTRIBUTED_BY_SUB_ID',
  'ATTRIBUTED_LAST_CLICK',
  'UNATTRIBUTED_NO_CLICK',
  'UNATTRIBUTED_AMBIGUOUS',
  'REJECTED_INVALID_DATA'
);
CREATE TYPE "AttributionMethod" AS ENUM (
  'EXTERNAL_CLICK_ID',
  'SUB_ID',
  'AFFILIATE_LINK',
  'PUBLICATION',
  'OFFER',
  'LAST_CLICK',
  'NONE'
);
CREATE TYPE "AttributionMatchQuality" AS ENUM (
  'EXACT',
  'DETERMINISTIC',
  'UNIQUE_CANDIDATE',
  'NONE',
  'AMBIGUOUS'
);

ALTER TABLE "Click"
  ADD COLUMN "fingerprintHash" TEXT,
  ADD COLUMN "fingerprintWindowStart" TIMESTAMP(3),
  ADD COLUMN "refererHost" TEXT,
  ADD COLUMN "userAgentCategory" TEXT;

ALTER TABLE "Conversion"
  ADD COLUMN "externalEventId" TEXT,
  ADD COLUMN "externalItemId" TEXT,
  ADD COLUMN "clickId" TEXT,
  ADD COLUMN "affiliateLinkId" TEXT,
  ADD COLUMN "channelId" TEXT,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "attributionStatus" "AttributionStatus",
  ADD COLUMN "attributionMethod" "AttributionMethod",
  ADD COLUMN "attributionMatchQuality" "AttributionMatchQuality",
  ADD COLUMN "attributedAt" TIMESTAMP(3),
  ADD COLUMN "attributionWindowHours" INTEGER,
  ADD COLUMN "externalSubId" TEXT,
  ADD COLUMN "attributionMetadata" JSONB;

ALTER TABLE "Commission"
  ADD COLUMN "externalEventId" TEXT,
  ADD COLUMN "externalOrderId" TEXT,
  ADD COLUMN "externalItemId" TEXT,
  ADD COLUMN "channelId" TEXT,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "metadata" JSONB;

ALTER TABLE "ImportJob"
  ADD COLUMN "importType" TEXT,
  ADD COLUMN "fileChecksum" TEXT,
  ADD COLUMN "adapterVersion" TEXT;
ALTER TABLE "ImportJobItem"
  ADD COLUMN "conversionId" TEXT,
  ADD COLUMN "commissionId" TEXT;

CREATE TABLE "TrackingDailyMetric" (
  "id" TEXT NOT NULL,
  "day" TIMESTAMP(3) NOT NULL,
  "marketplace" "Marketplace" NOT NULL,
  "redirects" INTEGER NOT NULL DEFAULT 0,
  "clicksPersisted" INTEGER NOT NULL DEFAULT 0,
  "clicksDeduplicated" INTEGER NOT NULL DEFAULT 0,
  "clicksRateLimited" INTEGER NOT NULL DEFAULT 0,
  "trackingDegraded" INTEGER NOT NULL DEFAULT 0,
  "destinationsBlocked" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TrackingDailyMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Click_affiliateLinkId_fingerprintHash_fingerprintWindowStart_key"
  ON "Click"("affiliateLinkId", "fingerprintHash", "fingerprintWindowStart");
CREATE INDEX "Click_channelId_createdAt_idx" ON "Click"("channelId", "createdAt");
CREATE INDEX "Click_affiliateLinkId_createdAt_idx" ON "Click"("affiliateLinkId", "createdAt");
CREATE INDEX "Click_fingerprintHash_fingerprintWindowStart_idx" ON "Click"("fingerprintHash", "fingerprintWindowStart");

CREATE UNIQUE INDEX "Conversion_marketplace_externalEventId_key" ON "Conversion"("marketplace", "externalEventId");
CREATE INDEX "Conversion_marketplace_externalOrderId_idx" ON "Conversion"("marketplace", "externalOrderId");
CREATE INDEX "Conversion_clickId_idx" ON "Conversion"("clickId");
CREATE INDEX "Conversion_affiliateLinkId_idx" ON "Conversion"("affiliateLinkId");
CREATE INDEX "Conversion_publicationId_idx" ON "Conversion"("publicationId");
CREATE INDEX "Conversion_channelId_idx" ON "Conversion"("channelId");
CREATE INDEX "Conversion_offerId_idx" ON "Conversion"("offerId");
CREATE INDEX "Conversion_attributionStatus_occurredAt_idx" ON "Conversion"("attributionStatus", "occurredAt");

CREATE UNIQUE INDEX "Commission_marketplace_externalEventId_key" ON "Commission"("marketplace", "externalEventId");
CREATE INDEX "Commission_marketplace_externalOrderId_idx" ON "Commission"("marketplace", "externalOrderId");
CREATE INDEX "Commission_marketplace_status_occurredAt_idx" ON "Commission"("marketplace", "status", "occurredAt");
CREATE INDEX "Commission_conversionId_idx" ON "Commission"("conversionId");
CREATE INDEX "Commission_publicationId_idx" ON "Commission"("publicationId");
CREATE INDEX "Commission_channelId_idx" ON "Commission"("channelId");
CREATE INDEX "Commission_offerId_idx" ON "Commission"("offerId");

CREATE UNIQUE INDEX "TrackingDailyMetric_day_marketplace_key" ON "TrackingDailyMetric"("day", "marketplace");
CREATE INDEX "TrackingDailyMetric_marketplace_day_idx" ON "TrackingDailyMetric"("marketplace", "day");
CREATE INDEX "ImportJob_marketplace_importType_fileChecksum_idx" ON "ImportJob"("marketplace", "importType", "fileChecksum");
CREATE INDEX "ImportJobItem_conversionId_idx" ON "ImportJobItem"("conversionId");
CREATE INDEX "ImportJobItem_commissionId_idx" ON "ImportJobItem"("commissionId");

ALTER TABLE "Click" ADD CONSTRAINT "Click_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_clickId_fkey"
  FOREIGN KEY ("clickId") REFERENCES "Click"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_affiliateLinkId_fkey"
  FOREIGN KEY ("affiliateLinkId") REFERENCES "AffiliateLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportJobItem" ADD CONSTRAINT "ImportJobItem_conversionId_fkey"
  FOREIGN KEY ("conversionId") REFERENCES "Conversion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ImportJobItem" ADD CONSTRAINT "ImportJobItem_commissionId_fkey"
  FOREIGN KEY ("commissionId") REFERENCES "Commission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
