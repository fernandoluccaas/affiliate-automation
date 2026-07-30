import { describe, expect, it } from "vitest";
import { createOfferFingerprint } from "./index";
import { offerFormSchema, parseDecimalInput } from "./offer-form-schema";

describe("ingestion offer schema", () => {
  it("exposes the public ingestion API", async () => {
    const ingestion = await import("./index");

    expect(typeof ingestion.ingestOffer).toBe("function");
    expect(typeof ingestion.offerFormSchema.safeParse).toBe("function");
    expect(typeof ingestion.formatOfferFormError).toBe("function");
  });

  it("keeps optional enrichment unavailable instead of forcing zero values", () => {
    const parsed = offerFormSchema.parse({
      marketplace: "MERCADO_LIVRE",
      externalProductId: "MLB1",
      title: "Produto valido",
      productUrl: "https://produto.example/MLB1",
      currentPrice: "299,99",
      shippingStatus: "UNKNOWN",
      stockStatus: "UNKNOWN",
    });

    expect(parsed.currentPrice).toBe(299.99);
    expect(parsed.originalPrice).toBeUndefined();
    expect(parsed.rating).toBeUndefined();
    expect(parsed.salesCount).toBeUndefined();
    expect(parsed.affiliateEligibility).toBe("UNKNOWN");
  });

  it("parses Brazilian decimal input", () => {
    expect(parseDecimalInput("1.299,99")).toBe(1299.99);
  });

  it("normalizes ranking and sanitized affiliate failure metadata", () => {
    const parsed = offerFormSchema.parse({
      marketplace: "MERCADO_LIVRE",
      externalProductId: "MLB123",
      title: "Produto ranqueado",
      productUrl: "https://produto.mercadolivre.com.br/MLB-123",
      currentPrice: 299.99,
      sourceCategoryId: " MLB1055 ",
      bestSellerPosition: "8",
      sourceHighlightId: " MLB123 ",
      sourceHighlightType: "PRODUCT",
      resolutionStrategy: "PRODUCT_CHILD_BUY_BOX",
      affiliateFailure: {
        stage: "LINK_GENERATION",
        status: 400,
        code: 111,
        message: "Produto nao elegivel.",
        productIneligible: true,
      },
    });

    expect(parsed).toMatchObject({
      sourceCategoryId: "MLB1055",
      bestSellerPosition: 8,
      sourceHighlightId: "MLB123",
      sourceHighlightType: "PRODUCT",
      resolutionStrategy: "PRODUCT_CHILD_BUY_BOX",
      affiliateFailure: {
        stage: "LINK_GENERATION",
        status: 400,
        code: "111",
        message: "Produto nao elegivel.",
        retryable: false,
        sessionExpired: false,
        productIneligible: true,
      },
    });
  });

  it("accepts the catalog PDP resolution strategy", () => {
    const parsed = offerFormSchema.parse({
      marketplace: "MERCADO_LIVRE",
      externalProductId: "MLB62081577",
      title: "Smartphone de catalogo",
      productUrl: "https://www.mercadolivre.com.br/smartphone/p/MLB62081577",
      currentPrice: 1429,
      sourceHighlightType: "PRODUCT",
      resolutionStrategy: "PRODUCT_CATALOG_PDP_FALLBACK",
    });

    expect(parsed.resolutionStrategy).toBe("PRODUCT_CATALOG_PDP_FALLBACK");
  });

  it("redacts secrets at the ingestion boundary before persistence", () => {
    const parsed = offerFormSchema.parse({
      marketplace: "MERCADO_LIVRE",
      externalProductId: "MLB124",
      title: "Produto com erro seguro",
      productUrl: "https://produto.mercadolivre.com.br/MLB-124",
      currentPrice: 199.99,
      affiliateFailure: {
        stage: "LINK_GENERATION",
        message:
          "HTTP 403\nCookie: session-id=mock-sensitive-value; csrf=mock-csrf\nAuthorization: Bearer mock-token",
      },
    });
    const message = parsed.affiliateFailure?.message ?? "";

    expect(message).toContain("HTTP 403");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("mock-sensitive-value");
    expect(message).not.toContain("mock-csrf");
    expect(message).not.toContain("mock-token");
  });

  it("keeps rank-only changes outside the offer fingerprint", () => {
    const materialFacts = {
      productId: "product-1",
      originalPrice: 500,
      currentPrice: 400,
      couponCode: null,
      couponExpiration: null,
      affiliateUrl: null,
      shippingStatus: "FREE",
      stockStatus: "IN_STOCK",
    };
    const firstObservation = {
      ...materialFacts,
      sourceCategoryId: "MLB1055",
      bestSellerPosition: 8,
    };
    const secondObservation = {
      ...materialFacts,
      sourceCategoryId: "MLB1055",
      bestSellerPosition: 9,
    };

    expect(createOfferFingerprint(firstObservation)).toBe(
      createOfferFingerprint(secondObservation),
    );
  });

  it("rejects invalid ranking positions and unbounded failure messages", () => {
    const base = {
      marketplace: "MERCADO_LIVRE",
      externalProductId: "MLB123",
      title: "Produto ranqueado",
      productUrl: "https://produto.mercadolivre.com.br/MLB-123",
      currentPrice: 299.99,
    };

    expect(
      offerFormSchema.safeParse({
        ...base,
        bestSellerPosition: 0,
      }).success,
    ).toBe(false);
    expect(
      offerFormSchema.safeParse({
        ...base,
        affiliateFailure: {
          stage: "LINK_GENERATION",
          message: "x".repeat(501),
        },
      }).success,
    ).toBe(false);
  });
});
