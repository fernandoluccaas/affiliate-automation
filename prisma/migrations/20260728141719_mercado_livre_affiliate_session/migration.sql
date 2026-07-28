-- CreateEnum
CREATE TYPE "MercadoLivreAffiliateSessionStatus" AS ENUM ('NOT_CONFIGURED', 'VALIDATING', 'CONNECTED', 'EXPIRED', 'ERROR');

-- CreateTable
CREATE TABLE "MercadoLivreAffiliateSession" (
    "id" TEXT NOT NULL,
    "marketplaceAccountId" TEXT NOT NULL,
    "sampleAffiliateLink" TEXT,
    "affiliateTag" TEXT,
    "availableTags" JSONB,
    "cookieEncrypted" TEXT,
    "csrfTokenEncrypted" TEXT,
    "status" "MercadoLivreAffiliateSessionStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "lastValidatedAt" TIMESTAMP(3),
    "lastCookieUpdateAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MercadoLivreAffiliateSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MercadoLivreAffiliateSession_marketplaceAccountId_key" ON "MercadoLivreAffiliateSession"("marketplaceAccountId");

-- AddForeignKey
ALTER TABLE "MercadoLivreAffiliateSession" ADD CONSTRAINT "MercadoLivreAffiliateSession_marketplaceAccountId_fkey" FOREIGN KEY ("marketplaceAccountId") REFERENCES "MarketplaceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
