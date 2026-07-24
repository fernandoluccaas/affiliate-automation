import { describe, expect, it } from "vitest";
import { calculateOfferScore } from "./index";

describe("calculateOfferScore", () => {
  it("returns auditable normalized components", () => {
    const score = calculateOfferScore(
      {
        discountPercentage: 25,
        commissionPercentage: 10,
        rating: 4.5,
        salesCount: 1000,
        freeShipping: true,
        couponExpiration: new Date("2026-01-02T00:00:00.000Z"),
        collectedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      undefined,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(score.total).toBeGreaterThan(0);
    expect(score.discountComponent).toBe(50);
    expect(score.weights.discount).toBe(0.25);
  });

  it("returns a high score for a strong valid offer", () => {
    const score = calculateOfferScore(
      {
        discountPercentage: 60,
        commissionPercentage: 20,
        rating: 5,
        salesCount: 100000,
        freeShipping: true,
        couponExpiration: new Date("2026-01-02T00:00:00.000Z"),
        collectedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      undefined,
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(score.total).toBeGreaterThanOrEqual(90);
  });
});
