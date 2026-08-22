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

  it("uses safe defaults for recent repetition and shop diversity", () => {
    expect(resolveShopeeAffiliateConfiguration({})).toMatchObject({
      recentSelectionWindowDays: 7,
      maxPerShopPerSession: 2,
      autoLinkAfterImport: false,
      autoLinkMaxPerRun: 12,
      autoLinkConcurrency: 1,
      discoverySource: "LOCAL_FILE",
      automatedDiscoveryEnabled: false,
      remoteDiscoveryReady: false,
      remoteDiscoveryContract: "OFFICIAL_V2_FULL",
      remoteDiscoveryState: "DISABLED_BY_SOURCE",
      remoteDiscoveryAutoRunReady: false,
      remoteDiscoveryPageSize: 500,
      remoteDiscoveryMaxPages: 10,
      remoteDiscoveryMaxItems: 10_000,
      remoteDiscoveryFeedIds: [],
      remoteDiscoveryReferenceIds: [],
    });
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_RECENT_SELECTION_WINDOW_DAYS: "invalid",
        SHOPEE_MAX_PER_SHOP_PER_SESSION: "99",
      }),
    ).toMatchObject({
      recentSelectionWindowDays: 7,
      maxPerShopPerSession: 2,
    });
  });

  it("accepts official remote discovery settings and prefers stable references", () => {
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_DISCOVERY_SOURCE: "OPEN_API_FEED",
        SHOPEE_AUTOMATED_DISCOVERY_ENABLED: "true",
        SHOPEE_REMOTE_DISCOVERY_MAX_PAGES: "20",
        SHOPEE_REMOTE_DISCOVERY_MAX_ITEMS: "5000",
        SHOPEE_REMOTE_DISCOVERY_PAGE_SIZE: "250",
        SHOPEE_REMOTE_DISCOVERY_REFERENCE_IDS: "ref-b,ref-a,ref-b",
        SHOPEE_REMOTE_DISCOVERY_FEED_IDS: "feed-b,feed-a,feed-b",
      }),
    ).toMatchObject({
      discoverySource: "OPEN_API_FEED",
      automatedDiscoveryEnabled: true,
      remoteDiscoveryReady: false,
      remoteDiscoveryPageSize: 250,
      remoteDiscoveryMaxPages: 20,
      remoteDiscoveryMaxItems: 5_000,
      remoteDiscoveryFeedIds: ["feed-b", "feed-a"],
      remoteDiscoveryReferenceIds: ["ref-b", "ref-a"],
    });
  });

  it("reports the official adapter ready separately from automatic allowlisting", () => {
    const base = {
      SHOPEE_AFFILIATE_ENABLED: "true",
      SHOPEE_AFFILIATE_MODE: "HYBRID",
      SHOPEE_OPEN_API_APP_ID: "fixture-app",
      SHOPEE_OPEN_API_SECRET: "fixture-secret",
      SHOPEE_DISCOVERY_SOURCE: "OPEN_API_FEED",
    };
    expect(resolveShopeeAffiliateConfiguration(base)).toMatchObject({
      remoteDiscoveryContract: "OFFICIAL_V2_FULL",
      remoteDiscoveryState: "READY_FOR_OPEN_API_FEED",
      remoteDiscoveryReady: true,
      remoteDiscoveryAutoRunReady: false,
    });
    expect(
      resolveShopeeAffiliateConfiguration({
        ...base,
        SHOPEE_REMOTE_DISCOVERY_REFERENCE_IDS: "stable-reference",
        SHOPEE_REMOTE_DISCOVERY_MAX_PAGES: "250",
        SHOPEE_REMOTE_DISCOVERY_MAX_ITEMS: "120000",
      }),
    ).toMatchObject({
      remoteDiscoveryReady: true,
      remoteDiscoveryAutoRunReady: true,
      remoteDiscoveryMaxPages: 250,
      remoteDiscoveryMaxItems: 120_000,
    });
  });

  it("fails closed for invalid remote discovery limits and feed identifiers", () => {
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_DISCOVERY_SOURCE: "UNKNOWN",
        SHOPEE_REMOTE_DISCOVERY_MAX_PAGES: "0",
        SHOPEE_REMOTE_DISCOVERY_MAX_ITEMS: "999999",
        SHOPEE_REMOTE_DISCOVERY_PAGE_SIZE: "501",
        SHOPEE_REMOTE_DISCOVERY_REFERENCE_IDS: "contains spaces",
        SHOPEE_REMOTE_DISCOVERY_FEED_IDS: "contains spaces",
      }),
    ).toMatchObject({
      configurationValid: false,
      discoverySource: "LOCAL_FILE",
      remoteDiscoveryMaxPages: 10,
      remoteDiscoveryMaxItems: 10_000,
      remoteDiscoveryFeedIds: [],
      issues: expect.arrayContaining([
        "SHOPEE_DISCOVERY_SOURCE_INVALID",
        "SHOPEE_REMOTE_DISCOVERY_MAX_PAGES_INVALID",
        "SHOPEE_REMOTE_DISCOVERY_MAX_ITEMS_INVALID",
        "SHOPEE_REMOTE_DISCOVERY_PAGE_SIZE_INVALID",
        "SHOPEE_REMOTE_DISCOVERY_REFERENCE_IDS_INVALID",
        "SHOPEE_REMOTE_DISCOVERY_FEED_IDS_INVALID",
      ]),
    });
  });

  it("enables post-import auto-linking only through exact safe settings", () => {
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_AUTO_LINK_AFTER_IMPORT: "true",
        SHOPEE_AUTO_LINK_MAX_PER_RUN: "6",
        SHOPEE_AUTO_LINK_CONCURRENCY: "1",
      }),
    ).toMatchObject({
      autoLinkAfterImport: true,
      autoLinkMaxPerRun: 6,
      autoLinkConcurrency: 1,
    });
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_AUTO_LINK_AFTER_IMPORT: "TRUE",
      }).autoLinkAfterImport,
    ).toBe(false);
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_AUTO_LINK_MAX_PER_RUN: "13",
        SHOPEE_AUTO_LINK_CONCURRENCY: "2",
      }),
    ).toMatchObject({
      configurationValid: false,
      autoLinkMaxPerRun: 12,
      autoLinkConcurrency: 1,
      issues: expect.arrayContaining([
        "SHOPEE_AUTO_LINK_MAX_PER_RUN_INVALID",
        "SHOPEE_AUTO_LINK_CONCURRENCY_INVALID",
      ]),
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
