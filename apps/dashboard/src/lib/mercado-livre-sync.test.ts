import { describe, expect, it, vi } from "vitest";
import { MercadoLivreApiError, type MarketplaceConnector, type MercadoLivreProduct } from "@affiliate/marketplace-connectors";
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
    highlightItemCount: 0,
    highlightProductCount: 0,
    highlightUserProductCount: 0,
    highlightUnknownTypeCount: 0,
    productDirectWinnerCount: 0,
    productParentCount: 0,
    productLeafCount: 0,
    productResolvedDirectly: 0,
    productResolvedViaChild: 0,
    productLeafWithoutWinner: 0,
    productParentWithoutResolvableChild: 0,
    resolvedItemCandidates: 0,
    unresolvedCandidates: 0,
    candidateResolutionSkipReasons: {} as Record<string, number>,
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

function catalogProduct(overrides: Partial<MercadoLivreProduct>): MercadoLivreProduct {
  return {
    id: "MLB100",
    name: null,
    status: "active",
    parentId: null,
    childrenIds: [],
    soldQuantity: null,
    buyBoxWinner: null,
    buyBoxWinnerPriceRange: null,
    buyBoxWinnerItemId: null,
    buyBoxWinnerPrice: null,
    ...overrides,
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
    getProduct: vi.fn(),
    getUserProduct: vi.fn(),
    getItemsByUserProduct: vi.fn(),
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
      getBestSellers: vi.fn().mockResolvedValue([
        { id: "MLB1", position: 1, type: "ITEM", rawType: "ITEM", categoryId: "MLB123" },
      ]),
      getItems,
    });

    const candidates = await discoverCandidatesFromLeafCategories(marketplace, ["MLB123"], 5, runMetrics);

    expect(candidates).toHaveLength(1);
    expect(getItems).toHaveBeenCalledWith(["MLB1"]);
    expect(runMetrics.categoriesWithHighlights).toBe(1);
    expect(runMetrics.candidatesFound).toBe(1);
    expect(runMetrics.uniqueCandidates).toBe(1);
    expect(runMetrics.resolvedItemCandidates).toBe(1);
    expect(runMetrics.unresolvedCandidates).toBe(0);
  });

  it("resolves mixed highlight types before fetching items", async () => {
    const runMetrics = metrics();
    const getItems = vi.fn().mockResolvedValue([
      {
        marketplace: "MERCADO_LIVRE",
        externalProductId: "MLBUSERITEM",
        title: "User product",
        productUrl: "https://produto.example/MLBUSERITEM",
        currentPrice: 100,
      },
      {
        marketplace: "MERCADO_LIVRE",
        externalProductId: "MLBPRODUCTITEM",
        title: "Product",
        productUrl: "https://produto.example/MLBPRODUCTITEM",
        currentPrice: 120,
      },
      {
        marketplace: "MERCADO_LIVRE",
        externalProductId: "MLB1234567890",
        title: "Item",
        productUrl: "https://produto.example/MLB1234567890",
        currentPrice: 130,
      },
    ]);
    const marketplace = connector({
      getCategory: vi.fn().mockResolvedValue({
        id: "MLB123",
        name: "Celulares",
        pathFromRoot: [{ id: "MLB123", name: "Celulares" }],
        children: [],
      }),
      getBestSellers: vi.fn().mockResolvedValue([
        { id: "MLBU3013800008", position: 1, type: "USER_PRODUCT", rawType: "USER_PRODUCT", categoryId: "MLB123" },
        { id: "MLB61695785", position: 2, type: "PRODUCT", rawType: "PRODUCT", categoryId: "MLB123" },
        { id: "MLB1234567890", position: 3, type: "ITEM", rawType: "ITEM", categoryId: "MLB123" },
      ]),
      getUserProduct: vi.fn().mockResolvedValue({ id: "MLBU3013800008", userId: "321" }),
      getItemsByUserProduct: vi.fn().mockResolvedValue(["MLBUSERITEM"]),
      getProduct: vi.fn().mockResolvedValue(
        catalogProduct({
          id: "MLB61695785",
          buyBoxWinner: { itemId: "MLBPRODUCTITEM", price: 120 },
          buyBoxWinnerItemId: "MLBPRODUCTITEM",
          buyBoxWinnerPrice: 120,
        }),
      ),
      getItems,
    });

    const candidates = await discoverCandidatesFromLeafCategories(marketplace, ["MLB123"], 5, runMetrics);

    expect(candidates).toHaveLength(3);
    expect(getItems).toHaveBeenLastCalledWith(["MLBUSERITEM", "MLBPRODUCTITEM", "MLB1234567890"]);
    expect(runMetrics).toMatchObject({
      candidatesFound: 3,
      uniqueCandidates: 3,
      highlightItemCount: 1,
      highlightProductCount: 1,
      highlightUserProductCount: 1,
      productDirectWinnerCount: 1,
      productResolvedDirectly: 1,
      resolvedItemCandidates: 3,
      unresolvedCandidates: 0,
    });
  });

  it("records parent product resolution through children without failing the category", async () => {
    const runMetrics = metrics();
    const getItems = vi.fn().mockResolvedValue([
      {
        marketplace: "MERCADO_LIVRE",
        externalProductId: "MLB9002",
        title: "Produto",
        productUrl: "https://produto.example/MLB9002",
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
      getBestSellers: vi.fn().mockResolvedValue([
        { id: "MLB100", position: 1, type: "PRODUCT", rawType: "PRODUCT", categoryId: "MLB123" },
      ]),
      getProduct: vi.fn(async (id: string) => {
        const products: Record<string, MercadoLivreProduct> = {
          MLB100: catalogProduct({ id: "MLB100", status: "inactive", childrenIds: ["MLB101", "MLB102"] }),
          MLB101: catalogProduct({
            id: "MLB101",
            soldQuantity: 50,
            buyBoxWinner: { itemId: "MLB9001", price: 1000 },
            buyBoxWinnerItemId: "MLB9001",
            buyBoxWinnerPrice: 1000,
          }),
          MLB102: catalogProduct({
            id: "MLB102",
            soldQuantity: 100,
            buyBoxWinner: { itemId: "MLB9002", price: 1100 },
            buyBoxWinnerItemId: "MLB9002",
            buyBoxWinnerPrice: 1100,
          }),
        };

        return products[id] ?? null;
      }),
      getItems,
    });

    const candidates = await discoverCandidatesFromLeafCategories(marketplace, ["MLB123"], 5, runMetrics);

    expect(candidates).toHaveLength(1);
    expect(getItems).toHaveBeenLastCalledWith(["MLB9002"]);
    expect(runMetrics).toMatchObject({
      candidatesFound: 1,
      uniqueCandidates: 1,
      productParentCount: 1,
      productLeafCount: 2,
      productResolvedViaChild: 1,
      resolvedItemCandidates: 1,
      unresolvedCandidates: 0,
    });
  });

  it("records unresolved leaf product highlights without failing the category", async () => {
    const runMetrics = metrics();
    const marketplace = connector({
      getCategory: vi.fn().mockResolvedValue({
        id: "MLB123",
        name: "Celulares",
        pathFromRoot: [{ id: "MLB123", name: "Celulares" }],
        children: [],
      }),
      getBestSellers: vi.fn().mockResolvedValue([
        { id: "MLB61695785", position: 1, type: "PRODUCT", rawType: "PRODUCT", categoryId: "MLB123" },
      ]),
      getProduct: vi.fn().mockResolvedValue(catalogProduct({ id: "MLB61695785", childrenIds: [] })),
    });

    const candidates = await discoverCandidatesFromLeafCategories(marketplace, ["MLB123"], 5, runMetrics);

    expect(candidates).toEqual([]);
    expect(runMetrics.categoriesWithHighlights).toBe(1);
    expect(runMetrics.candidatesFound).toBe(1);
    expect(runMetrics.uniqueCandidates).toBe(0);
    expect(runMetrics.productLeafWithoutWinner).toBe(1);
    expect(runMetrics.candidateResolutionSkipReasons).toEqual({ PRODUCT_LEAF_NO_BUY_BOX_WINNER: 1 });
  });
});
