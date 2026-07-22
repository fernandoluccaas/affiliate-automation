import { describe, expect, it } from "vitest";
import { validateOfferFacts } from "./index";

const baseOffer = {
  marketplace: "SHOPEE",
  externalProductId: "sku-1",
  title: "Oferta validada",
  imageUrl: "https://example.com/image.jpg",
  productUrl: "https://example.com/product",
  originalPrice: 100,
  currentPrice: 80,
  discountPercentage: 20,
  freeShipping: true,
  stockStatus: "IN_STOCK",
  collectedAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("validateOfferFacts", () => {
  it("accepts an offer with deterministic discount", () => {
    expect(validateOfferFacts(baseOffer)).toEqual({ ok: true, normalizedDiscountPercentage: 20 });
  });

  it("rejects a discount that does not match internal calculation", () => {
    expect(validateOfferFacts({ ...baseOffer, discountPercentage: 25 })).toMatchObject({
      ok: false,
      code: "DISCOUNT_MISMATCH",
    });
  });
});
