-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "Marketplace" AS ENUM ('SHOPEE', 'MERCADO_LIVRE');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('REJECTED_INVALID_DATA', 'REJECTED_EXPIRED', 'REJECTED_DUPLICATE', 'REJECTED_LOW_SCORE', 'QUARANTINED_INTEGRATION_ERROR', 'READY_TO_PUBLISH', 'SCHEDULED', 'PUBLISHED', 'PUBLICATION_FAILED');

-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('IN_STOCK', 'OUT_OF_STOCK', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('WHATSAPP_CLOUD', 'WHATSAPP_GROUPS', 'MANUAL_EXPORT', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('SCHEDULED', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PublicationAttemptStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceAccount" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedCredentials" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "encryptedCredentials" TEXT,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "dailyLimit" INTEGER NOT NULL DEFAULT 10,
    "minIntervalMinutes" INTEGER NOT NULL DEFAULT 30,
    "allowedHours" JSONB NOT NULL DEFAULT '[]',
    "allowedCategories" JSONB NOT NULL DEFAULT '[]',
    "allowedMarketplaces" JSONB NOT NULL DEFAULT '[]',
    "minScore" INTEGER NOT NULL DEFAULT 70,
    "minPrice" DECIMAL(12,2),
    "maxPrice" DECIMAL(12,2),
    "minDiscountPercentage" DECIMAL(5,2),
    "minRepeatDays" INTEGER NOT NULL DEFAULT 7,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "imageUrl" TEXT,
    "productUrl" TEXT NOT NULL,
    "rating" DECIMAL(3,2),
    "salesCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "productId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "imageUrl" TEXT,
    "productUrl" TEXT NOT NULL,
    "affiliateUrl" TEXT,
    "originalPrice" DECIMAL(12,2) NOT NULL,
    "currentPrice" DECIMAL(12,2) NOT NULL,
    "discountPercentage" DECIMAL(5,2) NOT NULL,
    "couponCode" TEXT,
    "couponExpiration" TIMESTAMP(3),
    "commissionPercentage" DECIMAL(5,2),
    "rating" DECIMAL(3,2),
    "salesCount" INTEGER,
    "freeShipping" BOOLEAN NOT NULL DEFAULT false,
    "stockStatus" "StockStatus" NOT NULL DEFAULT 'UNKNOWN',
    "score" INTEGER,
    "status" "OfferStatus" NOT NULL DEFAULT 'REJECTED_INVALID_DATA',
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discountAmount" DECIMAL(12,2),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateLink" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliateLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferScore" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "total" INTEGER NOT NULL,
    "discountComponent" INTEGER NOT NULL,
    "commissionComponent" INTEGER NOT NULL,
    "ratingComponent" INTEGER NOT NULL,
    "popularityComponent" INTEGER NOT NULL,
    "freeShippingComponent" INTEGER NOT NULL,
    "couponValidityComponent" INTEGER NOT NULL,
    "noveltyComponent" INTEGER NOT NULL,
    "weights" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "externalId" TEXT,
    "messagePayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicationAttempt" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "status" "PublicationAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "errorMessage" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Click" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "affiliateLinkId" TEXT,
    "publicationId" TEXT,
    "channelId" TEXT,
    "marketplace" "Marketplace" NOT NULL,
    "userAgent" TEXT,
    "referer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Click_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversion" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "externalOrderId" TEXT,
    "offerId" TEXT,
    "publicationId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" JSONB,

    CONSTRAINT "Conversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commission" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "offerId" TEXT,
    "publicationId" TEXT,
    "conversionId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "percentage" DECIMAL(5,2),
    "status" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "marketplaceAccountId" TEXT,
    "marketplace" "Marketplace" NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "rawSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "marketplaceAccountId" TEXT,
    "name" TEXT NOT NULL,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "idempotencyKey" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "metrics" JSONB,
    "errorMessage" TEXT,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemAlert" (
    "id" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "MarketplaceAccount_marketplace_enabled_idx" ON "MarketplaceAccount"("marketplace", "enabled");

-- CreateIndex
CREATE INDEX "Channel_type_enabled_idx" ON "Channel"("type", "enabled");

-- CreateIndex
CREATE INDEX "Product_marketplace_category_idx" ON "Product"("marketplace", "category");

-- CreateIndex
CREATE UNIQUE INDEX "Product_marketplace_externalProductId_key" ON "Product"("marketplace", "externalProductId");

-- CreateIndex
CREATE INDEX "Offer_status_score_idx" ON "Offer"("status", "score");

-- CreateIndex
CREATE INDEX "Offer_marketplace_category_idx" ON "Offer"("marketplace", "category");

-- CreateIndex
CREATE INDEX "Offer_scheduledAt_idx" ON "Offer"("scheduledAt");

-- CreateIndex
CREATE INDEX "Offer_publishedAt_idx" ON "Offer"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_marketplace_externalProductId_key" ON "Offer"("marketplace", "externalProductId");

-- CreateIndex
CREATE INDEX "Coupon_code_expiresAt_idx" ON "Coupon"("code", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AffiliateLink_slug_key" ON "AffiliateLink"("slug");

-- CreateIndex
CREATE INDEX "AffiliateLink_offerId_idx" ON "AffiliateLink"("offerId");

-- CreateIndex
CREATE INDEX "AffiliateLink_marketplace_idx" ON "AffiliateLink"("marketplace");

-- CreateIndex
CREATE INDEX "OfferScore_offerId_createdAt_idx" ON "OfferScore"("offerId", "createdAt");

-- CreateIndex
CREATE INDEX "Publication_channelId_scheduledAt_idx" ON "Publication"("channelId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Publication_offerId_status_idx" ON "Publication"("offerId", "status");

-- CreateIndex
CREATE INDEX "PublicationAttempt_publicationId_attemptedAt_idx" ON "PublicationAttempt"("publicationId", "attemptedAt");

-- CreateIndex
CREATE INDEX "Click_offerId_createdAt_idx" ON "Click"("offerId", "createdAt");

-- CreateIndex
CREATE INDEX "Click_publicationId_createdAt_idx" ON "Click"("publicationId", "createdAt");

-- CreateIndex
CREATE INDEX "Click_marketplace_createdAt_idx" ON "Click"("marketplace", "createdAt");

-- CreateIndex
CREATE INDEX "Conversion_marketplace_occurredAt_idx" ON "Conversion"("marketplace", "occurredAt");

-- CreateIndex
CREATE INDEX "Conversion_externalOrderId_idx" ON "Conversion"("externalOrderId");

-- CreateIndex
CREATE INDEX "Commission_marketplace_occurredAt_idx" ON "Commission"("marketplace", "occurredAt");

-- CreateIndex
CREATE INDEX "Commission_status_idx" ON "Commission"("status");

-- CreateIndex
CREATE INDEX "ImportJob_marketplace_status_idx" ON "ImportJob"("marketplace", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRun_idempotencyKey_key" ON "AutomationRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AutomationRun_name_startedAt_idx" ON "AutomationRun"("name", "startedAt");

-- CreateIndex
CREATE INDEX "SystemAlert_severity_acknowledged_idx" ON "SystemAlert"("severity", "acknowledged");

-- CreateIndex
CREATE INDEX "SystemAlert_source_createdAt_idx" ON "SystemAlert"("source", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliateLink" ADD CONSTRAINT "AffiliateLink_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferScore" ADD CONSTRAINT "OfferScore_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationAttempt" ADD CONSTRAINT "PublicationAttempt_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_affiliateLinkId_fkey" FOREIGN KEY ("affiliateLinkId") REFERENCES "AffiliateLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Click" ADD CONSTRAINT "Click_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "Conversion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_marketplaceAccountId_fkey" FOREIGN KEY ("marketplaceAccountId") REFERENCES "MarketplaceAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_marketplaceAccountId_fkey" FOREIGN KEY ("marketplaceAccountId") REFERENCES "MarketplaceAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
