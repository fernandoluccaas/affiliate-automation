import { describe, expect, it } from "vitest";
import {
  SHOPEE_CATEGORY_CATALOG,
  resolveShopeeAffiliateConfiguration,
} from "./config";
import {
  OpenApiConversionProvider,
  OpenApiOfferProvider,
  assertShopeeOperationalPublishingAllowed,
} from "./providers";

describe("Shopee affiliate configuration", () => {
  it("defaults to OFF", () => {
    expect(resolveShopeeAffiliateConfiguration({})).toMatchObject({
      enabled: false,
      mode: "OFF",
      state: "DISABLED",
      linksVerified: false,
    });
  });

  it("enables DATAFEED explicitly", () => {
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_AFFILIATE_ENABLED: "true",
        SHOPEE_AFFILIATE_MODE: "DATAFEED",
      }),
    ).toMatchObject({
      enabled: true,
      mode: "DATAFEED",
      state: "READY_FOR_DATAFEED",
    });
  });

  it("fails closed for an unknown mode", () => {
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_AFFILIATE_ENABLED: "true",
        SHOPEE_AFFILIATE_MODE: "UNKNOWN",
      }),
    ).toMatchObject({
      enabled: false,
      mode: "OFF",
      state: "INVALID_CONFIGURATION",
    });
  });

  it("keeps OPEN_API fail-closed without credentials", () => {
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_AFFILIATE_ENABLED: "true",
        SHOPEE_AFFILIATE_MODE: "OPEN_API",
      }),
    ).toMatchObject({
      mode: "OPEN_API",
      state: "OPEN_API_NOT_CONFIGURED",
      externalRequestsEnabled: false,
      openApiConfigured: false,
    });
  });

  it("enables HYBRID only with both server-side credentials", () => {
    const resolved = resolveShopeeAffiliateConfiguration({
      SHOPEE_AFFILIATE_ENABLED: "true",
      SHOPEE_AFFILIATE_MODE: "HYBRID",
      SHOPEE_OPEN_API_APP_ID: "fixture-app",
      SHOPEE_OPEN_API_SECRET: "fixture-secret",
    });
    expect(resolved).toMatchObject({
      mode: "HYBRID",
      state: "READY_FOR_HYBRID",
      externalRequestsEnabled: true,
      operationalWritesEnabled: true,
      openApiConfigured: true,
    });
    expect(JSON.stringify(resolved)).not.toContain("fixture-app");
    expect(JSON.stringify(resolved)).not.toContain("fixture-secret");
  });

  it("fails closed with only one credential", () => {
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_AFFILIATE_ENABLED: "true",
        SHOPEE_AFFILIATE_MODE: "HYBRID",
        SHOPEE_OPEN_API_APP_ID: "fixture-app",
      }),
    ).toMatchObject({
      state: "OPEN_API_NOT_CONFIGURED",
      openApiConfigured: false,
      openApiReady: false,
      externalRequestsEnabled: false,
    });
  });

  it("bounds invalid and excessive transport settings", () => {
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_OPEN_API_TIMEOUT_MS: "invalid",
        SHOPEE_OPEN_API_RATE_LIMIT_PER_HOUR: "9000",
      }),
    ).toMatchObject({
      openApiTimeoutMs: 10_000,
      openApiRateLimitPerHour: 1_000,
    });
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_OPEN_API_TIMEOUT_MS: "30000",
        SHOPEE_OPEN_API_RATE_LIMIT_PER_HOUR: "8000",
      }),
    ).toMatchObject({
      openApiTimeoutMs: 30_000,
      openApiRateLimitPerHour: 8_000,
    });
  });

  it("opens the attribution gate only through the exact flag", () => {
    const base = {
      SHOPEE_AFFILIATE_ENABLED: "true",
      SHOPEE_AFFILIATE_MODE: "DATAFEED",
    };
    expect(
      resolveShopeeAffiliateConfiguration({
        ...base,
        SHOPEE_DATAFEED_LINKS_VERIFIED: "TRUE",
      }).linksVerified,
    ).toBe(false);
    expect(
      resolveShopeeAffiliateConfiguration({
        ...base,
        SHOPEE_DATAFEED_LINKS_VERIFIED: "true",
      }).linksVerified,
    ).toBe(true);
  });

  it("uses six centralized category mappings", () => {
    expect(SHOPEE_CATEGORY_CATALOG.map((item) => item.id)).toEqual([
      "CELULARES",
      "CASA",
      "MODA",
      "RELOGIOS",
      "AUTOMOTIVO",
      "ELETRODOMESTICOS",
    ]);
  });

  it("fails closed when operational publication is requested", () => {
    expect(() =>
      assertShopeeOperationalPublishingAllowed({ linksVerified: false }),
    ).toThrow("SHOPEE_DATAFEED_LINKS_NOT_VERIFIED");
    expect(() =>
      assertShopeeOperationalPublishingAllowed({ linksVerified: true }),
    ).toThrow("SHOPEE_DATAFEED_PREVIEW_ONLY");
  });

  it("keeps unsupported Open API discovery and conversion unavailable", async () => {
    await expect(new OpenApiOfferProvider().stream()).rejects.toThrow(
      "WAITING_FOR_OFFICIAL_ACCESS",
    );
    await expect(new OpenApiConversionProvider().preflight()).resolves.toEqual({
      ready: false,
      reason: "SHOPEE_OPEN_API_WAITING_FOR_OFFICIAL_ACCESS",
    });
  });
});
