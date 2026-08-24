type Marketplace = "SHOPEE" | "MERCADO_LIVRE";

export type CouponBenefitType =
  | "PERCENTAGE"
  | "FIXED_AMOUNT"
  | "AUTOMATIC"
  | "OTHER";
export type CouponScope =
  | "PRODUCT"
  | "SELLER"
  | "STORE"
  | "PLATFORM"
  | "CATEGORY"
  | "UNKNOWN";
export type CouponApplicability =
  | "CONFIRMED"
  | "CONDITIONAL"
  | "UNKNOWN"
  | "NOT_APPLICABLE";
export type CouponSourceStatus = "ACTIVE" | "INACTIVE" | "UNKNOWN";

export type CouponCandidate = {
  marketplace: Marketplace;
  externalCouponId?: string | null;
  sourceKey?: string | null;
  code?: string | null;
  benefitType: CouponBenefitType;
  percentage?: string | null;
  fixedAmount?: string | null;
  minimumSpend?: string | null;
  maximumDiscount?: string | null;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  autoApply: boolean;
  scope: CouponScope;
  sellerId?: string | null;
  productExternalId?: string | null;
  source: string;
  status: CouponSourceStatus;
  active: boolean;
  lastValidatedAt: Date;
  applicability: CouponApplicability;
  applicabilityReason?: string | null;
  confidence: number;
  metadata?: Record<string, unknown> | null;
};

export type ResolvedCoupon = CouponCandidate & {
  sourceKey: string;
  resolutionStatus: "CONFIRMED" | "CONDITIONAL" | "REJECTED";
  resolutionReason: string;
  itemPrice: string;
  discountAmountCalculated: string | null;
  effectivePriceCalculated: string | null;
  effectiveDiscountPercentage: string | null;
};

export type CouponResolution = {
  bestCoupon: ResolvedCoupon | null;
  candidates: ResolvedCoupon[];
  confirmed: number;
  conditional: number;
  rejected: number;
  stackable: false;
};

export type CouponSnapshot = {
  marketplace: Marketplace;
  externalCouponId: string | null;
  sourceKey: string;
  code: string | null;
  benefitType: CouponBenefitType;
  percentage: string | null;
  fixedAmount: string | null;
  minimumSpend: string | null;
  maximumDiscount: string | null;
  autoApply: boolean;
  scope: CouponScope;
  applicability: "CONFIRMED" | "CONDITIONAL";
  startsAt: string | null;
  expiresAt: string | null;
  validatedAt: string;
  source: string;
  itemPrice: string;
  discountAmountCalculated: string | null;
  effectivePriceCalculated: string | null;
  effectiveDiscountPercentage: string | null;
};

const couponBenefitTypes = new Set<CouponBenefitType>([
  "PERCENTAGE",
  "FIXED_AMOUNT",
  "AUTOMATIC",
  "OTHER",
]);
const couponScopes = new Set<CouponScope>([
  "PRODUCT",
  "SELLER",
  "STORE",
  "PLATFORM",
  "CATEGORY",
  "UNKNOWN",
]);

export function isCouponSnapshot(value: unknown): value is CouponSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const nullableString = (item: unknown) =>
    item === null || typeof item === "string";
  return (
    (record.marketplace === "SHOPEE" ||
      record.marketplace === "MERCADO_LIVRE") &&
    typeof record.sourceKey === "string" &&
    typeof record.source === "string" &&
    typeof record.validatedAt === "string" &&
    typeof record.itemPrice === "string" &&
    typeof record.autoApply === "boolean" &&
    nullableString(record.externalCouponId) &&
    nullableString(record.code) &&
    nullableString(record.percentage) &&
    nullableString(record.fixedAmount) &&
    nullableString(record.minimumSpend) &&
    nullableString(record.maximumDiscount) &&
    nullableString(record.startsAt) &&
    nullableString(record.expiresAt) &&
    nullableString(record.discountAmountCalculated) &&
    nullableString(record.effectivePriceCalculated) &&
    nullableString(record.effectiveDiscountPercentage) &&
    couponBenefitTypes.has(record.benefitType as CouponBenefitType) &&
    couponScopes.has(record.scope as CouponScope) &&
    (record.applicability === "CONFIRMED" ||
      record.applicability === "CONDITIONAL")
  );
}

export type CouponProviderResult = {
  supported: boolean;
  reason: string | null;
  source: string | null;
  candidates: CouponCandidate[];
  externalRequests: number;
};

export type CouponProviderInput = {
  offerId: string;
  externalProductId: string;
  sellerId?: string | null;
  price: string;
  now: Date;
};

export interface CouponProvider {
  readonly marketplace: Marketplace;
  discoverCoupons(input: CouponProviderInput): Promise<CouponProviderResult>;
  refreshCoupons(input: CouponProviderInput): Promise<CouponProviderResult>;
}

export class ShopeeCouponProvider implements CouponProvider {
  readonly marketplace = "SHOPEE" as const;

  async discoverCoupons(
    _input: CouponProviderInput,
  ): Promise<CouponProviderResult> {
    await Promise.resolve();
    return {
      supported: false,
      reason: "SHOPEE_AFFILIATE_COUPON_DISCOVERY_UNAVAILABLE",
      source: null,
      candidates: [],
      externalRequests: 0,
    };
  }

  refreshCoupons = this.discoverCoupons;
}

export class MercadoLivreCouponProvider implements CouponProvider {
  readonly marketplace = "MERCADO_LIVRE" as const;

  async discoverCoupons(
    _input: CouponProviderInput,
  ): Promise<CouponProviderResult> {
    await Promise.resolve();
    return {
      supported: false,
      reason: "MERCADO_LIVRE_AFFILIATE_COUPON_DISCOVERY_UNAVAILABLE",
      source: null,
      candidates: [],
      externalRequests: 0,
    };
  }

  refreshCoupons = this.discoverCoupons;
}

export type CouponIntelligenceConfiguration = {
  enabled: boolean;
  shopeeDiscoveryEnabled: boolean;
  mercadoLivreDiscoveryEnabled: boolean;
  rankingEnabled: boolean;
  refreshTtlMinutes: number;
  expirySafetyMinutes: number;
  discoveryMaxPerCycle: number;
  rankingMaxBonus: number;
  issues: string[];
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  issue: string,
  issues: string[],
) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push(issue);
    return fallback;
  }
  return parsed;
}

export function resolveCouponIntelligenceConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): CouponIntelligenceConfiguration {
  const issues: string[] = [];
  const enabled = environment.COUPON_INTELLIGENCE_ENABLED === "true";
  return {
    enabled,
    shopeeDiscoveryEnabled:
      enabled && environment.SHOPEE_COUPON_DISCOVERY_ENABLED === "true",
    mercadoLivreDiscoveryEnabled:
      enabled &&
      environment.MERCADOLIVRE_COUPON_DISCOVERY_ENABLED === "true",
    rankingEnabled:
      enabled && environment.COUPON_RANKING_ENABLED === "true",
    refreshTtlMinutes: boundedInteger(
      environment.COUPON_REFRESH_TTL_MINUTES,
      30,
      1,
      1_440,
      "COUPON_REFRESH_TTL_INVALID",
      issues,
    ),
    expirySafetyMinutes: boundedInteger(
      environment.COUPON_EXPIRY_SAFETY_MINUTES,
      10,
      0,
      1_440,
      "COUPON_EXPIRY_SAFETY_INVALID",
      issues,
    ),
    discoveryMaxPerCycle: boundedInteger(
      environment.COUPON_DISCOVERY_MAX_PER_CYCLE,
      24,
      1,
      100,
      "COUPON_DISCOVERY_MAX_INVALID",
      issues,
    ),
    rankingMaxBonus: boundedInteger(
      environment.COUPON_RANKING_MAX_BONUS,
      8,
      0,
      20,
      "COUPON_RANKING_MAX_BONUS_INVALID",
      issues,
    ),
    issues,
  };
}

function scaledInteger(value: string, scale: number): bigint | null {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/u);
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const padded = `${fraction}${"0".repeat(scale + 1)}`;
  const kept = padded.slice(0, scale);
  const next = Number(padded[scale] ?? "0");
  return BigInt(`${whole}${kept}`) + (next >= 5 ? 1n : 0n);
}

function decimal(value: bigint, scale: number) {
  const divisor = 10n ** BigInt(scale);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(scale, "0");
  return `${whole}.${fraction}`;
}

function roundedDivide(value: bigint, divisor: bigint) {
  return (value + divisor / 2n) / divisor;
}

export function couponSourceKey(candidate: CouponCandidate) {
  if (candidate.sourceKey?.trim()) return candidate.sourceKey.trim();
  if (candidate.externalCouponId?.trim()) {
    return `${candidate.source}:${candidate.externalCouponId.trim()}`;
  }
  return [
    candidate.source,
    candidate.code?.trim().toUpperCase() ?? "AUTO",
    candidate.benefitType,
    candidate.percentage ?? "",
    candidate.fixedAmount ?? "",
    candidate.minimumSpend ?? "",
    candidate.maximumDiscount ?? "",
    candidate.scope,
    candidate.sellerId ?? "",
    candidate.productExternalId ?? "",
  ].join(":");
}

function reject(
  candidate: CouponCandidate,
  price: string,
  reason: string,
): ResolvedCoupon {
  return {
    ...candidate,
    sourceKey: couponSourceKey(candidate),
    resolutionStatus: "REJECTED",
    resolutionReason: reason,
    itemPrice: price,
    discountAmountCalculated: null,
    effectivePriceCalculated: null,
    effectiveDiscountPercentage: null,
  };
}

export function resolveCouponCandidate(input: {
  candidate: CouponCandidate;
  price: string;
  marketplace: Marketplace;
  externalProductId: string;
  sellerId?: string | null;
  now: Date;
  refreshTtlMinutes: number;
  expirySafetyMinutes: number;
}): ResolvedCoupon {
  const { candidate } = input;
  const price = scaledInteger(input.price, 2);
  if (price === null || price <= 0n) return reject(candidate, input.price, "PRICE_INVALID");
  if (candidate.marketplace !== input.marketplace)
    return reject(candidate, input.price, "MARKETPLACE_MISMATCH");
  if (!candidate.active || candidate.status !== "ACTIVE")
    return reject(candidate, input.price, "COUPON_INACTIVE");
  if (candidate.startsAt && candidate.startsAt > input.now)
    return reject(candidate, input.price, "COUPON_NOT_STARTED");
  const safetyBoundary = new Date(
    input.now.getTime() + input.expirySafetyMinutes * 60_000,
  );
  if (candidate.expiresAt && candidate.expiresAt <= safetyBoundary)
    return reject(candidate, input.price, "COUPON_EXPIRED_OR_EXPIRING");
  if (
    candidate.productExternalId &&
    candidate.productExternalId !== input.externalProductId
  )
    return reject(candidate, input.price, "PRODUCT_MISMATCH");
  if (candidate.sellerId && candidate.sellerId !== input.sellerId)
    return reject(candidate, input.price, "SELLER_MISMATCH");
  if (candidate.applicability === "NOT_APPLICABLE")
    return reject(candidate, input.price, "NOT_APPLICABLE");
  if (candidate.applicability === "UNKNOWN")
    return reject(candidate, input.price, "APPLICABILITY_UNKNOWN");
  if (
    !Number.isFinite(candidate.lastValidatedAt.getTime()) ||
    candidate.lastValidatedAt.getTime() > input.now.getTime() + 5 * 60_000 ||
    input.now.getTime() - candidate.lastValidatedAt.getTime() >
      input.refreshTtlMinutes * 60_000
  )
    return reject(candidate, input.price, "COUPON_VALIDATION_TIME_INVALID");

  const minimumSpend = candidate.minimumSpend
    ? scaledInteger(candidate.minimumSpend, 2)
    : null;
  if (candidate.minimumSpend && minimumSpend === null)
    return reject(candidate, input.price, "MINIMUM_SPEND_INVALID");
  const percentage = candidate.percentage
    ? scaledInteger(candidate.percentage, 2)
    : null;
  if (
    candidate.percentage &&
    (percentage === null || percentage <= 0n || percentage > 10_000n)
  )
    return reject(candidate, input.price, "PERCENTAGE_BENEFIT_INVALID");
  if (
    candidate.benefitType === "PERCENTAGE" &&
    percentage === null
  )
    return reject(candidate, input.price, "PERCENTAGE_BENEFIT_INVALID");
  const fixedAmount = candidate.fixedAmount
    ? scaledInteger(candidate.fixedAmount, 2)
    : null;
  if (candidate.fixedAmount && (fixedAmount === null || fixedAmount <= 0n))
    return reject(candidate, input.price, "FIXED_BENEFIT_INVALID");
  if (
    candidate.benefitType === "FIXED_AMOUNT" &&
    fixedAmount === null
  )
    return reject(candidate, input.price, "FIXED_BENEFIT_INVALID");
  const maximumDiscount = candidate.maximumDiscount
    ? scaledInteger(candidate.maximumDiscount, 2)
    : null;
  if (
    candidate.maximumDiscount &&
    (maximumDiscount === null || maximumDiscount <= 0n)
  )
    return reject(candidate, input.price, "MAXIMUM_DISCOUNT_INVALID");
  const minimumMet = minimumSpend === null || price >= minimumSpend;
  const scopeConfirmed =
    candidate.scope === "PLATFORM" ||
    candidate.scope === "CATEGORY" ||
    candidate.scope === "UNKNOWN" ||
    (candidate.scope === "PRODUCT" &&
      candidate.productExternalId === input.externalProductId) ||
    (["SELLER", "STORE"] as CouponScope[]).includes(candidate.scope) &&
      Boolean(candidate.sellerId && candidate.sellerId === input.sellerId);
  const confirmed =
    candidate.applicability === "CONFIRMED" && minimumMet && scopeConfirmed;
  let discount: bigint | null = null;
  if (
    confirmed &&
    (candidate.benefitType === "PERCENTAGE" ||
      candidate.benefitType === "AUTOMATIC") &&
    candidate.percentage
  ) {
    if (percentage !== null && percentage > 0n) {
      discount = roundedDivide(price * percentage, 10_000n);
    }
  } else if (
    confirmed &&
    (candidate.benefitType === "FIXED_AMOUNT" ||
      candidate.benefitType === "AUTOMATIC")
  ) {
    discount = fixedAmount;
  }
  if (discount !== null && maximumDiscount !== null && discount > maximumDiscount)
    discount = maximumDiscount;
  if (discount !== null && discount > price) discount = price;
  const effectivePrice = discount === null ? null : price - discount;
  const effectivePercentage =
    discount === null ? null : roundedDivide(discount * 10_000n, price);
  return {
    ...candidate,
    sourceKey: couponSourceKey(candidate),
    resolutionStatus: confirmed ? "CONFIRMED" : "CONDITIONAL",
    resolutionReason: confirmed
      ? discount === null
        ? "CONFIRMED_WITHOUT_CALCULABLE_BENEFIT"
        : "CONFIRMED_APPLICABLE"
      : minimumMet
        ? scopeConfirmed
          ? "APPLICABILITY_NOT_CONFIRMED"
          : "SCOPE_NOT_CONFIRMED"
        : "MINIMUM_SPEND_NOT_MET",
    itemPrice: decimal(price, 2),
    discountAmountCalculated: discount === null ? null : decimal(discount, 2),
    effectivePriceCalculated:
      effectivePrice === null ? null : decimal(effectivePrice, 2),
    effectiveDiscountPercentage:
      effectivePercentage === null ? null : decimal(effectivePercentage, 2),
  };
}

function compareResolvedCoupons(left: ResolvedCoupon, right: ResolvedCoupon) {
  const statusOrder = { CONFIRMED: 0, CONDITIONAL: 1, REJECTED: 2 } as const;
  const status =
    statusOrder[left.resolutionStatus] - statusOrder[right.resolutionStatus];
  if (status !== 0) return status;
  const discount =
    (scaledInteger(right.discountAmountCalculated ?? "0", 2) ?? 0n) -
    (scaledInteger(left.discountAmountCalculated ?? "0", 2) ?? 0n);
  if (discount !== 0n) return discount > 0n ? 1 : -1;
  const percentage =
    (scaledInteger(right.effectiveDiscountPercentage ?? "0", 2) ?? 0n) -
    (scaledInteger(left.effectiveDiscountPercentage ?? "0", 2) ?? 0n);
  if (percentage !== 0n) return percentage > 0n ? 1 : -1;
  if (left.confidence !== right.confidence)
    return right.confidence - left.confidence;
  const leftMinimum = scaledInteger(left.minimumSpend ?? "0", 2) ?? 0n;
  const rightMinimum = scaledInteger(right.minimumSpend ?? "0", 2) ?? 0n;
  if (leftMinimum !== rightMinimum) return leftMinimum < rightMinimum ? -1 : 1;
  const leftExpiry = left.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightExpiry = right.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftExpiry !== rightExpiry) return rightExpiry - leftExpiry;
  return left.sourceKey.localeCompare(right.sourceKey);
}

export function resolveBestCoupon(input: {
  candidates: readonly CouponCandidate[];
  price: string;
  marketplace: Marketplace;
  externalProductId: string;
  sellerId?: string | null;
  now: Date;
  refreshTtlMinutes: number;
  expirySafetyMinutes: number;
}): CouponResolution {
  const candidates = input.candidates
    .map((candidate) => resolveCouponCandidate({ ...input, candidate }))
    .sort(compareResolvedCoupons);
  return {
    bestCoupon:
      candidates.find((coupon) => coupon.resolutionStatus !== "REJECTED") ??
      null,
    candidates,
    confirmed: candidates.filter(
      (coupon) => coupon.resolutionStatus === "CONFIRMED",
    ).length,
    conditional: candidates.filter(
      (coupon) => coupon.resolutionStatus === "CONDITIONAL",
    ).length,
    rejected: candidates.filter(
      (coupon) => coupon.resolutionStatus === "REJECTED",
    ).length,
    stackable: false,
  };
}

export function createCouponSnapshot(
  coupon: ResolvedCoupon,
): CouponSnapshot | null {
  if (coupon.resolutionStatus === "REJECTED") return null;
  return {
    marketplace: coupon.marketplace,
    externalCouponId: coupon.externalCouponId ?? null,
    sourceKey: coupon.sourceKey,
    code: coupon.code?.trim() || null,
    benefitType: coupon.benefitType,
    percentage: coupon.percentage ?? null,
    fixedAmount: coupon.fixedAmount ?? null,
    minimumSpend: coupon.minimumSpend ?? null,
    maximumDiscount: coupon.maximumDiscount ?? null,
    autoApply: coupon.autoApply,
    scope: coupon.scope,
    applicability: coupon.resolutionStatus,
    startsAt: coupon.startsAt?.toISOString() ?? null,
    expiresAt: coupon.expiresAt?.toISOString() ?? null,
    validatedAt: coupon.lastValidatedAt.toISOString(),
    source: coupon.source,
    itemPrice: coupon.itemPrice,
    discountAmountCalculated: coupon.discountAmountCalculated,
    effectivePriceCalculated: coupon.effectivePriceCalculated,
    effectiveDiscountPercentage: coupon.effectiveDiscountPercentage,
  };
}

export function evaluateCouponSnapshotFreshness(input: {
  snapshot: CouponSnapshot;
  now: Date;
  currentPrice: string;
  ttlMinutes: number;
  expirySafetyMinutes: number;
}) {
  const validatedAt = new Date(input.snapshot.validatedAt);
  if (
    !Number.isFinite(validatedAt.getTime()) ||
    validatedAt.getTime() > input.now.getTime() + 5 * 60_000 ||
    input.now.getTime() - validatedAt.getTime() > input.ttlMinutes * 60_000
  )
    return { fresh: false, reason: "COUPON_VALIDATION_TTL_EXPIRED" } as const;
  if (input.snapshot.expiresAt) {
    const expiresAt = new Date(input.snapshot.expiresAt);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <=
        input.now.getTime() + input.expirySafetyMinutes * 60_000
    )
      return { fresh: false, reason: "COUPON_EXPIRED_OR_EXPIRING" } as const;
  }
  const snapshotPrice = scaledInteger(input.snapshot.itemPrice, 2);
  const currentPrice = scaledInteger(input.currentPrice, 2);
  if (
    snapshotPrice === null ||
    currentPrice === null ||
    snapshotPrice !== currentPrice
  )
    return { fresh: false, reason: "COUPON_ITEM_PRICE_CHANGED" } as const;
  return { fresh: true, reason: "COUPON_FRESH" } as const;
}

export function applyCouponRankingBonus(input: {
  baseScore: number;
  snapshot: CouponSnapshot | null;
  enabled: boolean;
  fresh: boolean;
  maxBonus: number;
}) {
  if (
    !input.enabled ||
    !input.fresh ||
    input.snapshot?.applicability !== "CONFIRMED" ||
    !input.snapshot.effectiveDiscountPercentage
  )
    return { finalScore: input.baseScore, couponBonus: 0 };
  const percentage = Number(input.snapshot.effectiveDiscountPercentage);
  if (!Number.isFinite(percentage) || percentage <= 0)
    return { finalScore: input.baseScore, couponBonus: 0 };
  const maxBonus = Number.isFinite(input.maxBonus)
    ? Math.max(0, input.maxBonus)
    : 0;
  const couponBonus = Math.min(
    maxBonus,
    Math.max(0, (percentage / 20) * maxBonus),
  );
  return {
    finalScore: Math.min(100, Math.round((input.baseScore + couponBonus) * 100) / 100),
    couponBonus: Math.round(couponBonus * 100) / 100,
  };
}
