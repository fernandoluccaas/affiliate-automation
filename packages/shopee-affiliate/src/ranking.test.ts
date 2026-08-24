import { describe, expect, it } from "vitest";
import {
  compareShopeeAdvancedScores,
  scoreShopeeAdvancedCandidate,
} from "./ranking";

const now = new Date("2026-08-23T15:00:00.000Z");
const base = {
  itemId: "1001",
  qualityScore: 80,
  salePrice: 80,
  originalPrice: 120,
  discountPercentage: 33.33,
  collectedAt: new Date("2026-08-23T14:00:00.000Z"),
  now,
};

describe("Shopee advanced ranking", () => {
  it("is deterministic and exposes every score component", () => {
    const first = scoreShopeeAdvancedCandidate(base);
    expect(scoreShopeeAdvancedCandidate(base)).toEqual(first);
    expect(first.components).toMatchObject({
      quality: expect.any(Number),
      discount: expect.any(Number),
      absoluteSavings: expect.any(Number),
      price: expect.any(Number),
      freshness: expect.any(Number),
      productCooldownPenalty: 0,
      sellerCooldownPenalty: 0,
      duplicatePenalty: 0,
    });
  });

  it("does not invent absent commission or historical performance", () => {
    const result = scoreShopeeAdvancedCandidate(base);
    expect(result.components.commission).toBeNull();
    expect(result.components.historicalPerformance).toBeNull();
  });

  it("uses persisted tracking performance when supplied", () => {
    const converting = scoreShopeeAdvancedCandidate({
      ...base,
      clicks: 100,
      conversions: 5,
    });
    const noConversions = scoreShopeeAdvancedCandidate({
      ...base,
      clicks: 100,
      conversions: 0,
    });
    expect(converting.score).toBeGreaterThan(noConversions.score);
  });

  it("blocks a recently published product through the cooldown penalty", () => {
    const result = scoreShopeeAdvancedCandidate({
      ...base,
      publishedAt: new Date("2026-08-23T14:00:00.000Z"),
      productCooldownHours: 168,
    });
    expect(result.score).toBe(0);
    expect(result.components.productCooldownPenalty).toBe(100);
  });

  it("penalizes seller and category concentration", () => {
    const diverse = scoreShopeeAdvancedCandidate(base);
    const concentrated = scoreShopeeAdvancedCandidate({
      ...base,
      categorySelectedCount: 2,
      sellerSelectedCount: 2,
      sellerLastPublishedAt: new Date("2026-08-23T10:00:00.000Z"),
    });
    expect(concentrated.score).toBeLessThan(diverse.score);
  });

  it("applies a duplicate similarity penalty", () => {
    const unique = scoreShopeeAdvancedCandidate(base);
    const duplicate = scoreShopeeAdvancedCandidate({
      ...base,
      duplicateSimilarity: 1,
    });
    expect(duplicate.score).toBeCloseTo(unique.score - 40, 2);
  });

  it("uses a stable item id tie-break", () => {
    expect(
      [
        { itemId: "b", score: 80 },
        { itemId: "a", score: 80 },
      ].sort(compareShopeeAdvancedScores),
    ).toEqual([
      { itemId: "a", score: 80 },
      { itemId: "b", score: 80 },
    ]);
  });

  it("keeps legacy ranking byte-for-byte compatible when coupons are disabled", () => {
    const legacy = scoreShopeeAdvancedCandidate(base);
    const disabled = scoreShopeeAdvancedCandidate({
      ...base,
      couponRankingEnabled: false,
      couponRankingMaxBonus: 8,
      couponSnapshot: {
        marketplace: "SHOPEE",
        externalCouponId: "voucher-1",
        sourceKey: "fixture:voucher-1",
        code: "OFF10",
        benefitType: "PERCENTAGE",
        percentage: "10",
        fixedAmount: null,
        minimumSpend: null,
        maximumDiscount: null,
        autoApply: false,
        scope: "PRODUCT",
        applicability: "CONFIRMED",
        startsAt: null,
        expiresAt: "2026-08-25T12:00:00.000Z",
        validatedAt: "2026-08-24T12:00:00.000Z",
        source: "SHOPEE_OFFICIAL_TEST",
        itemPrice: "100.00",
        discountAmountCalculated: "10.00",
        effectivePriceCalculated: "90.00",
        effectiveDiscountPercentage: "10.00",
      },
    });
    expect(disabled.score).toBe(legacy.score);
    expect(disabled.components).toEqual(legacy.components);
  });

  it("requires an explicitly fresh confirmed snapshot before adding a bonus", () => {
    const snapshot = {
      marketplace: "SHOPEE" as const,
      externalCouponId: "voucher-1",
      sourceKey: "fixture:voucher-1",
      code: "OFF10",
      benefitType: "PERCENTAGE" as const,
      percentage: "10",
      fixedAmount: null,
      minimumSpend: null,
      maximumDiscount: null,
      autoApply: false,
      scope: "PRODUCT" as const,
      applicability: "CONFIRMED" as const,
      startsAt: null,
      expiresAt: "2026-08-25T12:00:00.000Z",
      validatedAt: "2026-08-24T12:00:00.000Z",
      source: "SHOPEE_OFFICIAL_TEST",
      itemPrice: "100.00",
      discountAmountCalculated: "10.00",
      effectivePriceCalculated: "90.00",
      effectiveDiscountPercentage: "10.00",
    };
    const stale = scoreShopeeAdvancedCandidate({
      ...base,
      couponSnapshot: snapshot,
      couponRankingEnabled: true,
      couponFresh: false,
      couponRankingMaxBonus: 8,
    });
    const fresh = scoreShopeeAdvancedCandidate({
      ...base,
      couponSnapshot: snapshot,
      couponRankingEnabled: true,
      couponFresh: true,
      couponRankingMaxBonus: 8,
    });
    expect(stale.components.couponBonus).toBe(0);
    expect(fresh.components.couponBonus).toBe(4);
    expect(fresh.score).toBeGreaterThan(stale.score);
  });
});
