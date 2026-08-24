CREATE TYPE "CouponBenefitType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'AUTOMATIC', 'OTHER');
CREATE TYPE "CouponScope" AS ENUM ('PRODUCT', 'SELLER', 'STORE', 'PLATFORM', 'CATEGORY', 'UNKNOWN');
CREATE TYPE "CouponApplicability" AS ENUM ('CONFIRMED', 'CONDITIONAL', 'UNKNOWN', 'NOT_APPLICABLE');
CREATE TYPE "CouponSourceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'UNKNOWN');

ALTER TABLE "Coupon"
  ADD COLUMN "marketplace" "Marketplace",
  ADD COLUMN "externalCouponId" TEXT,
  ADD COLUMN "sourceKey" TEXT,
  ADD COLUMN "benefitType" "CouponBenefitType" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "percentage" DECIMAL(7,4),
  ADD COLUMN "minimumSpend" DECIMAL(12,2),
  ADD COLUMN "maximumDiscount" DECIMAL(12,2),
  ADD COLUMN "startsAt" TIMESTAMP(3),
  ADD COLUMN "autoApply" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "scope" "CouponScope" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "sellerId" TEXT,
  ADD COLUMN "productExternalId" TEXT,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'LEGACY_MANUAL',
  ADD COLUMN "status" "CouponSourceStatus" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "selected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastValidatedAt" TIMESTAMP(3),
  ADD COLUMN "applicability" "CouponApplicability" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "applicabilityReason" TEXT,
  ADD COLUMN "confidence" INTEGER,
  ADD COLUMN "itemPrice" DECIMAL(12,2),
  ADD COLUMN "calculatedDiscount" DECIMAL(12,2),
  ADD COLUMN "calculatedEffectivePrice" DECIMAL(12,2),
  ADD COLUMN "metadata" JSONB;

ALTER TABLE "Publication" ADD COLUMN "couponSnapshot" JSONB;

CREATE UNIQUE INDEX "Coupon_offerId_sourceKey_key" ON "Coupon"("offerId", "sourceKey");
CREATE INDEX "Coupon_marketplace_active_selected_idx" ON "Coupon"("marketplace", "active", "selected");
CREATE INDEX "Coupon_offerId_applicability_lastValidatedAt_idx" ON "Coupon"("offerId", "applicability", "lastValidatedAt");
