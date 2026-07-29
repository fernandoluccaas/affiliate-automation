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
  parseMercadoLivreCatalogProductItemSummary,
  resolveMercadoLivreItemCondition,
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

  it("keeps credentials encrypted with the legacy key readable after a dedicated key is configured", () => {
    const encrypted = encryptSecret("existing-oauth-token", encryptionEnv);
    const migratedEnv = {
      ...encryptionEnv,
      CREDENTIALS_ENCRYPTION_KEY:
        "dedicated-credentials-key-with-at-least-32-characters",
    };

    expect(decryptSecret(encrypted, migratedEnv)).toBe("existing-oauth-token");
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

  it("preserves only sanitized API error fields", async () => {
    const accessToken = "access-token-that-must-not-leak";
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        {
          error: "access_denied",
          code: "FORBIDDEN",
          message: `Authorization: Bearer ${accessToken}`,
          cause: [
            {
              code: "invalid_scope",
              message: `access_token=${accessToken}`,
              authorization: accessToken,
            },
          ],
          blocked_by: "access policy",
          access_token: accessToken,
          refresh_token: "refresh-secret",
          client_secret: "client-secret",
          Authorization: `Bearer ${accessToken}`,
        },
        403,
      ),
    );
    const client = new MercadoLivreApiClient({
      accessToken,
      fetchFn,
      retries: 2,
    });

    const error = await client
      .request("/sites/MLB/search")
      .catch((value) => value);

    expect(error).toBeInstanceOf(MercadoLivreApiError);
    expect(error).toMatchObject({
      status: 403,
      details: {
        httpStatus: 403,
        error: "access_denied",
        code: "FORBIDDEN",
        message: "[REDACTED_CREDENTIAL]",
        cause: [
          {
            code: "invalid_scope",
            message: "access_token=[REDACTED]",
          },
        ],
        blocked_by: "access policy",
      },
    });
    const apiError = error as MercadoLivreApiError;
    expect(JSON.stringify(apiError.details)).not.toContain(accessToken);
    expect(JSON.stringify(apiError.details)).not.toMatch(/authorization/i);
    expect(JSON.stringify(apiError.details)).not.toContain("refresh-secret");
    expect(JSON.stringify(apiError.details)).not.toContain("client-secret");
    expect(apiError.details).not.toHaveProperty("Authorization");
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

  it("preserves catalog product metadata without ad hoc logging", async () => {
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
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("loads and normalizes official catalog product items", async () => {
    const requestedUrls: string[] = [];
    let requestedHeaders: Headers | undefined;
    const fetchFn: ApiFetch = vi.fn(async (url, init) => {
      requestedUrls.push(String(url));
      requestedHeaders = init?.headers as Headers;
      return requestedUrls.length === 1
        ? jsonResponse({
            paging: { total: 1, limit: 100, offset: 0 },
            results: [
              {
                item_id: "MLB123",
                site_id: "MLB",
                price: 199.9,
                condition: "new",
                shipping: { free_shipping: true },
                official_store_id: 42,
              },
            ],
          })
        : jsonResponse(
            [
              {
                code: 206,
                body: {
                  id: "MLB123",
                  site_id: "MLB",
                  title: "Produto hidratado",
                  status: "active",
                  condition: "new",
                  permalink:
                    "https://produto.mercadolivre.com.br/MLB-123-produto",
                  available_quantity: 8,
                  channels: ["marketplace"],
                  shipping: { free_shipping: true },
                },
              },
            ],
            206,
          );
    });
    const priceService = {
      getPrice: vi
        .fn()
        .mockResolvedValue({ currentPrice: 199.9, originalPrice: 249.9 }),
    } as unknown as MercadoLivrePriceService;
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
      priceService,
    });

    await expect(
      connector.getProductItems("MLB-CATALOG"),
    ).resolves.toMatchObject({
      summaries: [
        {
          itemId: "MLB123",
          siteId: "MLB",
          condition: "new",
          price: 199.9,
          freeShipping: true,
          officialStoreId: "42",
        },
      ],
      candidates: [
        {
          externalProductId: "MLB123",
          itemStatus: "active",
          currentPrice: 199.9,
          originalPrice: 249.9,
        },
      ],
      diagnostics: {
        productItemsHttpStatus: 200,
        productItemsResultsCount: 1,
        productItemsParsedCount: 1,
        productItemsHydrated: 1,
        productItemsUsable: 1,
        priceApiFetched: 1,
      },
    });
    expect(requestedUrls[0]).toBe(
      "https://api.mercadolibre.com/products/MLB-CATALOG/items?limit=100&offset=0",
    );
    expect(requestedUrls[1]).toBe(
      "https://api.mercadolibre.com/items?ids=MLB123",
    );
    expect(requestedHeaders?.get("authorization")).toBe("Bearer token");
  });

  it("parses sparse summaries and a valid id fallback without requiring detail fields", () => {
    expect(
      parseMercadoLivreCatalogProductItemSummary({
        item_id: "MLB123456",
      }),
    ).toMatchObject({
      itemId: "MLB123456",
      summaryFieldsPresent: ["item_id"],
    });
    expect(
      parseMercadoLivreCatalogProductItemSummary({
        id: "MLB654321",
      }),
    ).toMatchObject({
      itemId: "MLB654321",
      summaryFieldsPresent: ["id"],
    });
    expect(
      parseMercadoLivreCatalogProductItemSummary({ id: "PRODUCT123" }),
    ).toBeNull();
  });

  it("resolves item_condition before condition and ITEM_CONDITION attributes", () => {
    expect(
      resolveMercadoLivreItemCondition({
        item_condition: "new",
        condition: "used",
      }),
    ).toBe("new");
    expect(
      resolveMercadoLivreItemCondition({
        attributes: [{ id: "ITEM_CONDITION", value_name: "new" }],
      }),
    ).toBe("new");
    expect(resolveMercadoLivreItemCondition({})).toBe("unknown");
  });

  it("hydrates sparse summaries and uses the summary price as the last fallback", async () => {
    const fetchFn = vi
      .fn<ApiFetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          paging: { total: 1 },
          results: [{ item_id: "MLB123456", price: 89.9 }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            code: 200,
            body: {
              id: "MLB123456",
              site_id: "MLB",
              title: "Produto sem campos opcionais",
              permalink:
                "https://produto.mercadolivre.com.br/MLB-123456-produto",
              attributes: [{ id: "ITEM_CONDITION", value_name: "new" }],
            },
          },
        ]),
      );
    const priceService = {
      getPrice: vi.fn().mockRejectedValue(new Error("unavailable")),
    } as unknown as MercadoLivrePriceService;
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
      priceService,
    });

    const result = await connector.getProductItems("MLBPRODUCT");

    expect(result.candidates[0]).toMatchObject({
      externalProductId: "MLB123456",
      currentPrice: 89.9,
      priceSource: "ITEM_FALLBACK",
      availableQuantity: null,
      channels: [],
      stockStatus: "UNKNOWN",
    });
    expect(result.diagnostics).toMatchObject({
      productItemsHydrated: 1,
      productItemsUsable: 1,
      priceFallbackUsed: 1,
      rejectionReasons: {},
    });
  });

  it("isolates invalid hydrated items and keeps a valid sibling", async () => {
    const fetchFn = vi
      .fn<ApiFetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          paging: { total: 2 },
          results: [{ item_id: "MLB111111" }, { item_id: "MLB222222" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            code: 200,
            body: {
              id: "MLB111111",
              site_id: "MLB",
              title: "Inativo",
              status: "paused",
              condition: "new",
              permalink:
                "https://produto.mercadolivre.com.br/MLB-111111-inativo",
              price: 10,
            },
          },
          {
            code: 206,
            body: {
              id: "MLB222222",
              site_id: "MLB",
              title: "Ativo",
              status: "active",
              condition: "new",
              permalink: "https://produto.mercadolivre.com.br/MLB-222222-ativo",
              price: 20,
              available_quantity: 1,
              channels: ["marketplace"],
            },
          },
        ]),
      );
    const priceService = {
      getPrice: vi
        .fn()
        .mockResolvedValue({ currentPrice: 20, originalPrice: null }),
    } as unknown as MercadoLivrePriceService;
    const connector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({ accessToken: "token", fetchFn }),
      priceService,
    });

    const result = await connector.getProductItems("MLBPRODUCT");

    expect(result.candidates.map((item) => item.externalProductId)).toEqual([
      "MLB222222",
    ]);
    expect(result.diagnostics).toMatchObject({
      productItemsHydrated: 2,
      productItemsUsable: 1,
      rejectionReasons: { PRODUCT_ITEM_INACTIVE: 1 },
    });
  });

  it("distinguishes summary schema mismatch from hydration failure", async () => {
    const schemaConnector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({
        accessToken: "token",
        fetchFn: vi.fn(async () =>
          jsonResponse({ paging: { total: 1 }, results: [{ foo: "bar" }] }),
        ),
      }),
    });
    const schemaResult = await schemaConnector.getProductItems("MLBPRODUCT");

    expect(schemaResult.diagnostics).toMatchObject({
      productItemsResultsCount: 1,
      productItemsParsedCount: 0,
      rejectionReasons: { PRODUCT_ITEM_INVALID_ID: 1 },
    });

    const hydrationConnector = new MercadoLivreConnector({
      client: new MercadoLivreApiClient({
        accessToken: "token",
        fetchFn: vi
          .fn<ApiFetch>()
          .mockResolvedValueOnce(
            jsonResponse({ results: [{ item_id: "MLB123456" }] }),
          )
          .mockResolvedValueOnce(
            jsonResponse([{ code: 404, body: { message: "not found" } }]),
          ),
      }),
    });
    const hydrationResult =
      await hydrationConnector.getProductItems("MLBPRODUCT");

    expect(hydrationResult.diagnostics).toMatchObject({
      productItemsUniqueIds: 1,
      productItemsHydrated: 0,
      rejectionReasons: { PRODUCT_ITEM_DETAIL_HTTP_ERROR: 1 },
    });
  });
});

describe("category search probe", () => {
  function connectorFor(fetchFn: ApiFetch) {
    return new MercadoLivreConnector({
      client: new MercadoLivreApiClient({
        accessToken: "test-access-token-value",
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
      method: "GET",
      endpoint: "/sites/MLB/search",
      parameters: { category: "MLB123", limit: 10 },
      categoryId: "MLB123",
      authenticatedAttempt: {
        authenticationMode: "BEARER_TOKEN",
        ok: true,
        httpStatus: 200,
        resultsFound: 7,
      },
    });
    expect(result.authenticatedAttempt.usableItemIds).toHaveLength(7);
    expect(result.authenticatedAttempt.sample).toHaveLength(5);
    expect(result.publicAttempt).toBeUndefined();
  });

  it("returns an empty successful diagnostic", async () => {
    const result = await connectorFor(
      vi.fn(async () => jsonResponse({ paging: { total: 0 }, results: [] })),
    ).probeCategorySearch({ siteId: "MLB", categoryId: "MLB123", limit: 5 });

    expect(result.authenticatedAttempt).toMatchObject({
      ok: true,
      resultsFound: 0,
      usableItemIds: [],
    });
  });

  it.each([
    [429, "RATE_LIMITED"],
    [503, "API_ERROR"],
  ])("maps HTTP %s without throwing", async (status, errorCode) => {
    const result = await connectorFor(
      vi.fn(async () => jsonResponse({ error: "failure" }, status)),
    ).probeCategorySearch({
      siteId: "MLB",
      categoryId: "MLB123",
      limit: 5,
      testPublicAttempt: false,
    });

    expect(result.authenticatedAttempt).toMatchObject({
      ok: false,
      httpStatus: status,
      errorCode,
    });
  });

  it.each([
    {
      body: { code: "invalid_scope", message: "Invalid scopes" },
      classification: "INVALID_SCOPES",
    },
    {
      body: { error: "access_denied", code: "FORBIDDEN" },
      classification: "ACCESS_DENIED",
    },
    {
      body: {
        code: "application_restricted",
        message: "Application restricted",
      },
      classification: "APPLICATION_RESTRICTED",
    },
    {
      body: { code: "token_forbidden", message: "Token forbidden" },
      classification: "TOKEN_FORBIDDEN",
    },
    {
      body: { code: "policy_denied", blocked_by: "access policy" },
      classification: "POLICY_DENIED",
    },
    {
      body: {
        error: "forbidden",
        code: "FORBIDDEN",
        message: "Request forbidden",
      },
      classification: "UNKNOWN_FORBIDDEN",
    },
  ])(
    "classifies 403 evidence as $classification",
    async ({ body, classification }) => {
      const result = await connectorFor(
        vi.fn(async () => jsonResponse(body, 403)),
      ).probeCategorySearch({
        siteId: "MLB",
        categoryId: "MLB123",
        limit: 5,
        testPublicAttempt: false,
      });

      expect(result.authenticatedAttempt).toMatchObject({
        ok: false,
        httpStatus: 403,
        errorCode: "API_ERROR",
        apiError: { httpStatus: 403, ...body },
        forbiddenClassification: classification,
      });
      expect(result.diagnosis).toBe(classification);
    },
  );

  it("runs a public diagnostic after authenticated 403 without leaking Authorization", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async (_input, init) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer test-access-token-value",
        );
        return jsonResponse(
          {
            error: "access_denied",
            code: "FORBIDDEN",
            message: "Access denied",
          },
          403,
        );
      })
      .mockImplementationOnce(async (_input, init) => {
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return jsonResponse({
          paging: { total: 1 },
          results: [{ id: "MLB1", title: "Produto" }],
        });
      });

    const result = await connectorFor(fetchFn).probeCategorySearch({
      siteId: "MLB",
      categoryId: "MLB123",
      limit: 5,
    });

    expect(result.authenticatedAttempt).toMatchObject({
      ok: false,
      httpStatus: 403,
      forbiddenClassification: "ACCESS_DENIED",
    });
    expect(result.publicAttempt).toMatchObject({
      authenticationMode: "PUBLIC",
      ok: true,
      httpStatus: 200,
      resultsFound: 1,
    });
    expect(JSON.stringify(result)).not.toContain("test-access-token-value");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("preserves separate failures when authenticated and public attempts return 403", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "access_denied", code: "FORBIDDEN" }, 403),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: "policy_denied", message: "Policy denied" }, 403),
      );

    const result = await connectorFor(fetchFn).probeCategorySearch({
      siteId: "MLB",
      categoryId: "MLB123",
      limit: 5,
    });

    expect(result.authenticatedAttempt.forbiddenClassification).toBe(
      "ACCESS_DENIED",
    );
    expect(result.publicAttempt?.forbiddenClassification).toBe("POLICY_DENIED");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("short-circuits the public attempt after authenticated success", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ paging: { total: 0 }, results: [] }),
    );

    const result = await connectorFor(fetchFn).probeCategorySearch({
      siteId: "MLB",
      categoryId: "MLB123",
      limit: 5,
      testPublicAttempt: true,
      shortCircuitOnAuthenticatedSuccess: true,
    });

    expect(result.authenticatedAttempt.ok).toBe(true);
    expect(result.publicAttempt).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledOnce();
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
        testPublicAttempt: false,
      }),
    ).resolves.toMatchObject({
      authenticatedAttempt: {
        ok: false,
        errorCode: "NETWORK_OR_TIMEOUT",
      },
    });
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
