ALTER TABLE "MercadoLivreDiscoveryConfig"
ADD COLUMN "multiCategoryEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "multiCategorySettings" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "multiCategoryMinOffersPerCategory" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "multiCategoryMaxOffersPerCategory" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN "multiCategoryMaxTotalPerSession" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN "multiCategorySelectionMode" TEXT NOT NULL DEFAULT 'ROUND_ROBIN',
ADD COLUMN "multiCategoryAllowCategoryBackfill" BOOLEAN NOT NULL DEFAULT false;
