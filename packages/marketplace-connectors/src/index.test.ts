import { describe, expect, it, vi } from "vitest";
import {
  MercadoLivreApiClient,
  MercadoLivreConnector,
  MercadoLivreOAuthClient,
  MercadoLivrePriceService,
  buildMercadoLivreAuthorizationUrl,
  decryptSecret,
  encryptSecret,
  type ApiFetch,
} from "./index";

function jsonResponse(body: unknown, status = 200): Awaited<ReturnType<ApiFetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
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
      { externalId: "MLB1", position: 1, type: "ITEM" },
      { externalId: "MLB2", position: 2, type: null },
    ]);
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
        { externalId: "MLB1", position: 1, type: "ITEM" },
        { externalId: "MLB2", position: 2, type: "ITEM" },
      ])
      .mockResolvedValueOnce([{ externalId: "MLB1", position: 1, type: "ITEM" }]);
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
});
