import { canScheduleInWindow } from "@affiliate/publication";
import type { ShopeeAffiliateConfiguration } from "./types";

export type ShopeeDistributionSkipCode =
  | "SHOPEE_AUTO_DISTRIBUTION_DISABLED"
  | "SHOPEE_PUBLICATION_CHANNEL_DISABLED"
  | "SHOPEE_PUBLICATION_CYCLE_LIMIT"
  | "SHOPEE_PUBLICATION_DAILY_LIMIT"
  | "SHOPEE_PUBLICATION_MIN_INTERVAL"
  | "SHOPEE_PUBLICATION_OUTSIDE_WINDOW";

export type ShopeeDistributionPolicyInput = {
  configuration: ShopeeAffiliateConfiguration;
  channelType: string;
  timezone: string;
  now: Date;
  scheduledThisCycle: number;
  publicationsToday: number;
  lastPublicationAt?: Date | null;
};

export function isShopeeAutomaticDistributionEnabled(
  configuration: ShopeeAffiliateConfiguration,
) {
  return (
    configuration.publicationEnabled && configuration.autoDistributionEnabled
  );
}

export function isShopeeDistributionChannelEnabled(
  configuration: ShopeeAffiliateConfiguration,
  channelType: string,
) {
  if (channelType === "TELEGRAM") {
    return configuration.publicationTelegramEnabled;
  }
  if (channelType === "WHATSAPP_GROUPS") {
    return configuration.publicationWhatsAppEnabled;
  }
  return false;
}

export function evaluateShopeeDistributionPolicy(
  input: ShopeeDistributionPolicyInput,
): { ok: true } | { ok: false; code: ShopeeDistributionSkipCode } {
  if (!isShopeeAutomaticDistributionEnabled(input.configuration)) {
    return { ok: false, code: "SHOPEE_AUTO_DISTRIBUTION_DISABLED" };
  }
  if (
    !isShopeeDistributionChannelEnabled(
      input.configuration,
      input.channelType,
    )
  ) {
    return { ok: false, code: "SHOPEE_PUBLICATION_CHANNEL_DISABLED" };
  }
  if (
    input.scheduledThisCycle >= input.configuration.publicationMaxPerCycle
  ) {
    return { ok: false, code: "SHOPEE_PUBLICATION_CYCLE_LIMIT" };
  }
  const window = canScheduleInWindow({
    channel: {
      enabled: true,
      type: input.channelType,
      timezone: input.timezone,
      dailyPublicationLimit: input.configuration.publicationMaxPerDay,
      minimumIntervalMinutes:
        input.configuration.publicationMinIntervalMinutes,
      allowedStartTime: input.configuration.publicationWindowStart,
      allowedEndTime: input.configuration.publicationWindowEnd,
      productRepeatIntervalDays: 0,
      allowedMarketplaces: ["SHOPEE"],
      allowedCategories: [],
    },
    now: input.now,
    publicationsToday: input.publicationsToday,
    lastPublicationAt: input.lastPublicationAt ?? null,
    lastProductPublicationAt: null,
  });
  if (window.ok) return window;
  if (window.code === "CHANNEL_DAILY_LIMIT") {
    return { ok: false, code: "SHOPEE_PUBLICATION_DAILY_LIMIT" };
  }
  if (window.code === "CHANNEL_MIN_INTERVAL") {
    return { ok: false, code: "SHOPEE_PUBLICATION_MIN_INTERVAL" };
  }
  return { ok: false, code: "SHOPEE_PUBLICATION_OUTSIDE_WINDOW" };
}

export function nextShopeePublicationAt(input: {
  configuration: ShopeeAffiliateConfiguration;
  lastPublicationAt?: Date | null;
}) {
  if (!input.lastPublicationAt) return null;
  return new Date(
    input.lastPublicationAt.getTime() +
      input.configuration.publicationMinIntervalMinutes * 60_000,
  );
}
