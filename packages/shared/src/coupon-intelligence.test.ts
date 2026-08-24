import { describe, expect, it } from "vitest";
import {
  MercadoLivreCouponProvider,
  ShopeeCouponProvider,
  applyCouponRankingBonus,
  createCouponSnapshot,
  evaluateCouponSnapshotFreshness,
  resolveBestCoupon,
  resolveCouponCandidate,
  resolveCouponIntelligenceConfiguration,
  type CouponCandidate,
} from "./coupon-intelligence";

const now = new Date("2026-08-24T12:00:00.000Z");

function candidate(
  overrides: Partial<CouponCandidate> = {},
): CouponCandidate {
  return {
    marketplace: "SHOPEE",
    externalCouponId: "coupon-1",
    code: "OFERTA10",
    benefitType: "PERCENTAGE",
    percentage: "10",
    fixedAmount: null,
    minimumSpend: null,
    maximumDiscount: null,
    startsAt: new Date("2026-08-24T00:00:00.000Z"),
    expiresAt: new Date("2026-08-25T12:00:00.000Z"),
    autoApply: false,
    scope: "PRODUCT",
    sellerId: "seller-1",
    productExternalId: "product-1",
    source: "SHOPEE_OFFICIAL_TEST",
    status: "ACTIVE",
    active: true,
    lastValidatedAt: now,
    applicability: "CONFIRMED",
    applicabilityReason: null,
    confidence: 90,
    ...overrides,
  };
}

function resolve(overrides: Partial<CouponCandidate> = {}, price = "100.00") {
  return resolveCouponCandidate({
    candidate: candidate(overrides),
    price,
    marketplace: "SHOPEE",
    externalProductId: "product-1",
    sellerId: "seller-1",
    now,
    refreshTtlMinutes: 30,
    expirySafetyMinutes: 10,
  });
}

describe("cross-marketplace coupon resolver", () => {
  it("calculates a percentage coupon with exact decimal money", () => {
    expect(resolve().discountAmountCalculated).toBe("10.00");
    expect(resolve().effectivePriceCalculated).toBe("90.00");
    expect(resolve().effectiveDiscountPercentage).toBe("10.00");
  });

  it("calculates and caps a fixed coupon at zero effective price", () => {
    const result = resolve(
      { benefitType: "FIXED_AMOUNT", percentage: null, fixedAmount: "20" },
      "10",
    );
    expect(result.discountAmountCalculated).toBe("10.00");
    expect(result.effectivePriceCalculated).toBe("0.00");
  });

  it("applies maximumDiscount to percentage benefits", () => {
    expect(resolve({ percentage: "15", maximumDiscount: "8" }).discountAmountCalculated).toBe(
      "8.00",
    );
  });

  it("keeps minimum-spend failures conditional without an effective price", () => {
    const result = resolve(
      {
        benefitType: "FIXED_AMOUNT",
        percentage: null,
        fixedAmount: "20",
        minimumSpend: "200",
      },
      "80",
    );
    expect(result.resolutionStatus).toBe("CONDITIONAL");
    expect(result.effectivePriceCalculated).toBeNull();
  });

  it.each([
    ["expired", { expiresAt: new Date("2026-08-24T11:59:00.000Z") }],
    ["not started", { startsAt: new Date("2026-08-24T12:01:00.000Z") }],
    ["inside safety window", { expiresAt: new Date("2026-08-24T12:09:00.000Z") }],
    ["inactive", { active: false }],
    ["unknown applicability", { applicability: "UNKNOWN" as const }],
  ])("rejects %s coupons", (_name, overrides) => {
    expect(resolve(overrides).resolutionStatus).toBe("REJECTED");
  });

  it("represents an official automatic coupon without inventing a code", () => {
    const result = resolve({
      externalCouponId: null,
      code: null,
      autoApply: true,
      benefitType: "AUTOMATIC",
      percentage: null,
    });
    expect(result.resolutionStatus).toBe("CONFIRMED");
    expect(result.effectivePriceCalculated).toBeNull();
    expect(result.code).toBeNull();
    expect(result.sourceKey).toBe(
      "SHOPEE_OFFICIAL_TEST:AUTO:AUTOMATIC:::::PRODUCT:seller-1:product-1",
    );
    expect(createCouponSnapshot(result)).toMatchObject({
      code: null,
      sourceKey:
        "SHOPEE_OFFICIAL_TEST:AUTO:AUTOMATIC:::::PRODUCT:seller-1:product-1",
      autoApply: true,
      benefitType: "AUTOMATIC",
    });
  });

  it("does not stack and deterministically chooses the largest real saving", () => {
    const resolution = resolveBestCoupon({
      candidates: [
        candidate({ externalCouponId: "ten", percentage: "10" }),
        candidate({ externalCouponId: "twenty", percentage: "20" }),
      ],
      price: "100",
      marketplace: "SHOPEE",
      externalProductId: "product-1",
      sellerId: "seller-1",
      now,
      refreshTtlMinutes: 30,
      expirySafetyMinutes: 10,
    });
    expect(resolution.stackable).toBe(false);
    expect(resolution.bestCoupon?.externalCouponId).toBe("twenty");
  });

  it("uses a stable source key as the final tie breaker", () => {
    const resolution = resolveBestCoupon({
      candidates: [candidate({ sourceKey: "b" }), candidate({ sourceKey: "a" })],
      price: "100",
      marketplace: "SHOPEE",
      externalProductId: "product-1",
      sellerId: "seller-1",
      now,
      refreshTtlMinutes: 30,
      expirySafetyMinutes: 10,
    });
    expect(resolution.bestCoupon?.sourceKey).toBe("a");
  });

  it("creates an immutable structured snapshot from the selected coupon", () => {
    const snapshot = createCouponSnapshot(resolve());
    expect(snapshot).toMatchObject({
      marketplace: "SHOPEE",
      code: "OFERTA10",
      itemPrice: "100.00",
      effectivePriceCalculated: "90.00",
      applicability: "CONFIRMED",
    });
  });
});

describe("coupon freshness, ranking and fail-closed configuration", () => {
  const snapshot = createCouponSnapshot(resolve());
  if (!snapshot) throw new Error("fixture snapshot missing");

  it("invalidates stale validation, expiring coupons and changed prices", () => {
    expect(
      evaluateCouponSnapshotFreshness({
        snapshot,
        now: new Date("2026-08-24T13:00:01.000Z"),
        currentPrice: "100",
        ttlMinutes: 60,
        expirySafetyMinutes: 10,
      }).fresh,
    ).toBe(false);
    expect(
      evaluateCouponSnapshotFreshness({
        snapshot: { ...snapshot, expiresAt: "2026-08-24T12:05:00.000Z" },
        now,
        currentPrice: "100.00",
        ttlMinutes: 60,
        expirySafetyMinutes: 10,
      }).reason,
    ).toBe("COUPON_EXPIRED_OR_EXPIRING");
    expect(
      evaluateCouponSnapshotFreshness({
        snapshot,
        now,
        currentPrice: "99.99",
        ttlMinutes: 60,
        expirySafetyMinutes: 10,
      }).reason,
    ).toBe("COUPON_ITEM_PRICE_CHANGED");
  });

  it("keeps ranking exactly unchanged while the feature is disabled", () => {
    expect(
      applyCouponRankingBonus({
        baseScore: 72.5,
        snapshot,
        enabled: false,
        fresh: true,
        maxBonus: 8,
      }),
    ).toEqual({ finalScore: 72.5, couponBonus: 0 });
  });

  it("applies a bounded bonus only for confirmed calculated coupons", () => {
    expect(
      applyCouponRankingBonus({
        baseScore: 70,
        snapshot,
        enabled: true,
        fresh: true,
        maxBonus: 8,
      }),
    ).toEqual({ finalScore: 74, couponBonus: 4 });
    expect(
      applyCouponRankingBonus({
        baseScore: 70,
        snapshot: { ...snapshot, applicability: "CONDITIONAL" },
        enabled: true,
        fresh: true,
        maxBonus: 8,
      }).couponBonus,
    ).toBe(0);
    expect(
      applyCouponRankingBonus({
        baseScore: 70,
        snapshot,
        enabled: true,
        fresh: false,
        maxBonus: 8,
      }).couponBonus,
    ).toBe(0);
  });

  it("defaults every feature flag to off and bounds invalid values", () => {
    const configuration = resolveCouponIntelligenceConfiguration({
      COUPON_REFRESH_TTL_MINUTES: "invalid",
      COUPON_RANKING_MAX_BONUS: "999",
    } as NodeJS.ProcessEnv);
    expect(configuration.enabled).toBe(false);
    expect(configuration.rankingEnabled).toBe(false);
    expect(configuration.refreshTtlMinutes).toBe(30);
    expect(configuration.rankingMaxBonus).toBe(8);
    expect(configuration.issues).toHaveLength(2);
  });
});

describe("official coupon source capabilities", () => {
  it.each([
    [new ShopeeCouponProvider(), "SHOPEE_AFFILIATE_COUPON_DISCOVERY_UNAVAILABLE"],
    [
      new MercadoLivreCouponProvider(),
      "MERCADO_LIVRE_AFFILIATE_COUPON_DISCOVERY_UNAVAILABLE",
    ],
  ])("reports unsupported without an external request", async (provider, reason) => {
    const result = await provider.discoverCoupons({
      offerId: "offer-1",
      externalProductId: "product-1",
      sellerId: "seller-1",
      price: "100",
      now,
    });
    expect(result).toEqual({
      supported: false,
      reason,
      source: null,
      candidates: [],
      externalRequests: 0,
    });
  });
});
