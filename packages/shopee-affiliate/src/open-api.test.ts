import { describe, expect, it, vi } from "vitest";
import {
  SHOPEE_OPEN_API_ENDPOINT,
  ShopeeOpenApiClient,
  createGetItemFeedDataPayload,
  createGenerateShortLinkPayload,
  createListItemFeedsPayload,
  createShopeeGraphQlStringLiteral,
  createShopeeOpenApiSignature,
  sanitizeShopeeSubIds,
} from "./open-api";
import {
  extractShopeeItemId,
  validateShopeeGeneratedShortLink,
  validateShopeeProductOrigin,
} from "./validation";

const now = new Date("2020-01-01T00:00:00.000Z");
const credentials = { appId: "123456", secret: "demo" };
const originUrl = "https://shopee.com.br/produto-i.123.456";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successFetch() {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    response({
      data: {
        generateShortLink: {
          shortLink: "https://s.shopee.com.br/fixture",
          longLink: "https://shopee.com.br/product/123/456",
        },
      },
    }),
  );
}

describe("Shopee Affiliate Open API signature and payload", () => {
  it("builds the confirmed FULL feed operations without a cursor", () => {
    const list = createListItemFeedsPayload("FULL");
    expect(list.request.query).toContain("listItemFeeds(feedMode: FULL)");
    expect(list.request.query).toContain("referenceId");
    const page = createGetItemFeedDataPayload({
      datafeedId: "reference_FULL_2026-08-19",
      offset: 500,
      limit: 3,
    });
    expect(page.request.query).toContain(
      'getItemFeedData(datafeedId: "reference_FULL_2026-08-19", offset: 500, limit: 3)',
    );
    expect(page.request.query).not.toContain("cursor");
  });

  it("rejects an Item Feed page size above 500 before transport", () => {
    expect(() =>
      createGetItemFeedDataPayload({
        datafeedId: "feed",
        offset: 0,
        limit: 501,
      }),
    ).toThrow("SHOPEE_REMOTE_DISCOVERY_PAGINATION_INVALID");
  });

  it("matches the official signature vector byte-for-byte", () => {
    const payload =
      '{"query":"{\\nbrandOffer{\\n    nodes{\\n        commissionRate\\n        offerName\\n    }\\n}\\n}"}';
    const signature = createShopeeOpenApiSignature({
      appId: "123456",
      timestamp: 1_577_836_800,
      payload,
      secret: "demo",
    });

    expect(Buffer.byteLength(payload, "utf8")).toBe(94);
    expect(signature).toBe(
      "dc88d72feea70c80c52c3399751a7d34966763f51a7f056aa070a5e9df645412",
    );
    expect(
      createShopeeOpenApiSignature({
        appId: "123456",
        timestamp: 1_577_836_800,
        payload: `${payload} `,
        secret: "demo",
      }),
    ).not.toBe(signature);
    expect(
      createShopeeOpenApiSignature({
        appId: "123456",
        timestamp: 1_577_836_800,
        payload: payload.replace("\\n", "\n"),
        secret: "demo",
      }),
    ).not.toBe(signature);
  });

  it("produces deterministic lowercase SHA-256 output", () => {
    const payload = createGenerateShortLinkPayload({
      originUrl,
      subIds: ["sourcedatafeed", "phase6a3"],
    }).body;
    expect(
      createShopeeOpenApiSignature({
        appId: "123456",
        secret: "demo",
        timestamp: 1_577_836_800,
        payload,
      }),
    ).toBe("af394380c798b6e99bdd7bd66774318ee108a8907bc789c43de37cd9560779a1");
    expect(
      createShopeeOpenApiSignature({
        appId: "123456",
        secret: "demo",
        timestamp: 1_577_836_800,
        payload,
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses the anonymous Explorer V2 literal mutation and a query-only body", () => {
    const payload = createGenerateShortLinkPayload({
      originUrl,
      subIds: ["sourcedatafeed", "phase6a3"],
    });
    expect(payload.request.query).toBe(`mutation {
  generateShortLink(input: {originUrl: "https://shopee.com.br/produto-i.123.456", subIds: ["sourcedatafeed", "phase6a3"]}) {
    shortLink
    longLink
  }
}`);
    expect(payload.request.query).not.toContain("mutation GenerateShortLink");
    expect(payload.request).not.toHaveProperty("operationName");
    expect(payload.request).not.toHaveProperty("variables");
    expect(Object.keys(JSON.parse(payload.body))).toEqual(["query"]);
    expect(JSON.parse(payload.body)).toEqual(payload.request);
  });

  it("omits the optional SubIds field when none are supplied", () => {
    expect(
      createGenerateShortLinkPayload({ originUrl }).request.query,
    ).not.toContain("subIds");
    expect(
      createGenerateShortLinkPayload({ originUrl, subIds: [] }).request.query,
    ).not.toContain("subIds");
  });

  it("creates escaped GraphQL literals and rejects control characters", () => {
    expect(createShopeeGraphQlStringLiteral('aspas " e barra \\')).toBe(
      '"aspas \\" e barra \\\\"',
    );
    expect(() => createShopeeGraphQlStringLiteral("linha\nseguinte")).toThrow(
      "SHOPEE_GRAPHQL_STRING_CONTROL_CHARACTER",
    );
  });

  it("sends byte-for-byte the same body that was signed", async () => {
    const request = successFetch();
    const client = new ShopeeOpenApiClient(credentials, {
      fetch: request,
      now: () => now,
    });
    await client.generateShortLink({
      originUrl,
      itemId: "456",
      subIds: ["sourcedatafeed"],
    });
    const [, init] = request.mock.calls[0]!;
    const body = String(init?.body);
    const signature = createShopeeOpenApiSignature({
      appId: "123456",
      timestamp: 1_577_836_800,
      payload: body,
      secret: "demo",
    });
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: `SHA256 Credential=123456, Timestamp=1577836800, Signature=${signature}`,
    });
    expect(request).toHaveBeenCalledWith(
      SHOPEE_OPEN_API_ENDPOINT,
      expect.any(Object),
    );
  });

  it("accepts only alphanumeric SubIds without silently normalizing them", () => {
    expect(
      sanitizeShopeeSubIds(["sourcedatafeed", "retry", "phase6a3", "abc123"]),
    ).toEqual(["sourcedatafeed", "retry", "phase6a3", "abc123"]);
    expect(sanitizeShopeeSubIds(["UpperCase123"])).toEqual(["UpperCase123"]);
    expect(() => sanitizeShopeeSubIds([])).not.toThrow();
    expect(() => sanitizeShopeeSubIds(["a", "b", "c", "d", "e", "f"])).toThrow(
      "SHOPEE_SUB_IDS_LIMIT_EXCEEDED",
    );
    for (const invalid of [
      "source_datafeed",
      "phase-6a3",
      "has space",
      "has.dot",
      "",
      " padded ",
      'safe"]}) { injected',
      "a".repeat(65),
    ]) {
      expect(() => sanitizeShopeeSubIds([invalid])).toThrow(
        "SHOPEE_SUB_ID_INVALID",
      );
    }
  });
});

describe("Shopee Affiliate Open API transport", () => {
  it("reuses signed transport for listItemFeeds and getItemFeedData", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          data: {
            listItemFeeds: {
              feeds: [
                {
                  datafeedId: "ref_FULL_2026-08-19",
                  referenceId: "ref",
                  datafeedName: "Feed sanitizado",
                  description: "Fixture",
                  totalCount: "10000",
                  date: "20260819",
                  feedMode: "FULL",
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          data: {
            getItemFeedData: {
              rows: [{ columns: "{}", updateType: null }],
              pageInfo: {
                offset: 0,
                limit: 3,
                totalCount: 1,
                hasMore: false,
              },
            },
          },
        }),
      );
    const client = new ShopeeOpenApiClient(credentials, {
      fetch: request,
      now: () => now,
    });
    await expect(client.listItemFeeds("FULL")).resolves.toMatchObject({
      feeds: [{ referenceId: "ref", totalCount: 10_000 }],
    });
    await expect(
      client.getItemFeedData({
        datafeedId: "ref_FULL_2026-08-19",
        offset: 0,
        limit: 3,
      }),
    ).resolves.toMatchObject({ pageInfo: { limit: 3, hasMore: false } });
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, init] of request.mock.calls) {
      expect(init.headers.authorization).toMatch(
        /^SHA256 Credential=123456, Timestamp=\d+, Signature=[a-f0-9]{64}$/,
      );
    }
  });

  it("rejects missing credentials before creating a request", () => {
    expect(
      () => new ShopeeOpenApiClient({ appId: "", secret: "demo" }),
    ).toThrow("SHOPEE_OPEN_API_CREDENTIALS_MISSING");
    expect(
      () => new ShopeeOpenApiClient({ appId: "123456", secret: "" }),
    ).toThrow("SHOPEE_OPEN_API_CREDENTIALS_MISSING");
  });

  it("uses a Unix timestamp in seconds and the exact authorization contract", async () => {
    const request = successFetch();
    await new ShopeeOpenApiClient(credentials, {
      fetch: request,
      now: () => new Date(1_700_000_000_999),
    }).generateShortLink({ originUrl, itemId: "456" });
    const authorization = (
      request.mock.calls[0]![1]?.headers as Record<string, string>
    ).authorization;
    expect(authorization).toContain("Timestamp=1700000000");
  });

  it("normalizes a Unicode URL before creating its safe literal", async () => {
    const request = successFetch();
    await new ShopeeOpenApiClient(credentials, {
      fetch: request,
      now: () => now,
    }).generateShortLink({
      originUrl: "https://shopee.com.br/Kit-Orgânico-i.1060585622.23199461392",
      itemId: "23199461392",
    });
    const body = JSON.parse(String(request.mock.calls[0]![1]?.body)) as {
      query: string;
    };
    expect(body.query).toContain("Kit-Org%C3%A2nico");
    expect(body.query).toContain("23199461392");
    expect(body.query).not.toContain("variables");
  });

  it("cannot close the origin literal to inject another operation", async () => {
    const request = successFetch();
    await new ShopeeOpenApiClient(credentials, {
      fetch: request,
      now: () => now,
    }).generateShortLink({
      originUrl:
        "https://shopee.com.br/produto-i.123.456?probe=%22%7D%29%7Bmutation%7Bevil%7D",
      itemId: "456",
    });
    const body = JSON.parse(String(request.mock.calls[0]![1]?.body)) as {
      query: string;
    };
    expect(body.query.match(/generateShortLink/gu)).toHaveLength(1);
    expect(body.query).not.toContain('probe="}){mutation{evil}');
  });

  it("rejects origin control characters before transport", async () => {
    const request = successFetch();
    await expect(
      new ShopeeOpenApiClient(credentials, {
        fetch: request,
        now: () => now,
      }).generateShortLink({
        originUrl: "https://shopee.com.br/produto-i.123.456\n",
        itemId: "456",
      }),
    ).rejects.toThrow("SHOPEE_ORIGIN_URL_INVALID");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an invalid SubId before fetch without consuming rate capacity", async () => {
    const request = successFetch();
    const client = new ShopeeOpenApiClient(credentials, {
      fetch: request,
      now: () => now,
      rateLimitPerHour: 1,
    });
    await expect(
      client.generateShortLink({
        originUrl,
        itemId: "456",
        subIds: ["source_datafeed"],
      }),
    ).rejects.toThrow("SHOPEE_SUB_ID_INVALID");
    expect(request).not.toHaveBeenCalled();

    await expect(
      client.generateShortLink({
        originUrl,
        itemId: "456",
        subIds: ["sourcedatafeed", "retry"],
      }),
    ).resolves.toMatchObject({ provider: "SHOPEE_OPEN_API" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("recognizes longLink without returning or persisting it", async () => {
    const result = await new ShopeeOpenApiClient(credentials, {
      fetch: successFetch(),
      now: () => now,
    }).generateShortLink({ originUrl, itemId: "456" });
    expect(result.affiliateUrl).toBe("https://s.shopee.com.br/fixture");
    expect(result).not.toHaveProperty("longLink");
  });

  it("fails safely for timeout and non-200 HTTP", async () => {
    const timeoutFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    await expect(
      new ShopeeOpenApiClient(credentials, {
        fetch: timeoutFetch,
        now: () => now,
        timeoutMs: 1,
      }).generateShortLink({ originUrl, itemId: "456" }),
    ).rejects.toThrow("SHOPEE_OPEN_API_TIMEOUT");
    await expect(
      new ShopeeOpenApiClient(credentials, {
        fetch: vi.fn(async () => response({}, 503)),
        now: () => now,
      }).generateShortLink({ originUrl, itemId: "456" }),
    ).rejects.toThrow("SHOPEE_OPEN_API_HTTP_ERROR");
  });

  it("classifies HTTP 429 as a retryable rate-limit error", async () => {
    const operation = new ShopeeOpenApiClient(credentials, {
      fetch: vi.fn(async () => response({}, 429)),
      now: () => now,
    }).generateShortLink({ originUrl, itemId: "456" });
    await expect(operation).rejects.toMatchObject({
      code: "SHOPEE_OPEN_API_RATE_LIMITED",
      retryable: true,
    });
  });

  it("rejects malformed JSON without reflecting response contents", async () => {
    const privateResponse = `not-json-${credentials.secret}`;
    const request = vi.fn(
      async () =>
        new Response(privateResponse, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const promise = new ShopeeOpenApiClient(credentials, {
      fetch: request,
      now: () => now,
    }).generateShortLink({ originUrl, itemId: "456" });
    await expect(promise).rejects.toThrow("SHOPEE_OPEN_API_RESPONSE_INVALID");
    await expect(promise).rejects.not.toThrow(privateResponse);
  });

  it.each([
    [10000, "SHOPEE_OPEN_API_SYSTEM_ERROR"],
    [10010, "SHOPEE_OPEN_API_REQUEST_PARSE_ERROR"],
    [10020, "SHOPEE_OPEN_API_AUTHENTICATION_FAILED"],
    [10030, "SHOPEE_OPEN_API_RATE_LIMITED"],
    [11000, "SHOPEE_OPEN_API_BUSINESS_ERROR"],
  ])(
    "maps GraphQL error %i without exposing response details",
    async (code, expected) => {
      const client = new ShopeeOpenApiClient(credentials, {
        fetch: vi.fn(async () =>
          response({
            errors: [
              {
                message: `secret=${credentials.secret}`,
                extensions: { code },
              },
            ],
          }),
        ),
        now: () => now,
      });
      await expect(
        client.generateShortLink({ originUrl, itemId: "456" }),
      ).rejects.toThrow(expected);
      await expect(
        client.generateShortLink({ originUrl, itemId: "456" }),
      ).rejects.not.toThrow(credentials.secret);
    },
  );

  it.each([
    [{}, "SHOPEE_OPEN_API_SHORT_LINK_MISSING"],
    [{ data: {} }, "SHOPEE_OPEN_API_SHORT_LINK_MISSING"],
    [
      {
        data: { generateShortLink: { shortLink: "https://evil.example/link" } },
      },
      "SHOPEE_SHORT_LINK_INVALID",
    ],
  ])(
    "rejects incomplete or unsafe success responses",
    async (body, expected) => {
      await expect(
        new ShopeeOpenApiClient(credentials, {
          fetch: vi.fn(async () => response(body)),
          now: () => now,
        }).generateShortLink({ originUrl, itemId: "456" }),
      ).rejects.toThrow(expected);
    },
  );

  it("enforces a conservative local hourly limit", async () => {
    const request = successFetch();
    const client = new ShopeeOpenApiClient(credentials, {
      fetch: request,
      now: () => now,
      rateLimitPerHour: 1,
    });
    await client.generateShortLink({ originUrl, itemId: "456" });
    await expect(
      client.generateShortLink({ originUrl, itemId: "456" }),
    ).rejects.toThrow("SHOPEE_OPEN_API_LOCAL_RATE_LIMITED");
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("Shopee product and generated link validation", () => {
  it("extracts and matches itemId from official product URL shapes", () => {
    expect(extractShopeeItemId(new URL(originUrl))).toBe("456");
    expect(
      validateShopeeProductOrigin(
        "https://www.shopee.com.br/product/123/456",
        "456",
      ),
    ).toMatchObject({ ok: true, itemId: "456" });
  });

  it.each([
    "https://shopee.com.br.evil.example/produto-i.123.456",
    "http://shopee.com.br/produto-i.123.456",
    "https://user:pass@shopee.com.br/produto-i.123.456",
    "https://shopee.com.br:8443/produto-i.123.456",
    "https://shope.ee/fixture",
    "https://s.shopee.com.br/produto-i.123.456",
  ])("rejects unsafe origin %s", (url) => {
    expect(validateShopeeProductOrigin(url, "456").ok).toBe(false);
  });

  it("rejects a divergent or missing itemId", () => {
    expect(validateShopeeProductOrigin(originUrl, "999")).toMatchObject({
      ok: false,
      code: "SHOPEE_ORIGIN_ITEM_ID_MISMATCH",
    });
    expect(
      validateShopeeProductOrigin("https://shopee.com.br/produto", "456"),
    ).toMatchObject({
      ok: false,
      code: "SHOPEE_ORIGIN_ITEM_ID_MISSING",
    });
  });

  it("accepts only the expected generated short-link host", () => {
    expect(
      validateShopeeGeneratedShortLink("https://s.shopee.com.br/fixture").ok,
    ).toBe(true);
    expect(
      validateShopeeGeneratedShortLink(
        "https://s.shopee.com.br.evil.test/fixture",
      ).ok,
    ).toBe(false);
    expect(
      validateShopeeGeneratedShortLink("https://shope.ee/fixture").ok,
    ).toBe(false);
  });
});
