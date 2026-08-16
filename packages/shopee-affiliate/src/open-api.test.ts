import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GENERATE_SHORT_LINK_MUTATION,
  SHOPEE_OPEN_API_ENDPOINT,
  ShopeeOpenApiClient,
  createGenerateShortLinkPayload,
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
        },
      },
    }),
  );
}

describe("Shopee Affiliate Open API signature and payload", () => {
  it("produces deterministic lowercase SHA-256 output", () => {
    const payload = createGenerateShortLinkPayload({
      originUrl,
      subIds: ["source_datafeed", "phase_6a3"],
    }).body;
    expect(
      createShopeeOpenApiSignature({
        appId: "123456",
        secret: "demo",
        timestamp: 1_577_836_800,
        payload,
      }),
    ).toBe("ab66144fa8bd551a0c9ad0e4c3ce95f5b9aa01f870e93d29b5ada3bfb7787b4b");
    expect(
      createShopeeOpenApiSignature({
        appId: "123456",
        secret: "demo",
        timestamp: 1_577_836_800,
        payload,
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses the named mutation, GraphQL variables and no interpolated URL", () => {
    const payload = createGenerateShortLinkPayload({ originUrl });
    expect(payload.request.operationName).toBe("GenerateShortLink");
    expect(payload.request.query).toBe(GENERATE_SHORT_LINK_MUTATION);
    expect(payload.request.query).not.toContain(originUrl);
    expect(payload.request.variables.originUrl).toBe(originUrl);
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
      subIds: ["source_datafeed"],
    });
    const [, init] = request.mock.calls[0]!;
    const body = String(init?.body);
    const signature = createHash("sha256")
      .update(`1234561577836800${body}demo`)
      .digest("hex");
    expect(init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: `SHA256 Credential=123456, Timestamp=1577836800, Signature=${signature}`,
    });
    expect(request).toHaveBeenCalledWith(
      SHOPEE_OPEN_API_ENDPOINT,
      expect.any(Object),
    );
  });

  it("limits and sanitizes optional SubIds", () => {
    expect(sanitizeShopeeSubIds([" Source_Datafeed ", "phase-6a3"])).toEqual([
      "source_datafeed",
      "phase-6a3",
    ]);
    expect(() => sanitizeShopeeSubIds([])).not.toThrow();
    expect(() => sanitizeShopeeSubIds(["a", "b", "c", "d", "e", "f"])).toThrow(
      "SHOPEE_SUB_IDS_LIMIT_EXCEEDED",
    );
    expect(() => sanitizeShopeeSubIds([""])).toThrow("SHOPEE_SUB_ID_INVALID");
  });
});

describe("Shopee Affiliate Open API transport", () => {
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
