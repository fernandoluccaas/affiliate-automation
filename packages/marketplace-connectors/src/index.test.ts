import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  marketplaceAccount: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  systemAlert: { create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@affiliate/database", () => ({ prisma: database }));

import {
  MercadoLivreApiClient,
  MercadoLivreApiError,
  MercadoLivreConnector,
  MercadoLivreOAuthClient,
  MercadoLivreOAuthError,
  MercadoLivrePriceService,
  MercadoLivreTokenRefreshInProgressError,
  MercadoLivreTokenService,
  buildMercadoLivreAuthorizationUrl,
  decryptSecret,
  encryptSecret,
  type ApiFetch,
} from "./index";

function jsonResponse(
  body: unknown,
  status = 200,
): Awaited<ReturnType<ApiFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

const encryptionEnv = {
  ENCRYPTION_KEY: "12345678901234567890123456789012",
  MERCADO_LIVRE_CLIENT_ID: "client",
  MERCADO_LIVRE_CLIENT_SECRET: "secret",
  MERCADO_LIVRE_REDIRECT_URI: "http://localhost/callback",
};

describe("Mercado Livre OAuth", () => {
  it("builds authorization URL with state", () => {
    const url = new URL(
      buildMercadoLivreAuthorizationUrl("state-123", encryptionEnv),
    );

    expect(url.hostname).toBe("auth.mercadolivre.com.br");
    expect(url.searchParams.get("state")).toBe("state-123");
  });

  it("exchanges code and preserves token fields", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 21600,
        user_id: 123,
      }),
    );
    const token = await new MercadoLivreOAuthClient({
      fetchFn,
      env: encryptionEnv,
    }).exchangeCode("code");

    expect(token.access_token).toBe("access");
    expect(token.refresh_token).toBe("refresh");
  });

  it("surfaces invalid_grant as a typed authentication error", async () => {
    const oauth = new MercadoLivreOAuthClient({
      fetchFn: vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)),
      env: encryptionEnv,
    });

    await expect(oauth.refresh("expired")).rejects.toMatchObject({
      status: 400,
      code: "invalid_grant",
    });
  });

  it("encrypts and decrypts marketplace secrets", () => {
    const encrypted = encryptSecret("refresh-token", encryptionEnv);

    expect(encrypted).not.toContain("refresh-token");
    expect(decryptSecret(encrypted, encryptionEnv)).toBe("refresh-token");
  });
});

describe("MercadoLivreApiClient", () => {
  it("retries 429 and 5xx responses", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "rate limit" }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new MercadoLivreApiClient({
      accessToken: "token",
      fetchFn,
      retries: 2,
    });

    await expect(client.request("/items/MLB1")).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-recoverable 401", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: "unauthorized" }, 401),
    );
    const client = new MercadoLivreApiClient({
      accessToken: "token",
      fetchFn,
      retries: 2,
    });

    await expect(client.request("/items/MLB1")).rejects.toBeInstanceOf(
      MercadoLivreApiError,
    );
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("times out stalled requests", async () => {
    const fetchFn: ApiFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    const client = new MercadoLivreApiClient({
      accessToken: "token",
      fetchFn,
      retries: 0,
      timeoutMs: 1,
    });

    await expect(client.request("/slow")).rejects.toThrow("aborted");
  });
});

describe("MercadoLivreConnector", () => {
  it("loads category hierarchy and preserves mixed highlight types", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "MLB123",
          name: "Celulares",
          path_from_root: [
            { id: "MLB1000", name: "Eletronicos" },
            { id: "MLB123", name: "Celulares" },
          ],
          children_categories: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          content: [
            { id: "MLB1", position: 1, type: "ITEM" },
            { id: "MLBPRODUCT", position: 2, type: "PRODUCT" },
            { id: "MLBU1", position: 3, type: "USER_PRODUCT" },
          ],
        }),
      );
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
      siteId: "MLB",
    });

    await expect(connector.getCategory("MLB123")).resolves.toMatchObject({
      id: "MLB123",
      children: [],
    });
    await expect(connector.getBestSellers("MLB123")).resolves.toEqual([
      {
        id: "MLB1",
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
        id: "MLBU1",
        position: 3,
        type: "USER_PRODUCT",
        rawType: "USER_PRODUCT",
        categoryId: "MLB123",
      },
    ]);
  });

  it("reports a successful Price API fetch separately", async () => {
    const priceService = {
      getPrice: vi
        .fn()
        .mockResolvedValue({ currentPrice: 99.9, originalPrice: null }),
    } as unknown as MercadoLivrePriceService;
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({
        accessToken: "token",
        fetchFn: vi.fn(async () =>
          jsonResponse([
            {
              code: 200,
              body: {
                id: "MLB1",
                title: "Produto",
                permalink: "https://produto.example/MLB1",
                price: 89.9,
                status: "active",
              },
            },
          ]),
        ),
      }),
      priceService,
    });

    const result = await connector.getItemsWithDiagnostics(["MLB1"]);

    expect(result.diagnostics).toMatchObject({
      itemsFetched: 1,
      priceApiFetched: 1,
      priceFallbackUsed: 0,
      priceUnavailable: 0,
    });
    expect(result.candidates[0]?.priceSource).toBe("PRICE_API");
  });

  it("counts item price fallback without incrementing Price API success", async () => {
    const priceService = {
      getPrice: vi.fn().mockRejectedValue(new Error("price unavailable")),
    } as unknown as MercadoLivrePriceService;
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({
        accessToken: "token",
        fetchFn: vi.fn(async () =>
          jsonResponse([
            {
              code: 200,
              body: {
                id: "MLB1",
                title: "Produto",
                permalink: "https://produto.example/MLB1",
                price: 89.9,
                status: "active",
              },
            },
          ]),
        ),
      }),
      priceService,
    });

    const result = await connector.getItemsWithDiagnostics(["MLB1"]);

    expect(result.diagnostics).toMatchObject({
      itemsFetched: 1,
      priceApiFetched: 0,
      priceFallbackUsed: 1,
      priceUnavailable: 0,
    });
    expect(result.candidates[0]?.priceSource).toBe("ITEM_FALLBACK");
  });

  it("reports unavailable price when both sources are missing", async () => {
    const priceService = {
      getPrice: vi.fn().mockRejectedValue(new Error("price unavailable")),
    } as unknown as MercadoLivrePriceService;
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({
        accessToken: "token",
        fetchFn: vi.fn(async () =>
          jsonResponse([
            {
              code: 200,
              body: {
                id: "MLB1",
                title: "Produto",
                permalink: "https://produto.example/MLB1",
                status: "active",
              },
            },
          ]),
        ),
      }),
      priceService,
    });

    const result = await connector.getItemsWithDiagnostics(["MLB1"]);

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.priceUnavailable).toBe(1);
  });

  it("preserves catalog product metadata in sanitized logs", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({
        accessToken: "token",
        fetchFn: vi.fn(async () =>
          jsonResponse({
            id: "MLB100",
            status: "inactive",
            children_ids: ["MLB101"],
            sold_quantity: 300,
            buy_box_winner: null,
          }),
        ),
      }),
    });

    await expect(connector.getProduct("MLB100")).resolves.toMatchObject({
      id: "MLB100",
      status: "inactive",
      childrenIds: ["MLB101"],
      soldQuantity: 300,
    });
    expect(log).toHaveBeenCalledWith("[mercado-livre.product]", {
      productId: "MLB100",
      status: "inactive",
      childrenCount: 1,
      hasBuyBoxWinner: false,
    });
    log.mockRestore();
  });
});

describe("category search probe", () => {
  function connectorFor(fetchFn: ApiFetch) {
    return new MercadoLivreConnector({
      client: new MercadoLivreApiClient({
        accessToken: "token",
        fetchFn,
        retries: 0,
        timeoutMs: 1,
      }),
    });
  }

  it("returns at most five sanitized samples on success", async () => {
    const results = Array.from({ length: 7 }, (_, index) => ({
      id: `MLB${index + 1}`,
      title: `Produto ${index + 1}`,
      price: index + 10,
      permalink: `https://produto.example/MLB${index + 1}`,
    }));
    const result = await connectorFor(
      vi.fn(async () => jsonResponse({ paging: { total: 7 }, results })),
    ).probeCategorySearch({ siteId: "MLB", categoryId: "MLB123", limit: 10 });

    expect(result).toMatchObject({
      ok: true,
      httpStatus: 200,
      categoryId: "MLB123",
      resultsFound: 7,
    });
    expect(result.usableItemIds).toHaveLength(7);
    expect(result.sample).toHaveLength(5);
  });

  it("returns an empty successful diagnostic", async () => {
    await expect(
      connectorFor(
        vi.fn(async () => jsonResponse({ paging: { total: 0 }, results: [] })),
      ).probeCategorySearch({ siteId: "MLB", categoryId: "MLB123", limit: 5 }),
    ).resolves.toMatchObject({ ok: true, resultsFound: 0, usableItemIds: [] });
  });

  it.each([
    [429, "RATE_LIMITED"],
    [503, "API_ERROR"],
  ])("maps HTTP %s without throwing", async (status, errorCode) => {
    await expect(
      connectorFor(
        vi.fn(async () => jsonResponse({ error: "failure" }, status)),
      ).probeCategorySearch({ siteId: "MLB", categoryId: "MLB123", limit: 5 }),
    ).resolves.toMatchObject({ ok: false, httpStatus: status, errorCode });
  });

  it("maps timeout without requiring a live API", async () => {
    const fetchFn: ApiFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });

    await expect(
      connectorFor(fetchFn).probeCategorySearch({
        siteId: "MLB",
        categoryId: "MLB123",
        limit: 5,
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: "NETWORK_OR_TIMEOUT" });
  });
});

describe("MercadoLivreTokenService concurrency and account health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.$transaction.mockImplementation(async (operations: unknown[]) =>
      Promise.all(operations),
    );
    database.marketplaceAccount.update.mockResolvedValue({});
    database.systemAlert.create.mockResolvedValue({});
  });

  function expiredAccount() {
    return {
      id: "account-1",
      marketplace: "MERCADO_LIVRE",
      name: "Mercado Livre",
      encryptedCredentials: "",
      externalUserId: "123",
      accessTokenEncrypted: encryptSecret("old-token", encryptionEnv),
      refreshTokenEncrypted: encryptSecret("refresh-token", encryptionEnv),
      expiresAt: new Date("2026-07-27T10:00:00.000Z"),
      scopes: [],
      status: "CONNECTED",
      siteId: "MLB",
      lastRefreshAt: null,
      lastSyncAt: null,
      lastErrorAt: null,
      lastError: null,
      capabilities: {},
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as const;
  }

  it("waits for the winner and uses only the renewed token", async () => {
    const account = expiredAccount();
    const renewed = {
      ...account,
      accessTokenEncrypted: encryptSecret("new-token", encryptionEnv),
      expiresAt: new Date("2026-07-27T20:00:00.000Z"),
    };
    let clock = new Date("2026-07-27T11:00:00.000Z").getTime();
    database.marketplaceAccount.findFirst.mockResolvedValue(account);
    database.marketplaceAccount.findUnique
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce(renewed);

    const token = await new MercadoLivreTokenService({
      env: encryptionEnv,
      acquireLock: vi.fn().mockResolvedValue({
        acquired: false,
        release: vi.fn(),
      }),
      now: () => clock,
      sleep: async (durationMs) => {
        clock += durationMs;
      },
      refreshWaitTimeoutMs: 1_000,
      refreshPollIntervalMs: 100,
    }).getValidAccessToken();

    expect(token).toBe("new-token");
  });

  it("never returns the expired token when refresh remains in progress", async () => {
    const account = expiredAccount();
    let clock = new Date("2026-07-27T11:00:00.000Z").getTime();
    database.marketplaceAccount.findFirst.mockResolvedValue(account);
    database.marketplaceAccount.findUnique.mockResolvedValue(account);

    await expect(
      new MercadoLivreTokenService({
        env: encryptionEnv,
        acquireLock: vi
          .fn()
          .mockResolvedValue({ acquired: false, release: vi.fn() }),
        now: () => clock,
        sleep: async (durationMs) => {
          clock += durationMs;
        },
        refreshWaitTimeoutMs: 200,
        refreshPollIntervalMs: 100,
      }).getValidAccessToken(),
    ).rejects.toBeInstanceOf(MercadoLivreTokenRefreshInProgressError);
  });

  it.each([
    [429, "rate limited"],
    [503, "unavailable"],
  ])("keeps CONNECTED on transient OAuth HTTP %s", async (status, message) => {
    const account = expiredAccount();
    database.marketplaceAccount.findFirst.mockResolvedValue(account);
    const release = vi.fn();
    const oauth = {
      refresh: vi
        .fn()
        .mockRejectedValue(new MercadoLivreOAuthError(message, status)),
    };

    await expect(
      new MercadoLivreTokenService({
        env: encryptionEnv,
        oauth: oauth as unknown as MercadoLivreOAuthClient,
        acquireLock: vi.fn().mockResolvedValue({ acquired: true, release }),
        now: () => new Date("2026-07-27T11:00:00.000Z").getTime(),
      }).getValidAccessToken(),
    ).rejects.toThrow(message);

    expect(database.marketplaceAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ status: expect.anything() }),
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps CONNECTED when token refresh times out", async () => {
    const account = expiredAccount();
    database.marketplaceAccount.findFirst.mockResolvedValue(account);
    const oauth = {
      refresh: vi.fn().mockRejectedValue(new Error("request timed out")),
    };

    await expect(
      new MercadoLivreTokenService({
        env: encryptionEnv,
        oauth: oauth as unknown as MercadoLivreOAuthClient,
        acquireLock: vi.fn().mockResolvedValue({
          acquired: true,
          release: vi.fn(),
        }),
        now: () => new Date("2026-07-27T11:00:00.000Z").getTime(),
      }).getValidAccessToken(),
    ).rejects.toThrow("request timed out");

    expect(database.marketplaceAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ status: expect.anything() }),
      }),
    );
  });

  it("marks invalid refresh token as REAUTH_REQUIRED", async () => {
    const account = expiredAccount();
    database.marketplaceAccount.findFirst.mockResolvedValue(account);
    const oauth = {
      refresh: vi
        .fn()
        .mockRejectedValue(
          new MercadoLivreOAuthError("invalid grant", 400, "invalid_grant"),
        ),
    };

    await expect(
      new MercadoLivreTokenService({
        env: encryptionEnv,
        oauth: oauth as unknown as MercadoLivreOAuthClient,
        acquireLock: vi
          .fn()
          .mockResolvedValue({ acquired: true, release: vi.fn() }),
        now: () => new Date("2026-07-27T11:00:00.000Z").getTime(),
      }).getValidAccessToken(),
    ).rejects.toThrow("invalid grant");

    expect(database.marketplaceAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REAUTH_REQUIRED" }),
      }),
    );
  });
});
