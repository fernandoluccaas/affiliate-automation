import { describe, expect, it } from "vitest";
import {
  calculateValidatedDiscount,
  sanitizeOperationalErrorMessage,
  validateMarketplaceAffiliateUrl,
  validateOfferFacts,
} from "./index";

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
    expect(validateOfferFacts(baseOffer)).toEqual({
      ok: true,
      normalizedDiscountPercentage: 20,
    });
  });

  it("accepts missing original price and keeps discount unavailable", () => {
    expect(
      validateOfferFacts({
        ...baseOffer,
        imageUrl: undefined,
        originalPrice: undefined,
        discountPercentage: null,
        couponCode: undefined,
        couponExpiration: undefined,
        shippingStatus: "UNKNOWN",
        stockStatus: "UNKNOWN",
      }),
    ).toEqual({ ok: true, normalizedDiscountPercentage: null });
  });

  it("rejects a discount that does not match internal calculation", () => {
    expect(
      validateOfferFacts({ ...baseOffer, discountPercentage: 25 }),
    ).toMatchObject({
      ok: false,
      code: "DISCOUNT_MISMATCH",
    });
  });

  it("rejects an expired coupon deterministically", () => {
    expect(
      validateOfferFacts(
        {
          ...baseOffer,
          couponExpiration: new Date("2025-12-31T23:59:59.000Z"),
        },
        new Date("2026-01-01T00:00:00.000Z"),
      ),
    ).toMatchObject({
      ok: false,
      code: "EXPIRED_COUPON",
    });
  });
});

describe("calculateValidatedDiscount", () => {
  it("calculates discount from original and current prices", () => {
    expect(calculateValidatedDiscount(200, 150)).toEqual({
      ok: true,
      discountPercentage: 25,
    });
  });

  it("does not reject when original price is unavailable", () => {
    expect(calculateValidatedDiscount(undefined, 150)).toEqual({
      ok: true,
      discountPercentage: null,
    });
  });

  it("rejects invalid prices", () => {
    expect(calculateValidatedDiscount(100, 120)).toMatchObject({
      ok: false,
      code: "INVALID_PRICE",
    });
  });
});

describe("sanitizeOperationalErrorMessage", () => {
  it("preserves diagnostics while redacting credential-shaped values", () => {
    const sanitized = sanitizeOperationalErrorMessage(
      "HTTP 403 stage LINK_GENERATION\nCookie: session-id=mock-cookie; csrf=mock-csrf\nAuthorization: Bearer mock-token",
    );

    expect(sanitized).toContain("HTTP 403");
    expect(sanitized).toContain("LINK_GENERATION");
    expect(sanitized).not.toContain("mock-cookie");
    expect(sanitized).not.toContain("mock-csrf");
    expect(sanitized).not.toContain("mock-token");
  });
});

describe("validateMarketplaceAffiliateUrl", () => {
  it.each([
    "https://meli.la/AbC123",
    "https://www.meli.la/AbC123",
    "https://mercadolivre.com.br/affiliate/AbC123",
    "https://www.mercadolivre.com.br/affiliate/AbC123",
    "https://mercadolibre.com/affiliate/AbC123",
    "https://www.mercadolibre.com/affiliate/AbC123",
  ])("accepts allowed Mercado Livre affiliate URL %s", (url) => {
    expect(validateMarketplaceAffiliateUrl("MERCADO_LIVRE", url)).toMatchObject(
      { ok: true },
    );
  });

  it.each([
    "http://localhost:3000/affiliate",
    "javascript:alert(1)",
    "https://192.168.1.10/affiliate",
    "https://[::1]/affiliate",
  ])("rejects unsafe affiliate URL %s", (url) => {
    expect(validateMarketplaceAffiliateUrl("MERCADO_LIVRE", url).ok).toBe(
      false,
    );
  });

  it.each([
    "https://evilmercadolivre.com.br/affiliate",
    "https://mercadolivre.com.br.evil.example/affiliate",
    "https://evilmercadolibre.com/affiliate",
    "https://mercadolibre.com.evil.example/affiliate",
    "https://meli.la.evil.example/affiliate",
    "https://example.com/affiliate",
  ])("rejects non-allowlisted Mercado Livre host %s", (url) => {
    expect(validateMarketplaceAffiliateUrl("MERCADO_LIVRE", url)).toMatchObject(
      {
        ok: false,
        code: "HOST_NOT_ALLOWED",
      },
    );
  });

  it("preserves generic safe HTTPS validation for other marketplaces", () => {
    expect(
      validateMarketplaceAffiliateUrl(
        "SHOPEE",
        "https://affiliate.example/link",
      ),
    ).toMatchObject({ ok: true });
  });
});
