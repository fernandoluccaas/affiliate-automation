import { describe, expect, it } from "vitest";
import { offerFormSchema, parseDecimalInput } from "./offer-form-schema";

describe("ingestion offer schema", () => {
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
});
