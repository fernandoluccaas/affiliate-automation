import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  runShopeeOpenApiSmoke,
  serializeShopeeOpenApiSmokeResult,
} from "./open-api-smoke";

const originUrl = "https://shopee.com.br/produto-ficticio-i.123.456";
const now = () => new Date("2020-01-01T00:00:00.000Z");

function environment(mode = "OPEN_API"): NodeJS.ProcessEnv {
  return {
    SHOPEE_AFFILIATE_ENABLED: "true",
    SHOPEE_AFFILIATE_MODE: mode,
    SHOPEE_OPEN_API_APP_ID: "fixture-sensitive-app-id",
    SHOPEE_OPEN_API_SECRET: "fixture-sensitive-secret",
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulFetch() {
  return vi.fn(async () =>
    response({
      data: {
        generateShortLink: {
          shortLink: "https://s.shopee.com.br/smoke-fixture",
        },
      },
    }),
  );
}

function confirmedInput() {
  return {
    confirmLiveCall: true,
    originUrl,
    itemId: "456",
    subIds: ["smoke_fixture"],
  };
}

describe("controlled Shopee Open API smoke test", () => {
  it("fails closed without confirmation and never calls fetch", async () => {
    const request = successfulFetch();
    const result = await runShopeeOpenApiSmoke(
      { ...confirmedInput(), confirmLiveCall: false },
      { environment: environment(), fetch: request, now },
    );

    expect(result).toEqual({
      success: false,
      requestAttempts: 0,
      errorCode: "LIVE_CALL_NOT_CONFIRMED",
      stateModified: false,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects missing credentials before fetch", async () => {
    const request = successfulFetch();
    const result = await runShopeeOpenApiSmoke(confirmedInput(), {
      environment: {
        SHOPEE_AFFILIATE_ENABLED: "true",
        SHOPEE_AFFILIATE_MODE: "OPEN_API",
      },
      fetch: request,
      now,
    });
    expect(result).toMatchObject({
      success: false,
      requestAttempts: 0,
      errorCode: "SHOPEE_OPEN_API_CREDENTIALS_MISSING",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects OFF mode", async () => {
    const request = successfulFetch();
    const result = await runShopeeOpenApiSmoke(confirmedInput(), {
      environment: environment("OFF"),
      fetch: request,
      now,
    });
    expect(result).toMatchObject({ success: false, requestAttempts: 0 });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects DATAFEED mode", async () => {
    const request = successfulFetch();
    const result = await runShopeeOpenApiSmoke(confirmedInput(), {
      environment: environment("DATAFEED"),
      fetch: request,
      now,
    });
    expect(result).toMatchObject({
      success: false,
      requestAttempts: 0,
      errorCode: "SHOPEE_OPEN_API_MODE_REQUIRED",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["OPEN_API", "HYBRID"])(
    "permits %s mode and performs one request",
    async (mode) => {
      const request = successfulFetch();
      const result = await runShopeeOpenApiSmoke(confirmedInput(), {
        environment: environment(mode),
        fetch: request,
        now,
      });
      expect(result).toMatchObject({ success: true, requestAttempts: 1 });
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("rejects a disabled feature even when OPEN_API is requested", async () => {
    const request = successfulFetch();
    const result = await runShopeeOpenApiSmoke(confirmedInput(), {
      environment: {
        ...environment(),
        SHOPEE_AFFILIATE_ENABLED: "false",
      },
      fetch: request,
      now,
    });
    expect(result).toMatchObject({
      success: false,
      requestAttempts: 0,
      errorCode: "SHOPEE_AFFILIATE_DISABLED",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "http://shopee.com.br/produto-i.123.456",
    "https://shopee.com.br.evil.example/produto-i.123.456",
    "https://shope.ee/produto-i.123.456",
  ])("rejects unsafe origin %s before fetch", async (unsafeOrigin) => {
    const request = successfulFetch();
    const result = await runShopeeOpenApiSmoke(
      { ...confirmedInput(), originUrl: unsafeOrigin },
      { environment: environment(), fetch: request, now },
    );
    expect(result).toMatchObject({
      success: false,
      requestAttempts: 0,
      errorCode: "SHOPEE_ORIGIN_URL_INVALID",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a missing itemId before fetch", async () => {
    const request = successfulFetch();
    const result = await runShopeeOpenApiSmoke(
      { confirmLiveCall: true, originUrl },
      { environment: environment(), fetch: request, now },
    );
    expect(result).toMatchObject({
      success: false,
      requestAttempts: 0,
      errorCode: "SHOPEE_ORIGIN_ITEM_ID_REQUIRED",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a divergent itemId before fetch", async () => {
    const request = successfulFetch();
    const result = await runShopeeOpenApiSmoke(
      { ...confirmedInput(), itemId: "999" },
      { environment: environment(), fetch: request, now },
    );
    expect(result).toMatchObject({
      success: false,
      requestAttempts: 0,
      errorCode: "SHOPEE_ORIGIN_ITEM_ID_MISMATCH",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects more than five SubIds before fetch", async () => {
    const request = successfulFetch();
    const result = await runShopeeOpenApiSmoke(
      { ...confirmedInput(), subIds: ["a", "b", "c", "d", "e", "f"] },
      { environment: environment(), fetch: request, now },
    );
    expect(result).toMatchObject({
      success: false,
      requestAttempts: 0,
      errorCode: "SHOPEE_SUB_IDS_LIMIT_EXCEEDED",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("returns only the validated official shortlink and immutable-state markers", async () => {
    const request = successfulFetch();
    const result = await runShopeeOpenApiSmoke(confirmedInput(), {
      environment: environment(),
      fetch: request,
      now,
    });
    expect(result).toEqual({
      success: true,
      requestAttempts: 1,
      operation: "GenerateShortLink",
      originItemId: "456",
      shortLink: "https://s.shopee.com.br/smoke-fixture",
      shortLinkHost: "s.shopee.com.br",
      stateModified: false,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not retry an HTTP failure", async () => {
    const request = vi.fn(async () => response({}, 503));
    const result = await runShopeeOpenApiSmoke(confirmedInput(), {
      environment: environment(),
      fetch: request,
      now,
    });
    expect(result).toMatchObject({
      success: false,
      requestAttempts: 1,
      errorCode: "SHOPEE_OPEN_API_HTTP_ERROR",
      stateModified: false,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("times out after one request without retry", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(
        (_request: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("fixture abort")),
            );
          }),
      );
      const pending = runShopeeOpenApiSmoke(confirmedInput(), {
        environment: {
          ...environment(),
          SHOPEE_OPEN_API_TIMEOUT_MS: "1000",
        },
        fetch: request,
        now,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({
        success: false,
        requestAttempts: 1,
        errorCode: "SHOPEE_OPEN_API_TIMEOUT",
      });
      expect(request).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes GraphQL errors and all output secrets", async () => {
    const request = vi.fn(async () =>
      response({
        errors: [
          {
            message:
              "fixture-sensitive-secret fixture-sensitive-app-id Authorization Signature",
            extensions: { code: 10020 },
          },
        ],
      }),
    );
    const result = await runShopeeOpenApiSmoke(confirmedInput(), {
      environment: environment(),
      fetch: request,
      now,
    });
    const stdout = serializeShopeeOpenApiSmokeResult(result);
    const stderr = "";
    expect(result).toMatchObject({
      success: false,
      requestAttempts: 1,
      errorCode: "SHOPEE_OPEN_API_AUTHENTICATION_FAILED",
      stateModified: false,
    });
    for (const sensitive of [
      "fixture-sensitive-secret",
      "fixture-sensitive-app-id",
      "Authorization",
      "Signature",
    ]) {
      expect(stdout).not.toContain(sensitive);
      expect(stderr).not.toContain(sensitive);
    }
  });

  it("has no database, import, Redis or operational dependency", () => {
    const source = readFileSync(
      new URL("./open-api-smoke.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /@affiliate\/database|prisma|postgres|redis|\.\/operational|\.\/index/iu,
    );
  });
});
