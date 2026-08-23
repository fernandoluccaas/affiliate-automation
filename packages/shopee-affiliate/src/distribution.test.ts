import { describe, expect, it } from "vitest";
import { resolveShopeeAffiliateConfiguration } from "./config";
import {
  evaluateShopeeDistributionPolicy,
  isShopeeAutomaticDistributionEnabled,
} from "./distribution";

function configuration(overrides: NodeJS.ProcessEnv = {}) {
  return resolveShopeeAffiliateConfiguration({
    SHOPEE_PUBLICATION_ENABLED: "true",
    SHOPEE_AUTO_DISTRIBUTION_ENABLED: "true",
    SHOPEE_PUBLICATION_TELEGRAM_ENABLED: "true",
    ...overrides,
  });
}

function evaluate(overrides: Partial<Parameters<typeof evaluateShopeeDistributionPolicy>[0]> = {}) {
  return evaluateShopeeDistributionPolicy({
    configuration: configuration(),
    channelType: "TELEGRAM",
    timezone: "America/Fortaleza",
    now: new Date("2026-08-23T15:00:00.000Z"),
    scheduledThisCycle: 0,
    publicationsToday: 0,
    lastPublicationAt: null,
    ...overrides,
  });
}

describe("Shopee automated distribution policy", () => {
  it("fails closed when the scheduler flag is disabled", () => {
    const disabled = configuration({ SHOPEE_AUTO_DISTRIBUTION_ENABLED: "false" });
    expect(isShopeeAutomaticDistributionEnabled(disabled)).toBe(false);
    expect(evaluate({ configuration: disabled })).toEqual({
      ok: false,
      code: "SHOPEE_AUTO_DISTRIBUTION_DISABLED",
    });
  });

  it("gates Telegram and WhatsApp independently", () => {
    const disabledChannels = configuration({
      SHOPEE_PUBLICATION_TELEGRAM_ENABLED: "false",
      SHOPEE_PUBLICATION_WHATSAPP_ENABLED: "false",
    });
    expect(evaluate({ configuration: disabledChannels })).toEqual({
      ok: false,
      code: "SHOPEE_PUBLICATION_CHANNEL_DISABLED",
    });
    expect(
      evaluate({
        configuration: configuration({
          SHOPEE_PUBLICATION_TELEGRAM_ENABLED: "false",
          SHOPEE_PUBLICATION_WHATSAPP_ENABLED: "true",
        }),
        channelType: "WHATSAPP_GROUPS",
      }),
    ).toEqual({ ok: true });
  });

  it("enforces the per-cycle and daily limits", () => {
    expect(evaluate({ scheduledThisCycle: 2 })).toEqual({
      ok: false,
      code: "SHOPEE_PUBLICATION_CYCLE_LIMIT",
    });
    expect(evaluate({ publicationsToday: 12 })).toEqual({
      ok: false,
      code: "SHOPEE_PUBLICATION_DAILY_LIMIT",
    });
  });

  it("enforces the minimum interval", () => {
    expect(
      evaluate({ lastPublicationAt: new Date("2026-08-23T14:30:00.000Z") }),
    ).toEqual({ ok: false, code: "SHOPEE_PUBLICATION_MIN_INTERVAL" });
  });

  it("accepts and rejects the configured local-time window", () => {
    expect(evaluate()).toEqual({ ok: true });
    expect(evaluate({ now: new Date("2026-08-23T06:00:00.000Z") })).toEqual({
      ok: false,
      code: "SHOPEE_PUBLICATION_OUTSIDE_WINDOW",
    });
  });
});
