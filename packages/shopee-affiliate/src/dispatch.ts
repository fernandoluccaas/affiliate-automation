import { prisma, type PrismaClient } from "@affiliate/database";
import { resolveShopeeAffiliateConfiguration } from "./config";
import { validateShopeeGeneratedShortLink } from "./validation";
import type { ShopeeAffiliateConfiguration } from "./types";

export type ShopeeDispatchRecord = {
  publicationId: string;
  offerId: string;
  channelId: string;
  marketplace: string;
  publicationStatus: string;
  channelType: string;
  channelEnabled: boolean;
  allowedMarketplaces: string[];
  trackingUrl: string;
  affiliateLinks: Array<{ active: boolean; destination: string }>;
  deliveryUncertain: boolean;
};

export type ShopeeDispatchGateCode =
  | "SHOPEE_PUBLICATION_DISABLED"
  | "SHOPEE_AUTO_DISTRIBUTION_DISABLED"
  | "SHOPEE_EXTERNAL_SENDS_DISABLED"
  | "SHOPEE_CHANNEL_SEND_DISABLED"
  | "SHOPEE_CHANNEL_DISABLED"
  | "SHOPEE_CHANNEL_MARKETPLACE_MISMATCH"
  | "SHOPEE_CHANNEL_TYPE_UNSUPPORTED"
  | "SHOPEE_PUBLICATION_NOT_SCHEDULED"
  | "SHOPEE_AFFILIATE_LINK_MISSING"
  | "SHOPEE_TRACKING_URL_INVALID"
  | "SHOPEE_DELIVERY_UNCERTAIN_REVIEW_REQUIRED";

export function evaluateShopeeDispatchGates(input: {
  configuration: ShopeeAffiliateConfiguration;
  record: ShopeeDispatchRecord;
}): { ok: true } | { ok: false; code: ShopeeDispatchGateCode } {
  const { configuration, record } = input;
  if (!configuration.publicationEnabled) {
    return { ok: false, code: "SHOPEE_PUBLICATION_DISABLED" };
  }
  if (!configuration.autoDistributionEnabled) {
    return { ok: false, code: "SHOPEE_AUTO_DISTRIBUTION_DISABLED" };
  }
  if (!configuration.externalSendsEnabled) {
    return { ok: false, code: "SHOPEE_EXTERNAL_SENDS_DISABLED" };
  }
  const channelGate =
    record.channelType === "TELEGRAM"
      ? configuration.publicationTelegramEnabled
      : record.channelType === "WHATSAPP_GROUPS"
        ? configuration.publicationWhatsAppEnabled
        : false;
  if (!channelGate) return { ok: false, code: "SHOPEE_CHANNEL_SEND_DISABLED" };
  if (!record.channelEnabled) {
    return { ok: false, code: "SHOPEE_CHANNEL_DISABLED" };
  }
  if (!record.allowedMarketplaces.includes("SHOPEE")) {
    return { ok: false, code: "SHOPEE_CHANNEL_MARKETPLACE_MISMATCH" };
  }
  if (!["TELEGRAM", "WHATSAPP_GROUPS"].includes(record.channelType)) {
    return { ok: false, code: "SHOPEE_CHANNEL_TYPE_UNSUPPORTED" };
  }
  if (record.publicationStatus !== "SCHEDULED") {
    return { ok: false, code: "SHOPEE_PUBLICATION_NOT_SCHEDULED" };
  }
  if (record.deliveryUncertain) {
    return {
      ok: false,
      code: "SHOPEE_DELIVERY_UNCERTAIN_REVIEW_REQUIRED",
    };
  }
  if (
    !record.affiliateLinks.some(
      (link) =>
        link.active && validateShopeeGeneratedShortLink(link.destination).ok,
    )
  ) {
    return { ok: false, code: "SHOPEE_AFFILIATE_LINK_MISSING" };
  }
  try {
    const tracking = new URL(record.trackingUrl, "https://local.invalid");
    if (!tracking.pathname.startsWith("/go/")) throw new Error();
  } catch {
    return { ok: false, code: "SHOPEE_TRACKING_URL_INVALID" };
  }
  return { ok: true };
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function loadShopeeDispatchRecord(
  publicationId: string,
  channelId: string,
  database: PrismaClient = prisma,
): Promise<ShopeeDispatchRecord | null> {
  const publication = await database.publication.findFirst({
    where: { id: publicationId, channelId },
    include: {
      channel: true,
      offer: { include: { affiliateLinks: true } },
    },
  });
  if (!publication || publication.offer.marketplace !== "SHOPEE") return null;
  const metadata = object(publication.metadata);
  return {
    publicationId: publication.id,
    offerId: publication.offerId,
    channelId: publication.channelId,
    marketplace: publication.offer.marketplace,
    publicationStatus: publication.status,
    channelType: publication.channel.type,
    channelEnabled: publication.channel.enabled,
    allowedMarketplaces: strings(publication.channel.allowedMarketplaces),
    trackingUrl: publication.trackingUrlSnapshot,
    affiliateLinks: publication.offer.affiliateLinks.map((link) => ({
      active: link.active,
      destination: link.destination,
    })),
    deliveryUncertain:
      metadata.deliveryUncertain === true ||
      metadata.deliveryState === "DELIVERY_UNCERTAIN",
  };
}

export async function previewShopeeDispatch(input: {
  publicationId: string;
  channelId: string;
  environment?: NodeJS.ProcessEnv;
  load?: typeof loadShopeeDispatchRecord;
}) {
  const record = await (input.load ?? loadShopeeDispatchRecord)(
    input.publicationId,
    input.channelId,
  );
  if (!record) {
    return {
      status: "BLOCKED",
      allowed: false,
      reason: "SHOPEE_PUBLICATION_NOT_FOUND",
      publicationId: input.publicationId,
      channelId: input.channelId,
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    } as const;
  }
  const gate = evaluateShopeeDispatchGates({
    configuration: resolveShopeeAffiliateConfiguration(
      input.environment ?? process.env,
    ),
    record,
  });
  return {
    status: gate.ok ? "READY" : "BLOCKED",
    allowed: gate.ok,
    reason: gate.ok ? null : gate.code,
    publicationId: record.publicationId,
    offerId: record.offerId,
    channelId: record.channelId,
    channelType: record.channelType,
    trackingUrlValid: record.trackingUrl.includes("/go/"),
    canonicalAffiliateLink: record.affiliateLinks.some(
      (link) =>
        link.active && validateShopeeGeneratedShortLink(link.destination).ok,
    ),
    externalRequests: 0,
    writes: 0,
    messagesSent: 0,
    stateModified: false,
  } as const;
}
