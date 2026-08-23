import { prisma, Prisma, type PrismaClient } from "@affiliate/database";
import { buildPromoMessage, getZonedDayRange } from "@affiliate/publication";
import { resolveShopeeAffiliateConfiguration } from "./config";
import { nextShopeePublicationAt } from "./distribution";
import { validateShopeeGeneratedShortLink } from "./validation";

export type ShopeePublicationSkipCode =
  | "SHOPEE_PUBLICATION_DISABLED"
  | "SHOPEE_OFFER_WRONG_MARKETPLACE"
  | "SHOPEE_OFFER_NOT_READY"
  | "SHOPEE_AFFILIATE_LINK_MISSING"
  | "SHOPEE_AFFILIATE_LINK_INVALID"
  | "SHOPEE_CHANNEL_DISABLED"
  | "SHOPEE_CHANNEL_MARKETPLACE_MISMATCH"
  | "SHOPEE_CHANNEL_CATEGORY_MISMATCH"
  | "SHOPEE_CHANNEL_MIN_SCORE"
  | "SHOPEE_CHANNEL_MIN_DISCOUNT"
  | "SHOPEE_PUBLICATION_DUPLICATE"
  | "SHOPEE_PUBLICATION_LIMIT_REACHED";

export type ShopeePublicationOffer = {
  id: string;
  productId: string | null;
  marketplace: string;
  externalProductId: string;
  version: number;
  status: string;
  title: string;
  category: string | null;
  imageUrl: string | null;
  affiliateUrl: string | null;
  originalPrice: string | null;
  currentPrice: string;
  discountPercentage: string | null;
  couponCode: string | null;
  couponExpiration: Date | null;
  freeShipping: boolean;
  shippingStatus: string;
  score: number | null;
  sourceCategoryId: string | null;
  bestSellerPosition: number | null;
  sourceHighlightId: string | null;
  sourceHighlightType: string | null;
  resolutionStrategy: string | null;
  affiliateLinks: Array<{
    id: string;
    slug: string;
    destination: string;
    active: boolean;
  }>;
};

export type ShopeePublicationChannel = {
  id: string;
  type: string;
  enabled: boolean;
  allowedMarketplaces: string[];
  allowedCategories: string[];
  minimumScore: number;
  minimumDiscountPercentage: string | null;
};

export type ShopeePublicationCreateInput = {
  idempotencyKey: string;
  offer: ShopeePublicationOffer;
  channel: ShopeePublicationChannel;
  affiliateDestination: string;
  affiliateLinkId: string;
  trackingUrl: string;
  message: string;
  now: Date;
};

export interface ShopeePublicationStore {
  listReadyOffers(): Promise<ShopeePublicationOffer[]>;
  listChannels(): Promise<ShopeePublicationChannel[]>;
  publicationExists(idempotencyKey: string): Promise<boolean>;
  createControlledPublication(
    input: ShopeePublicationCreateInput,
  ): Promise<{ id: string; created: boolean }>;
}

export type ShopeePublicationDecision = {
  offerId: string;
  channelId: string | null;
  result: "PLANNED" | "CREATED" | "SKIPPED";
  reason: ShopeePublicationSkipCode | null;
  publicationId: string | null;
};

export type ShopeePublicationPlanResult = {
  status: "DISABLED" | "PREVIEW_COMPLETED" | "SUCCEEDED";
  candidates: number;
  eligible: number;
  planned: number;
  publicationsCreated: number;
  duplicates: number;
  skipped: number;
  reasons: Record<string, number>;
  decisions: ShopeePublicationDecision[];
  externalRequests: 0;
  writes: number;
  messagesSent: 0;
  stateModified: boolean;
};

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function appBaseUrl(environment: NodeJS.ProcessEnv) {
  return (
    environment.APP_BASE_URL ??
    environment.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function canonicalLink(offer: ShopeePublicationOffer) {
  let invalid = false;
  for (const link of offer.affiliateLinks) {
    if (!link.active) continue;
    const validation = validateShopeeGeneratedShortLink(link.destination);
    if (validation.ok) {
      return {
        link,
        destination: validation.normalizedUrl,
      };
    }
    invalid = true;
  }
  return invalid ? "INVALID" : null;
}

export function evaluateShopeePublicationOffer(
  offer: ShopeePublicationOffer,
): ShopeePublicationSkipCode | null {
  if (offer.marketplace !== "SHOPEE") return "SHOPEE_OFFER_WRONG_MARKETPLACE";
  if (offer.status !== "READY_TO_PUBLISH") return "SHOPEE_OFFER_NOT_READY";
  const link = canonicalLink(offer);
  if (link === "INVALID") return "SHOPEE_AFFILIATE_LINK_INVALID";
  if (!link) return "SHOPEE_AFFILIATE_LINK_MISSING";
  return null;
}

function evaluateChannel(
  offer: ShopeePublicationOffer,
  channel: ShopeePublicationChannel,
): ShopeePublicationSkipCode | null {
  if (!channel.enabled) return "SHOPEE_CHANNEL_DISABLED";
  if (
    channel.allowedMarketplaces.length > 0 &&
    !channel.allowedMarketplaces.includes("SHOPEE")
  ) {
    return "SHOPEE_CHANNEL_MARKETPLACE_MISMATCH";
  }
  if (
    channel.allowedCategories.length > 0 &&
    (!offer.category || !channel.allowedCategories.includes(offer.category))
  ) {
    return "SHOPEE_CHANNEL_CATEGORY_MISMATCH";
  }
  if ((offer.score ?? 0) < channel.minimumScore) {
    return "SHOPEE_CHANNEL_MIN_SCORE";
  }
  const minimumDiscount = Number(channel.minimumDiscountPercentage ?? 0);
  if (Number(offer.discountPercentage ?? 0) < minimumDiscount) {
    return "SHOPEE_CHANNEL_MIN_DISCOUNT";
  }
  return null;
}

function result(status: ShopeePublicationPlanResult["status"]) {
  return {
    status,
    candidates: 0,
    eligible: 0,
    planned: 0,
    publicationsCreated: 0,
    duplicates: 0,
    skipped: 0,
    reasons: {} as Record<string, number>,
    decisions: [] as ShopeePublicationDecision[],
    externalRequests: 0 as const,
    writes: 0,
    messagesSent: 0 as const,
    stateModified: false,
  };
}

function skip(
  output: ShopeePublicationPlanResult,
  offerId: string,
  channelId: string | null,
  reason: ShopeePublicationSkipCode,
) {
  output.skipped += 1;
  output.reasons[reason] = (output.reasons[reason] ?? 0) + 1;
  output.decisions.push({
    offerId,
    channelId,
    result: "SKIPPED",
    reason,
    publicationId: null,
  });
}

export async function planShopeePublications(input: {
  store?: ShopeePublicationStore;
  environment?: NodeJS.ProcessEnv;
  preview?: boolean;
  confirmCreatePublication?: boolean;
  now?: Date;
}): Promise<ShopeePublicationPlanResult> {
  const environment = input.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  const preview = input.preview === true;
  const output = result(
    configuration.publicationEnabled
      ? preview
        ? "PREVIEW_COMPLETED"
        : "SUCCEEDED"
      : "DISABLED",
  );
  if (!configuration.publicationEnabled) {
    output.reasons.SHOPEE_PUBLICATION_DISABLED = 1;
    return output;
  }
  if (!preview && !input.confirmCreatePublication) {
    throw new Error("SHOPEE_PUBLICATION_NOT_CONFIRMED");
  }

  const store = input.store ?? createPrismaShopeePublicationStore();
  const [allOffers, channels] = await Promise.all([
    store.listReadyOffers(),
    store.listChannels(),
  ]);
  const currentByProduct = new Map<string, ShopeePublicationOffer>();
  for (const offer of allOffers) {
    const key = offer.productId ?? `external:${offer.externalProductId}`;
    const current = currentByProduct.get(key);
    if (!current || offer.version > current.version) {
      currentByProduct.set(key, offer);
    }
  }
  const currentOffers = [...currentByProduct.values()];
  output.candidates = currentOffers.length;
  const now = input.now ?? new Date();

  for (const offer of currentOffers) {
    const offerReason = evaluateShopeePublicationOffer(offer);
    if (offerReason) {
      skip(output, offer.id, null, offerReason);
      continue;
    }
    output.eligible += 1;
    const canonical = canonicalLink(offer);
    if (!canonical || canonical === "INVALID") continue;

    for (const channel of channels) {
      if (output.planned >= configuration.publicationMaxPerCycle) {
        skip(output, offer.id, channel.id, "SHOPEE_PUBLICATION_LIMIT_REACHED");
        continue;
      }
      const channelReason = evaluateChannel(offer, channel);
      if (channelReason) {
        skip(output, offer.id, channel.id, channelReason);
        continue;
      }
      const idempotencyKey = `publication:${channel.id}:${offer.id}`;
      if (await store.publicationExists(idempotencyKey)) {
        output.duplicates += 1;
        skip(output, offer.id, channel.id, "SHOPEE_PUBLICATION_DUPLICATE");
        continue;
      }
      const trackingUrl = `${appBaseUrl(environment)}/go/${encodeURIComponent(canonical.link.slug)}`;
      const message = buildPromoMessage({
        title: offer.title,
        marketplace: "SHOPEE",
        originalPrice: offer.originalPrice,
        currentPrice: offer.currentPrice,
        discountPercentage: offer.discountPercentage,
        couponCode: offer.couponCode,
        couponExpiration: offer.couponExpiration,
        freeShipping: offer.freeShipping,
        shippingStatus: offer.shippingStatus,
        trackingUrl,
        seed: `${channel.id}:${offer.id}`,
      }).message;
      output.planned += 1;
      if (preview) {
        output.decisions.push({
          offerId: offer.id,
          channelId: channel.id,
          result: "PLANNED",
          reason: null,
          publicationId: null,
        });
        continue;
      }
      const created = await store.createControlledPublication({
        idempotencyKey,
        offer,
        channel,
        affiliateDestination: canonical.destination,
        affiliateLinkId: canonical.link.id,
        trackingUrl,
        message,
        now,
      });
      if (created.created) {
        output.publicationsCreated += 1;
        output.writes += 1;
        output.stateModified = true;
        output.decisions.push({
          offerId: offer.id,
          channelId: channel.id,
          result: "CREATED",
          reason: null,
          publicationId: created.id,
        });
      } else {
        output.duplicates += 1;
        output.planned -= 1;
        skip(output, offer.id, channel.id, "SHOPEE_PUBLICATION_DUPLICATE");
      }
    }
  }
  return output;
}

export function createPrismaShopeePublicationStore(
  database: PrismaClient = prisma,
): ShopeePublicationStore {
  return {
    async listReadyOffers() {
      const offers = await database.offer.findMany({
        where: { marketplace: "SHOPEE" },
        orderBy: [
          { externalProductId: "asc" },
          { version: "desc" },
          { score: "desc" },
        ],
        include: { affiliateLinks: { where: { active: true } } },
      });
      return offers.map((offer) => ({
        ...offer,
        originalPrice: offer.originalPrice?.toString() ?? null,
        currentPrice: offer.currentPrice.toString(),
        discountPercentage: offer.discountPercentage?.toString() ?? null,
        shippingStatus: offer.shippingStatus,
        affiliateLinks: offer.affiliateLinks,
      }));
    },
    async listChannels() {
      const channels = await database.channel.findMany({
        where: {
          type: { in: ["TELEGRAM", "MANUAL_EXPORT", "WHATSAPP_GROUPS"] },
        },
        orderBy: { createdAt: "asc" },
      });
      return channels.map((channel) => ({
        id: channel.id,
        type: channel.type,
        enabled: channel.enabled,
        allowedMarketplaces: stringArray(channel.allowedMarketplaces),
        allowedCategories: stringArray(channel.allowedCategories),
        minimumScore: channel.minimumScore,
        minimumDiscountPercentage:
          channel.minDiscountPercentage?.toString() ?? null,
      }));
    },
    async publicationExists(idempotencyKey) {
      return Boolean(
        await database.publication.findUnique({
          where: { idempotencyKey },
          select: { id: true },
        }),
      );
    },
    async createControlledPublication(input) {
      try {
        const publication = await database.publication.create({
          data: {
            offerId: input.offer.id,
            channelId: input.channel.id,
            status: "AWAITING_MANUAL_PUBLICATION",
            idempotencyKey: input.idempotencyKey,
            scheduledAt: input.now,
            messagePayload: {
              offerId: input.offer.id,
              channelId: input.channel.id,
              trackingUrl: input.trackingUrl,
              message: input.message,
              imageUrl: input.offer.imageUrl,
            },
            imageUrlSnapshot: input.offer.imageUrl,
            metadata: {
              publicationMode: "SHOPEE_CONTROLLED",
              distributionState: "PLANNED",
              affiliateLinkId: input.affiliateLinkId,
              canonicalDestinationValidated: true,
            },
            messageSource: "DETERMINISTIC_FALLBACK",
            aiProvider: "DETERMINISTIC",
            aiValidationPassed: true,
            aiValidationReasons: [],
            generatedAt: input.now,
            offerTitleSnapshot: input.offer.title,
            productExternalIdSnapshot: input.offer.externalProductId,
            marketplaceSnapshot: "SHOPEE",
            categorySnapshot: input.offer.category,
            originalPriceSnapshot: input.offer.originalPrice,
            currentPriceSnapshot: input.offer.currentPrice,
            discountPercentageSnapshot: input.offer.discountPercentage,
            couponCodeSnapshot: input.offer.couponCode,
            couponExpirationSnapshot: input.offer.couponExpiration,
            freeShippingSnapshot: input.offer.freeShipping,
            shippingStatusSnapshot: input.offer.shippingStatus as
              | "FREE"
              | "NOT_FREE"
              | "UNKNOWN",
            affiliateUrlSnapshot: input.affiliateDestination,
            trackingUrlSnapshot: input.trackingUrl,
            offerVersionSnapshot: input.offer.version,
            sourceCategoryIdSnapshot: input.offer.sourceCategoryId,
            bestSellerPositionSnapshot: input.offer.bestSellerPosition,
            sourceHighlightIdSnapshot: input.offer.sourceHighlightId,
            sourceHighlightTypeSnapshot: input.offer.sourceHighlightType,
            resolutionStrategySnapshot: input.offer.resolutionStrategy,
          },
          select: { id: true },
        });
        return { id: publication.id, created: true };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const existing = await database.publication.findUniqueOrThrow({
            where: { idempotencyKey: input.idempotencyKey },
            select: { id: true },
          });
          return { id: existing.id, created: false };
        }
        throw error;
      }
    },
  };
}

export async function loadShopeeProductionStatus(input: {
  database?: PrismaClient;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  timezone?: string;
} = {}) {
  const database = input.database ?? prisma;
  const environment = input.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? "America/Fortaleza";
  const range = getZonedDayRange(now, timezone);
  const cutoff = new Date(
    now.getTime() - configuration.publicationMaxOfferAgeHours * 3_600_000,
  );
  const [candidateCount, plannedCount, publishedToday, stale, last] =
    await Promise.all([
      database.offer.count({
        where: { marketplace: "SHOPEE", status: "READY_TO_PUBLISH" },
      }),
      database.publication.count({
        where: {
          marketplaceSnapshot: "SHOPEE",
          status: { in: ["SCHEDULED", "AWAITING_MANUAL_PUBLICATION"] },
        },
      }),
      database.publication.count({
        where: {
          marketplaceSnapshot: "SHOPEE",
          status: { in: ["PUBLISHED", "EXPORTED"] },
          publishedAt: { gte: range.start, lt: range.end },
        },
      }),
      database.offer.count({
        where: {
          marketplace: "SHOPEE",
          status: { in: ["READY_TO_PUBLISH", "SCHEDULED"] },
          collectedAt: { lt: cutoff },
          OR: [{ verifiedAt: null }, { verifiedAt: { lt: cutoff } }],
        },
      }),
      database.publication.findFirst({
        where: { marketplaceSnapshot: "SHOPEE" },
        orderBy: { scheduledAt: "desc" },
        select: {
          status: true,
          scheduledAt: true,
          publishedAt: true,
          errorMessage: true,
        },
      }),
    ]);
  const lastPublicationAt = last?.publishedAt ?? last?.scheduledAt ?? null;
  return {
    enabled: configuration.publicationEnabled,
    autoDistributionEnabled: configuration.autoDistributionEnabled,
    telegramEnabled: configuration.publicationTelegramEnabled,
    whatsappEnabled: configuration.publicationWhatsAppEnabled,
    candidateCount,
    plannedCount,
    publishedToday,
    dailyLimit: configuration.publicationMaxPerDay,
    nextAllowedPublicationAt: nextShopeePublicationAt({
      configuration,
      lastPublicationAt,
    })?.toISOString() ?? null,
    lastPublicationAt: lastPublicationAt?.toISOString() ?? null,
    lastPublicationStatus: last?.status ?? null,
    lastErrorCode:
      last?.errorMessage && /^SHOPEE_[A-Z0-9_]+$/.test(last.errorMessage)
        ? last.errorMessage
        : last?.errorMessage
          ? "SHOPEE_PUBLICATION_FAILED"
          : null,
    freshness: {
      fresh: Math.max(0, candidateCount + plannedCount - stale),
      stale,
    },
    ranking: {
      candidatePool: candidateCount,
    },
    enrichment: {
      enabled: configuration.enrichmentEnabled,
      maxItems: configuration.enrichmentMaxItems,
    },
    externalRequests: 0 as const,
    stateModified: false as const,
  };
}

export function auditShopeeProductionStatus(
  status: Awaited<ReturnType<typeof loadShopeeProductionStatus>>,
) {
  const findings: Array<{
    code: string;
    severity: "WARNING" | "CRITICAL";
    action: string;
  }> = [];
  if (status.freshness.stale > 0) {
    findings.push({
      code: "SHOPEE_STALE_OFFERS_PENDING",
      severity: "WARNING",
      action: "REVIEW_SHOPEE_FRESHNESS",
    });
  }
  if (status.lastErrorCode) {
    findings.push({
      code: status.lastErrorCode,
      severity: "WARNING",
      action: "INSPECT_SHOPEE_PUBLICATION",
    });
  }
  if (
    status.autoDistributionEnabled &&
    !status.telegramEnabled &&
    !status.whatsappEnabled
  ) {
    findings.push({
      code: "SHOPEE_DISTRIBUTION_WITHOUT_CHANNEL",
      severity: "WARNING",
      action: "ENABLE_ONE_SHOPEE_CHANNEL_OR_DISABLE_DISTRIBUTION",
    });
  }
  return findings;
}
