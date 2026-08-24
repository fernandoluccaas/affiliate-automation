import { prisma, Prisma, type PrismaClient } from "@affiliate/database";
import {
  buildPromoMessage,
  getZonedDayRange,
  validatePromoMessageEncoding,
} from "@affiliate/publication";
import {
  applyCouponRankingBonus,
  createCouponSnapshot,
  resolveBestCoupon,
  resolveCouponIntelligenceConfiguration,
  type CouponCandidate,
  type CouponSnapshot,
} from "@affiliate/shared";
import { resolveShopeeAffiliateConfiguration } from "./config";
import { nextShopeePublicationAt } from "./distribution";
import { loadShopeeFreshnessSummary } from "./freshness";
import {
  deriveShopeeProductionMode,
  inspectShopeeProductionLock,
  SHOPEE_PRODUCTION_RUN_NAME,
} from "./production";
import { resolveShopeePublicTrackingReadiness } from "./tracking-url";
import { validateShopeeGeneratedShortLink } from "./validation";

export type ShopeePublicationSkipCode =
  | "SHOPEE_PUBLICATION_DISABLED"
  | "SHOPEE_OFFER_NOT_FOUND"
  | "SHOPEE_OFFER_NOT_CURRENT"
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
  | "SHOPEE_PUBLICATION_LIMIT_REACHED"
  | "SHOPEE_MESSAGE_ENCODING_INVALID";

export type ShopeePublicationOffer = {
  id: string;
  productId: string | null;
  marketplace: string;
  externalProductId: string;
  sellerId: string | null;
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
  coupons: Array<{
    marketplace: "SHOPEE" | "MERCADO_LIVRE" | null;
    externalCouponId: string | null;
    sourceKey: string | null;
    code: string;
    benefitType: "PERCENTAGE" | "FIXED_AMOUNT" | "AUTOMATIC" | "OTHER";
    percentage: string | null;
    discountAmount: string | null;
    minimumSpend: string | null;
    maximumDiscount: string | null;
    startsAt: Date | null;
    expiresAt: Date | null;
    autoApply: boolean;
    scope: "PRODUCT" | "SELLER" | "STORE" | "PLATFORM" | "CATEGORY" | "UNKNOWN";
    sellerId: string | null;
    productExternalId: string | null;
    source: string;
    status: "ACTIVE" | "INACTIVE" | "UNKNOWN";
    active: boolean;
    lastValidatedAt: Date | null;
    applicability: "CONFIRMED" | "CONDITIONAL" | "UNKNOWN" | "NOT_APPLICABLE";
    applicabilityReason: string | null;
    confidence: number | null;
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
  couponSnapshot: CouponSnapshot | null;
  couponCodeSnapshot: string | null;
  couponExpirationSnapshot: Date | null;
  now: Date;
};

export interface ShopeePublicationStore {
  listReadyOffers(): Promise<ShopeePublicationOffer[]>;
  loadOfferById(
    offerId: string,
  ): Promise<{ offer: ShopeePublicationOffer; isCurrent: boolean } | null>;
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

function couponCandidate(
  coupon: ShopeePublicationOffer["coupons"][number],
  now: Date,
): CouponCandidate {
  return {
    marketplace: coupon.marketplace ?? "SHOPEE",
    externalCouponId: coupon.externalCouponId,
    sourceKey: coupon.sourceKey,
    code: coupon.code || null,
    benefitType: coupon.benefitType,
    percentage: coupon.percentage,
    fixedAmount: coupon.discountAmount,
    minimumSpend: coupon.minimumSpend,
    maximumDiscount: coupon.maximumDiscount,
    startsAt: coupon.startsAt,
    expiresAt: coupon.expiresAt,
    autoApply: coupon.autoApply,
    scope: coupon.scope,
    sellerId: coupon.sellerId,
    productExternalId: coupon.productExternalId,
    source: coupon.source,
    status: coupon.status,
    active: coupon.active,
    lastValidatedAt: coupon.lastValidatedAt ?? now,
    applicability: coupon.applicability,
    applicabilityReason: coupon.applicabilityReason,
    confidence: coupon.confidence ?? 0,
    metadata: null,
  };
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
  offerId?: string;
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
  let allOffers: ShopeePublicationOffer[];
  let channels: ShopeePublicationChannel[];
  if (input.offerId) {
    const [target, loadedChannels] = await Promise.all([
      store.loadOfferById(input.offerId),
      store.listChannels(),
    ]);
    if (!target) {
      skip(output, input.offerId, null, "SHOPEE_OFFER_NOT_FOUND");
      return output;
    }
    if (!target.isCurrent) {
      output.candidates = 1;
      skip(output, target.offer.id, null, "SHOPEE_OFFER_NOT_CURRENT");
      return output;
    }
    allOffers = [target.offer];
    channels = loadedChannels;
  } else {
    [allOffers, channels] = await Promise.all([
      store.listReadyOffers(),
      store.listChannels(),
    ]);
  }
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
  const couponConfiguration =
    resolveCouponIntelligenceConfiguration(environment);
  const preparedOffers = currentOffers.map((offer) => {
    const couponResolution = couponConfiguration.enabled
      ? resolveBestCoupon({
          candidates: offer.coupons
            .filter(
              (coupon) =>
                coupon.lastValidatedAt !== null &&
                now.getTime() - coupon.lastValidatedAt.getTime() <=
                  couponConfiguration.refreshTtlMinutes * 60_000,
            )
            .map((coupon) => couponCandidate(coupon, now)),
          price: offer.currentPrice,
          marketplace: "SHOPEE",
          externalProductId: offer.externalProductId,
          sellerId: offer.sellerId,
          now,
          refreshTtlMinutes: couponConfiguration.refreshTtlMinutes,
          expirySafetyMinutes: couponConfiguration.expirySafetyMinutes,
        })
      : null;
    const couponSnapshot = couponResolution?.bestCoupon
      ? createCouponSnapshot(couponResolution.bestCoupon)
      : null;
    const couponScore = applyCouponRankingBonus({
      baseScore: offer.score ?? 0,
      snapshot: couponSnapshot,
      enabled: couponConfiguration.rankingEnabled,
      fresh: couponSnapshot !== null,
      maxBonus: couponConfiguration.rankingMaxBonus,
    });
    return { offer, couponSnapshot, couponScore };
  });
  if (couponConfiguration.rankingEnabled) {
    preparedOffers.sort(
      (left, right) =>
        right.couponScore.finalScore - left.couponScore.finalScore ||
        left.offer.id.localeCompare(right.offer.id),
    );
  }

  for (const prepared of preparedOffers) {
    const { offer, couponSnapshot, couponScore } = prepared;
    const offerReason = evaluateShopeePublicationOffer(offer);
    if (offerReason) {
      skip(output, offer.id, null, offerReason);
      continue;
    }
    output.eligible += 1;
    const canonical = canonicalLink(offer);
    if (!canonical || canonical === "INVALID") continue;
    const couponCodeSnapshot = couponConfiguration.enabled
      ? (couponSnapshot?.code ?? null)
      : offer.couponCode;
    const couponExpirationSnapshot = couponConfiguration.enabled
      ? couponSnapshot?.expiresAt
        ? new Date(couponSnapshot.expiresAt)
        : null
      : offer.couponExpiration;

    for (const channel of channels) {
      if (output.planned >= configuration.publicationMaxPerCycle) {
        skip(output, offer.id, channel.id, "SHOPEE_PUBLICATION_LIMIT_REACHED");
        continue;
      }
      const channelReason = evaluateChannel(
        couponConfiguration.rankingEnabled
          ? { ...offer, score: couponScore.finalScore }
          : offer,
        channel,
      );
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
      const generatedMessage = buildPromoMessage({
        title: offer.title,
        marketplace: "SHOPEE",
        originalPrice: offer.originalPrice,
        currentPrice: offer.currentPrice,
        discountPercentage: offer.discountPercentage,
        couponCode: couponCodeSnapshot,
        couponExpiration: couponExpirationSnapshot,
        couponSnapshot,
        freeShipping: offer.freeShipping,
        shippingStatus: offer.shippingStatus,
        trackingUrl,
        seed: `${channel.id}:${offer.id}`,
      }).message;
      const messageValidation = validatePromoMessageEncoding(generatedMessage);
      if (!messageValidation.ok) {
        skip(output, offer.id, channel.id, "SHOPEE_MESSAGE_ENCODING_INVALID");
        continue;
      }
      const message = messageValidation.normalizedMessage;
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
        couponSnapshot,
        couponCodeSnapshot,
        couponExpirationSnapshot,
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
        include: {
          affiliateLinks: { where: { active: true } },
          coupons: { where: { active: true } },
        },
      });
      return offers.map((offer) => ({
        ...offer,
        originalPrice: offer.originalPrice?.toString() ?? null,
        currentPrice: offer.currentPrice.toString(),
        discountPercentage: offer.discountPercentage?.toString() ?? null,
        shippingStatus: offer.shippingStatus,
        affiliateLinks: offer.affiliateLinks,
        coupons: offer.coupons.map((coupon) => ({
          ...coupon,
          percentage: coupon.percentage?.toString() ?? null,
          discountAmount: coupon.discountAmount?.toString() ?? null,
          minimumSpend: coupon.minimumSpend?.toString() ?? null,
          maximumDiscount: coupon.maximumDiscount?.toString() ?? null,
        })),
      }));
    },
    async loadOfferById(offerId) {
      const offer = await database.offer.findUnique({
        where: { id: offerId },
        include: {
          affiliateLinks: { where: { active: true } },
          coupons: { where: { active: true } },
        },
      });
      if (!offer) return null;
      const current = await database.offer.findFirst({
        where: offer.productId
          ? { productId: offer.productId }
          : {
              marketplace: offer.marketplace,
              externalProductId: offer.externalProductId,
            },
        orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        select: { id: true },
      });
      return {
        offer: {
          ...offer,
          originalPrice: offer.originalPrice?.toString() ?? null,
          currentPrice: offer.currentPrice.toString(),
          discountPercentage: offer.discountPercentage?.toString() ?? null,
          shippingStatus: offer.shippingStatus,
          affiliateLinks: offer.affiliateLinks,
          coupons: offer.coupons.map((coupon) => ({
            ...coupon,
            percentage: coupon.percentage?.toString() ?? null,
            discountAmount: coupon.discountAmount?.toString() ?? null,
            minimumSpend: coupon.minimumSpend?.toString() ?? null,
            maximumDiscount: coupon.maximumDiscount?.toString() ?? null,
          })),
        },
        isCurrent: current?.id === offer.id,
      };
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
            couponCodeSnapshot: input.couponCodeSnapshot,
            couponExpirationSnapshot: input.couponExpirationSnapshot,
            couponSnapshot:
              input.couponSnapshot === null
                ? Prisma.JsonNull
                : (input.couponSnapshot as Prisma.InputJsonValue),
            freeShippingSnapshot: input.offer.freeShipping,
            shippingStatusSnapshot: input.offer.shippingStatus as
              "FREE" | "NOT_FREE" | "UNKNOWN",
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

export async function loadShopeeProductionStatus(
  input: {
    database?: PrismaClient;
    environment?: NodeJS.ProcessEnv;
    now?: Date;
    timezone?: string;
  } = {},
) {
  const database = input.database ?? prisma;
  const environment = input.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  const publicTracking = resolveShopeePublicTrackingReadiness(environment);
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? "America/Fortaleza";
  const range = getZonedDayRange(now, timezone);
  const [
    candidateCount,
    plannedCount,
    publishedToday,
    freshness,
    last,
    channels,
    productionPublications,
    lastProductionRun,
    lock,
  ] = await Promise.all([
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
    loadShopeeFreshnessSummary({ environment, now, database }),
      database.publication.findFirst({
        where: {
          marketplaceSnapshot: "SHOPEE",
          status: {
            in: [
              "SCHEDULED",
              "PUBLISHED",
              "EXPORTED",
              "FAILED",
              "PUBLICATION_FAILED",
            ],
          },
        },
      orderBy: { scheduledAt: "desc" },
      select: {
        status: true,
        scheduledAt: true,
        publishedAt: true,
        errorMessage: true,
      },
    }),
    database.channel.findMany({
      where: { type: { in: ["TELEGRAM", "WHATSAPP_GROUPS", "MANUAL_EXPORT"] } },
      select: {
        id: true,
        type: true,
        enabled: true,
        allowedMarketplaces: true,
      },
    }),
    database.publication.findMany({
      where: { marketplaceSnapshot: "SHOPEE" },
      select: {
        status: true,
        publishedAt: true,
        metadata: true,
        channel: { select: { type: true } },
      },
    }),
    database.automationRun.findFirst({
      where: { name: SHOPEE_PRODUCTION_RUN_NAME },
      orderBy: { startedAt: "desc" },
      select: {
        status: true,
        startedAt: true,
        finishedAt: true,
        errorMessage: true,
      },
    }),
    inspectShopeeProductionLock(environment),
  ]);
  const allowed = (value: unknown) =>
    Array.isArray(value) && value.includes("SHOPEE");
  const configured = channels.filter(
    (channel) => channel.enabled && allowed(channel.allowedMarketplaces),
  );
  const configuredShopeeChannels = {
    total: configured.length,
    telegram: configured.filter((channel) => channel.type === "TELEGRAM")
      .length,
    whatsapp: configured.filter((channel) => channel.type === "WHATSAPP_GROUPS")
      .length,
    manual: configured.filter((channel) => channel.type === "MANUAL_EXPORT")
      .length,
  };
  const channelMetrics = (type: "TELEGRAM" | "WHATSAPP_GROUPS") => {
    const matching = productionPublications.filter(
      (publication) => publication.channel.type === type,
    );
    const uncertain = matching.filter((publication) => {
      const metadata =
        publication.metadata &&
        typeof publication.metadata === "object" &&
        !Array.isArray(publication.metadata)
          ? (publication.metadata as Record<string, unknown>)
          : {};
      return (
        metadata.deliveryUncertain === true ||
        metadata.deliveryState === "DELIVERY_UNCERTAIN"
      );
    }).length;
    return {
      pending: matching.filter((publication) =>
        ["SCHEDULED", "AWAITING_MANUAL_PUBLICATION"].includes(
          publication.status,
        ),
      ).length,
      sentToday: matching.filter(
        (publication) =>
          publication.status === "PUBLISHED" &&
          publication.publishedAt &&
          publication.publishedAt >= range.start &&
          publication.publishedAt < range.end,
      ).length,
      failed: matching.filter((publication) =>
        ["FAILED", "PUBLICATION_FAILED"].includes(publication.status),
      ).length,
      deliveryUncertain: uncertain,
    };
  };
  const lastPublicationAt = last?.publishedAt ?? last?.scheduledAt ?? null;
  return {
    mode: deriveShopeeProductionMode({
      configuration,
      configuredChannelCount:
        (configuration.publicationTelegramEnabled
          ? configuredShopeeChannels.telegram
          : 0) +
        (configuration.publicationWhatsAppEnabled
          ? configuredShopeeChannels.whatsapp
          : 0),
      publicTrackingReady: publicTracking.ready,
    }),
    enabled: configuration.publicationEnabled,
    publicationEnabled: configuration.publicationEnabled,
    autoDistributionEnabled: configuration.autoDistributionEnabled,
    externalSendsEnabled: configuration.externalSendsEnabled,
    publicTracking: {
      ready: publicTracking.ready,
      configured: publicTracking.configured,
      reason: publicTracking.reason,
    },
    telegramEnabled: configuration.publicationTelegramEnabled,
    whatsappEnabled: configuration.publicationWhatsAppEnabled,
    configuredShopeeChannels,
    candidateCount,
    plannedCount,
    publishedToday,
    dailyLimit: configuration.publicationMaxPerDay,
    nextAllowedPublicationAt:
      nextShopeePublicationAt({
        configuration,
        lastPublicationAt,
      })?.toISOString() ?? null,
    lastPublicationAt: lastPublicationAt?.toISOString() ?? null,
    lastPublicationStatus: last?.status ?? null,
    lastErrorCode:
      last &&
      ["FAILED", "PUBLICATION_FAILED"].includes(last.status) &&
      last.errorMessage &&
      /^SHOPEE_[A-Z0-9_]+$/.test(last.errorMessage)
        ? last.errorMessage
        : last &&
            ["FAILED", "PUBLICATION_FAILED"].includes(last.status) &&
            last.errorMessage
          ? "SHOPEE_PUBLICATION_FAILED"
          : null,
    freshness: { fresh: freshness.fresh, stale: freshness.stale },
    ranking: {
      candidatePool: candidateCount,
    },
    enrichment: {
      enabled: configuration.enrichmentEnabled,
      maxItems: configuration.enrichmentMaxItems,
    },
    lastProductionRun: lastProductionRun
      ? {
          status: lastProductionRun.status,
          startedAt: lastProductionRun.startedAt.toISOString(),
          finishedAt: lastProductionRun.finishedAt?.toISOString() ?? null,
          errorCode:
            lastProductionRun.errorMessage &&
            /^SHOPEE_[A-Z0-9_]+$/.test(lastProductionRun.errorMessage)
              ? lastProductionRun.errorMessage
              : null,
        }
      : null,
    telegram: channelMetrics("TELEGRAM"),
    whatsapp: {
      ...channelMetrics("WHATSAPP_GROUPS"),
      queued: channelMetrics("WHATSAPP_GROUPS").pending,
    },
    lock,
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
  if (
    status.externalSendsEnabled &&
    status.publicTracking.ready &&
    status.mode !== "LIVE"
  ) {
    findings.push({
      code: "SHOPEE_EXTERNAL_SENDS_NOT_READY",
      severity: "CRITICAL",
      action: "DISABLE_EXTERNAL_SENDS_OR_COMPLETE_CHANNEL_GATES",
    });
  }
  if (status.externalSendsEnabled && !status.publicTracking.ready) {
    findings.push({
      code: "SHOPEE_PUBLIC_TRACKING_URL_NOT_CONFIGURED",
      severity: "CRITICAL",
      action: "CONFIGURE_PUBLIC_HTTPS_APP_BASE_URL",
    });
  }
  if (
    status.telegram.deliveryUncertain > 0 ||
    status.whatsapp.deliveryUncertain > 0
  ) {
    findings.push({
      code: "SHOPEE_DELIVERY_UNCERTAIN_REVIEW_REQUIRED",
      severity: "CRITICAL",
      action: "RECONCILE_EXTERNAL_DELIVERY_BEFORE_RETRY",
    });
  }
  if (status.lastProductionRun?.status === "RUNNING" && !status.lock.held) {
    findings.push({
      code: "SHOPEE_PRODUCTION_RUN_ABANDONED",
      severity: "WARNING",
      action: "RUN_CONFIRMED_PRODUCTION_TICK_TO_RECOVER",
    });
  }
  return findings;
}
