import { describe, expect, it, vi } from "vitest";
import { resolveShopeeAffiliateConfiguration } from "./config";
import {
  evaluateShopeeDispatchGates,
  previewShopeeDispatch,
  type ShopeeDispatchRecord,
} from "./dispatch";

const liveEnvironment = {
  SHOPEE_PUBLICATION_ENABLED: "true",
  SHOPEE_AUTO_DISTRIBUTION_ENABLED: "true",
  SHOPEE_EXTERNAL_SENDS_ENABLED: "true",
  SHOPEE_PUBLICATION_TELEGRAM_ENABLED: "true",
} as NodeJS.ProcessEnv;

function record(
  overrides: Partial<ShopeeDispatchRecord> = {},
): ShopeeDispatchRecord {
  return {
    publicationId: "publication-fixture",
    offerId: "offer-fixture",
    channelId: "channel-fixture",
    marketplace: "SHOPEE",
    publicationStatus: "SCHEDULED",
    channelType: "TELEGRAM",
    channelEnabled: true,
    allowedMarketplaces: ["MERCADO_LIVRE", "SHOPEE"],
    trackingUrl: "https://affiliate.test/go/shopee-fixture",
    affiliateLinks: [
      { active: true, destination: "https://s.shopee.com.br/AbCdEf" },
    ],
    deliveryUncertain: false,
    ...overrides,
  };
}

describe("Shopee dispatch gates", () => {
  it("blocks every external dispatch while the global kill switch is off", () => {
    const gate = evaluateShopeeDispatchGates({
      configuration: resolveShopeeAffiliateConfiguration({
        ...liveEnvironment,
        SHOPEE_EXTERNAL_SENDS_ENABLED: "false",
      }),
      record: record(),
    });
    expect(gate).toEqual({ ok: false, code: "SHOPEE_EXTERNAL_SENDS_DISABLED" });
  });

  it("requires the canonical link and never accepts productUrl as fallback", () => {
    const gate = evaluateShopeeDispatchGates({
      configuration: resolveShopeeAffiliateConfiguration(liveEnvironment),
      record: record({
        affiliateLinks: [
          { active: true, destination: "https://shopee.com.br/product/1/2" },
        ],
      }),
    });
    expect(gate).toEqual({ ok: false, code: "SHOPEE_AFFILIATE_LINK_MISSING" });
  });

  it.each([
    "http://affiliate.test/go/shopee-fixture",
    "http://localhost:3000/go/shopee-fixture",
    "https://127.0.0.1/go/shopee-fixture",
    "/go/shopee-fixture",
  ])("blocks a non-public tracking URL before kill switches: %s", (trackingUrl) => {
    const gate = evaluateShopeeDispatchGates({
      configuration: resolveShopeeAffiliateConfiguration({}),
      record: record({ trackingUrl }),
    });
    expect(gate).toEqual({
      ok: false,
      code: "SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS",
    });
  });

  it("does not use the affiliate destination as tracking fallback", () => {
    const gate = evaluateShopeeDispatchGates({
      configuration: resolveShopeeAffiliateConfiguration(liveEnvironment),
      record: record({ trackingUrl: "https://s.shopee.com.br/AbCdEf" }),
    });
    expect(gate).toEqual({
      ok: false,
      code: "SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS",
    });
  });

  it("blocks automatic retry for uncertain delivery", () => {
    const gate = evaluateShopeeDispatchGates({
      configuration: resolveShopeeAffiliateConfiguration(liveEnvironment),
      record: record({ deliveryUncertain: true }),
    });
    expect(gate).toEqual({
      ok: false,
      code: "SHOPEE_DELIVERY_UNCERTAIN_REVIEW_REQUIRED",
    });
  });

  it("previews a ready Telegram dispatch with zero effects", async () => {
    const load = vi.fn(async () => record());
    const result = await previewShopeeDispatch({
      publicationId: "publication-fixture",
      channelId: "channel-fixture",
      environment: liveEnvironment,
      load,
    });
    expect(result).toMatchObject({
      status: "READY",
      allowed: true,
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(load).toHaveBeenCalledOnce();
  });

  it("previews localhost as a structured blocker with zero effects", async () => {
    const result = await previewShopeeDispatch({
      publicationId: "publication-fixture",
      channelId: "channel-fixture",
      environment: liveEnvironment,
      load: vi.fn(async () =>
        record({ trackingUrl: "http://localhost:3000/go/shopee-fixture" }),
      ),
    });
    expect(result).toMatchObject({
      status: "BLOCKED",
      allowed: false,
      reason: "SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS",
      trackingUrlValid: false,
      trackingUrlReason: "NOT_HTTPS",
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
  });
});
