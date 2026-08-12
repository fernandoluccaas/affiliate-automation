import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_SHOPEE_FILTERS, SHOPEE_CATEGORY_CATALOG } from "./config";
import {
  filterShopeeCandidate,
  matchShopeeCategory,
  previewShopeeDatafeeds,
  scoreShopeeCandidate,
  selectShopeeRoundRobin,
} from "./discovery";
import { DatafeedAffiliateLinkProvider } from "./providers";
import type {
  ShopeeDatafeedProduct,
  ShopeeLogicalCategory,
  ShopeeRankedCandidate,
} from "./types";

const officialFixture = fileURLToPath(
  new URL("../fixtures/shopee-official-br-sanitized.csv", import.meta.url),
);
const brazilFixture = fileURLToPath(
  new URL("../fixtures/shopee-brasil-sanitized.csv", import.meta.url),
);
const environment = {
  SHOPEE_AFFILIATE_ENABLED: "true",
  SHOPEE_AFFILIATE_MODE: "DATAFEED",
  SHOPEE_DATAFEED_LINKS_VERIFIED: "false",
};

function product(
  overrides: Partial<ShopeeDatafeedProduct> = {},
): ShopeeDatafeedProduct {
  return {
    itemId: "1",
    title: "Produto",
    description: "Completo",
    originalPrice: 150,
    salePrice: 100,
    discountPercentage: 33,
    itemRating: 4.9,
    shopRating: 4.8,
    likeCount: 100,
    condition: "new",
    crossBorder: false,
    category1: "Home & Living",
    category1Id: "10",
    category2: "Decor",
    category2Id: "20",
    category3: null,
    category3Id: null,
    shopName: "Loja",
    imageUrl: "https://cf.shopee.com.br/file/image",
    secondaryImageUrl: null,
    sourceProductUrl: "https://shopee.com.br/item",
    candidateAffiliateUrl: "https://shope.ee/an_redir?origin_link=x",
    verifiedAffiliateUrl: null,
    modelIds: null,
    modelNames: null,
    commissionAvailable: false,
    salesCountAvailable: false,
    source: "OFFICIAL_BR",
    sources: ["OFFICIAL_BR"],
    ...overrides,
  };
}

function candidate(
  id: string,
  category: ShopeeLogicalCategory,
  score = 80,
): ShopeeRankedCandidate {
  return {
    itemId: id,
    title: id,
    category,
    salePrice: 100,
    originalPrice: 120,
    discountPercentage: 20,
    itemRating: 4.8,
    shopRating: null,
    imageUrl: "https://cf.shopee.com.br/image",
    sourceProductHost: "shopee.com.br",
    candidateLinkHost: "shope.ee",
    linkStatus: "NOT_VERIFIED",
    score,
    components: {
      discountScore: 30,
      itemRatingScore: 90,
      shopRatingScore: null,
      likeScore: null,
      completenessScore: 80,
      diversityPenalty: 0,
    },
    sources: ["BRAZIL"],
  };
}

describe("Shopee category matching", () => {
  it("matches Celulares only for Mobile Phones", () => {
    expect(
      matchShopeeCategory(
        product({ category1: "Mobile & Gadgets", category2: "Mobile Phones" }),
      )?.id,
    ).toBe("CELULARES");
    expect(
      matchShopeeCategory(
        product({ category1: "Mobile & Gadgets", category2: "Accessories" }),
      ),
    ).toBeNull();
  });

  it.each([
    ["Home & Living", "CASA"],
    ["Women Clothes", "MODA"],
    ["Men Clothes", "MODA"],
    ["Fashion Accessories", "MODA"],
    ["Watches", "RELOGIOS"],
    ["Spare Parts and Accessories for Vehicles", "AUTOMOTIVO"],
    ["Home Appliances", "ELETRODOMESTICOS"],
  ])("maps %s to %s", (category1, expected) => {
    expect(matchShopeeCategory(product({ category1 }))?.id).toBe(expected);
  });
});

describe("Shopee discovery filters", () => {
  it("applies minimum discount", () => {
    expect(
      filterShopeeCandidate(
        product({ discountPercentage: 10 }),
        DEFAULT_SHOPEE_FILTERS,
      ),
    ).toBe("DISCOUNT_BELOW_MINIMUM");
  });

  it("applies minimum item rating", () => {
    expect(
      filterShopeeCandidate(product({ itemRating: 4 }), DEFAULT_SHOPEE_FILTERS),
    ).toBe("ITEM_RATING_BELOW_MINIMUM");
  });

  it("treats absent shop rating neutrally", () => {
    expect(
      filterShopeeCandidate(product({ shopRating: null }), {
        ...DEFAULT_SHOPEE_FILTERS,
        shopRatingMin: 4.9,
      }),
    ).toBeNull();
  });

  it("filters an available shop rating below the minimum", () => {
    expect(
      filterShopeeCandidate(product({ shopRating: 4 }), {
        ...DEFAULT_SHOPEE_FILTERS,
        shopRatingMin: 4.9,
      }),
    ).toBe("SHOP_RATING_BELOW_MINIMUM");
  });

  it("blocks cross-border by default", () => {
    expect(
      filterShopeeCandidate(
        product({ crossBorder: true }),
        DEFAULT_SHOPEE_FILTERS,
      ),
    ).toBe("CROSS_BORDER_NOT_ALLOWED");
  });

  it("filters forbidden title words deterministically", () => {
    expect(
      filterShopeeCandidate(product({ title: "Produto proibido" }), {
        ...DEFAULT_SHOPEE_FILTERS,
        forbiddenWords: ["PROIBIDO"],
      }),
    ).toBe("FORBIDDEN_WORD");
  });

  it("applies price bounds", () => {
    expect(
      filterShopeeCandidate(product({ salePrice: 9 }), {
        ...DEFAULT_SHOPEE_FILTERS,
        priceMin: 10,
      }),
    ).toBe("PRICE_BELOW_MINIMUM");
    expect(
      filterShopeeCandidate(product({ salePrice: 101 }), {
        ...DEFAULT_SHOPEE_FILTERS,
        priceMax: 100,
      }),
    ).toBe("PRICE_ABOVE_MAXIMUM");
  });
});

describe("Shopee deterministic ranking", () => {
  it("returns an explainable score breakdown", () => {
    const result = scoreShopeeCandidate(product());
    expect(result.score).toBeGreaterThan(0);
    expect(result.components).toEqual(
      expect.objectContaining({
        discountScore: expect.any(Number),
        itemRatingScore: expect.any(Number),
        completenessScore: expect.any(Number),
        diversityPenalty: 0,
      }),
    );
  });

  it("is deterministic for equal input", () => {
    expect(scoreShopeeCandidate(product())).toEqual(
      scoreShopeeCandidate(product()),
    );
  });

  it("renormalizes absent optional shop and like scores instead of using zero", () => {
    const result = scoreShopeeCandidate(
      product({ shopRating: null, likeCount: null }),
    );
    expect(result.components.shopRatingScore).toBeNull();
    expect(result.components.likeScore).toBeNull();
    expect(result.score).toBeGreaterThan(50);
  });

  it("applies an explicit diversity penalty", () => {
    expect(scoreShopeeCandidate(product(), undefined, 10).score).toBe(
      scoreShopeeCandidate(product()).score - 10,
    );
  });
});

describe("Shopee round robin", () => {
  function pools() {
    return new Map<ShopeeLogicalCategory, ShopeeRankedCandidate[]>([
      [
        "CELULARES",
        [candidate("c1", "CELULARES", 90), candidate("c2", "CELULARES", 80)],
      ],
      ["CASA", [candidate("h1", "CASA", 95), candidate("h2", "CASA", 85)]],
      ["MODA", [candidate("m1", "MODA", 92), candidate("m2", "MODA", 82)]],
    ]);
  }

  it("selects one pass per category before the second pass", () => {
    const categories = SHOPEE_CATEGORY_CATALOG.filter((item) =>
      ["CELULARES", "CASA", "MODA"].includes(item.id),
    );
    expect(
      selectShopeeRoundRobin({ pools: pools(), categories }).selected.map(
        (item) => item.itemId,
      ),
    ).toEqual(["c1", "h1", "m1", "c2", "h2", "m2"]);
  });

  it("respects max total", () => {
    const categories = SHOPEE_CATEGORY_CATALOG.filter((item) =>
      ["CELULARES", "CASA", "MODA"].includes(item.id),
    );
    expect(
      selectShopeeRoundRobin({ pools: pools(), categories, maxTotal: 4 })
        .selected,
    ).toHaveLength(4);
  });

  it("respects category maximums", () => {
    const categories = SHOPEE_CATEGORY_CATALOG.filter(
      (item) => item.id === "CELULARES",
    ).map((item) => ({ ...item, maxPerCategory: 1 }));
    expect(
      selectShopeeRoundRobin({ pools: pools(), categories }).selected,
    ).toHaveLength(1);
  });

  it("does not backfill a second round when a minimum is unmet", () => {
    const categories = SHOPEE_CATEGORY_CATALOG.filter((item) =>
      ["CELULARES", "CASA"].includes(item.id),
    );
    const sparse = pools();
    sparse.set("CASA", []);
    expect(
      selectShopeeRoundRobin({
        pools: sparse,
        categories,
        backfill: false,
      }).selected.map((item) => item.itemId),
    ).toEqual(["c1"]);
    expect(
      selectShopeeRoundRobin({
        pools: sparse,
        categories,
        backfill: true,
      }).selected.map((item) => item.itemId),
    ).toEqual(["c1", "c2"]);
  });

  it("uses priority for a deterministic initial order", () => {
    const categories = SHOPEE_CATEGORY_CATALOG.filter((item) =>
      ["CELULARES", "CASA"].includes(item.id),
    ).map((item) => ({ ...item, priority: item.id === "CASA" ? 100 : 0 }));
    expect(
      selectShopeeRoundRobin({
        pools: pools(),
        categories,
        maxTotal: 2,
      }).selected.map((item) => item.itemId),
    ).toEqual(["h1", "c1"]);
  });
});

describe("Shopee read-only preview", () => {
  it("deduplicates both feeds and records deterministic conflicts", async () => {
    const result = await previewShopeeDatafeeds({
      files: [officialFixture, brazilFixture],
      environment,
    });
    expect(result).toMatchObject({
      duplicateItems: 1,
      mergeConflicts: 3,
      databaseWrites: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      publicationAllowed: false,
      linksVerified: false,
    });
    expect(
      result.selected.find((item) => item.itemId === "2001")?.sources,
    ).toEqual(["BRAZIL", "OFFICIAL_BR"]);
  });

  it("produces the same winners when feed order changes", async () => {
    const first = await previewShopeeDatafeeds({
      files: [officialFixture, brazilFixture],
      environment,
    });
    const second = await previewShopeeDatafeeds({
      files: [brazilFixture, officialFixture],
      environment,
    });
    expect(second.selected).toEqual(first.selected);
  });

  it("selects the six fixture categories in round robin", async () => {
    const result = await previewShopeeDatafeeds({
      files: [officialFixture, brazilFixture],
      environment,
    });
    expect(result.selected.map((item) => item.category)).toEqual([
      "CELULARES",
      "CASA",
      "MODA",
      "RELOGIOS",
      "AUTOMOTIVO",
      "ELETRODOMESTICOS",
    ]);
  });

  it("keeps every candidate link unverified", async () => {
    const result = await previewShopeeDatafeeds({
      files: [officialFixture, brazilFixture],
      environment,
    });
    expect(
      result.selected.every((item) => item.linkStatus === "NOT_VERIFIED"),
    ).toBe(true);
  });

  it("returns an unverified result from the Datafeed link provider", async () => {
    await expect(
      new DatafeedAffiliateLinkProvider().resolve(product()),
    ).resolves.toMatchObject({
      status: "UNVERIFIED",
      reason: "SHOPEE_DATAFEED_ATTRIBUTION_NOT_VERIFIED",
    });
  });
});
