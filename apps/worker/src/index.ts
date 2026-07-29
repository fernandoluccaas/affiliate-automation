import {
  canScheduleInWindow,
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

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

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

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
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

async function channelDailyCount(channelId: string, now: Date) {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);

  return prisma.publication.count({
    where: {
      channelId,
      scheduledAt: { gte: today, lt: tomorrow },
      status: { notIn: ["CANCELLED", "PUBLICATION_FAILED", "FAILED"] },
    },
  });
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
      orderBy: { collectedAt: "asc" },
      take: 50,
      include: { affiliateLinks: true },
    }),
    prisma.channel.findMany({ orderBy: { createdAt: "asc" } }),
  ]);
  metrics.readyOffersFound = offers.length;

  for (const offer of offers) {
    let offerScheduled = false;

    for (const channel of channels) {
      if (offerScheduled) {
        break;
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
        continue;
      }

      const publisher = publisherForChannel(channel);

      if (!publisher) {
        recordSkip(metrics, "PUBLISHER_UNAVAILABLE");
        continue;
      }

      const [publicationsToday, lastPublication, productPublication] =
        await Promise.all([
          channelDailyCount(channel.id, now),
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
        const created = await prisma.$transaction(async (tx) => {
          const publication = await createPublicationIdempotently(
            tx,
            offer,
            channel,
            payload,
            now,
          );
          await tx.offer.update({
            where: { id: offer.id },
            data: { status: "SCHEDULED", scheduledAt: now },
          });
          return publication;
        });

        if (created.createdAt.getTime() === created.updatedAt.getTime()) {
          metrics.scheduled += 1;
          offerScheduled = true;
        } else {
          recordSkip(metrics, "DUPLICATE_PUBLICATION");
        }
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

  const definitiveFailure = attemptNumber >= maxAttempts;
  await prisma.publication.update({
    where: { id: publication.id },
    data: {
      status: definitiveFailure ? "PUBLICATION_FAILED" : "FAILED",
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

export async function publishScheduledOffers(now = new Date()) {
  const metrics = emptyMetrics();
  const maxAttempts = Number(
    process.env.WORKER_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS,
  );
  const publications = await prisma.publication.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lte: now },
    },
    take: 25,
    orderBy: { scheduledAt: "asc" },
    include: {
      channel: true,
      offer: { include: { affiliateLinks: true } },
      attempts: { select: { id: true } },
    },
  });

  for (const publication of publications) {
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
    where: { status: "FAILED" },
    include: { attempts: { select: { id: true } } },
  });

  for (const publication of publications) {
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
  options: { once?: boolean; pollIntervalMs?: number } = {},
) {
  if (loopStarted) {
    throw new Error("Worker loop already started in this process.");
  }

  if (options.once) {
    return runWorkerCycle();
  }

  loopStarted = true;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopping = false;

  const stop = async () => {
    stopping = true;
    await prisma.$disconnect();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    await runWorkerCycle();
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return emptyMetrics();
}

if (process.env.NODE_ENV !== "test") {
  const once = process.argv.includes("--once");
  const pollIntervalMs = Number(
    process.env.WORKER_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS,
  );

  startWorker({ once, pollIntervalMs }).catch(() => {
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
