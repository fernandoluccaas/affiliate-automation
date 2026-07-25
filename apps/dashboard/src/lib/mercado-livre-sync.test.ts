import { describe, expect, it, vi } from "vitest";
import { MercadoLivreApiError, type MarketplaceConnector } from "@affiliate/marketplace-connectors";
import { discoverCandidatesFromLeafCategories } from "./mercado-livre-sync";

vi.mock("@affiliate/database", () => ({
  prisma: {},
}));

vi.mock("@affiliate/ingestion", () => ({
  ingestOffer: vi.fn(),
}));

function metrics() {
  return {
    categoriesProcessed: 0,
    categoriesWithHighlights: 0,
    categoriesSkipped: 0,
    categorySkipReasons: {} as Record<string, number>,
    candidatesFound: 0,
    uniqueCandidates: 0,
    itemsFetched: 0,
    pricesFetched: 0,
    newProducts: 0,
    newOfferVersions: 0,
    existingOffers: 0,
    readyForAffiliateLink: 0,
    rejected: 0,
    errors: 0,
  };
}

function connector(overrides: Partial<MarketplaceConnector>): MarketplaceConnector {
  return {
    marketplace: "MERCADO_LIVRE",
    healthCheck: vi.fn(),
    getItem: vi.fn(),
    getItems: vi.fn().mockResolvedValue([]),
    getPrice: vi.fn(),
    getSiteCategories: vi.fn(),
    getCategory: vi.fn(),
    getCategoryChildren: vi.fn(),
    getBestSellers: vi.fn(),
    discoverCandidates: vi.fn(),
    ...overrides,
  } as MarketplaceConnector;
}

describe("discoverCandidatesFromLeafCategories", () => {
  it("skips a category with children as CATEGORY_NOT_LEAF", async () => {
    const runMetrics = metrics();
    const marketplace = connector({
      getCategory: vi.fn().mockResolvedValue({
        id: "MLB1055",
        name: "Eletronicos",
        pathFromRoot: [{ id: "MLB1055", name: "Eletronicos" }],
        children: [{ id: "MLB123", name: "Celulares" }],
      }),
    });

    const candidates = await discoverCandidatesFromLeafCategories(marketplace, ["MLB1055"], 5, runMetrics);

    expect(candidates).toEqual([]);
    expect(runMetrics).toMatchObject({
      categoriesProcessed: 1,
      categoriesSkipped: 1,
      categorySkipReasons: { CATEGORY_NOT_LEAF: 1 },
      candidatesFound: 0,
    });
    expect(marketplace.getBestSellers).not.toHaveBeenCalled();
  });

  it("skips nonexistent category as CATEGORY_NOT_FOUND", async () => {
    const runMetrics = metrics();
    const marketplace = connector({
      getCategory: vi.fn().mockRejectedValue(new MercadoLivreApiError("Category not found", 404)),
    });

    await discoverCandidatesFromLeafCategories(marketplace, ["MLB404"], 5, runMetrics);

    expect(runMetrics.categorySkipReasons).toEqual({ CATEGORY_NOT_FOUND: 1 });
  });

  it("skips leaf category without highlights as NO_HIGHLIGHTS_FOR_CATEGORY", async () => {
    const runMetrics = metrics();
    const marketplace = connector({
      getCategory: vi.fn().mockResolvedValue({
        id: "MLB123",
        name: "Celulares",
        pathFromRoot: [{ id: "MLB123", name: "Celulares" }],
        children: [],
      }),
      getBestSellers: vi.fn().mockResolvedValue([]),
    });

    await discoverCandidatesFromLeafCategories(marketplace, ["MLB123"], 5, runMetrics);

    expect(runMetrics.categorySkipReasons).toEqual({ NO_HIGHLIGHTS_FOR_CATEGORY: 1 });
  });

  it("records highlights 404 as NO_HIGHLIGHTS_FOR_CATEGORY", async () => {
    const runMetrics = metrics();
    const marketplace = connector({
      getCategory: vi.fn().mockResolvedValue({
        id: "MLB123",
        name: "Celulares",
        pathFromRoot: [{ id: "MLB123", name: "Celulares" }],
        children: [],
      }),
      getBestSellers: vi
        .fn()
        .mockRejectedValue(new MercadoLivreApiError("Dimension CATEGORY with id MLB123 not found", 404)),
    });

    await discoverCandidatesFromLeafCategories(marketplace, ["MLB123"], 5, runMetrics);

    expect(runMetrics.categorySkipReasons).toEqual({ NO_HIGHLIGHTS_FOR_CATEGORY: 1 });
  });

  it("fetches items for leaf category with highlights", async () => {
    const runMetrics = metrics();
    const getItems = vi.fn().mockResolvedValue([
      {
        marketplace: "MERCADO_LIVRE",
        externalProductId: "MLB1",
        title: "Produto",
        productUrl: "https://produto.example/MLB1",
        currentPrice: 100,
      },
    ]);
    const marketplace = connector({
      getCategory: vi.fn().mockResolvedValue({
        id: "MLB123",
        name: "Celulares",
        pathFromRoot: [{ id: "MLB123", name: "Celulares" }],
        children: [],
      }),
      getBestSellers: vi.fn().mockResolvedValue([{ externalId: "MLB1", position: 1, type: "ITEM" }]),
      getItems,
    });

    const candidates = await discoverCandidatesFromLeafCategories(marketplace, ["MLB123"], 5, runMetrics);

    expect(candidates).toHaveLength(1);
    expect(getItems).toHaveBeenCalledWith(["MLB1"]);
    expect(runMetrics.categoriesWithHighlights).toBe(1);
    expect(runMetrics.candidatesFound).toBe(1);
  });
});
