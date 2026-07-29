import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MercadoLivreAffiliateApiError,
  MercadoLivreApiError,
  type MarketplaceConnector,
  type MercadoLivreProduct,
} from "@affiliate/marketplace-connectors";
import {
  MercadoLivreDiscoveryService,
  MercadoLivreHighlightResolver,
  createMercadoLivreDiscoveryMetrics,
  discoverCandidatesFromLeafCategories,
  generatePendingMercadoLivreAffiliateLinks,
  passesMinimumDiscount,
  refreshMercadoLivreOffers,
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
    importJob: {
      create: vi.fn().mockResolvedValue({ id: "import-job-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    importJobItem: {
      create: vi.fn().mockResolvedValue({}),
    },
    mercadoLivreAffiliateSession: {
      findUnique: vi.fn().mockResolvedValue({
        status: "CONNECTED",
        affiliateTag: "default-tag",
        cookieEncrypted: "encrypted-cookie",
        csrfTokenEncrypted: null,
        updatedAt: new Date("2026-07-28T00:00:00.000Z"),
      }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    offer: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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

function offerCandidate(id: string) {
  return {
    marketplace: "MERCADO_LIVRE" as const,
    externalProductId: id,
    title: `Produto ${id}`,
    productUrl: `https://www.mercadolivre.com.br/p/${id}`,
    currentPrice: 100,
    shippingStatus: "UNKNOWN" as const,
    stockStatus: "IN_STOCK" as const,
  };
}

function readyIngestResult(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ok: true,
    offerId: `offer-${id}`,
    productId: `product-${id}`,
    status: "READY_TO_PUBLISH",
    statusReason: "ready",
    productCreated: true,
    offerCreated: true,
    offerReused: false,
    offerUpdated: false,
    ...overrides,
  };
}

function refreshOffer(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `offer-${id}`,
    externalProductId: id,
    affiliateUrl: `https://meli.la/${id.toLowerCase()}`,
    affiliateLabel: "default-tag",
    affiliateEligibility: "ELIGIBLE",
    affiliateFailure: null,
    trackingStrategy: "DIRECT_AFFILIATE_LINK",
    sourceCategoryId: "MLB123",
    bestSellerPosition: 1,
    sourceHighlightId: id,
    sourceHighlightType: "ITEM",
    resolutionStrategy: "ITEM_DIRECT",
    minimumScoreApplied: 70,
    ...overrides,
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
    expect(candidates[0]).toMatchObject({
      sourceCategoryId: "MLB123",
      bestSellerPosition: 1,
      sourceHighlightId: "MLB1",
      sourceHighlightType: "ITEM",
      resolutionStrategy: "ITEM_DIRECT",
    });
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

  it("generates a link before ingestion and passes minimumScore zero explicitly", async () => {
    const database = fakeDatabase();
    const marketplace = connector({
      getBestSellers: vi.fn().mockResolvedValue([
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
      ok: true,
      offerId: "offer-1",
      productId: "product-1",
      status: "READY_TO_PUBLISH",
      statusReason: "ready",
      productCreated: true,
      offerCreated: true,
      offerReused: false,
    });
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector: vi.fn().mockResolvedValue(marketplace),
      affiliateLinkProvider: {
        generate: vi.fn().mockResolvedValue({
          status: "GENERATED",
          affiliateUrl: "https://meli.la/affiliate-1",
          provider: "official-api-test",
        }),
      },
      decryptCredential: vi.fn().mockReturnValue("session=opaque"),
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
        readyToPublish: 1,
        affiliateLinksGenerated: 1,
      },
    });
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        affiliateUrl: "https://meli.la/affiliate-1",
        affiliateEligibility: "ELIGIBLE",
        affiliateFailure: null,
      }),
      expect.anything(),
    );
  });

  it("returns already-running without duplicating API calls", async () => {
    const database = fakeDatabase();
    const createConnector = vi.fn();
    const lock = vi
      .fn()
      .mockResolvedValue({ ...acquiredLock(), acquired: false });
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector,
      lock,
    }).run(new Date(), { force: true });

    expect(result).toMatchObject({
      status: "SKIPPED",
      errorCode: "DISCOVERY_ALREADY_RUNNING",
    });
    expect(createConnector).not.toHaveBeenCalled();
    expect(database.automationRun.create).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledWith(
      "mercado-livre:discovery:account-1",
      10 * 60 * 1000,
    );
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

describe("MercadoLivre affiliate discovery enrichment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("processes a mixed ITEM, PRODUCT and USER_PRODUCT ranking without aborting the batch", async () => {
    const database = fakeDatabase();
    const marketplace = connector({
      getBestSellers: vi.fn().mockResolvedValue([
        {
          id: "MLBITEM1",
          position: 1,
          type: "ITEM",
          rawType: "ITEM",
          categoryId: "MLB123",
        },
        {
          id: "MLBPRODUCT",
          position: 2,
          type: "PRODUCT",
          rawType: "PRODUCT",
          categoryId: "MLB123",
        },
        {
          id: "MLBUSER",
          position: 3,
          type: "USER_PRODUCT",
          rawType: "USER_PRODUCT",
          categoryId: "MLB123",
        },
        {
          id: "MLBITEM4",
          position: 4,
          type: "ITEM",
          rawType: "ITEM",
          categoryId: "MLB123",
        },
      ]),
      getProduct: vi.fn().mockResolvedValue(
        catalogProduct({
          id: "MLBPRODUCT",
          buyBoxWinnerItemId: "MLBITEM2",
        }),
      ),
      getUserProduct: vi.fn().mockResolvedValue({
        id: "MLBUSER",
        userId: "seller-1",
      }),
      getItemsByUserProduct: vi.fn().mockResolvedValue(["MLBITEM3"]),
      getItems: vi.fn().mockResolvedValue([offerCandidate("MLBITEM3")]),
      getItemsWithDiagnostics: vi.fn(async (ids: string[]) => ({
        candidates: ids.map(offerCandidate),
        diagnostics: {
          itemsFetched: ids.length,
          priceApiFetched: ids.length,
          priceFallbackUsed: 0,
          priceUnavailable: 0,
        },
      })),
    });
    let active = 0;
    let maximumActive = 0;
    const createLink = vi.fn(async ({ productUrl }: { productUrl: string }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      active -= 1;

      if (productUrl.includes("MLBITEM3")) {
        return { status: "INELIGIBLE" as const, reason: "not eligible" };
      }

      if (productUrl.includes("MLBITEM4")) {
        return { status: "MANUAL_REQUIRED" as const, reason: "manual" };
      }

      const itemId = productUrl.split("/").pop();
      return {
        status: "GENERATED" as const,
        affiliateUrl: `https://meli.la/${itemId}`,
        provider: "official-api-test",
      };
    });
    const ingest = vi.fn(async (rawInput: unknown) => {
      const input = rawInput as {
        externalProductId: string;
        affiliateEligibility: string;
        affiliateUrl?: string;
      };

      if (input.affiliateEligibility === "INELIGIBLE") {
        return readyIngestResult(input.externalProductId, {
          ok: false,
          status: "REJECTED_INVALID_DATA",
          statusReason: "ineligible",
        });
      }

      if (!input.affiliateUrl) {
        return readyIngestResult(input.externalProductId, {
          ok: false,
          status: "READY_FOR_AFFILIATE_LINK",
          statusReason: "pending",
        });
      }

      return readyIngestResult(input.externalProductId);
    });
    const emitOperationalMetric = vi.fn();
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector: vi.fn().mockResolvedValue(marketplace),
      affiliateLinkProvider: { generate: createLink as never },
      affiliateConcurrency: 99,
      decryptCredential: vi.fn().mockReturnValue("session=opaque"),
      emitOperationalMetric,
      ingest: ingest as never,
      lock: vi.fn().mockResolvedValue(acquiredLock()),
    }).run(new Date("2026-07-28T12:00:00.000Z"), { force: true });

    expect(result).toMatchObject({
      ok: true,
      status: "PARTIAL",
      importJobId: "import-job-1",
      metrics: {
        affiliateLinkAttempts: 4,
        affiliateLinksGenerated: 2,
        affiliateIneligible: 1,
        affiliatePending: 1,
        readyToPublish: 2,
        readyForAffiliateLink: 1,
      },
    });
    expect(ingest).toHaveBeenCalledTimes(4);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(
      ingest.mock.calls.map(([input]) => ({
        sourceType: (input as { sourceHighlightType: string })
          .sourceHighlightType,
        strategy: (input as { resolutionStrategy: string }).resolutionStrategy,
        category: (input as { sourceCategoryId: string }).sourceCategoryId,
        position: (input as { bestSellerPosition: number }).bestSellerPosition,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          sourceType: "ITEM",
          strategy: "ITEM_DIRECT",
          category: "MLB123",
          position: 1,
        },
        {
          sourceType: "PRODUCT",
          strategy: "PRODUCT_DIRECT_BUY_BOX",
          category: "MLB123",
          position: 2,
        },
        {
          sourceType: "USER_PRODUCT",
          strategy: "USER_PRODUCT_ACTIVE_ITEM",
          category: "MLB123",
          position: 3,
        },
      ]),
    );
    const itemStatuses = database.importJobItem.create.mock.calls.map(
      ([call]) => call.data.status,
    );
    expect(itemStatuses).toEqual(
      expect.arrayContaining([
        "SUCCEEDED",
        "INELIGIBLE",
        "PENDING_AFFILIATE_LINK",
      ]),
    );
    expect(database.importJobItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalItemId: "MLBITEM4",
          attempts: 1,
          status: "PENDING_AFFILIATE_LINK",
        }),
      }),
    );
    expect(database.importJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUCCEEDED_WITH_ERRORS",
          totalFound: 4,
          totalResolved: 4,
          totalLinksGenerated: 2,
          totalReadyToPublish: 2,
          totalReadyForAffiliateLink: 1,
          totalIneligible: 1,
          totalCreated: 4,
          totalFailed: 0,
        }),
      }),
    );
    const emittedEvents = emitOperationalMetric.mock.calls.map(
      ([event]) => event,
    );
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        "mercadolivre_import_created",
        "mercadolivre_discovery_items_found",
        "mercadolivre_discovery_items_resolved",
        "mercadolivre_affiliate_link_generated",
        "mercadolivre_discovery_items_ineligible",
        "mercadolivre_discovery_items_pending_link",
        "mercadolivre_import_updated",
      ]),
    );
    expect(
      emitOperationalMetric.mock.calls.filter(
        ([event]) => event === "mercadolivre_affiliate_link_generated",
      ),
    ).toHaveLength(2);
    expect(JSON.stringify(emitOperationalMetric.mock.calls)).not.toContain(
      "session=opaque",
    );
  });

  it("treats manual-required results as a successful pending discovery", async () => {
    const database = fakeDatabase(
      enabledConfig({ maxCandidatesPerCategory: 20 }),
    );
    const highlights = Array.from({ length: 8 }, (_, index) => ({
      id: `MLB${index + 1}`,
      position: index + 1,
      type: "ITEM" as const,
      rawType: "ITEM",
      categoryId: "MLB123",
    }));
    const marketplace = connector({
      getBestSellers: vi.fn().mockResolvedValue(highlights),
      getItemsWithDiagnostics: vi.fn(async (ids: string[]) => ({
        candidates: ids.map(offerCandidate),
        diagnostics: {
          itemsFetched: ids.length,
          priceApiFetched: ids.length,
          priceFallbackUsed: 0,
          priceUnavailable: 0,
        },
      })),
    });
    let calls = 0;
    const createLink = vi.fn(async () => {
      calls += 1;

      if (calls === 1) {
        throw new MercadoLivreAffiliateApiError("expired", {
          stage: "LINK_GENERATION",
          status: 401,
          sessionExpired: true,
        });
      }

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      return { affiliateUrl: `https://meli.la/success-${calls}` };
    });
    const ingest = vi.fn(async (rawInput: unknown) => {
      const input = rawInput as {
        externalProductId: string;
        affiliateUrl?: string;
      };
      return readyIngestResult(
        input.externalProductId,
        input.affiliateUrl
          ? {}
          : {
              ok: false,
              status: "READY_FOR_AFFILIATE_LINK",
              statusReason: "pending",
            },
      );
    });
    const emitOperationalMetric = vi.fn();
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector: vi.fn().mockResolvedValue(marketplace),
      affiliateLinkService: { create: createLink },
      decryptCredential: vi.fn().mockReturnValue("session=opaque"),
      emitOperationalMetric,
      ingest: ingest as never,
      lock: vi.fn().mockResolvedValue(acquiredLock()),
    }).run(new Date("2026-07-28T13:00:00.000Z"), { force: true });

    expect(result).toMatchObject({
      ok: true,
      status: "SUCCEEDED",
      metrics: {
        affiliateLinkAttempts: 8,
        affiliateLinksGenerated: 0,
        affiliatePending: 8,
        affiliateSkippedAfterSessionExpired: 0,
        readyForAffiliateLink: 8,
      },
    });
    expect(createLink).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledTimes(8);
    expect(
      database.mercadoLivreAffiliateSession.updateMany,
    ).not.toHaveBeenCalled();
    for (const [call] of database.marketplaceAccount.update.mock.calls) {
      expect(call.data).not.toHaveProperty("status");
    }
    expect(
      emitOperationalMetric.mock.calls.filter(
        ([event]) => event === "mercadolivre_discovery_items_pending_link",
      ),
    ).toHaveLength(8);
  });

  it("does not read, encrypt or rotate browser cookies during discovery", async () => {
    const database = fakeDatabase();
    const marketplace = connector({
      getBestSellers: vi.fn().mockResolvedValue([
        {
          id: "MLBA",
          position: 1,
          type: "ITEM",
          rawType: "ITEM",
          categoryId: "MLB123",
        },
        {
          id: "MLBB",
          position: 2,
          type: "ITEM",
          rawType: "ITEM",
          categoryId: "MLB123",
        },
      ]),
      getItemsWithDiagnostics: vi.fn(async (ids: string[]) => ({
        candidates: ids.map(offerCandidate),
        diagnostics: {
          itemsFetched: ids.length,
          priceApiFetched: ids.length,
          priceFallbackUsed: 0,
          priceUnavailable: 0,
        },
      })),
    });
    const createLink = vi.fn(async ({ productUrl }: { productUrl: string }) => {
      if (productUrl.endsWith("MLBA")) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        return {
          affiliateUrl: "https://meli.la/a",
          refreshedCookie: "sid=rotated-a; csrf-token=old; base=keep",
        };
      }

      return {
        affiliateUrl: "https://meli.la/b",
        refreshedCookie: "sid=old; csrf-token=rotated-b; base=keep",
      };
    });
    const encryptCredential = vi
      .fn()
      .mockReturnValue("encrypted-refreshed-cookie");
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector: vi.fn().mockResolvedValue(marketplace),
      affiliateLinkService: { create: createLink as never },
      decryptCredential: vi
        .fn()
        .mockReturnValue("sid=old; csrf-token=old; base=keep"),
      encryptCredential,
      ingest: vi
        .fn()
        .mockImplementation((input: { externalProductId: string }) =>
          Promise.resolve(readyIngestResult(input.externalProductId)),
        ) as never,
      lock: vi.fn().mockResolvedValue(acquiredLock()),
    }).run(new Date("2026-07-28T14:00:00.000Z"), { force: true });

    expect(result.status).toBe("SUCCEEDED");
    expect(createLink).not.toHaveBeenCalled();
    expect(encryptCredential).not.toHaveBeenCalled();
    expect(
      database.mercadoLivreAffiliateSession.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("reuses an existing generated link on repeated discovery without duplicating the product", async () => {
    const database = fakeDatabase();
    database.offer.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        externalProductId: "MLBREPEAT",
        affiliateUrl: "https://meli.la/stable",
        affiliateLabel: "default-tag",
      },
    ]);
    const marketplace = connector({
      getBestSellers: vi.fn().mockResolvedValue([
        {
          id: "MLBREPEAT",
          position: 8,
          type: "ITEM",
          rawType: "ITEM",
          categoryId: "MLB123",
        },
      ]),
      getItemsWithDiagnostics: vi.fn().mockResolvedValue({
        candidates: [offerCandidate("MLBREPEAT")],
        diagnostics: {
          itemsFetched: 1,
          priceApiFetched: 1,
          priceFallbackUsed: 0,
          priceUnavailable: 0,
        },
      }),
    });
    const productIds = new Set<string>();
    const ingest = vi.fn(async (rawInput: unknown) => {
      const input = rawInput as {
        externalProductId: string;
        affiliateFailure: unknown;
      };
      const existed = productIds.has(input.externalProductId);
      productIds.add(input.externalProductId);
      return readyIngestResult(input.externalProductId, {
        productCreated: !existed,
        offerCreated: !existed,
        offerReused: existed,
        offerUpdated: existed,
      });
    });
    const service = new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector: vi.fn().mockResolvedValue(marketplace),
      affiliateLinkProvider: {
        generate: vi.fn(async () => ({
          status: "GENERATED" as const,
          affiliateUrl: "https://meli.la/stable",
          provider: "official-api-test",
        })),
      },
      decryptCredential: vi.fn().mockReturnValue("session=opaque"),
      ingest: ingest as never,
      lock: vi.fn().mockResolvedValue(acquiredLock()),
    });

    const first = await service.run(new Date("2026-07-28T15:00:00.000Z"), {
      force: true,
    });
    const second = await service.run(new Date("2026-07-28T16:00:00.000Z"), {
      force: true,
    });

    expect(first.status).toBe("SUCCEEDED");
    expect(second).toMatchObject({
      status: "SUCCEEDED",
      metrics: { affiliateLinksReused: 1, updatedOffers: 1 },
    });
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(productIds).toEqual(new Set(["MLBREPEAT"]));
    for (const [input] of ingest.mock.calls) {
      expect(input).toMatchObject({
        affiliateUrl: "https://meli.la/stable",
        affiliateFailure: null,
        sourceCategoryId: "MLB123",
        bestSellerPosition: 8,
      });
    }
    expect(database.offer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "READY_FOR_AFFILIATE_LINK",
          affiliateUrl: null,
        }),
        data: expect.objectContaining({ status: "REJECTED_DUPLICATE" }),
      }),
    );
  });

  it("sanitizes an unexpected fatal error before persisting diagnostics", async () => {
    const database = fakeDatabase();
    const sensitiveMarker = "sensitive-marker";
    const unsafeMessage = `${["Cook", "ie"].join("")}: session=${sensitiveMarker}`;
    const result = await new MercadoLivreDiscoveryService({
      database: database as never,
      createConnector: vi.fn().mockRejectedValue(new Error(unsafeMessage)),
      lock: vi.fn().mockResolvedValue(acquiredLock()),
    }).run(new Date("2026-07-28T17:00:00.000Z"), { force: true });

    expect(result).toMatchObject({
      ok: false,
      status: "FAILED",
      errorMessage: "[REDACTED]",
    });
    expect(
      JSON.stringify([
        database.marketplaceAccount.update.mock.calls,
        database.systemAlert.create.mock.calls,
        database.importJob.update.mock.calls,
      ]),
    ).not.toContain(sensitiveMarker);
  });
});

describe("generatePendingMercadoLivreAffiliateLinks", () => {
  it("enriches the current pending offer through versioned ingestion and retires the old pending version", async () => {
    const database = fakeDatabase();
    const lock = vi.fn().mockResolvedValue(acquiredLock());
    database.offer.findFirst.mockResolvedValue({ id: "pending-1" });
    database.offer.findMany.mockResolvedValue([
      {
        id: "pending-1",
        productId: "product-MLBPENDING",
        externalProductId: "MLBPENDING",
        title: "Produto pendente",
        description: null,
        category: "MLB123",
        imageUrl: null,
        productUrl: "https://www.mercadolivre.com.br/p/MLBPENDING",
        affiliateLabel: null,
        sellerId: null,
        officialStoreId: null,
        sourceCategoryId: "MLB123",
        bestSellerPosition: 9,
        sourceHighlightId: "MLBPRODUCT",
        sourceHighlightType: "PRODUCT",
        resolutionStrategy: "PRODUCT_DIRECT_BUY_BOX",
        trackingStrategy: "DIRECT_AFFILIATE_LINK",
        originalPrice: 120,
        currentPrice: 100,
        couponCode: null,
        couponExpiration: null,
        commissionPercentage: null,
        rating: null,
        salesCount: 10,
        shippingStatus: "FREE",
        stockStatus: "IN_STOCK",
        minimumScoreApplied: 70,
      },
    ]);
    const ingest = vi.fn().mockResolvedValue(
      readyIngestResult("MLBPENDING", {
        productCreated: false,
        offerCreated: true,
      }),
    );
    const result = await generatePendingMercadoLivreAffiliateLinks(
      { limit: 10, offerIds: ["pending-1"] },
      {
        database: database as never,
        affiliateLinkService: {
          create: vi.fn().mockResolvedValue({
            affiliateUrl: "https://meli.la/pending",
          }),
        },
        decryptCredential: vi.fn().mockReturnValue("session=opaque"),
        ingest,
        lock,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "SUCCEEDED",
      selected: 1,
      processed: 1,
      linksGenerated: 1,
      updated: 1,
      pending: 0,
      failed: 0,
    });
    expect(lock).toHaveBeenCalledWith(
      "mercado-livre:affiliate-link-operations:account-1",
      10 * 60 * 1000,
    );
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        externalProductId: "MLBPENDING",
        affiliateUrl: "https://meli.la/pending",
        affiliateFailure: null,
        sourceCategoryId: "MLB123",
        bestSellerPosition: 9,
      }),
      { now: expect.any(Date), minScore: 70 },
    );
    expect(database.offer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "offer-MLBPENDING" },
          status: "READY_FOR_AFFILIATE_LINK",
        }),
        data: expect.objectContaining({ status: "REJECTED_DUPLICATE" }),
      }),
    );
    expect(database.importJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUCCEEDED",
          totalLinksGenerated: 1,
          totalReadyToPublish: 1,
          totalUpdated: 1,
        }),
      }),
    );
  });

  it("reuses a valid link from an earlier version even when the affiliate session is unavailable", async () => {
    const database = fakeDatabase();
    database.offer.findMany
      .mockResolvedValueOnce([
        {
          id: "pending-reuse",
          productId: "product-reuse",
          externalProductId: "MLBREUSE",
          title: "Produto para reuso",
          description: null,
          category: "MLB123",
          imageUrl: null,
          productUrl: "https://www.mercadolivre.com.br/p/MLBREUSE",
          affiliateLabel: null,
          sellerId: null,
          officialStoreId: null,
          sourceCategoryId: "MLB123",
          bestSellerPosition: 4,
          sourceHighlightId: "MLBREUSE",
          sourceHighlightType: "ITEM",
          resolutionStrategy: "ITEM_DIRECT",
          trackingStrategy: "DIRECT_AFFILIATE_LINK",
          originalPrice: null,
          currentPrice: 100,
          couponCode: null,
          couponExpiration: null,
          commissionPercentage: null,
          rating: null,
          salesCount: null,
          shippingStatus: "UNKNOWN",
          stockStatus: "IN_STOCK",
          minimumScoreApplied: 70,
        },
      ])
      .mockResolvedValueOnce([
        {
          externalProductId: "MLBREUSE",
          affiliateUrl: "https://meli.la/reused",
          affiliateLabel: "prior-tag",
        },
      ]);
    database.offer.findFirst.mockResolvedValue({ id: "pending-reuse" });
    database.mercadoLivreAffiliateSession.findUnique.mockResolvedValue(null);
    const createLink = vi.fn();
    const ingest = vi.fn().mockResolvedValue(
      readyIngestResult("MLBREUSE", {
        productCreated: false,
        offerCreated: true,
      }),
    );

    const result = await generatePendingMercadoLivreAffiliateLinks(
      { limit: 10 },
      {
        database: database as never,
        affiliateLinkService: { create: createLink as never },
        ingest: ingest as never,
        lock: vi.fn().mockResolvedValue(acquiredLock()),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "SUCCEEDED",
      selected: 1,
      linksGenerated: 0,
      updated: 1,
    });
    expect(createLink).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        affiliateUrl: "https://meli.la/reused",
        affiliateLabel: "prior-tag",
        affiliateFailure: null,
      }),
      expect.anything(),
    );
  });

  it("supports a bounded dry run without reading or mutating affiliate credentials", async () => {
    const database = fakeDatabase();
    database.offer.findMany.mockResolvedValue([
      { id: "pending-1", externalProductId: "MLB1" },
      { id: "pending-2", externalProductId: "MLB2" },
    ]);
    const lock = vi.fn();
    const createLink = vi.fn();
    const result = await generatePendingMercadoLivreAffiliateLinks(
      { limit: 2, dryRun: true },
      {
        database: database as never,
        affiliateLinkService: { create: createLink as never },
        lock: lock as never,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "DRY_RUN",
      selected: 2,
      processed: 0,
      pending: 2,
    });
    expect(createLink).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(
      database.mercadoLivreAffiliateSession.findUnique,
    ).not.toHaveBeenCalled();
    expect(database.importJob.create).not.toHaveBeenCalled();
  });

  it("does not enrich an older pending version when a newer offer already exists", async () => {
    const database = fakeDatabase();
    database.offer.findMany.mockResolvedValue([
      {
        id: "old-pending",
        productId: "product-1",
        externalProductId: "MLB1",
      },
    ]);
    database.offer.findFirst.mockResolvedValue({ id: "new-current" });
    const createLink = vi.fn();
    const lock = vi.fn();
    const result = await generatePendingMercadoLivreAffiliateLinks(
      { limit: 10 },
      {
        database: database as never,
        affiliateLinkService: { create: createLink as never },
        lock: lock as never,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "SUCCEEDED",
      selected: 0,
      processed: 0,
    });
    expect(createLink).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(database.importJob.create).not.toHaveBeenCalled();
    expect(database.offer.updateMany).toHaveBeenCalledWith({
      where: {
        id: "old-pending",
        status: "READY_FOR_AFFILIATE_LINK",
        affiliateUrl: null,
      },
      data: {
        status: "REJECTED_DUPLICATE",
        statusReason: "Substituida por uma versao mais recente desta oferta.",
      },
    });
  });
});

describe("refreshMercadoLivreOffers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns real counters, preserves affiliate URLs and isolates an offer failure", async () => {
    const database = fakeDatabase();
    database.offer.findMany.mockResolvedValue([
      refreshOffer("MLBA"),
      refreshOffer("MLBB", {
        affiliateUrl: "https://meli.la/original-b",
        minimumScoreApplied: 80,
      }),
      refreshOffer("MLBC"),
      refreshOffer("MLBD"),
    ]);
    const marketplace = connector({
      getItemsWithDiagnostics: vi.fn().mockResolvedValue({
        candidates: ["MLBA", "MLBB", "MLBD"].map((id) => ({
          ...offerCandidate(id),
          affiliateUrl: "https://meli.la/connector-value-must-not-win",
        })),
        diagnostics: {
          itemsFetched: 3,
          priceApiFetched: 2,
          priceFallbackUsed: 1,
          priceUnavailable: 1,
        },
      }),
    });
    const sensitiveMarker = "refresh-sensitive-marker";
    const unsafeMessage = `${["Cook", "ie"].join("")}: session=${sensitiveMarker}`;
    const ingest = vi.fn(async (rawInput: unknown, _options?: unknown) => {
      const input = rawInput as { externalProductId: string };

      if (input.externalProductId === "MLBD") {
        throw new Error(unsafeMessage);
      }

      if (input.externalProductId === "MLBA") {
        return readyIngestResult("MLBA", {
          productCreated: false,
          offerCreated: false,
          offerReused: true,
          offerUpdated: true,
        });
      }

      return readyIngestResult("MLBB", {
        productCreated: false,
        offerCreated: true,
        offerReused: false,
      });
    });
    const result = await refreshMercadoLivreOffers(
      new Date("2026-07-28T18:00:00.000Z"),
      {
        database: database as never,
        createConnector: vi.fn().mockResolvedValue(marketplace),
        ingest: ingest as never,
      },
    );

    expect(result).toMatchObject({
      selected: 4,
      refreshed: 2,
      unchanged: 1,
      newVersions: 1,
      notFound: 1,
      failed: 1,
      affiliateUrlsPreserved: 2,
      itemsFetched: 3,
      priceApiFetched: 2,
      priceFallbackUsed: 1,
      priceUnavailable: 1,
      failures: [
        {
          externalProductId: "MLBD",
          errorMessage: "[REDACTED]",
        },
      ],
    });
    expect(ingest).toHaveBeenCalledTimes(3);
    const inputByExternalId = new Map(
      ingest.mock.calls.map(([input, options]) => [
        (input as { externalProductId: string }).externalProductId,
        { input, options },
      ]),
    );
    expect(inputByExternalId.get("MLBA")).toMatchObject({
      input: {
        affiliateUrl: "https://meli.la/mlba",
        affiliateFailure: null,
        sourceCategoryId: "MLB123",
      },
      options: {
        now: new Date("2026-07-28T18:00:00.000Z"),
        minScore: 70,
      },
    });
    expect(inputByExternalId.get("MLBB")).toMatchObject({
      input: { affiliateUrl: "https://meli.la/original-b" },
      options: { minScore: 80 },
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveMarker);
    expect(database.systemAlert.create).not.toHaveBeenCalled();
    expect(database.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PARTIAL",
          errorMessage: "Refresh completed with 1 offer failure(s).",
          metrics: expect.objectContaining({
            selected: 4,
            refreshed: 2,
            failed: 1,
          }),
        }),
      }),
    );
  });

  it("counts every unprocessed offer as failed and sanitizes a global connector failure", async () => {
    const database = fakeDatabase();
    database.offer.findMany.mockResolvedValue([
      refreshOffer("MLBA"),
      refreshOffer("MLBB"),
    ]);
    const sensitiveMarker = "global-refresh-sensitive";
    const unsafeMessage = `${["Set", "-Cookie"].join("")}: sid=${sensitiveMarker}`;
    const result = await refreshMercadoLivreOffers(
      new Date("2026-07-28T19:00:00.000Z"),
      {
        database: database as never,
        createConnector: vi.fn().mockRejectedValue(new Error(unsafeMessage)),
      },
    );

    expect(result).toMatchObject({
      selected: 2,
      refreshed: 0,
      notFound: 0,
      failed: 2,
      failures: [
        { externalProductId: "MLBA", errorMessage: "[REDACTED]" },
        { externalProductId: "MLBB", errorMessage: "[REDACTED]" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveMarker);
    expect(database.marketplaceAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastError: "[REDACTED]" }),
      }),
    );
    expect(database.systemAlert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "mercado-livre.refresh",
          metadata: {
            stage: "REFRESH",
            status: "FAILED",
            errorCode: "MELI_API_UNAVAILABLE",
          },
        }),
      }),
    );
    expect(database.automationRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          metrics: expect.objectContaining({ selected: 2, failed: 2 }),
          errorMessage: "[REDACTED]",
        }),
      }),
    );
  });
});
