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
});
