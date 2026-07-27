import { describe, expect, it, vi } from "vitest";
import {
  MercadoLivreApiError,
  MercadoLivreApiClient,
  MercadoLivreConnector,
  MercadoLivreHighlightResolver,
  MercadoLivreOAuthClient,
  MercadoLivrePriceService,
  buildMercadoLivreAuthorizationUrl,
  decryptSecret,
  encryptSecret,
  type ApiFetch,
  type MercadoLivreProduct,
} from "./index";

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<ApiFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
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

describe("Mercado Livre OAuth", () => {
  it("builds authorization URL with state and redirect URI", () => {
    const url = new URL(
      buildMercadoLivreAuthorizationUrl("state-123", {
        MERCADO_LIVRE_CLIENT_ID: "client-id",
        MERCADO_LIVRE_REDIRECT_URI: "http://localhost:3000/api/integrations/mercadolivre/callback",
      }),
    );

    expect(url.hostname).toBe("auth.mercadolivre.com.br");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe("state-123");
  });

  it("exchanges code for tokens without exposing secrets in the response shape", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 21600,
        user_id: 123,
        scope: "read write",
      }),
    );

    const token = await new MercadoLivreOAuthClient({
      fetchFn,
      env: {
        MERCADO_LIVRE_CLIENT_ID: "client",
        MERCADO_LIVRE_CLIENT_SECRET: "secret",
        MERCADO_LIVRE_REDIRECT_URI: "http://localhost/callback",
      },
    }).exchangeCode("code");

    expect(token.access_token).toBe("access");
    expect(token.refresh_token).toBe("refresh");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("encrypts and decrypts token payloads", () => {
    const env = { ENCRYPTION_KEY: "12345678901234567890123456789012" };
    const encrypted = encryptSecret("refresh-token", env);

    expect(encrypted).not.toContain("refresh-token");
    expect(decryptSecret(encrypted, env)).toBe("refresh-token");
  });
});

describe("MercadoLivreApiClient", () => {
  it("does not retry non-recoverable 401 responses", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
    const client = new MercadoLivreApiClient({ accessToken: "token", fetchFn, retries: 2 });

    await expect(client.request("/items/MLB1")).rejects.toThrow("401");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries 429 responses", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "rate limit" }, 429))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new MercadoLivreApiClient({ accessToken: "token", fetchFn, retries: 2 });

    await expect(client.request("/items/MLB1")).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries 500 responses", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "server" }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new MercadoLivreApiClient({ accessToken: "token", fetchFn, retries: 2 });

    await expect(client.request("/items/MLB1")).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("times out stalled requests", async () => {
    const fetchFn: ApiFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const client = new MercadoLivreApiClient({ accessToken: "token", fetchFn, retries: 0, timeoutMs: 1 });

    await expect(client.request("/slow")).rejects.toThrow("aborted");
  });
});

describe("MercadoLivreConnector", () => {
  it("loads site root categories", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([
        { id: "MLB1000", name: "Eletronicos" },
        { id: "MLB2000", name: "Casa" },
      ]),
    );
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
      siteId: "MLB",
    });

    await expect(connector.getSiteCategories()).resolves.toEqual([
      { id: "MLB1000", name: "Eletronicos" },
      { id: "MLB2000", name: "Casa" },
    ]);
  });

  it("loads category and category children", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        id: "MLB1055",
        name: "Celulares",
        path_from_root: [{ id: "MLB1000", name: "Eletronicos" }],
        children_categories: [{ id: "MLB123", name: "Smartphones" }],
      }),
    );
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
    });

    await expect(connector.getCategoryChildren("MLB1055")).resolves.toEqual([
      { id: "MLB123", name: "Smartphones" },
    ]);
  });

  it("marks category with children as not leaf", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        id: "MLB1055",
        name: "Eletronicos",
        path_from_root: [{ id: "MLB1055", name: "Eletronicos" }],
        children_categories: [{ id: "MLB123", name: "Celulares" }],
      }),
    );
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
    });

    const category = await connector.getCategory("MLB1055");

    expect(category?.children).toHaveLength(1);
  });

  it("marks category without children as leaf", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        id: "MLB123",
        name: "Celulares",
        path_from_root: [
          { id: "MLB1055", name: "Eletronicos" },
          { id: "MLB123", name: "Celulares" },
        ],
        children_categories: [],
      }),
    );
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
    });

    const category = await connector.getCategory("MLB123");

    expect(category?.children).toHaveLength(0);
    expect(category?.pathFromRoot.map((item) => item.name).join(" > ")).toBe("Eletronicos > Celulares");
  });

  it("surfaces nonexistent category as 404", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: "Category not found" }, 404));
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn, retries: 0 }),
    });

    await expect(connector.getCategory("MLB404")).rejects.toBeInstanceOf(MercadoLivreApiError);
  });

  it("normalizes best sellers from highlights", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        content: [
          { id: "MLB1", position: 1, type: "ITEM" },
          { item_id: "MLB2" },
        ],
      }),
    );
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
      siteId: "MLB",
    });

    await expect(connector.getBestSellers("MLB1055")).resolves.toEqual([
      { id: "MLB1", position: 1, type: "ITEM", rawType: "ITEM", categoryId: "MLB1055" },
      { id: "MLB2", position: 2, type: "UNKNOWN", rawType: null, categoryId: "MLB1055" },
    ]);
  });

  it("preserves mixed highlight candidate types without treating them as item ids", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        content: [
          { id: "MLBU3013800008", position: 1, type: "USER_PRODUCT" },
          { id: "MLB61695785", position: 2, type: "PRODUCT" },
          { id: "MLB1234567890", position: 3, type: "ITEM" },
        ],
      }),
    );
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
      siteId: "MLB",
    });

    await expect(connector.getBestSellers("MLB123")).resolves.toEqual([
      {
        id: "MLBU3013800008",
        position: 1,
        type: "USER_PRODUCT",
        rawType: "USER_PRODUCT",
        categoryId: "MLB123",
      },
      { id: "MLB61695785", position: 2, type: "PRODUCT", rawType: "PRODUCT", categoryId: "MLB123" },
      { id: "MLB1234567890", position: 3, type: "ITEM", rawType: "ITEM", categoryId: "MLB123" },
    ]);
  });

  it("keeps empty highlights as an empty list", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ content: [] }));
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
      siteId: "MLB",
    });

    await expect(connector.getBestSellers("MLB123")).resolves.toEqual([]);
  });

  it("surfaces highlights 404 so discovery can record NO_HIGHLIGHTS_FOR_CATEGORY", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ message: "Dimension CATEGORY with id MLB123 not found" }, 404),
    );
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn, retries: 0 }),
      siteId: "MLB",
    });

    await expect(connector.getBestSellers("MLB123")).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("Dimension CATEGORY"),
    });
  });

  it("loads catalog product metadata needed for parent resolution without logging raw responses", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        id: "MLB100",
        name: "Catalog parent",
        status: "inactive",
        parent_id: null,
        children_ids: ["MLB101", "MLB102"],
        sold_quantity: 300,
        buy_box_winner: null,
        buy_box_winner_price_range: { min: 1000, max: 1200 },
      }),
    );
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
    });

    await expect(connector.getProduct("MLB100")).resolves.toMatchObject({
      id: "MLB100",
      name: "Catalog parent",
      status: "inactive",
      parentId: null,
      childrenIds: ["MLB101", "MLB102"],
      soldQuantity: 300,
      buyBoxWinner: null,
      buyBoxWinnerPriceRange: { min: 1000, max: 1200 },
      buyBoxWinnerItemId: null,
    });
    expect(log).toHaveBeenCalledWith("[mercado-livre.product]", {
      productId: "MLB100",
      status: "inactive",
      childrenCount: 2,
      hasBuyBoxWinner: false,
    });

    log.mockRestore();
  });

  it("uses official prices and preserves null or UNKNOWN fields", async () => {
    const itemFetch = vi.fn(async () =>
      jsonResponse([
        {
          code: 200,
          body: {
            id: "MLB1",
            title: "Produto",
            permalink: "https://produto.example/MLB1",
            category_id: "MLB1055",
            thumbnail: "https://img.example/1.jpg",
            status: "active",
            shipping: {},
          },
        },
      ]),
    );
    const priceService = {
      getPrice: vi.fn(async () => ({ currentPrice: 99.9, originalPrice: null })),
    } as unknown as MercadoLivrePriceService;
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn: itemFetch }),
      priceService,
    });

    const [candidate] = await connector.getItems(["MLB1"]);

    expect(candidate).toMatchObject({
      marketplace: "MERCADO_LIVRE",
      externalProductId: "MLB1",
      currentPrice: 99.9,
      originalPrice: null,
      shippingStatus: "UNKNOWN",
      stockStatus: "UNKNOWN",
      rating: null,
      affiliateUrl: null,
      trackingStrategy: "DIRECT_AFFILIATE_LINK",
    });
    expect(priceService.getPrice).toHaveBeenCalledWith("MLB1");
  });

  it("deduplicates candidates discovered from highlights", async () => {
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn: vi.fn() }),
    });
    vi.spyOn(connector, "getBestSellers")
      .mockResolvedValueOnce([
        { id: "MLB1", position: 1, type: "ITEM", rawType: "ITEM", categoryId: "MLB1055" },
        { id: "MLB2", position: 2, type: "ITEM", rawType: "ITEM", categoryId: "MLB1055" },
      ])
      .mockResolvedValueOnce([{ id: "MLB1", position: 1, type: "ITEM", rawType: "ITEM", categoryId: "MLB1648" }]);
    vi.spyOn(connector, "getItems").mockResolvedValue([
      {
        marketplace: "MERCADO_LIVRE",
        externalProductId: "MLB1",
        title: "Produto",
        productUrl: "https://produto.example/MLB1",
        currentPrice: 100,
      },
      {
        marketplace: "MERCADO_LIVRE",
        externalProductId: "MLB2",
        title: "Produto 2",
        productUrl: "https://produto.example/MLB2",
        currentPrice: 120,
      },
    ]);

    const candidates = await connector.discoverCandidates(["MLB1055", "MLB1648"]);

    expect(candidates).toHaveLength(2);
    expect(connector.getItems).toHaveBeenCalledWith(["MLB1", "MLB2"]);
  });

  it("deduplicates PRODUCT highlights after final item resolution", async () => {
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn: vi.fn() }),
    });
    vi.spyOn(connector, "getBestSellers").mockResolvedValue([
      { id: "MLBPRODUCTA", position: 1, type: "PRODUCT", rawType: "PRODUCT", categoryId: "MLB1055" },
      { id: "MLBPRODUCTB", position: 2, type: "PRODUCT", rawType: "PRODUCT", categoryId: "MLB1055" },
    ]);
    vi.spyOn(connector, "getProduct").mockImplementation(async (id: string) =>
      catalogProduct({
        id,
        buyBoxWinner: { itemId: "MLB9001", price: 100 },
        buyBoxWinnerItemId: "MLB9001",
        buyBoxWinnerPrice: 100,
      }),
    );
    vi.spyOn(connector, "getItems").mockResolvedValue([
      {
        marketplace: "MERCADO_LIVRE",
        externalProductId: "MLB9001",
        title: "Produto",
        productUrl: "https://produto.example/MLB9001",
        currentPrice: 100,
      },
    ]);

    const candidates = await connector.discoverCandidates(["MLB1055"]);

    expect(candidates).toHaveLength(1);
    expect(connector.getItems).toHaveBeenCalledWith(["MLB9001"]);
  });

  it("resolves PRODUCT highlights through buy_box_winner.item_id", async () => {
    const getProduct = vi.fn().mockResolvedValue(
      catalogProduct({
        id: "MLB61695785",
        buyBoxWinner: { itemId: "MLBITEM1", price: 99 },
        buyBoxWinnerItemId: "MLBITEM1",
        buyBoxWinnerPrice: 99,
      }),
    );
    const marketplace = {
      getProduct,
    } as unknown as MercadoLivreConnector;
    const resolver = new MercadoLivreHighlightResolver(marketplace);

    await expect(
      resolver.resolveCandidate({
        id: "MLB61695785",
        position: 2,
        type: "PRODUCT",
        rawType: "PRODUCT",
        categoryId: "MLB123",
      }),
    ).resolves.toEqual({
      ok: true,
      candidate: {
        sourceHighlightId: "MLB61695785",
        sourceHighlightType: "PRODUCT",
        resolvedProductId: "MLB61695785",
        resolvedItemId: "MLBITEM1",
        resolutionStrategy: "PRODUCT_DIRECT_BUY_BOX",
        position: 2,
        categoryId: "MLB123",
      },
      diagnostics: {
        productDirectWinnerCount: 1,
        productParentCount: 0,
        productLeafCount: 1,
        productResolvedDirectly: 1,
        productResolvedViaChild: 0,
        productLeafWithoutWinner: 0,
        productParentWithoutResolvableChild: 0,
      },
    });
    expect(getProduct).toHaveBeenCalledTimes(1);
  });

  it("resolves PRODUCT parent through the child with highest sold quantity", async () => {
    const marketplace = {
      getProduct: vi.fn(async (id: string) => {
        const products: Record<string, MercadoLivreProduct> = {
          MLB100: catalogProduct({
            id: "MLB100",
            status: "inactive",
            childrenIds: ["MLB101", "MLB102"],
          }),
          MLB101: catalogProduct({
            id: "MLB101",
            status: "active",
            soldQuantity: 50,
            buyBoxWinner: { itemId: "MLB9001", price: 1000 },
            buyBoxWinnerItemId: "MLB9001",
            buyBoxWinnerPrice: 1000,
          }),
          MLB102: catalogProduct({
            id: "MLB102",
            status: "active",
            soldQuantity: 100,
            buyBoxWinner: { itemId: "MLB9002", price: 1100 },
            buyBoxWinnerItemId: "MLB9002",
            buyBoxWinnerPrice: 1100,
          }),
        };

        return products[id] ?? null;
      }),
    } as unknown as MercadoLivreConnector;
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
        sourceHighlightId: "MLB100",
        sourceHighlightType: "PRODUCT",
        resolvedProductId: "MLB102",
        resolvedItemId: "MLB9002",
        resolutionStrategy: "PRODUCT_CHILD_BUY_BOX",
      },
      diagnostics: {
        productParentCount: 1,
        productLeafCount: 2,
        productResolvedViaChild: 1,
      },
    });
  });

  it("resolves nested PRODUCT parents within the depth limit", async () => {
    const marketplace = {
      getProduct: vi.fn(async (id: string) => {
        const products: Record<string, MercadoLivreProduct> = {
          MLB100: catalogProduct({ id: "MLB100", childrenIds: ["MLB101"] }),
          MLB101: catalogProduct({ id: "MLB101", childrenIds: ["MLB102"] }),
          MLB102: catalogProduct({
            id: "MLB102",
            soldQuantity: 10,
            buyBoxWinner: { itemId: "MLB9002", price: 1100 },
            buyBoxWinnerItemId: "MLB9002",
            buyBoxWinnerPrice: 1100,
          }),
        };

        return products[id] ?? null;
      }),
    } as unknown as MercadoLivreConnector;
    const resolver = new MercadoLivreHighlightResolver(marketplace, { maxProductDepth: 4 });

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
      candidate: { resolvedProductId: "MLB102", resolvedItemId: "MLB9002" },
    });
  });

  it("skips PRODUCT leaves without buy box winner", async () => {
    const marketplace = {
      getProduct: vi.fn().mockResolvedValue(catalogProduct({ id: "MLB61695785", childrenIds: [] })),
    } as unknown as MercadoLivreConnector;
    const resolver = new MercadoLivreHighlightResolver(marketplace);

    await expect(
      resolver.resolveCandidate({
        id: "MLB61695785",
        position: 2,
        type: "PRODUCT",
        rawType: "PRODUCT",
        categoryId: "MLB123",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "PRODUCT_LEAF_NO_BUY_BOX_WINNER" });
  });

  it("skips PRODUCT parents without resolvable children", async () => {
    const marketplace = {
      getProduct: vi.fn(async (id: string) => {
        const products: Record<string, MercadoLivreProduct> = {
          MLB100: catalogProduct({ id: "MLB100", childrenIds: ["MLB101", "MLB102", "MLB103"] }),
          MLB101: catalogProduct({ id: "MLB101" }),
          MLB102: catalogProduct({ id: "MLB102" }),
          MLB103: catalogProduct({ id: "MLB103" }),
        };

        return products[id] ?? null;
      }),
    } as unknown as MercadoLivreConnector;
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
      ok: false,
      reason: "PRODUCT_PARENT_NO_RESOLVABLE_CHILD",
      diagnostics: { productParentWithoutResolvableChild: 1 },
    });
  });

  it("stops PRODUCT tree traversal at the configured depth limit", async () => {
    const marketplace = {
      getProduct: vi.fn(async (id: string) => {
        const products: Record<string, MercadoLivreProduct> = {
          MLB100: catalogProduct({ id: "MLB100", childrenIds: ["MLB101"] }),
          MLB101: catalogProduct({ id: "MLB101", childrenIds: ["MLB102"] }),
          MLB102: catalogProduct({
            id: "MLB102",
            buyBoxWinner: { itemId: "MLB9002", price: 1100 },
            buyBoxWinnerItemId: "MLB9002",
            buyBoxWinnerPrice: 1100,
          }),
        };

        return products[id] ?? null;
      }),
    } as unknown as MercadoLivreConnector;
    const resolver = new MercadoLivreHighlightResolver(marketplace, { maxProductDepth: 1 });

    await expect(
      resolver.resolveCandidate({
        id: "MLB100",
        position: 1,
        type: "PRODUCT",
        rawType: "PRODUCT",
        categoryId: "MLB123",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "PRODUCT_TREE_DEPTH_LIMIT" });
  });

  it("resolves USER_PRODUCT highlights to an active marketplace item", async () => {
    const marketplace = {
      getUserProduct: vi.fn().mockResolvedValue({ id: "MLBU1", userId: "123" }),
      getItemsByUserProduct: vi.fn().mockResolvedValue(["MLB2", "MLB1"]),
      getItems: vi.fn().mockResolvedValue([
        {
          marketplace: "MERCADO_LIVRE",
          externalProductId: "MLB2",
          title: "Paused",
          productUrl: "https://produto.example/MLB2",
          currentPrice: 100,
          itemStatus: "paused",
          channels: ["marketplace"],
        },
        {
          marketplace: "MERCADO_LIVRE",
          externalProductId: "MLB1",
          title: "Active",
          productUrl: "https://produto.example/MLB1",
          currentPrice: 110,
          itemStatus: "active",
          channels: ["marketplace"],
        },
      ]),
    } as unknown as MercadoLivreConnector;
    const resolver = new MercadoLivreHighlightResolver(marketplace);

    await expect(
      resolver.resolveCandidate({
        id: "MLBU1",
        position: 1,
        type: "USER_PRODUCT",
        rawType: "USER_PRODUCT",
        categoryId: "MLB123",
      }),
    ).resolves.toMatchObject({
      ok: true,
      candidate: { sourceHighlightId: "MLBU1", sourceHighlightType: "USER_PRODUCT", resolvedItemId: "MLB1" },
    });
  });

  it("skips USER_PRODUCT highlights without active items", async () => {
    const marketplace = {
      getUserProduct: vi.fn().mockResolvedValue({ id: "MLBU1", userId: "123" }),
      getItemsByUserProduct: vi.fn().mockResolvedValue([]),
    } as unknown as MercadoLivreConnector;
    const resolver = new MercadoLivreHighlightResolver(marketplace);

    await expect(
      resolver.resolveCandidate({
        id: "MLBU1",
        position: 1,
        type: "USER_PRODUCT",
        rawType: "USER_PRODUCT",
        categoryId: "MLB123",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "USER_PRODUCT_NO_ACTIVE_ITEM" });
  });
});
