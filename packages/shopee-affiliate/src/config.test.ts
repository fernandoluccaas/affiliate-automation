import { describe, expect, it } from "vitest";
import {
  SHOPEE_CATEGORY_CATALOG,
  resolveShopeeAffiliateConfiguration,
} from "./config";
import {
  OpenApiAffiliateLinkProvider,
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

  it("keeps OPEN_API unavailable", () => {
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_AFFILIATE_ENABLED: "true",
        SHOPEE_AFFILIATE_MODE: "OPEN_API",
      }),
    ).toMatchObject({
      mode: "OPEN_API",
      state: "WAITING_FOR_OFFICIAL_ACCESS",
      externalRequestsEnabled: false,
    });
  });

  it("keeps HYBRID unavailable", () => {
    expect(
      resolveShopeeAffiliateConfiguration({
        SHOPEE_AFFILIATE_ENABLED: "true",
        SHOPEE_AFFILIATE_MODE: "HYBRID",
      }),
    ).toMatchObject({
      mode: "HYBRID",
      state: "WAITING_FOR_OFFICIAL_ACCESS",
      externalRequestsEnabled: false,
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

  it("keeps all Open API providers unavailable without requests", async () => {
    await expect(new OpenApiOfferProvider().stream()).rejects.toThrow(
      "WAITING_FOR_OFFICIAL_ACCESS",
    );
    await expect(new OpenApiAffiliateLinkProvider().resolve()).rejects.toThrow(
      "WAITING_FOR_OFFICIAL_ACCESS",
    );
    await expect(new OpenApiConversionProvider().preflight()).resolves.toEqual({
      ready: false,
      reason: "SHOPEE_OPEN_API_WAITING_FOR_OFFICIAL_ACCESS",
    });
  });
});
