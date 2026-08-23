import { describe, expect, it, vi } from "vitest";
import {
  enrichShopeeShortlist,
  type ShopeeProductEnrichment,
  type ShopeeProductEnrichmentClient,
} from "./enrichment";
import { ShopeeOpenApiError } from "./open-api";

const enabled = {
  SHOPEE_AFFILIATE_ENABLED: "true",
  SHOPEE_AFFILIATE_MODE: "HYBRID",
  SHOPEE_OPEN_API_APP_ID: "fixture-app",
  SHOPEE_OPEN_API_SECRET: "fixture-secret",
  SHOPEE_ENRICHMENT_ENABLED: "true",
} as NodeJS.ProcessEnv;

function metadata(itemId: string): ShopeeProductEnrichment {
  return {
    itemId,
    shopId: "200",
    priceMin: 50,
    priceMax: 50,
    sales: 100,
    ratingStar: 4.8,
    commissionRate: 8,
    sellerCommissionRate: null,
    shopeeCommissionRate: null,
    commission: 4,
    productLink: "https://shopee.com.br/product/200/100",
    offerLink: "https://s.shopee.com.br/metadata-only",
    periodStartTime: null,
    periodEndTime: null,
    available: null,
  };
}

describe("Shopee shortlist enrichment", () => {
  it("does not call the client when disabled", async () => {
    const client = { enrichItem: vi.fn() };
    const result = await enrichShopeeShortlist({
      itemIds: ["100"],
      environment: {},
      client,
    });
    expect(result.status).toBe("DISABLED");
    expect(client.enrichItem).not.toHaveBeenCalled();
  });

  it("enriches only the bounded shortlist", async () => {
    const client: ShopeeProductEnrichmentClient = {
      enrichItem: vi.fn(async (itemId) => metadata(itemId)),
    };
    const result = await enrichShopeeShortlist({
      itemIds: Array.from({ length: 100 }, (_, index) => String(index + 1)),
      environment: enabled,
      client,
    });
    expect(result.shortlisted).toBe(24);
    expect(result.externalRequests).toBe(24);
    expect(client.enrichItem).toHaveBeenCalledTimes(24);
  });

  it("reuses the per-cycle cache", async () => {
    const cache = new Map([["100", metadata("100")]]);
    const client = { enrichItem: vi.fn() };
    const result = await enrichShopeeShortlist({
      itemIds: ["100"],
      environment: enabled,
      client,
      cache,
    });
    expect(result.cached).toBe(1);
    expect(result.externalRequests).toBe(0);
  });

  it("isolates an individual item failure", async () => {
    const client: ShopeeProductEnrichmentClient = {
      enrichItem: vi.fn(async (itemId) => {
        if (itemId === "100") throw new Error("fixture failure");
        return metadata(itemId);
      }),
    };
    const result = await enrichShopeeShortlist({
      itemIds: ["100", "101"],
      environment: enabled,
      client,
    });
    expect(result.status).toBe("SUCCEEDED_WITH_ERRORS");
    expect(result).toMatchObject({ attempted: 2, enriched: 1, failed: 1 });
  });

  it("aborts after an authentication or global GraphQL failure", async () => {
    const client: ShopeeProductEnrichmentClient = {
      enrichItem: vi
        .fn()
        .mockRejectedValue(
          new ShopeeOpenApiError("SHOPEE_OPEN_API_AUTHENTICATION_FAILED"),
        ),
    };
    const result = await enrichShopeeShortlist({
      itemIds: ["100", "101", "102"],
      environment: enabled,
      client,
    });
    expect(result).toMatchObject({
      status: "FAILED",
      attempted: 1,
      notAttempted: 2,
      globalErrorCode: "SHOPEE_OPEN_API_AUTHENTICATION_FAILED",
    });
  });

  it("keeps offerLink as metadata and never changes canonical AffiliateLink", async () => {
    const result = await enrichShopeeShortlist({
      itemIds: ["100"],
      environment: enabled,
      client: { enrichItem: vi.fn().mockResolvedValue(metadata("100")) },
    });
    expect(result.items[0]?.metadata?.offerLink).toBe(
      "https://s.shopee.com.br/metadata-only",
    );
    expect(result.canonicalAffiliateLinksChanged).toBe(0);
  });
});
