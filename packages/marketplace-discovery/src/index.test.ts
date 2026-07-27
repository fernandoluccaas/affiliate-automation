import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MercadoLivreApiError,
  type MarketplaceConnector,
  type MercadoLivreProduct,
} from "@affiliate/marketplace-connectors";
import {
  MercadoLivreDiscoveryService,
  MercadoLivreHighlightResolver,
  createMercadoLivreDiscoveryMetrics,
  discoverCandidatesFromLeafCategories,
  passesMinimumDiscount,
} from "./index";

function catalogProduct(
  overrides: Partial<MercadoLivreProduct>,
): MercadoLivreProduct {
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

function connector(overrides: Partial<MarketplaceConnector> = {}) {
  return {
    marketplace: "MERCADO_LIVRE",
    healthCheck: vi.fn().mockResolvedValue(true),
    getItem: vi.fn().mockResolvedValue(null),
    getItems: vi.fn().mockResolvedValue([]),
    getItemsWithDiagnostics: vi.fn().mockResolvedValue({
      candidates: [],
      diagnostics: {
        itemsFetched: 0,
        priceApiFetched: 0,
        priceFallbackUsed: 0,
        priceUnavailable: 0,
      },
    }),
    getPrice: vi.fn(),
    getSiteCategories: vi.fn().mockResolvedValue([]),
    getCategory: vi.fn().mockResolvedValue({
      id: "MLB123",
      name: "Celulares",
      pathFromRoot: [{ id: "MLB123", name: "Celulares" }],
      children: [],
    }),
    getCategoryChildren: vi.fn().mockResolvedValue([]),
    getBestSellers: vi.fn().mockResolvedValue([]),
    getProduct: vi.fn().mockResolvedValue(null),
    getUserProduct: vi.fn().mockResolvedValue(null),
    getItemsByUserProduct: vi.fn().mockResolvedValue([]),
    probeCategorySearch: vi.fn(),
    ...overrides,
  } as MarketplaceConnector;
}

function connectedAccount() {
  return {
    id: "account-1",
    marketplace: "MERCADO_LIVRE",
    status: "CONNECTED",
    enabled: true,
  };
}

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "config-1",
    enabled: true,
    siteId: "MLB",
    categoryIds: ["MLB123"],
    bestSellersEnabled: true,
    minimumPrice: null,
    maximumPrice: null,
    minimumDiscountPercentage: null,
    minimumScore: 0,
    maxCandidatesPerCategory: 5,
    refreshIntervalMinutes: 360,
    lastRunAt: null,
    ...overrides,
  };
}

function fakeDatabase(config = enabledConfig()) {
  const database = {
    mercadoLivreDiscoveryConfig: {
      findFirst: vi.fn().mockResolvedValue(config),
      update: vi.fn().mockResolvedValue({}),
    },
    marketplaceAccount: {
      findFirst: vi.fn().mockResolvedValue(connectedAccount()),
      update: vi.fn().mockResolvedValue({}),
    },
    automationRun: {
      create: vi.fn().mockResolvedValue({ id: "run-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    systemAlert: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi
      .fn()
      .mockImplementation(async (operations: unknown[]) =>
        Promise.all(operations),
      ),
  };

  return database;
}

function acquiredLock() {
  return {
    key: "lock",
    token: "token",
    acquired: true,
    mode: "redis-url",
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe("shared discovery architecture", () => {
  it("is the single import used by dashboard and worker", () => {
    const repositoryRoot = resolve(process.cwd(), "../..");
    const dashboard = readFileSync(
      resolve(repositoryRoot, "apps/dashboard/src/lib/actions.ts"),
      "utf8",
    );
    const worker = readFileSync(
      resolve(repositoryRoot, "apps/worker/src/index.ts"),
      "utf8",
    );

    expect(dashboard).toContain('from "@affiliate/marketplace-discovery"');
    expect(worker).toContain('from "@affiliate/marketplace-discovery"');
    expect(dashboard).not.toContain("function collectMercadoLivreCandidates");
    expect(worker).not.toContain("function collectMercadoLivreCandidates");
  });
});

describe("minimum policies", () => {
  it("treats Decimal zero as no discount requirement", () => {
    expect(passesMinimumDiscount({ toString: () => "0" }, null)).toBe(true);
  });

  it("blocks unknown discount when a positive minimum is configured", () => {
    expect(passesMinimumDiscount({ toString: () => "10" }, null)).toBe(false);
  });

  it("passes a proven discount above a positive minimum", () => {
    expect(passesMinimumDiscount("10", 15)).toBe(true);
  });
});

describe("MercadoLivreHighlightResolver", () => {
  it("resolves a direct PRODUCT winner", async () => {
    const resolver = new MercadoLivreHighlightResolver(
      connector({
        getProduct: vi.fn().mockResolvedValue(
          catalogProduct({
            id: "MLBPRODUCT",
            buyBoxWinnerItemId: "MLBITEM",
            buyBoxWinner: { itemId: "MLBITEM", price: 100 },
            buyBoxWinnerPrice: 100,
          }),
        ),
      }),
    );

    await expect(
      resolver.resolveCandidate({
        id: "MLBPRODUCT",
        position: 1,
        type: "PRODUCT",
        rawType: "PRODUCT",
        categoryId: "MLB123",
      }),
    ).resolves.toMatchObject({
      ok: true,
      candidate: {
        resolvedItemId: "MLBITEM",
        resolutionStrategy: "PRODUCT_DIRECT_BUY_BOX",
      },
    });
  });

  it("resolves a PRODUCT parent through the best child", async () => {
    const marketplace = connector({
      getProduct: vi.fn(async (id: string) => {
        const products: Record<string, MercadoLivreProduct> = {
          MLB100: catalogProduct({
            id: "MLB100",
            childrenIds: ["MLB101", "MLB102"],
          }),
          MLB101: catalogProduct({
            id: "MLB101",
            soldQuantity: 50,
            buyBoxWinnerItemId: "MLBITEM1",
            buyBoxWinnerPrice: 100,
          }),
          MLB102: catalogProduct({
            id: "MLB102",
            soldQuantity: 100,
            buyBoxWinnerItemId: "MLBITEM2",
            buyBoxWinnerPrice: 110,
          }),
        };
        return products[id] ?? null;
      }),
    });
    const resolver = new MercadoLivreHighlightResolver(marketplace);

    await expect(
      resolver.resolveCandidate({
        id: "MLB100",
        position: 1,
        type: "PRODUCT",
        rawType: "PRODUCT",
        categoryId: "MLB123",
      }),
    ).resolves.toMatchObject({
      ok: true,
      candidate: {
        resolvedProductId: "MLB102",
        resolvedItemId: "MLBITEM2",
        resolutionStrategy: "PRODUCT_CHILD_BUY_BOX",
      },
      diagnostics: { productResolvedViaChild: 1 },
    });
  });

  it("records a terminal PRODUCT without winner as a semantic skip", async () => {
    const resolver = new MercadoLivreHighlightResolver(
      connector({
        getProduct: vi
          .fn()
          .mockResolvedValue(
            catalogProduct({ id: "MLBPRODUCT", childrenIds: [] }),
          ),
      }),
    );

    await expect(
      resolver.resolveCandidate({
        id: "MLBPRODUCT",
        position: 1,
        type: "PRODUCT",
        rawType: "PRODUCT",
        categoryId: "MLB123",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "PRODUCT_LEAF_NO_BUY_BOX_WINNER",
      diagnostics: { productLeafWithoutWinner: 1 },
    });
  });
});

describe("candidate collection metrics", () => {
  it("deduplicates resolved items and records precise price sources", async () => {
    const marketplace = connector({
      getBestSellers: vi.fn().mockResolvedValue([
        {
          id: "MLB1",
          position: 1,
          type: "ITEM",
          rawType: "ITEM",
          categoryId: "MLB123",
        },
        {
          id: "MLB1",
          position: 2,
          type: "ITEM",
          rawType: "ITEM",
          categoryId: "MLB123",
        },
      ]),
      getItemsWithDiagnostics: vi.fn().mockResolvedValue({
        candidates: [
          {
            marketplace: "MERCADO_LIVRE",
            externalProductId: "MLB1",
            title: "Produto",
            productUrl: "https://produto.example/MLB1",
            currentPrice: 100,
          },
        ],
        diagnostics: {
          itemsFetched: 1,
          priceApiFetched: 0,
          priceFallbackUsed: 1,
          priceUnavailable: 0,
        },
      }),
    });
    const metrics = createMercadoLivreDiscoveryMetrics();
    const candidates = await discoverCandidatesFromLeafCategories(
      marketplace,
      ["MLB123"],
      5,
      metrics,
    );

    expect(candidates).toHaveLength(1);
    expect(metrics).toMatchObject({
      candidatesFound: 2,
      resolvedItemCandidates: 2,
      uniqueCandidates: 1,
      itemsFetched: 1,
      priceApiFetched: 0,
      priceFallbackUsed: 1,
      priceUnavailable: 0,
    });
  });
});

describe("MercadoLivreDiscoveryService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not call highlights when best sellers is disabled", async () => {
    const database = fakeDatabase(enabledConfig({ bestSellersEnabled: false }));
    const createConnector = vi.fn();
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector,
    }).run();

    expect(result).toMatchObject({
      ok: false,
      status: "SKIPPED",
      errorCode: "DISCOVERY_SOURCE_DISABLED",
    });
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("passes minimumScore zero explicitly and records operational ingestion metadata", async () => {
    const database = fakeDatabase();
    const marketplace = connector({
      getBestSellers: vi
        .fn()
        .mockResolvedValue([
          {
            id: "MLB1",
            position: 1,
            type: "ITEM",
            rawType: "ITEM",
            categoryId: "MLB123",
          },
        ]),
      getItemsWithDiagnostics: vi.fn().mockResolvedValue({
        candidates: [
          {
            marketplace: "MERCADO_LIVRE",
            externalProductId: "MLB1",
            title: "Produto",
            productUrl: "https://produto.example/MLB1",
            currentPrice: 100,
          },
        ],
        diagnostics: {
          itemsFetched: 1,
          priceApiFetched: 1,
          priceFallbackUsed: 0,
          priceUnavailable: 0,
        },
      }),
    });
    const ingest = vi.fn().mockResolvedValue({
      ok: false,
      offerId: "offer-1",
      productId: "product-1",
      status: "READY_FOR_AFFILIATE_LINK",
      statusReason: "waiting",
      productCreated: true,
      offerCreated: true,
      offerReused: false,
    });
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector: vi.fn().mockResolvedValue(marketplace),
      ingest,
      lock: vi.fn().mockResolvedValue(acquiredLock()),
    }).run(new Date("2026-07-27T12:00:00.000Z"), { force: true });

    expect(ingest).toHaveBeenCalledWith(expect.anything(), {
      now: new Date("2026-07-27T12:00:00.000Z"),
      minScore: 0,
    });
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      metrics: {
        newProducts: 1,
        newOfferVersions: 1,
        existingOffers: 0,
        readyForAffiliateLink: 1,
      },
    });
  });

  it("returns already-running without duplicating API calls", async () => {
    const database = fakeDatabase();
    const createConnector = vi.fn();
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector,
      lock: vi.fn().mockResolvedValue({ ...acquiredLock(), acquired: false }),
    }).run(new Date(), { force: true });

    expect(result).toMatchObject({
      status: "SKIPPED",
      errorCode: "DISCOVERY_ALREADY_RUNNING",
    });
    expect(createConnector).not.toHaveBeenCalled();
    expect(database.automationRun.create).not.toHaveBeenCalled();
  });

  it("returns PARTIAL when a category API error is isolated", async () => {
    const database = fakeDatabase();
    const marketplace = connector({
      getCategory: vi
        .fn()
        .mockRejectedValue(new MercadoLivreApiError("temporary", 503)),
    });
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector: vi.fn().mockResolvedValue(marketplace),
      lock: vi.fn().mockResolvedValue(acquiredLock()),
    }).run(new Date(), { force: true });

    expect(result).toMatchObject({
      ok: true,
      status: "PARTIAL",
      metrics: { errors: 1 },
    });
    expect(database.marketplaceAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ status: expect.anything() }),
      }),
    );
  });

  it("returns FAILED and preserves auth status on a transient global failure", async () => {
    const database = fakeDatabase();
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector: vi
        .fn()
        .mockRejectedValue(new MercadoLivreApiError("rate limit", 429)),
      lock: vi.fn().mockResolvedValue(acquiredLock()),
    }).run(new Date(), { force: true });

    expect(result).toMatchObject({
      ok: false,
      status: "FAILED",
      errorCode: "MELI_RATE_LIMIT",
    });
    expect(database.marketplaceAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ status: expect.anything() }),
      }),
    );
  });
});
