import {
  canScheduleInWindow,
  WhatsAppMessageFormatter,
  getZonedDayRange,
  isOfferCompatibleWithChannel,
  type ChannelPolicy,
  type PolicyFailureCode,
} from "@affiliate/publication";
import {
  generateMessageForOffer,
  type MessageGenerationResult,
} from "@affiliate/ai-copywriter";
import {
  AssistedWhatsAppGroupsPublisher,
  ManualExportPublisher,
  TelegramPublisher,
  getWhatsAppWebRuntimeConfig,
  type PublicationPayload,
  type PublisherAdapter,
  type PublisherResult,
} from "@affiliate/publisher-connectors";
import { acquireLock, type LockHandle } from "@affiliate/redis";
import { existsSync } from "node:fs";
import {
  getWhatsAppWebQueueStatus,
  lockWhatsAppWebChannelForUpdate,
  prisma,
  Prisma,
  type Channel,
  type Offer,
  type Publication,
} from "@affiliate/database";
import {
  collectMercadoLivreCandidates,
  processAffiliateLinkJobs,
  refreshMercadoLivreOffers,
} from "@affiliate/marketplace-discovery";
import { sanitizeMercadoLivreAffiliateError } from "@affiliate/marketplace-connectors";
import { validateMarketplaceAffiliateUrl } from "@affiliate/validation";
import {
  getWorkerCadences,
  runContinuousWorker,
  type ContinuousWorkerDependencies,
  type WorkerComponentOutcome,
  type WorkerCadences,
  type WorkerComponent,
} from "./runtime";
import { runWithWorkerLeadership } from "./worker-leadership";

const DEFAULT_MAX_ATTEMPTS = 4;
const PUBLICATION_RETRY_MINUTES = [1, 5, 15, 30] as const;

type JobMetrics = {
  offersSelected: number;
  publicationsPlanned: number;
  publicationsCreated: number;
  publicationsAlreadyExisting: number;
  publicationsExecuted: number;
  publicationsDeferred: number;
  publicationsFailed: number;
  readyOffersFound: number;
  scheduled: number;
  published: number;
  exported: number;
  failed: number;
  retried: number;
  expired: number;
  skipped: number;
  aiGenerated: number;
  aiFallbackUsed: number;
  whatsappGroupAssistedPrepared: number;
  whatsappGroupAssistedConfirmed: number;
  whatsappGroupAssistedSkipped: number;
  whatsappGroupAssistedFailed: number;
  whatsappWebDryRuns: number;
  whatsappWebAttempts: number;
  whatsappWebPublished: number;
  whatsappWebFailed: number;
  whatsappWebDeliveryUncertain: number;
  whatsappWebLoginRequired: number;
  whatsappWebSelectorMismatch: number;
  whatsappWebMediaFallback: number;
  whatsappQueueActive: number;
  whatsappQueueWaiting: number;
  whatsappQueueBlockedByDeliveryUncertain: number;
  whatsappPlanningSkippedActiveExists: number;
  whatsappAuthorizationsActive: number;
  whatsappAuthorizationsExpired: number;
  whatsappPublicationsCancelled: number;
  whatsappPublicationsArchived: number;
  skipReasons: Record<string, number>;
  planningDecisions: PublicationPlanningDecision[];
};

export type PublicationPlanningResult =
  | "CREATED"
  | "ALREADY_EXISTS"
  | "BLOCKED_BY_DELIVERY_UNCERTAIN"
  | "ACTIVE_PUBLICATION_EXISTS"
  | "CHANNEL_BLOCKED_BY_DELIVERY_UNCERTAIN"
  | "BLOCKED_BY_CHANNEL_PAUSE"
  | "BLOCKED_BY_DISABLED_CHANNEL"
  | "BLOCKED_BY_POLICY"
  | "NO_ELIGIBLE_OFFER";

export type PublicationPlanningDecision = {
  offerVersionId: string;
  offerVersion: number;
  channelId: string;
  channelType: string;
  publicationMode: string | null;
  planningResult: PublicationPlanningResult;
  executionResult: "DEFERRED" | "PENDING" | "PUBLISHED" | "EXPORTED" | "FAILED";
  reason: string | null;
  publicationId: string | null;
};

type OfferWithLinks = Offer & {
  affiliateLinks: Array<{
    id: string;
    slug: string;
    destination: string;
    active: boolean;
  }>;
};

type PublicationWithRelations = Publication & {
  offer: OfferWithLinks;
  channel: Channel;
  attempts: Array<{ id: string }>;
};

type GeneratedPublicationPayload = PublicationPayload & {
  messageSource: MessageGenerationResult["source"];
  aiProvider: MessageGenerationResult["aiProvider"];
  aiModel?: string | undefined;
  aiGenerationDurationMs?: number | undefined;
  aiValidationPassed: boolean;
  aiValidationReasons: string[];
  generatedAt: string;
};

function emptyMetrics(): JobMetrics {
  return {
    offersSelected: 0,
    publicationsPlanned: 0,
    publicationsCreated: 0,
    publicationsAlreadyExisting: 0,
    publicationsExecuted: 0,
    publicationsDeferred: 0,
    publicationsFailed: 0,
    readyOffersFound: 0,
    scheduled: 0,
    published: 0,
    exported: 0,
    failed: 0,
    retried: 0,
    expired: 0,
    skipped: 0,
    aiGenerated: 0,
    aiFallbackUsed: 0,
    whatsappGroupAssistedPrepared: 0,
    whatsappGroupAssistedConfirmed: 0,
    whatsappGroupAssistedSkipped: 0,
    whatsappGroupAssistedFailed: 0,
    whatsappWebDryRuns: 0,
    whatsappWebAttempts: 0,
    whatsappWebPublished: 0,
    whatsappWebFailed: 0,
    whatsappWebDeliveryUncertain: 0,
    whatsappWebLoginRequired: 0,
    whatsappWebSelectorMismatch: 0,
    whatsappWebMediaFallback: 0,
    whatsappQueueActive: 0,
    whatsappQueueWaiting: 0,
    whatsappQueueBlockedByDeliveryUncertain: 0,
    whatsappPlanningSkippedActiveExists: 0,
    whatsappAuthorizationsActive: 0,
    whatsappAuthorizationsExpired: 0,
    whatsappPublicationsCancelled: 0,
    whatsappPublicationsArchived: 0,
    skipReasons: {},
    planningDecisions: [],
  };
}

function mergeMetrics(target: JobMetrics, source: JobMetrics) {
  const numericKeys: Array<
    Exclude<keyof JobMetrics, "skipReasons" | "planningDecisions">
  > = [
    "offersSelected",
    "publicationsPlanned",
    "publicationsCreated",
    "publicationsAlreadyExisting",
    "publicationsExecuted",
    "publicationsDeferred",
    "publicationsFailed",
    "readyOffersFound",
    "scheduled",
    "published",
    "exported",
    "failed",
    "retried",
    "expired",
    "skipped",
    "aiGenerated",
    "aiFallbackUsed",
    "whatsappGroupAssistedPrepared",
    "whatsappGroupAssistedConfirmed",
    "whatsappGroupAssistedSkipped",
    "whatsappGroupAssistedFailed",
    "whatsappWebDryRuns",
    "whatsappWebAttempts",
    "whatsappWebPublished",
    "whatsappWebFailed",
    "whatsappWebDeliveryUncertain",
    "whatsappWebLoginRequired",
    "whatsappWebSelectorMismatch",
    "whatsappWebMediaFallback",
    "whatsappQueueActive",
    "whatsappQueueWaiting",
    "whatsappQueueBlockedByDeliveryUncertain",
    "whatsappPlanningSkippedActiveExists",
    "whatsappAuthorizationsActive",
    "whatsappAuthorizationsExpired",
    "whatsappPublicationsCancelled",
    "whatsappPublicationsArchived",
  ];

  for (const key of numericKeys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] += value;
    }
  }

  for (const [reason, count] of Object.entries(source.skipReasons)) {
    target.skipReasons[reason] = (target.skipReasons[reason] ?? 0) + count;
  }
  for (const decision of source.planningDecisions ?? []) {
    const existing = target.planningDecisions.find(
      (candidate) =>
        candidate.offerVersionId === decision.offerVersionId &&
        candidate.channelId === decision.channelId,
    );
    if (!existing) {
      target.planningDecisions.push(decision);
      continue;
    }
    if (decision.executionResult !== "PENDING") {
      existing.executionResult = decision.executionResult;
    }
    if (decision.reason) existing.reason = decision.reason;
    if (decision.publicationId) existing.publicationId = decision.publicationId;
  }
}

type WorkerSkipReason =
  | PolicyFailureCode
  | "PUBLISHER_UNAVAILABLE"
  | "OFFER_MISSING_AFFILIATE_LINK"
  | "LOCK_NOT_ACQUIRED"
  | "DUPLICATE_PUBLICATION"
  | "CHANNEL_DISABLED"
  | "CHANNEL_PAUSED"
  | "ACTIVE_PUBLICATION_EXISTS"
  | "WHATSAPP_WEB_DELIVERY_UNCERTAIN"
  | "PLANNING_FAILED";

function recordSkip(metrics: JobMetrics, reason: WorkerSkipReason) {
  metrics.skipped += 1;
  metrics.skipReasons[reason] = (metrics.skipReasons[reason] ?? 0) + 1;
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function channelPolicy(channel: Channel): ChannelPolicy {
  return {
    enabled: channel.enabled,
    type: channel.type,
    timezone: channel.timezone,
    dailyPublicationLimit: channel.dailyPublicationLimit,
    minimumIntervalMinutes: channel.minimumIntervalMinutes,
    allowedStartTime: channel.allowedStartTime,
    allowedEndTime: channel.allowedEndTime,
    minimumScore: channel.minimumScore,
    minimumDiscountPercentage:
      channel.minDiscountPercentage?.toString() ?? null,
    productRepeatIntervalDays: channel.productRepeatIntervalDays,
    allowedMarketplaces: asStringArray(channel.allowedMarketplaces),
    allowedCategories: asStringArray(channel.allowedCategories),
  };
}

function getBaseUrl() {
  return (
    process.env.APP_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function trackingUrlForSlug(slug: string) {
  return `${getBaseUrl()}/go/${encodeURIComponent(slug)}`;
}

export function resolvePublicationUrl(offer: OfferWithLinks) {
  if (
    offer.marketplace === "MERCADO_LIVRE" ||
    offer.trackingStrategy === "DIRECT_AFFILIATE_LINK"
  ) {
    if (!offer.affiliateUrl) return null;
    const validation = validateMarketplaceAffiliateUrl(
      offer.marketplace,
      offer.affiliateUrl,
    );
    return validation.ok
      ? { url: validation.normalizedUrl, affiliateLinkId: null }
      : null;
  }

  const link = offer.affiliateLinks.find((item) => item.active);
  return link
    ? { url: trackingUrlForSlug(link.slug), affiliateLinkId: link.id }
    : null;
}

async function messagePayloadFor(
  offer: OfferWithLinks,
  channel: Channel,
): Promise<GeneratedPublicationPayload | null> {
  const publicationUrl = resolvePublicationUrl(offer);

  if (!publicationUrl) {
    return null;
  }

  const recentHeadlines = await recentChannelHeadlines(channel.id);
  const generated = await generateMessageForOffer({
    title: offer.title,
    marketplace: offer.marketplace,
    category: offer.category,
    originalPrice: offer.originalPrice?.toString() ?? null,
    currentPrice: offer.currentPrice.toString(),
    discountPercentage: offer.discountPercentage?.toString() ?? null,
    couponCode: offer.couponCode,
    couponExpiration: offer.couponExpiration,
    freeShipping: offer.freeShipping,
    shippingStatus: offer.shippingStatus,
    rating: offer.rating?.toString() ?? null,
    salesCount: offer.salesCount,
    trackingUrl: publicationUrl.url,
    footer: getChannelMessageFooter(channel.configuration),
    seed: `${channel.id}:${offer.id}`,
    recentHeadlines,
  });

  const message = isAssistedWhatsAppGroup(channel)
    ? new WhatsAppMessageFormatter().format({
        title: offer.title,
        marketplace: offer.marketplace,
        originalPrice: offer.originalPrice?.toString() ?? null,
        currentPrice: offer.currentPrice.toString(),
        discountPercentage: offer.discountPercentage?.toString() ?? null,
        couponCode: offer.couponCode,
        couponExpiration: offer.couponExpiration,
        freeShipping: offer.freeShipping,
        shippingStatus: offer.shippingStatus,
        trackingUrl: publicationUrl.url,
        seed: `${channel.id}:${offer.id}`,
        recentHeadlines,
        headlineSuggestion: headlineFromMessagePayload({
          message: generated.message,
        }),
        customHeader: channelConfigString(channel, "customHeader"),
        customFooter: channelConfigString(channel, "customFooter"),
      }).message
    : generated.message;

  return {
    offerId: offer.id,
    channelId: channel.id,
    trackingUrl: publicationUrl.url,
    message,
    imageUrl:
      isAssistedWhatsAppGroup(channel) &&
      channelConfiguration(channel).sendImage === false
        ? null
        : offer.imageUrl,
    messageSource: generated.source,
    aiProvider: generated.aiProvider,
    aiModel: generated.aiModel,
    aiGenerationDurationMs: generated.aiGenerationDurationMs,
    aiValidationPassed: generated.aiValidationPassed,
    aiValidationReasons: generated.aiValidationReasons,
    generatedAt: generated.generatedAt.toISOString(),
  };
}

function channelConfiguration(channel: Channel) {
  return channel.configuration &&
    typeof channel.configuration === "object" &&
    !Array.isArray(channel.configuration)
    ? (channel.configuration as Record<string, unknown>)
    : {};
}

function channelConfigString(channel: Channel, key: string) {
  const value = channelConfiguration(channel)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function channelConfigBoolean(channel: Channel, key: string, fallback = false) {
  const value = channelConfiguration(channel)[key];
  return typeof value === "boolean" ? value : fallback;
}

export function isAssistedWhatsAppGroup(channel: Channel) {
  return (
    channel.type === "WHATSAPP_GROUPS" &&
    channelConfiguration(channel).publicationMode === "ASSISTED"
  );
}

export function isExperimentalWhatsAppGroup(channel: Channel) {
  return (
    channel.type === "WHATSAPP_GROUPS" &&
    channelConfiguration(channel).publicationMode === "WEB_EXPERIMENTAL"
  );
}

export function hasBlockedWhatsAppWebSendState(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const value = metadata as Record<string, unknown>;
  return (
    value.retryAuthorized !== true &&
    (value.deliveryUncertain === true ||
      typeof value.sendClickStartedAt === "string")
  );
}

function whatsappGroupDisplayName(channel: Channel) {
  return channelConfigString(channel, "groupDisplayName") ?? channel.name;
}

function publicationMode(channel: Channel) {
  return channelConfigString(channel, "publicationMode");
}

export function controlledChannelPlanningBlock(channel: Channel): {
  planningResult: "BLOCKED_BY_CHANNEL_PAUSE" | "BLOCKED_BY_DISABLED_CHANNEL";
  reason: string;
} | null {
  if (!channel.enabled) {
    return {
      planningResult: "BLOCKED_BY_DISABLED_CHANNEL",
      reason: "CHANNEL_DISABLED",
    };
  }
  if (
    isExperimentalWhatsAppGroup(channel) &&
    channelConfigBoolean(channel, "webAutomationPaused")
  ) {
    return {
      planningResult: "BLOCKED_BY_CHANNEL_PAUSE",
      reason:
        channelConfigString(channel, "webAutomationPauseReason") ??
        "WHATSAPP_WEB_CHANNEL_PAUSED",
    };
  }
  return null;
}

function recordPlanningDecision(
  metrics: JobMetrics,
  offer: Offer,
  channel: Channel,
  planningResult: PublicationPlanningResult,
  options: {
    executionResult?: PublicationPlanningDecision["executionResult"];
    reason?: string | null;
    publicationId?: string | null;
  } = {},
) {
  metrics.planningDecisions.push({
    offerVersionId: offer.id,
    offerVersion: offer.version,
    channelId: channel.id,
    channelType: channel.type,
    publicationMode: publicationMode(channel),
    planningResult,
    executionResult: options.executionResult ?? "PENDING",
    reason: options.reason ?? null,
    publicationId: options.publicationId ?? null,
  });
}

function compactPlanningDecisions(decisions: PublicationPlanningDecision[]) {
  const byChannel = new Map<string, PublicationPlanningDecision>();
  const priority = (decision: PublicationPlanningDecision) => {
    const executionPriority =
      decision.executionResult === "PUBLISHED" ||
      decision.executionResult === "EXPORTED"
        ? 50
        : decision.executionResult === "FAILED"
          ? 40
          : 0;
    const planningPriority =
      decision.planningResult === "CREATED"
        ? 100
        : decision.planningResult === "CHANNEL_BLOCKED_BY_DELIVERY_UNCERTAIN"
          ? 95
          : decision.planningResult === "ACTIVE_PUBLICATION_EXISTS"
            ? 92
            : decision.planningResult === "BLOCKED_BY_DELIVERY_UNCERTAIN"
              ? 90
              : decision.planningResult === "ALREADY_EXISTS"
                ? 80
                : decision.planningResult === "BLOCKED_BY_CHANNEL_PAUSE" ||
                    decision.planningResult === "BLOCKED_BY_DISABLED_CHANNEL"
                  ? 70
                  : 10;
    return planningPriority + executionPriority;
  };

  for (const decision of decisions) {
    const current = byChannel.get(decision.channelId);
    if (!current || priority(decision) > priority(current)) {
      byChannel.set(decision.channelId, decision);
    }
  }
  return [...byChannel.values()];
}

function controlledWhatsAppPlanningMetadata(
  channel: Channel,
  now: Date,
  planningRunId?: string,
  previous: Record<string, unknown> = {},
) {
  return {
    ...previous,
    publicationMode: "WEB_EXPERIMENTAL",
    whatsappDestinationType: "GROUP",
    groupDisplayNameSnapshot: whatsappGroupDisplayName(channel),
    confirmationStrategy: "VISUAL_OUTGOING_MESSAGE",
    sendWasClicked: false,
    whatsappWebState:
      typeof previous.whatsappWebState === "string"
        ? previous.whatsappWebState
        : "AWAITING_VISUAL_INSPECTION",
    plannedAt:
      typeof previous.plannedAt === "string"
        ? previous.plannedAt
        : now.toISOString(),
    plannedBy: "WORKER",
    planningRunId:
      typeof previous.planningRunId === "string"
        ? previous.planningRunId
        : (planningRunId ?? null),
    visualInspectionRequired: true,
    visualInspectionConfirmed: previous.visualInspectionConfirmed === true,
    preflightRequired: true,
    preflightCompleted: previous.preflightCompleted === true,
    realSendAuthorized: false,
    deliveryUncertain: previous.deliveryUncertain === true,
    dispatchBlockedReason:
      typeof previous.dispatchBlockedReason === "string"
        ? previous.dispatchBlockedReason
        : "VISUAL_DRAFT_INSPECTION_REQUIRED",
  };
}

function assistedMaxPending(channel: Channel) {
  const configuration = channelConfiguration(channel);
  const configured = Number(
    configuration.maxPendingPublications ?? configuration.maxPending,
  );
  const fallback = Number(
    process.env.WHATSAPP_ASSISTED_MAX_PENDING_PER_CHANNEL ?? 5,
  );
  return Math.max(1, Number.isFinite(configured) ? configured : fallback);
}

export function hasAssistedGroupPendingCapacity(
  channel: Channel,
  pending: number,
) {
  return pending < assistedMaxPending(channel);
}

export function getChannelMessageFooter(
  configuration: Channel["configuration"],
) {
  if (
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration)
  ) {
    return null;
  }

  const record = configuration as Record<string, unknown>;
  const value =
    typeof record.messageFooter === "string"
      ? record.messageFooter
      : typeof record.footer === "string"
        ? record.footer
        : null;

  return value?.trim() || null;
}

export function headlineFromMessagePayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const message = (payload as Record<string, unknown>).message;
  if (typeof message !== "string") return null;

  return (
    message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

async function recentChannelHeadlines(channelId: string) {
  // Some isolated unit-test Prisma doubles intentionally implement only upsert.
  if (typeof prisma.publication.findMany !== "function") return [];

  const publications = await prisma.publication.findMany({
    where: {
      channelId,
      status: {
        in: [
          "PUBLISHED",
          "EXPORTED",
          "SCHEDULED",
          "AWAITING_MANUAL_PUBLICATION",
        ],
      },
    },
    orderBy: { scheduledAt: "desc" },
    take: 5,
    select: { messagePayload: true },
  });

  return publications
    .map((publication) =>
      headlineFromMessagePayload(publication.messagePayload),
    )
    .filter((headline): headline is string => Boolean(headline))
    .slice(0, 5);
}

function getTelegramChatId(channel: Channel) {
  const configuration = channel.configuration;

  if (
    configuration &&
    typeof configuration === "object" &&
    !Array.isArray(configuration)
  ) {
    const record = configuration as Record<string, unknown>;

    if (typeof record.chatId === "string" && record.chatId.trim()) {
      return record.chatId.trim();
    }
  }

  return process.env.TELEGRAM_CHAT_ID;
}

function publisherForChannel(channel: Channel): PublisherAdapter | null {
  if (channel.type === "MANUAL_EXPORT") {
    return new ManualExportPublisher();
  }

  if (channel.type === "TELEGRAM") {
    return new TelegramPublisher({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      chatId: getTelegramChatId(channel),
    });
  }

  return null;
}

async function channelDailyCount(channel: Channel, now: Date) {
  const { start, end } = getZonedDayRange(now, channel.timezone);

  return prisma.publication.count({
    where: {
      channelId: channel.id,
      scheduledAt: { gte: start, lt: end },
      status: { notIn: ["CANCELLED", "PUBLICATION_FAILED", "FAILED"] },
    },
  });
}

type ReadyOfferPriority = {
  id: string;
  publishedAt: Date | null;
  score: number | null;
  discountPercentage: number | string | { toString(): string } | null;
  bestSellerPosition: number | null;
  collectedAt: Date;
};

export function compareReadyOfferPriority(
  left: ReadyOfferPriority,
  right: ReadyOfferPriority,
) {
  const leftPublished = left.publishedAt ? 1 : 0;
  const rightPublished = right.publishedAt ? 1 : 0;
  if (leftPublished !== rightPublished) {
    return leftPublished - rightPublished;
  }

  const scoreDifference = (right.score ?? 0) - (left.score ?? 0);
  if (scoreDifference !== 0) return scoreDifference;

  const discountDifference =
    Number(right.discountPercentage ?? -1) -
    Number(left.discountPercentage ?? -1);
  if (discountDifference !== 0) return discountDifference;

  const rankDifference =
    (left.bestSellerPosition ?? Number.MAX_SAFE_INTEGER) -
    (right.bestSellerPosition ?? Number.MAX_SAFE_INTEGER);
  if (rankDifference !== 0) return rankDifference;

  const recencyDifference =
    (right.collectedAt instanceof Date ? right.collectedAt.getTime() : 0) -
    (left.collectedAt instanceof Date ? left.collectedAt.getTime() : 0);
  if (recencyDifference !== 0) return recencyDifference;

  return left.id.localeCompare(right.id);
}

async function lastChannelPublication(channelId: string) {
  return prisma.publication.findFirst({
    where: {
      channelId,
      status: {
        in: [
          "PUBLISHED",
          "EXPORTED",
          "SCHEDULED",
          "AWAITING_MANUAL_PUBLICATION",
        ],
      },
    },
    orderBy: { scheduledAt: "desc" },
    select: { scheduledAt: true, publishedAt: true },
  });
}

async function lastProductPublication(
  channelId: string,
  productId?: string | null,
) {
  if (!productId) {
    return null;
  }

  return prisma.publication.findFirst({
    where: {
      channelId,
      status: {
        in: [
          "PUBLISHED",
          "EXPORTED",
          "SCHEDULED",
          "AWAITING_MANUAL_PUBLICATION",
        ],
      },
      offer: { productId },
    },
    orderBy: { scheduledAt: "desc" },
    select: { scheduledAt: true, publishedAt: true },
  });
}

export async function createPublicationIdempotently(
  tx: Prisma.TransactionClient,
  offer: OfferWithLinks,
  channel: Channel,
  payload: GeneratedPublicationPayload,
  now: Date,
  status: "SCHEDULED" | "AWAITING_MANUAL_PUBLICATION" = "SCHEDULED",
  planningRunId?: string,
) {
  const idempotencyKey = `publication:${channel.id}:${offer.id}`;

  return tx.publication.upsert({
    where: { idempotencyKey },
    update: {},
    create: {
      offerId: offer.id,
      channelId: channel.id,
      status,
      idempotencyKey,
      scheduledAt: now,
      messagePayload: payload,
      imageUrlSnapshot: payload.imageUrl ?? null,
      metadata:
        status === "AWAITING_MANUAL_PUBLICATION"
          ? {
              publicationMode: "ASSISTED",
              whatsappDestinationType: "GROUP",
              groupDisplayNameSnapshot: whatsappGroupDisplayName(channel),
              confirmationStrategy: "MANUAL",
              mediaFallbackUsed: !payload.imageUrl,
            }
          : isExperimentalWhatsAppGroup(channel)
            ? controlledWhatsAppPlanningMetadata(channel, now, planningRunId)
            : Prisma.JsonNull,
      messageSource: payload.messageSource,
      aiProvider: payload.aiProvider,
      aiModel: payload.aiModel ?? null,
      aiGenerationDurationMs: payload.aiGenerationDurationMs ?? null,
      aiValidationPassed: payload.aiValidationPassed,
      aiValidationReasons: payload.aiValidationReasons,
      generatedAt: new Date(payload.generatedAt),
      offerTitleSnapshot: offer.title,
      productExternalIdSnapshot: offer.externalProductId,
      marketplaceSnapshot: offer.marketplace,
      categorySnapshot: offer.category,
      originalPriceSnapshot: offer.originalPrice,
      currentPriceSnapshot: offer.currentPrice,
      discountPercentageSnapshot: offer.discountPercentage,
      couponCodeSnapshot: offer.couponCode,
      couponExpirationSnapshot: offer.couponExpiration,
      freeShippingSnapshot: offer.freeShipping,
      shippingStatusSnapshot: offer.shippingStatus,
      affiliateUrlSnapshot: offer.affiliateUrl,
      trackingUrlSnapshot: payload.trackingUrl,
      offerVersionSnapshot: offer.version,
      sourceCategoryIdSnapshot: offer.sourceCategoryId,
      bestSellerPositionSnapshot: offer.bestSellerPosition,
      sourceHighlightIdSnapshot: offer.sourceHighlightId,
      sourceHighlightTypeSnapshot: offer.sourceHighlightType,
      resolutionStrategySnapshot: offer.resolutionStrategy,
    },
  });
}

export async function scheduleReadyOffers(
  now = new Date(),
  options: { planningRunId?: string; preferredOfferIds?: string[] } = {},
) {
  const metrics = emptyMetrics();
  const preferredOfferIds = [...new Set(options.preferredOfferIds ?? [])];
  const [fallbackOffers, preferredOffers, channels] = await Promise.all([
    prisma.offer.findMany({
      where: {
        status: { in: ["READY_TO_PUBLISH", "SCHEDULED", "PUBLISHED"] },
      },
      orderBy: { publishedAt: "asc" },
      take: 50,
      include: { affiliateLinks: true },
    }),
    preferredOfferIds.length > 0
      ? prisma.offer.findMany({
          where: {
            id: { in: preferredOfferIds },
            status: { in: ["READY_TO_PUBLISH", "SCHEDULED", "PUBLISHED"] },
          },
          include: { affiliateLinks: true },
        })
      : Promise.resolve([]),
    prisma.channel.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  const offers = [
    ...new Map(
      [...preferredOffers, ...fallbackOffers].map((offer) => [offer.id, offer]),
    ).values(),
  ];
  metrics.readyOffersFound = offers.length;
  const preferredOrder = new Map(
    preferredOfferIds.map((offerId, index) => [offerId, index]),
  );
  const prioritizedOffers = [...offers].sort((left, right) => {
    const leftOrder = preferredOrder.get(left.id);
    const rightOrder = preferredOrder.get(right.id);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    }
    return compareReadyOfferPriority(left, right);
  });
  const scheduledChannelIds = new Set<string>();
  const selectedOfferIds = new Set<string>();
  const whatsappQueues = new Map<
    string,
    Awaited<ReturnType<typeof getWhatsAppWebQueueStatus>>
  >();

  for (const channel of channels) {
    if (!isExperimentalWhatsAppGroup(channel)) continue;
    const queue = await getWhatsAppWebQueueStatus(prisma, channel.id);
    whatsappQueues.set(channel.id, queue);
    metrics.whatsappQueueActive += queue.activePublicationId ? 1 : 0;
    metrics.whatsappQueueWaiting += queue.waitingCount;
    metrics.whatsappQueueBlockedByDeliveryUncertain +=
      queue.deliveryUncertainCount > 0 ? 1 : 0;
    metrics.whatsappAuthorizationsActive += queue.authorizationsActive;
    metrics.whatsappAuthorizationsExpired += queue.authorizationsExpired;
    metrics.whatsappPublicationsCancelled += queue.cancelledCount;
    metrics.whatsappPublicationsArchived += queue.archivedCount;
  }

  for (const offer of prioritizedOffers) {
    for (const channel of channels) {
      if (scheduledChannelIds.has(channel.id)) continue;

      try {
        const channelBlock = controlledChannelPlanningBlock(channel);
        if (channelBlock) {
          recordSkip(
            metrics,
            channelBlock.planningResult === "BLOCKED_BY_DISABLED_CHANNEL"
              ? "CHANNEL_DISABLED"
              : "CHANNEL_PAUSED",
          );
          recordPlanningDecision(
            metrics,
            offer,
            channel,
            channelBlock.planningResult,
            { reason: channelBlock.reason },
          );
          continue;
        }

        const existingQueue = whatsappQueues.get(channel.id);
        if (existingQueue?.activePublicationId) {
          const uncertain = existingQueue.deliveryUncertainCount > 0;
          recordSkip(
            metrics,
            uncertain
              ? "WHATSAPP_WEB_DELIVERY_UNCERTAIN"
              : "ACTIVE_PUBLICATION_EXISTS",
          );
          metrics.whatsappPlanningSkippedActiveExists += 1;
          recordPlanningDecision(
            metrics,
            offer,
            channel,
            uncertain
              ? "CHANNEL_BLOCKED_BY_DELIVERY_UNCERTAIN"
              : "ACTIVE_PUBLICATION_EXISTS",
            {
              executionResult: "DEFERRED",
              reason: uncertain
                ? "WHATSAPP_WEB_DELIVERY_UNCERTAIN"
                : `ACTIVE_PUBLICATION:${existingQueue.activePublicationId}`,
              publicationId: existingQueue.activePublicationId,
            },
          );
          scheduledChannelIds.add(channel.id);
          continue;
        }

        const policy = channelPolicy(channel);
        const compatibility = isOfferCompatibleWithChannel(
          {
            marketplace: offer.marketplace,
            category: offer.category,
            score: offer.score,
            scoreCompletenessPercentage:
              offer.scoreCompletenessPercentage?.toString() ?? null,
            discountPercentage: offer.discountPercentage?.toString() ?? null,
            stockStatus: offer.stockStatus,
            shippingStatus: offer.shippingStatus,
          },
          policy,
        );

        if (!compatibility.ok) {
          recordSkip(metrics, compatibility.code);
          recordPlanningDecision(metrics, offer, channel, "BLOCKED_BY_POLICY", {
            reason: compatibility.code,
          });
          continue;
        }

        const publisher = publisherForChannel(channel);

        const assisted = isAssistedWhatsAppGroup(channel);
        const webExperimental = isExperimentalWhatsAppGroup(channel);
        if (
          !publisher &&
          !assisted &&
          !(
            webExperimental &&
            getWhatsAppWebRuntimeConfig().enabled &&
            channelConfigBoolean(channel, "webAutomationEnabled")
          )
        ) {
          recordSkip(metrics, "PUBLISHER_UNAVAILABLE");
          recordPlanningDecision(metrics, offer, channel, "BLOCKED_BY_POLICY", {
            reason: "PUBLISHER_UNAVAILABLE",
          });
          continue;
        }

        if (assisted) {
          const pending = await prisma.publication.count({
            where: {
              channelId: channel.id,
              status: "AWAITING_MANUAL_PUBLICATION",
            },
          });
          if (!hasAssistedGroupPendingCapacity(channel, pending)) {
            recordSkip(metrics, "CHANNEL_DAILY_LIMIT");
            metrics.whatsappGroupAssistedSkipped += 1;
            recordPlanningDecision(
              metrics,
              offer,
              channel,
              "BLOCKED_BY_POLICY",
              {
                reason: "CHANNEL_DAILY_LIMIT",
              },
            );
            continue;
          }
        }

        const [publicationsToday, lastPublication, productPublication] =
          await Promise.all([
            channelDailyCount(channel, now),
            lastChannelPublication(channel.id),
            lastProductPublication(channel.id, offer.productId),
          ]);
        const windowResult = canScheduleInWindow({
          channel: policy,
          now,
          publicationsToday,
          lastPublicationAt:
            lastPublication?.publishedAt ??
            lastPublication?.scheduledAt ??
            null,
          lastProductPublicationAt:
            productPublication?.publishedAt ??
            productPublication?.scheduledAt ??
            null,
        });

        if (!windowResult.ok) {
          recordSkip(metrics, windowResult.code);
          recordPlanningDecision(metrics, offer, channel, "BLOCKED_BY_POLICY", {
            reason: windowResult.code,
          });
          continue;
        }

        const idempotencyKey = `publication:${channel.id}:${offer.id}`;
        const existingPublication = await prisma.publication.findFirst({
          where: { idempotencyKey },
          select: { id: true, metadata: true },
        });
        if (existingPublication) {
          recordSkip(metrics, "DUPLICATE_PUBLICATION");
          metrics.publicationsAlreadyExisting += 1;
          selectedOfferIds.add(offer.id);
          const blocked = hasBlockedWhatsAppWebSendState(
            existingPublication.metadata,
          );
          recordPlanningDecision(
            metrics,
            offer,
            channel,
            blocked ? "BLOCKED_BY_DELIVERY_UNCERTAIN" : "ALREADY_EXISTS",
            {
              executionResult: isExperimentalWhatsAppGroup(channel)
                ? "DEFERRED"
                : "PENDING",
              reason: blocked ? "WHATSAPP_WEB_DELIVERY_UNCERTAIN" : null,
              publicationId: existingPublication.id,
            },
          );
          continue;
        }

        const payload = await messagePayloadFor(offer, channel);

        if (!payload) {
          recordSkip(metrics, "OFFER_MISSING_AFFILIATE_LINK");
          recordPlanningDecision(metrics, offer, channel, "BLOCKED_BY_POLICY", {
            reason: "OFFER_MISSING_AFFILIATE_LINK",
          });
          continue;
        }
        if (payload.messageSource === "AI_GENERATED") {
          metrics.aiGenerated += 1;
        } else {
          metrics.aiFallbackUsed += 1;
        }

        const lock = await acquireLock(
          webExperimental
            ? `whatsapp:web:planning:${channel.id}`
            : `publication:${channel.id}:${offer.id}`,
          60_000,
          webExperimental ? { requireRedis: true } : undefined,
        );

        if (!lock.acquired) {
          recordSkip(metrics, "LOCK_NOT_ACQUIRED");
          recordPlanningDecision(metrics, offer, channel, "BLOCKED_BY_POLICY", {
            reason: "LOCK_NOT_ACQUIRED",
          });
          continue;
        }

        try {
          if (assisted) {
            await new AssistedWhatsAppGroupsPublisher().publish({
              ...payload,
              destinationType: "GROUP",
              groupDisplayName: whatsappGroupDisplayName(channel),
            });
          }
          let publicationId: string | null = null;
          let activePublicationId: string | null = null;
          await prisma.$transaction(async (tx) => {
            if (webExperimental) {
              await lockWhatsAppWebChannelForUpdate(tx, channel.id);
              const queue = await getWhatsAppWebQueueStatus(
                tx,
                channel.id,
                now,
              );
              activePublicationId = queue.activePublicationId;
              if (activePublicationId) return;
            }
            const publication = await createPublicationIdempotently(
              tx,
              offer,
              channel,
              payload,
              now,
              assisted ? "AWAITING_MANUAL_PUBLICATION" : "SCHEDULED",
              options.planningRunId,
            );
            publicationId = publication.id;
            if (offer.status !== "SCHEDULED" && offer.status !== "PUBLISHED") {
              await tx.offer.update({
                where: { id: offer.id },
                data: { status: "SCHEDULED", scheduledAt: now },
              });
            }
          });
          if (activePublicationId) {
            recordSkip(metrics, "ACTIVE_PUBLICATION_EXISTS");
            metrics.whatsappPlanningSkippedActiveExists += 1;
            recordPlanningDecision(
              metrics,
              offer,
              channel,
              "ACTIVE_PUBLICATION_EXISTS",
              {
                executionResult: "DEFERRED",
                reason: `ACTIVE_PUBLICATION:${activePublicationId}`,
                publicationId: activePublicationId,
              },
            );
            scheduledChannelIds.add(channel.id);
            continue;
          }
          metrics.scheduled += 1;
          metrics.publicationsPlanned += 1;
          metrics.publicationsCreated += 1;
          if (assisted) metrics.whatsappGroupAssistedPrepared += 1;
          selectedOfferIds.add(offer.id);
          recordPlanningDecision(metrics, offer, channel, "CREATED", {
            executionResult: webExperimental ? "DEFERRED" : "PENDING",
            reason: webExperimental ? "VISUAL_DRAFT_INSPECTION_REQUIRED" : null,
            publicationId,
          });
          scheduledChannelIds.add(channel.id);
        } finally {
          await lock.release();
        }
      } catch {
        metrics.failed += 1;
        metrics.publicationsFailed += 1;
        recordSkip(metrics, "PLANNING_FAILED");
        recordPlanningDecision(metrics, offer, channel, "BLOCKED_BY_POLICY", {
          reason: "PLANNING_FAILED",
        });
      }
    }
  }

  metrics.offersSelected = selectedOfferIds.size;

  return metrics;
}

async function payloadFromPublication(
  publication: PublicationWithRelations,
): Promise<PublicationPayload | null> {
  const payload = publication.messagePayload;

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;

    if (
      typeof record.message === "string" &&
      typeof record.trackingUrl === "string"
    ) {
      return {
        offerId: publication.offerId,
        channelId: publication.channelId,
        trackingUrl: record.trackingUrl,
        message: record.message,
        imageUrl:
          typeof record.imageUrl === "string"
            ? record.imageUrl
            : publication.offer.imageUrl,
      };
    }
  }

  return messagePayloadFor(publication.offer, publication.channel);
}

async function recordPublicationResult(
  publication: PublicationWithRelations,
  result: PublisherResult,
  attemptNumber: number,
  maxAttempts: number,
  now: Date,
) {
  const attemptStatus =
    result.status === "PUBLISHED"
      ? "SUCCESS"
      : result.status === "EXPORTED"
        ? "EXPORTED"
        : "FAILED";

  await prisma.publicationAttempt.create({
    data: {
      publicationId: publication.id,
      attemptNumber,
      status: attemptStatus,
      requestPayload: publication.messagePayload ?? {},
      responsePayload: result.rawResponse ?? {},
      errorMessage: result.errorMessage ?? null,
    },
  });

  if (result.status === "PUBLISHED") {
    await prisma.$transaction([
      prisma.publication.update({
        where: { id: publication.id },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
          externalId: result.externalId ?? null,
          errorMessage: null,
        },
      }),
      prisma.offer.update({
        where: { id: publication.offerId },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      }),
    ]);
    return;
  }

  if (result.status === "EXPORTED") {
    await prisma.publication.update({
      where: { id: publication.id },
      data: {
        status: "EXPORTED",
        externalId: result.externalId ?? null,
        errorMessage: null,
      },
    });
    return;
  }

  const definitiveFailure =
    result.failureKind === "PERMANENT" || attemptNumber >= maxAttempts;
  const retryAt = new Date(
    now.getTime() +
      publicationRetryDelayMs(attemptNumber, result.retryAfterSeconds),
  );
  await prisma.publication.update({
    where: { id: publication.id },
    data: {
      status: definitiveFailure ? "PUBLICATION_FAILED" : "FAILED",
      ...(!definitiveFailure ? { scheduledAt: retryAt } : {}),
      errorMessage: result.errorMessage ?? "Publication failed.",
    },
  });

  if (definitiveFailure) {
    await prisma.systemAlert.create({
      data: {
        severity: "ERROR",
        source: "worker.publishScheduledOffers",
        message: `Publication ${publication.id} failed after ${attemptNumber} attempt(s).`,
        metadata: {
          publicationId: publication.id,
          offerId: publication.offerId,
          channelId: publication.channelId,
        },
      },
    });
  }
}

export function publicationRetryDelayMs(
  attemptNumber: number,
  retryAfterSeconds?: number,
) {
  const position = Math.max(
    0,
    Math.min(PUBLICATION_RETRY_MINUTES.length - 1, attemptNumber - 1),
  );
  const backoffMs = (PUBLICATION_RETRY_MINUTES[position] ?? 30) * 60_000;
  const retryAfterMs =
    retryAfterSeconds && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
  return Math.max(backoffMs, retryAfterMs);
}

export async function publishScheduledOffers(now = new Date()) {
  const metrics = emptyMetrics();
  const maxAttempts = Number(
    process.env.WORKER_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
  );
  const publications = await prisma.publication.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lte: now },
      channel: {
        publications: {
          none: {
            status: "FAILED",
            scheduledAt: { gt: now },
          },
        },
      },
    },
    take: 100,
    orderBy: { scheduledAt: "asc" },
    include: {
      channel: true,
      offer: { include: { affiliateLinks: true } },
      attempts: { select: { id: true } },
    },
  });

  const controlledWebPublications = publications.filter((publication) =>
    isExperimentalWhatsAppGroup(publication.channel),
  );
  for (const publication of controlledWebPublications) {
    const metadata =
      publication.metadata &&
      typeof publication.metadata === "object" &&
      !Array.isArray(publication.metadata)
        ? (publication.metadata as Record<string, unknown>)
        : {};
    if (
      typeof metadata.whatsappWebState !== "string" ||
      metadata.visualInspectionRequired !== true ||
      metadata.preflightRequired !== true ||
      typeof metadata.dispatchBlockedReason !== "string"
    ) {
      await prisma.publication.update({
        where: { id: publication.id },
        data: {
          metadata: controlledWhatsAppPlanningMetadata(
            publication.channel,
            publication.scheduledAt,
            undefined,
            metadata,
          ) as Prisma.InputJsonValue,
        },
      });
    }
    metrics.publicationsDeferred += 1;
    recordPlanningDecision(
      metrics,
      publication.offer,
      publication.channel,
      "ALREADY_EXISTS",
      {
        executionResult: "DEFERRED",
        reason: hasBlockedWhatsAppWebSendState(metadata)
          ? "WHATSAPP_WEB_DELIVERY_UNCERTAIN"
          : "VISUAL_DRAFT_INSPECTION_REQUIRED",
        publicationId: publication.id,
      },
    );
  }

  const selectedChannelIds = new Set<string>();
  const selectedPublications = publications.filter((publication) => {
    if (isExperimentalWhatsAppGroup(publication.channel)) return false;
    if (selectedChannelIds.has(publication.channelId)) return false;
    selectedChannelIds.add(publication.channelId);
    return true;
  });

  for (const publication of selectedPublications) {
    const payload = await payloadFromPublication(publication);
    const publisher = publisherForChannel(publication.channel);

    if (!payload || !publisher) {
      metrics.failed += 1;
      metrics.publicationsFailed += 1;
      recordPlanningDecision(
        metrics,
        publication.offer,
        publication.channel,
        "ALREADY_EXISTS",
        {
          executionResult: "FAILED",
          reason: "PUBLISHER_UNAVAILABLE",
          publicationId: publication.id,
        },
      );
      await prisma.publication.update({
        where: { id: publication.id },
        data: {
          status: "PUBLICATION_FAILED",
          errorMessage: "Publisher unavailable.",
        },
      });
      continue;
    }

    const result = await publisher.publish(payload);
    metrics.publicationsExecuted += 1;
    const attemptNumber = publication.attempts.length + 1;
    await recordPublicationResult(
      publication,
      result,
      attemptNumber,
      maxAttempts,
      now,
    );

    if (result.status === "PUBLISHED") {
      metrics.published += 1;
    } else if (result.status === "EXPORTED") {
      metrics.exported += 1;
    } else {
      metrics.failed += 1;
      metrics.publicationsFailed += 1;
    }
    recordPlanningDecision(
      metrics,
      publication.offer,
      publication.channel,
      "ALREADY_EXISTS",
      {
        executionResult:
          result.status === "PUBLISHED"
            ? "PUBLISHED"
            : result.status === "EXPORTED"
              ? "EXPORTED"
              : "FAILED",
        reason:
          result.status === "FAILED"
            ? (result.errorCode ?? "PUBLICATION_FAILED")
            : null,
        publicationId: publication.id,
      },
    );
  }

  return metrics;
}

export async function retryFailedPublications(now = new Date()) {
  const metrics = emptyMetrics();
  const maxAttempts = Number(
    process.env.WORKER_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
  );
  const publications = await prisma.publication.findMany({
    where: { status: "FAILED", scheduledAt: { lte: now } },
    orderBy: { scheduledAt: "asc" },
    take: 100,
    include: { attempts: { select: { id: true } } },
  });
  const selectedChannels = new Set<string>();

  for (const publication of publications) {
    if (selectedChannels.has(publication.channelId)) continue;
    selectedChannels.add(publication.channelId);

    if (publication.attempts.length >= maxAttempts) {
      await prisma.publication.update({
        where: { id: publication.id },
        data: { status: "PUBLICATION_FAILED" },
      });
      metrics.failed += 1;
      continue;
    }

    await prisma.publication.update({
      where: { id: publication.id },
      data: { status: "SCHEDULED", scheduledAt: now },
    });
    metrics.retried += 1;
  }

  return metrics;
}

export async function expireInvalidOffers(now = new Date()) {
  const result = await prisma.offer.updateMany({
    where: {
      status: { in: ["READY_TO_PUBLISH", "SCHEDULED"] },
      couponExpiration: { lte: now },
    },
    data: {
      status: "REJECTED_EXPIRED",
      statusReason: "Coupon is expired.",
    },
  });
  const metrics = emptyMetrics();
  metrics.expired = result.count;
  return metrics;
}

type WorkerStageName =
  | "expire"
  | "discovery"
  | "affiliate-links"
  | "refresh"
  | "schedule"
  | "retry"
  | "publish";

type WorkerStageStatus = "SUCCEEDED" | "SKIPPED" | "PARTIAL" | "FAILED";

type WorkerStageDiagnostic = {
  status: WorkerStageStatus;
  durationMs: number;
  errorCode: string | null;
};

type WorkerStageClassification = {
  status: WorkerStageStatus;
  errorCode?: string;
  errorMessage?: string;
};

type WorkerStageIssue = {
  stage: WorkerStageName;
  status: "PARTIAL" | "FAILED";
  errorCode: string;
  errorMessage: string;
};

type MercadoLivreDiscoveryCycleResult = Awaited<
  ReturnType<typeof collectMercadoLivreCandidates>
>;
type MercadoLivreAffiliateCycleResult = Awaited<
  ReturnType<typeof processAffiliateLinkJobs>
>;
type MercadoLivreRefreshCycleMetrics = Awaited<
  ReturnType<typeof refreshMercadoLivreOffers>
>;

export type WorkerCycleMetrics = JobMetrics & {
  stages: Partial<Record<WorkerStageName, WorkerStageDiagnostic>>;
  discovery: MercadoLivreDiscoveryCycleResult | null;
  affiliateLinks: MercadoLivreAffiliateCycleResult | null;
  refresh: MercadoLivreRefreshCycleMetrics | null;
};

type WorkerCycleDependencies = {
  expireInvalidOffers: typeof expireInvalidOffers;
  collectMercadoLivreCandidates: typeof collectMercadoLivreCandidates;
  processAffiliateLinkJobs: typeof processAffiliateLinkJobs;
  refreshMercadoLivreOffers: typeof refreshMercadoLivreOffers;
  scheduleReadyOffers: typeof scheduleReadyOffers;
  retryFailedPublications: typeof retryFailedPublications;
  publishScheduledOffers: typeof publishScheduledOffers;
};

function emptyWorkerCycleMetrics(): WorkerCycleMetrics {
  return {
    ...emptyMetrics(),
    stages: {},
    discovery: null,
    affiliateLinks: null,
    refresh: null,
  };
}

function sanitizedWorkerError(error: unknown) {
  return sanitizeMercadoLivreAffiliateError(error).slice(0, 500);
}

function sanitizedWorkerCode(value: unknown, fallback: string) {
  if (typeof value !== "string" && typeof value !== "number") {
    return fallback;
  }

  return sanitizeMercadoLivreAffiliateError(String(value))
    .replace(/\s+/g, "_")
    .slice(0, 100);
}

function pendingAffiliateBatchLimit() {
  const parsed = Number(process.env.AFFILIATE_LINK_JOB_INLINE_LIMIT ?? 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return 25;
  }

  return Math.min(100, Math.floor(parsed));
}

async function recordWorkerStageIssue(runId: string, issue: WorkerStageIssue) {
  await prisma.systemAlert
    .create({
      data: {
        severity: issue.status === "FAILED" ? "ERROR" : "WARNING",
        source: `worker.${issue.stage}`,
        message: `Worker stage ${issue.stage} completed as ${issue.status}.`,
        metadata: {
          runId,
          stage: issue.stage,
          status: issue.status,
          errorCode: issue.errorCode,
        },
      },
    })
    .catch(() => undefined);
}

export async function runWorkerCycle(
  now = new Date(),
  dependencyOverrides: Partial<WorkerCycleDependencies> = {},
) {
  const startedAt = new Date();
  const metrics = emptyWorkerCycleMetrics();
  const issues: WorkerStageIssue[] = [];
  const dependencies: WorkerCycleDependencies = {
    expireInvalidOffers,
    collectMercadoLivreCandidates,
    processAffiliateLinkJobs,
    refreshMercadoLivreOffers,
    scheduleReadyOffers,
    retryFailedPublications,
    publishScheduledOffers,
    ...dependencyOverrides,
  };
  const idempotencyKey = `worker-cycle:${startedAt.toISOString()}:${process.pid}`;
  const run = await prisma.automationRun.create({
    data: {
      name: "phase-2b-worker-cycle",
      status: "RUNNING",
      idempotencyKey,
      startedAt,
    },
  });

  async function runStage<T>(
    stage: WorkerStageName,
    operation: () => Promise<T>,
    classify: (result: T) => WorkerStageClassification = () => ({
      status: "SUCCEEDED",
    }),
  ) {
    const stageStartedAt = Date.now();

    try {
      const result = await operation();
      const classification = classify(result);
      const durationMs = Math.max(0, Date.now() - stageStartedAt);
      metrics.stages[stage] = {
        status: classification.status,
        durationMs,
        errorCode: classification.errorCode ?? null,
      };

      if (
        classification.status === "PARTIAL" ||
        classification.status === "FAILED"
      ) {
        const issue: WorkerStageIssue = {
          stage,
          status: classification.status,
          errorCode: sanitizedWorkerCode(
            classification.errorCode,
            `${stage.toUpperCase()}_${classification.status}`,
          ),
          errorMessage: sanitizedWorkerError(
            classification.errorMessage ??
              `Worker stage ${stage} completed as ${classification.status}.`,
          ),
        };
        issues.push(issue);
        await recordWorkerStageIssue(run.id, issue);
      }

      return result;
    } catch (error) {
      const durationMs = Math.max(0, Date.now() - stageStartedAt);
      const issue: WorkerStageIssue = {
        stage,
        status: "FAILED",
        errorCode: `${stage.toUpperCase()}_FAILED`,
        errorMessage: sanitizedWorkerError(error),
      };
      metrics.stages[stage] = {
        status: "FAILED",
        durationMs,
        errorCode: issue.errorCode,
      };
      issues.push(issue);
      await recordWorkerStageIssue(run.id, issue);
      return null;
    }
  }

  const expired = await runStage("expire", () =>
    dependencies.expireInvalidOffers(now),
  );
  if (expired) mergeMetrics(metrics, expired);

  const discovery = await runStage(
    "discovery",
    () => dependencies.collectMercadoLivreCandidates(now),
    (result) => {
      if (result.status === "FAILED") {
        return {
          status: "FAILED",
          errorCode: result.errorCode ?? "MELI_DISCOVERY_FAILED",
          errorMessage:
            result.errorMessage ?? "Mercado Livre discovery failed.",
        };
      }

      if (result.status === "PARTIAL") {
        return {
          status: "PARTIAL",
          errorCode: result.errorCode ?? "MELI_DISCOVERY_PARTIAL",
          errorMessage:
            result.errorMessage ??
            "Mercado Livre discovery completed with isolated item failures.",
        };
      }

      return {
        status: result.status === "SKIPPED" ? "SKIPPED" : "SUCCEEDED",
      };
    },
  );
  if (discovery) {
    metrics.discovery = discovery;
  }

  const affiliateLinks = await runStage(
    "affiliate-links",
    () =>
      dependencies.processAffiliateLinkJobs({
        limit: pendingAffiliateBatchLimit(),
      }),
    (result) => {
      if (result.failed > 0) {
        return {
          status: "PARTIAL",
          errorCode: "AFFILIATE_LINK_JOBS_PARTIAL",
          errorMessage: `${result.failed} affiliate link job(s) completed with errors.`,
        };
      }

      return { status: "SUCCEEDED" };
    },
  );
  if (affiliateLinks) {
    metrics.affiliateLinks = affiliateLinks;
  }

  const refresh = await runStage(
    "refresh",
    () => dependencies.refreshMercadoLivreOffers(now),
    (result) =>
      result.failed > 0
        ? {
            status: "PARTIAL",
            errorCode: "MELI_REFRESH_PARTIAL",
            errorMessage: `Mercado Livre refresh completed with ${result.failed} isolated failure(s).`,
          }
        : { status: "SUCCEEDED" },
  );
  if (refresh) metrics.refresh = refresh;

  const scheduled = await runStage("schedule", () =>
    dependencies.scheduleReadyOffers(now, {
      planningRunId: run.id,
      ...(discovery?.selectedOfferIds
        ? { preferredOfferIds: discovery.selectedOfferIds }
        : {}),
    }),
  );
  if (scheduled) {
    mergeMetrics(metrics, scheduled);
    if (discovery?.importJobId) {
      const skippedByChannelPolicy = Object.values(
        scheduled.skipReasons ?? {},
      ).reduce((total, count) => total + count, 0);
      await prisma.importJob
        ?.update({
          where: { id: discovery.importJobId },
          data: {
            summary: {
              ...discovery.metrics,
              scheduled: scheduled.scheduled,
              skippedByChannelPolicy,
            },
          },
        })
        .catch(() => undefined);
    }
  }

  const retried = await runStage(
    "retry",
    () => dependencies.retryFailedPublications(now),
    (result) =>
      result.failed > 0
        ? {
            status: "PARTIAL",
            errorCode: "PUBLICATION_RETRY_PARTIAL",
            errorMessage: `${result.failed} publication(s) exhausted their retry limit.`,
          }
        : { status: "SUCCEEDED" },
  );
  if (retried) mergeMetrics(metrics, retried);

  const published = await runStage(
    "publish",
    () => dependencies.publishScheduledOffers(now),
    (result) =>
      result.failed > 0
        ? {
            status: "PARTIAL",
            errorCode: "PUBLICATION_PARTIAL",
            errorMessage: `${result.failed} publication attempt(s) failed.`,
          }
        : { status: "SUCCEEDED" },
  );
  if (published) mergeMetrics(metrics, published);

  metrics.planningDecisions = compactPlanningDecisions(
    metrics.planningDecisions,
  );

  console.info(
    JSON.stringify({
      event: "publication_planning_completed",
      planningRunId: run.id,
      offersSelected: metrics.offersSelected,
      publicationsPlanned: metrics.publicationsPlanned,
      publicationsCreated: metrics.publicationsCreated,
      publicationsAlreadyExisting: metrics.publicationsAlreadyExisting,
      publicationsExecuted: metrics.publicationsExecuted,
      publicationsDeferred: metrics.publicationsDeferred,
      publicationsFailed: metrics.publicationsFailed,
      decisions: metrics.planningDecisions,
    }),
  );

  const errorMessage =
    issues.length > 0
      ? issues
          .map(
            (issue) =>
              `${issue.stage} (${issue.errorCode}): ${issue.errorMessage}`,
          )
          .join(" | ")
          .slice(0, 2_000)
      : null;
  const stageStatuses = Object.values(metrics.stages);
  const failedStageCount = stageStatuses.filter(
    (stage) => stage?.status === "FAILED",
  ).length;
  const finalStatus =
    stageStatuses.length > 0 && failedStageCount === stageStatuses.length
      ? "FAILED"
      : issues.length > 0
        ? "PARTIAL"
        : "SUCCEEDED";

  await prisma.automationRun.update({
    where: { id: run.id },
    data: {
      status: finalStatus,
      finishedAt: new Date(),
      metrics: metrics as unknown as Prisma.InputJsonValue,
      errorMessage,
    },
  });

  return metrics;
}

let loopStarted = false;

type AcquireWorkerLock = (key: string, ttlMs: number) => Promise<LockHandle>;

function withWorkerComponentOutcome(
  result: unknown,
  workerComponentOutcome: WorkerComponentOutcome,
) {
  return result && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), workerComponentOutcome }
    : { result, workerComponentOutcome };
}

async function recordContinuousWorkerLockOutcome(
  component: WorkerComponent,
  at: Date,
  outcome: WorkerComponentOutcome,
) {
  if (outcome.status === "SUCCEEDED") return;

  const failed = outcome.status === "FAILED";
  await prisma.automationRun
    .create({
      data: {
        name: `worker-${component}-lock`,
        status: failed ? "FAILED" : "SUCCEEDED",
        idempotencyKey: `worker-lock:${component}:${at.toISOString()}:${process.pid}`,
        startedAt: at,
        finishedAt: new Date(),
        metrics: {
          component,
          status: outcome.status,
          errorCode: failed
            ? "WORKER_COMPONENT_FAILED"
            : "WORKER_COMPONENT_SKIPPED",
          rootCause: outcome.rootCause ?? null,
          lockBackend: outcome.lockBackend,
        },
        errorMessage: failed
          ? "Protected workload did not run because the lock backend was unavailable."
          : null,
      },
    })
    .catch(() => undefined);
}

export function createLockedWorkerDependencies(
  dependencies: ContinuousWorkerDependencies,
  cadences: WorkerCadences,
  options: {
    acquireLock?: AcquireWorkerLock;
    requireRedis?: boolean;
    recordOutcome?: (
      component: WorkerComponent,
      at: Date,
      outcome: WorkerComponentOutcome,
    ) => Promise<void>;
  } = {},
): ContinuousWorkerDependencies {
  const acquire = options.acquireLock ?? acquireLock;
  const requireRedis =
    options.requireRedis ?? process.env.WORKER_REQUIRE_REDIS === "true";
  const recordOutcome =
    options.recordOutcome ?? recordContinuousWorkerLockOutcome;
  const components: WorkerComponent[] = [
    "discovery",
    "publication",
    "retry",
    "maintenance",
  ];

  return Object.fromEntries(
    components.map((component) => [
      component,
      async (now: Date) => {
        let lock: LockHandle;

        try {
          lock = await acquire(
            `worker:continuous:${component}`,
            Math.max(60_000, cadences[component]),
          );
        } catch {
          if (!requireRedis) {
            const result = await dependencies[component](now);
            return withWorkerComponentOutcome(result, {
              status: "SUCCEEDED",
              lockBackend: "UNAVAILABLE",
              rootCause: "REDIS_UNAVAILABLE",
            });
          }

          const outcome: WorkerComponentOutcome = {
            status: "FAILED",
            lockBackend: "UNAVAILABLE",
            rootCause: "REDIS_UNAVAILABLE",
          };
          await recordOutcome(component, now, outcome);
          return withWorkerComponentOutcome(null, outcome);
        }

        if (!lock.acquired) {
          const redisUnavailable =
            lock.failureReason === "REDIS_UNAVAILABLE" ||
            lock.mode === "unavailable";
          const outcome: WorkerComponentOutcome = redisUnavailable
            ? {
                status: "FAILED",
                lockBackend: "UNAVAILABLE",
                rootCause: "REDIS_UNAVAILABLE",
              }
            : {
                status: "SKIPPED",
                lockBackend: "AVAILABLE",
                rootCause: "LOCK_ALREADY_HELD",
              };
          await recordOutcome(component, now, outcome);
          return withWorkerComponentOutcome(null, outcome);
        }

        let result: unknown;
        try {
          result = await dependencies[component](now);
        } catch (error) {
          await lock.release().catch(() => undefined);
          throw error;
        }
        let outcome: WorkerComponentOutcome = {
          status: "SUCCEEDED",
          lockBackend:
            lock.failureReason === "REDIS_UNAVAILABLE"
              ? "UNAVAILABLE"
              : "AVAILABLE",
          ...(lock.failureReason === "REDIS_UNAVAILABLE"
            ? { rootCause: "REDIS_UNAVAILABLE" as const }
            : {}),
        };

        try {
          await lock.release();
        } catch {
          outcome = requireRedis
            ? {
                status: "FAILED",
                lockBackend: "UNAVAILABLE",
                rootCause: "REDIS_UNAVAILABLE",
              }
            : {
                status: "SUCCEEDED",
                lockBackend: "UNAVAILABLE",
                rootCause: "REDIS_UNAVAILABLE",
              };
          await recordOutcome(component, now, outcome);
        }

        return withWorkerComponentOutcome(result, outcome);
      },
    ]),
  ) as ContinuousWorkerDependencies;
}

export async function startWorker(
  options: {
    once?: boolean;
    cadences?: WorkerCadences;
    heartbeatIntervalMs?: number;
    signal?: AbortSignal;
    dependencies?: ContinuousWorkerDependencies;
  } = {},
) {
  if (process.env.WORKER_BURN_IN_MODE === "true") {
    throw new Error("BURN_IN_REQUIRES_ISOLATED_WORKER_ENTRYPOINT");
  }
  if (loopStarted) {
    throw new Error("Worker loop already started in this process.");
  }

  if (options.once) {
    return runWorkerCycle();
  }

  loopStarted = true;
  const shutdownController = new AbortController();
  const stop = () => {
    shutdownController.abort();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const componentStopFile = process.env.AFFILIATE_COMPONENT_STOP_FILE;
  const componentStopMonitor = componentStopFile
    ? setInterval(() => {
        if (existsSync(componentStopFile)) stop();
      }, 250)
    : null;
  componentStopMonitor?.unref();

  if (options.signal) {
    options.signal.addEventListener("abort", stop, { once: true });
  }

  const independently = async (operations: Array<() => Promise<unknown>>) => {
    const failures: unknown[] = [];
    const results: unknown[] = [];
    for (const operation of operations) {
      try {
        results.push(await operation());
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new Error("One or more worker component operations failed.");
    }
    return results;
  };

  const rawDependencies: ContinuousWorkerDependencies =
    options.dependencies ?? {
      discovery: async (now) => {
        const [discovery, , refresh] = (await independently([
          () => collectMercadoLivreCandidates(now),
          () =>
            processAffiliateLinkJobs({
              limit: pendingAffiliateBatchLimit(),
            }),
          () => refreshMercadoLivreOffers(now),
        ])) as [
          MercadoLivreDiscoveryCycleResult,
          MercadoLivreAffiliateCycleResult,
          MercadoLivreRefreshCycleMetrics,
        ];
        return {
          discoveryStatus: discovery.status,
          operationalMetrics: {
            offersDiscovered: discovery.metrics.candidatesFound,
            offersUpdated:
              discovery.metrics.updatedOffers +
              discovery.metrics.newOfferVersions +
              refresh.newVersions,
            affiliateLinksGenerated: discovery.metrics.affiliateLinksGenerated,
            affiliateLinksReused: discovery.metrics.affiliateLinksReused,
          },
        };
      },
      publication: async (now) => {
        const [scheduled, published] = (await independently([
          () => scheduleReadyOffers(now),
          () => publishScheduledOffers(now),
        ])) as [JobMetrics, JobMetrics];
        return {
          operationalMetrics: {
            offersEvaluated: scheduled.readyOffersFound,
            offersScheduled: scheduled.scheduled,
            offersSkipped: scheduled.skipped,
            publicationsAttempted:
              published.published + published.exported + published.failed,
            publicationsSucceeded: published.published,
            publicationsFailed: published.failed,
            aiGenerated: scheduled.aiGenerated,
            aiFallbackUsed: scheduled.aiFallbackUsed,
            whatsappGroupAssistedPrepared:
              scheduled.whatsappGroupAssistedPrepared,
            whatsappGroupAssistedConfirmed: 0,
            whatsappGroupAssistedSkipped:
              scheduled.whatsappGroupAssistedSkipped,
            whatsappGroupAssistedFailed: scheduled.whatsappGroupAssistedFailed,
            whatsappWebDryRuns: published.whatsappWebDryRuns,
            whatsappWebAttempts: published.whatsappWebAttempts,
            whatsappWebPublished: published.whatsappWebPublished,
            whatsappWebFailed: published.whatsappWebFailed,
            whatsappWebDeliveryUncertain:
              published.whatsappWebDeliveryUncertain,
            whatsappWebLoginRequired: published.whatsappWebLoginRequired,
            whatsappWebSelectorMismatch: published.whatsappWebSelectorMismatch,
            whatsappWebMediaFallback: published.whatsappWebMediaFallback,
          },
        };
      },
      retry: async (now) => {
        const result = await retryFailedPublications(now);
        return {
          operationalMetrics: {
            publicationsRetried: result.retried,
          },
        };
      },
      maintenance: (now) => expireInvalidOffers(now),
    };
  const cadences = options.cadences ?? getWorkerCadences();
  const dependencies = createLockedWorkerDependencies(
    rawDependencies,
    cadences,
  );

  try {
    return await runWithWorkerLeadership({
      signal: shutdownController.signal,
      run: (leadershipSignal, instanceId) =>
        runContinuousWorker({
          dependencies,
          signal: leadershipSignal,
          cadences,
          instanceId,
          ...(options.heartbeatIntervalMs
            ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
            : {}),
        }),
    });
  } finally {
    if (componentStopMonitor) clearInterval(componentStopMonitor);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await prisma.$disconnect();
  }
}

if (process.env.NODE_ENV !== "test") {
  const once = process.argv.includes("--once");

  startWorker({ once })
    .then((result) => {
      if (
        !once &&
        result &&
        typeof result === "object" &&
        "status" in result &&
        result.status !== "COMPLETED"
      ) {
        console.error(
          JSON.stringify({
            event: "worker_leadership_unavailable",
            component: "worker",
            level: "error",
            errorCode: result.status,
          }),
        );
        process.exitCode = 2;
      }
    })
    .catch(() => {
      console.error(
        JSON.stringify({
          event: "worker_failed",
          stage: "WORKER_LOOP",
          status: "FAILED",
          errorCode: "WORKER_FAILED",
        }),
      );
      process.exit(1);
    });
}
