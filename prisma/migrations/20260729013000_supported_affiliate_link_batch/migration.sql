ALTER TYPE "ImportJobItemStage" ADD VALUE IF NOT EXISTS 'AFFILIATE_LINK_VALIDATION';
ALTER TYPE "ImportJobItemStage" ADD VALUE IF NOT EXISTS 'AFFILIATE_LINK_APPLICATION';

ALTER TABLE "ImportJob"
  RENAME COLUMN "totalPendingAffiliateLink" TO "totalReadyForAffiliateLink";

ALTER TABLE "ImportJob"
  ADD COLUMN "totalInvalidLinks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "totalNotFound" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ImportJobItem"
  ADD COLUMN "productId" TEXT;

ALTER TABLE "ImportJobItem"
  ADD CONSTRAINT "ImportJobItem_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ImportJobItem_productId_idx" ON "ImportJobItem"("productId");
