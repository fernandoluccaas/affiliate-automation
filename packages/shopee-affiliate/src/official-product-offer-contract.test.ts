import { describe, expect, it } from "vitest";
import { createProductOfferV2Payload } from "./open-api";
import { ShopeeProductOfferV2ResponseSchema } from "./official-product-offer-contract";

describe("official productOfferV2 contract", () => {
  it("builds the confirmed single-item shortlist query", () => {
    const payload = createProductOfferV2Payload({ itemId: "100" });
    expect(payload.request.query).toContain(
      "productOfferV2(itemId: 100, page: 1, limit: 1)",
    );
    expect(payload.request.query).toContain("commissionRate");
    expect(payload.request.query).toContain("offerLink");
  });

  it("normalizes confirmed numeric string fields", () => {
    const parsed = ShopeeProductOfferV2ResponseSchema.parse({
      nodes: [
        {
          itemId: "100",
          shopId: "200",
          priceMin: "49.90",
          priceMax: "59.90",
          sales: "10",
          ratingStar: "4.8",
          commissionRate: "8",
          sellerCommissionRate: null,
          shopeeCommissionRate: null,
          commission: "4",
          productLink: "https://shopee.com.br/product/200/100",
          offerLink: "https://s.shopee.com.br/metadata-only",
          periodStartTime: null,
          periodEndTime: null,
        },
      ],
      pageInfo: { page: 1, limit: 1, hasNextPage: false, scrollId: null },
    });
    expect(parsed.nodes[0]).toMatchObject({
      itemId: "100",
      priceMin: 49.9,
      commissionRate: 8,
    });
  });
});
