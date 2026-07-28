-- Preserve ranking/source facts at publication time even when the operational
-- Offer ranking is refreshed without creating a new offer version.
ALTER TABLE "Publication"
  ADD COLUMN "sourceCategoryIdSnapshot" TEXT,
  ADD COLUMN "bestSellerPositionSnapshot" INTEGER,
  ADD COLUMN "sourceHighlightIdSnapshot" TEXT,
  ADD COLUMN "sourceHighlightTypeSnapshot" TEXT,
  ADD COLUMN "resolutionStrategySnapshot" TEXT;

-- Supports the dashboard's latest-import query when no category filter is
-- applied.
CREATE INDEX "ImportJob_marketplace_createdAt_idx"
  ON "ImportJob"("marketplace", "createdAt");
