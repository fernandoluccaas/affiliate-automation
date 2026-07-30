import {
  canScheduleInWindow,
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
  ManualExportPublisher,
  TelegramPublisher,
  type PublicationPayload,
  type PublisherAdapter,
  type PublisherResult,
} from "@affiliate/publisher-connectors";
import { acquireLock } from "@affiliate/redis";
import {
  prisma,
  type Channel,
  type Offer,
  type Prisma,
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
  type WorkerCadences,
  type WorkerComponent,
} from "./runtime";

const DEFAULT_MAX_ATTEMPTS = 4;
const PUBLICATION_RETRY_MINUTES = [1, 5, 15, 30] as const;

type JobMetrics = {
  readyOffersFound: number;
  scheduled: number;
  published: number;
  exported: number;
  failed: number;
  retried: number;
  expired: number;
  skipped: number;
  skipReasons: Record<string, number>;
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
    readyOffersFound: 0,
    scheduled: 0,
    published: 0,
    exported: 0,
    failed: 0,
    retried: 0,
    expired: 0,
    skipped: 0,
    skipReasons: {},
  };
}

function mergeMetrics(target: JobMetrics, source: JobMetrics) {
  const numericKeys: Array<Exclude<keyof JobMetrics, "skipReasons">> = [
    "readyOffersFound",
    "scheduled",
    "published",
    "exported",
    "failed",
    "retried",
    "expired",
    "skipped",
  ];

  for (const key of numericKeys) {
    target[key] += source[key];
  }

  for (const [reason, count] of Object.entries(source.skipReasons)) {
    target.skipReasons[reason] = (target.skipReasons[reason] ?? 0) + count;
  }
}

type WorkerSkipReason =
  | PolicyFailureCode
  | "PUBLISHER_UNAVAILABLE"
  | "OFFER_MISSING_AFFILIATE_LINK"
  | "LOCK_NOT_ACQUIRED"
  | "DUPLICATE_PUBLICATION";

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

  return {
    offerId: offer.id,
    channelId: channel.id,
    trackingUrl: publicationUrl.url,
    message: generated.message,
    imageUrl: offer.imageUrl,
    messageSource: generated.source,
    aiProvider: generated.aiProvider,
    aiModel: generated.aiModel,
    aiGenerationDurationMs: generated.aiGenerationDurationMs,
    aiValidationPassed: generated.aiValidationPassed,
    aiValidationReasons: generated.aiValidationReasons,
    generatedAt: generated.generatedAt.toISOString(),
  };
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
      status: { in: ["PUBLISHED", "EXPORTED", "SCHEDULED"] },
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
      status: { in: ["PUBLISHED", "EXPORTED", "SCHEDULED"] },
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
      status: { in: ["PUBLISHED", "EXPORTED", "SCHEDULED"] },
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
) {
  const idempotencyKey = `publication:${channel.id}:${offer.id}`;

  return tx.publication.upsert({
    where: { idempotencyKey },
    update: {},
    create: {
      offerId: offer.id,
      channelId: channel.id,
      status: "SCHEDULED",
      idempotencyKey,
      scheduledAt: now,
      messagePayload: payload,
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

export async function scheduleReadyOffers(now = new Date()) {
  const metrics = emptyMetrics();
  const [offers, channels] = await Promise.all([
    prisma.offer.findMany({
      where: { status: "READY_TO_PUBLISH" },
      take: 50,
      include: { affiliateLinks: true },
    }),
    prisma.channel.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  metrics.readyOffersFound = offers.length;
  const prioritizedOffers = [...offers].sort(compareReadyOfferPriority);
  const scheduledChannelIds = new Set<string>();

  for (const offer of prioritizedOffers) {
    for (const channel of channels) {
      if (scheduledChannelIds.has(channel.id)) continue;

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
        continue;
      }

      const publisher = publisherForChannel(channel);

      if (!publisher) {
        recordSkip(metrics, "PUBLISHER_UNAVAILABLE");
        continue;
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
          lastPublication?.publishedAt ?? lastPublication?.scheduledAt ?? null,
        lastProductPublicationAt:
          productPublication?.publishedAt ??
          productPublication?.scheduledAt ??
          null,
      });

      if (!windowResult.ok) {
        recordSkip(metrics, windowResult.code);
        continue;
      }

      const idempotencyKey = `publication:${channel.id}:${offer.id}`;
      const existingPublication = await prisma.publication.findFirst({
        where: { idempotencyKey },
        select: { id: true },
      });
      if (existingPublication) {
        recordSkip(metrics, "DUPLICATE_PUBLICATION");
        continue;
      }

      const payload = await messagePayloadFor(offer, channel);

      if (!payload) {
        recordSkip(metrics, "OFFER_MISSING_AFFILIATE_LINK");
        continue;
      }

      const lock = await acquireLock(
        `publication:${channel.id}:${offer.id}`,
        60_000,
      );

      if (!lock.acquired) {
        recordSkip(metrics, "LOCK_NOT_ACQUIRED");
        continue;
      }

      try {
        await prisma.$transaction(async (tx) => {
          await createPublicationIdempotently(tx, offer, channel, payload, now);
          await tx.offer.update({
            where: { id: offer.id },
            data: { status: "SCHEDULED", scheduledAt: now },
          });
        });
        metrics.scheduled += 1;
        scheduledChannelIds.add(channel.id);
      } finally {
        await lock.release();
      }
    }
  }

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
  const backoffMs =
    (PUBLICATION_RETRY_MINUTES[position] ?? 30) * 60_000;
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
  const selectedChannelIds = new Set<string>();
  const selectedPublications = publications.filter((publication) => {
    if (selectedChannelIds.has(publication.channelId)) return false;
    selectedChannelIds.add(publication.channelId);
    return true;
  });

  for (const publication of selectedPublications) {
    const payload = await payloadFromPublication(publication);
    const publisher = publisherForChannel(publication.channel);

    if (!payload || !publisher) {
      metrics.failed += 1;
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
    }
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
    dependencies.scheduleReadyOffers(now),
  );
  if (scheduled) mergeMetrics(metrics, scheduled);

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

export async function startWorker(
  options: {
    once?: boolean;
    cadences?: WorkerCadences;
    heartbeatIntervalMs?: number;
    signal?: AbortSignal;
    dependencies?: ContinuousWorkerDependencies;
  } = {},
) {
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

  if (options.signal) {
    options.signal.addEventListener("abort", stop, { once: true });
  }

  const independently = async (operations: Array<() => Promise<unknown>>) => {
    const failures: unknown[] = [];
    for (const operation of operations) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new Error("One or more worker component operations failed.");
    }
  };

  const rawDependencies: ContinuousWorkerDependencies =
    options.dependencies ?? {
      discovery: (now) =>
        independently([
          () => collectMercadoLivreCandidates(now),
          () =>
            processAffiliateLinkJobs({
              limit: pendingAffiliateBatchLimit(),
            }),
          () => refreshMercadoLivreOffers(now),
        ]),
      publication: (now) =>
        independently([
          () => scheduleReadyOffers(now),
          () => publishScheduledOffers(now),
        ]),
      retry: (now) => retryFailedPublications(now),
      maintenance: (now) => expireInvalidOffers(now),
    };
  const cadences = options.cadences ?? getWorkerCadences();
  const components: WorkerComponent[] = [
    "discovery",
    "publication",
    "retry",
    "maintenance",
  ];
  const dependencies = Object.fromEntries(
    components.map((component) => [
      component,
      async (now: Date) => {
        const lock = await acquireLock(
          `worker:continuous:${component}`,
          Math.max(60_000, cadences[component]),
        );
        if (!lock.acquired) {
          if (
            lock.mode === "unavailable" &&
            process.env.WORKER_REQUIRE_REDIS === "true"
          ) {
            throw new Error("Required Redis lock is unavailable.");
          }
          return { skipped: true, reason: "LOCK_NOT_ACQUIRED" };
        }

        try {
          return await rawDependencies[component](now);
        } finally {
          await lock.release();
        }
      },
    ]),
  ) as ContinuousWorkerDependencies;

  try {
    return await runContinuousWorker({
      dependencies,
      signal: shutdownController.signal,
      cadences,
      ...(options.heartbeatIntervalMs
        ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
        : {}),
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await prisma.$disconnect();
  }
}

if (process.env.NODE_ENV !== "test") {
  const once = process.argv.includes("--once");

  startWorker({ once }).catch(() => {
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
