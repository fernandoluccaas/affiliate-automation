import { prisma, type PrismaClient } from "@affiliate/database";
import { resolveShopeeAffiliateConfiguration } from "./config";
import {
  createOfficialShopeeProductEnrichmentClient,
  type ShopeeProductEnrichmentClient,
} from "./enrichment";
import { validateShopeeGeneratedShortLink } from "./validation";

export type ShopeeFreshnessReasonCode =
  | "SHOPEE_OFFER_FRESH"
  | "SHOPEE_OFFER_STALE"
  | "SHOPEE_OFFER_REFRESH_FAILED"
  | "SHOPEE_OFFER_NO_LONGER_ELIGIBLE"
  | "SHOPEE_AFFILIATE_LINK_MISSING"
  | "SHOPEE_PUBLICATION_DUPLICATE";

export type ShopeeFreshnessRecord = {
  publicationId: string;
  offerId: string;
  channelId: string;
  marketplace: string;
  externalProductId: string;
  currentPrice: number;
  collectedAt: Date;
  verifiedAt: Date | null;
  duplicate: boolean;
  affiliateLinks: Array<{ active: boolean; destination: string }>;
};

export interface ShopeeFreshnessStore {
  load(publicationId: string): Promise<ShopeeFreshnessRecord | null>;
  markRefreshed(offerId: string, now: Date): Promise<void>;
  cancel(input: {
    publicationId: string;
    offerId: string;
    reason: Exclude<ShopeeFreshnessReasonCode, "SHOPEE_OFFER_FRESH">;
  }): Promise<void>;
}

export function evaluateShopeeOfferFreshness(input: {
  collectedAt: Date;
  verifiedAt?: Date | null;
  now: Date;
  maxAgeHours: number;
}) {
  const reference = input.verifiedAt ?? input.collectedAt;
  return (
    input.now.getTime() - reference.getTime() <= input.maxAgeHours * 3_600_000
  );
}

function hasCanonicalAffiliateLink(record: ShopeeFreshnessRecord) {
  return record.affiliateLinks.some(
    (link) =>
      link.active && validateShopeeGeneratedShortLink(link.destination).ok,
  );
}

export async function ensureShopeePublicationFreshness(input: {
  publicationId: string;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  store?: ShopeeFreshnessStore;
  refreshClient?: ShopeeProductEnrichmentClient;
}) {
  const environment = input.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  const now = input.now ?? new Date();
  const store = input.store ?? createPrismaShopeeFreshnessStore();
  const record = await store.load(input.publicationId);
  if (!record || record.marketplace !== "SHOPEE") {
    return {
      publicationId: input.publicationId,
      offerId: record?.offerId ?? null,
      allowed: false,
      reason: "SHOPEE_OFFER_NO_LONGER_ELIGIBLE" as const,
      refreshAttempted: false,
      refreshSucceeded: false,
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    };
  }
  const cancel = async (
    reason: Exclude<ShopeeFreshnessReasonCode, "SHOPEE_OFFER_FRESH">,
    refreshAttempted = false,
  ) => {
    await store.cancel({
      publicationId: record.publicationId,
      offerId: record.offerId,
      reason,
    });
    return {
      publicationId: record.publicationId,
      offerId: record.offerId,
      allowed: false,
      reason,
      refreshAttempted,
      refreshSucceeded: false,
      externalRequests: refreshAttempted ? 1 : 0,
      writes: 2,
      stateModified: true,
    };
  };
  if (record.duplicate) return cancel("SHOPEE_PUBLICATION_DUPLICATE");
  if (!hasCanonicalAffiliateLink(record)) {
    return cancel("SHOPEE_AFFILIATE_LINK_MISSING");
  }
  if (
    evaluateShopeeOfferFreshness({
      collectedAt: record.collectedAt,
      verifiedAt: record.verifiedAt,
      now,
      maxAgeHours: configuration.publicationMaxOfferAgeHours,
    })
  ) {
    return {
      publicationId: record.publicationId,
      offerId: record.offerId,
      allowed: true,
      reason: "SHOPEE_OFFER_FRESH" as const,
      refreshAttempted: false,
      refreshSucceeded: false,
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    };
  }
  if (!configuration.refreshBeforePublication || !configuration.openApiReady) {
    return cancel(
      configuration.refreshBeforePublication
        ? "SHOPEE_OFFER_REFRESH_FAILED"
        : "SHOPEE_OFFER_STALE",
    );
  }
  const client =
    input.refreshClient ??
    createOfficialShopeeProductEnrichmentClient(environment);
  let refreshed;
  try {
    refreshed = await client.enrichItem(record.externalProductId);
  } catch {
    return cancel("SHOPEE_OFFER_REFRESH_FAILED", true);
  }
  if (!refreshed) {
    return cancel("SHOPEE_OFFER_NO_LONGER_ELIGIBLE", true);
  }
  if (
    refreshed.priceMin !== null &&
    Math.abs(refreshed.priceMin - record.currentPrice) > 0.009
  ) {
    // The immutable Publication snapshot is now stale. Discovery/ingestion
    // must create a commercial Offer version before a new Publication exists.
    return cancel("SHOPEE_OFFER_NO_LONGER_ELIGIBLE", true);
  }
  await store.markRefreshed(record.offerId, now);
  return {
    publicationId: record.publicationId,
    offerId: record.offerId,
    allowed: true,
    reason: "SHOPEE_OFFER_FRESH" as const,
    refreshAttempted: true,
    refreshSucceeded: true,
    externalRequests: 1,
    writes: 1,
    stateModified: true,
  };
}

export function createPrismaShopeeFreshnessStore(
  database: PrismaClient = prisma,
): ShopeeFreshnessStore {
  return {
    async load(publicationId) {
      const publication = await database.publication.findUnique({
        where: { id: publicationId },
        include: {
          offer: { include: { affiliateLinks: true } },
        },
      });
      if (!publication) return null;
      const duplicate = Boolean(
        await database.publication.findFirst({
          where: {
            id: { not: publication.id },
            offerId: publication.offerId,
            channelId: publication.channelId,
            status: { in: ["PUBLISHED", "EXPORTED", "SCHEDULED"] },
          },
          select: { id: true },
        }),
      );
      return {
        publicationId: publication.id,
        offerId: publication.offerId,
        channelId: publication.channelId,
        marketplace: publication.offer.marketplace,
        externalProductId: publication.offer.externalProductId,
        currentPrice: Number(publication.offer.currentPrice),
        collectedAt: publication.offer.collectedAt,
        verifiedAt: publication.offer.verifiedAt,
        duplicate,
        affiliateLinks: publication.offer.affiliateLinks.map((link) => ({
          active: link.active,
          destination: link.destination,
        })),
      };
    },
    async markRefreshed(offerId, now) {
      await database.offer.update({
        where: { id: offerId },
        data: { collectedAt: now, verifiedAt: now },
      });
    },
    async cancel(input) {
      await database.$transaction([
        database.publication.update({
          where: { id: input.publicationId },
          data: { status: "CANCELLED", errorMessage: input.reason },
        }),
        database.offer.update({
          where: { id: input.offerId },
          data: { status: "REJECTED_EXPIRED", statusReason: input.reason },
        }),
      ]);
    },
  };
}

export async function expireStaleShopeeOffers(input: {
  confirmExpire: boolean;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  database?: PrismaClient;
}) {
  if (!input.confirmExpire) throw new Error("SHOPEE_FRESHNESS_NOT_CONFIRMED");
  const configuration = resolveShopeeAffiliateConfiguration(
    input.environment ?? process.env,
  );
  const database = input.database ?? prisma;
  const now = input.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - configuration.publicationMaxOfferAgeHours * 3_600_000,
  );
  return database.$transaction(async (tx) => {
    const stale = await tx.offer.findMany({
      where: {
        marketplace: "SHOPEE",
        status: { in: ["READY_TO_PUBLISH", "SCHEDULED"] },
        collectedAt: { lt: cutoff },
        OR: [{ verifiedAt: null }, { verifiedAt: { lt: cutoff } }],
      },
      select: { id: true },
    });
    const offerIds = stale.map((offer) => offer.id);
    if (offerIds.length === 0) {
      return { expired: 0, cancelled: 0, writes: 0, stateModified: false };
    }
    const cancelled = await tx.publication.updateMany({
      where: {
        offerId: { in: offerIds },
        status: { in: ["SCHEDULED", "AWAITING_MANUAL_PUBLICATION"] },
      },
      data: {
        status: "CANCELLED",
        errorMessage: "SHOPEE_OFFER_STALE",
      },
    });
    const expired = await tx.offer.updateMany({
      where: { id: { in: offerIds } },
      data: {
        status: "REJECTED_EXPIRED",
        statusReason: "SHOPEE_OFFER_STALE",
      },
    });
    return {
      expired: expired.count,
      cancelled: cancelled.count,
      writes: expired.count + cancelled.count,
      stateModified: true,
    };
  });
}
