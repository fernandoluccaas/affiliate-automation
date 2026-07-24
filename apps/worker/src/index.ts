import {
  canScheduleInWindow,
  isOfferCompatibleWithChannel,
  type ChannelPolicy,
} from "@affiliate/publication";
import { generateMessageForOffer, type MessageGenerationResult } from "@affiliate/ai-copywriter";
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

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

type JobMetrics = {
  scheduled: number;
  published: number;
  exported: number;
  failed: number;
  retried: number;
  expired: number;
  skipped: number;
};

type OfferWithLinks = Offer & {
  affiliateLinks: Array<{ id: string; slug: string; destination: string; active: boolean }>;
};

type PublicationWithRelations = Publication & {
  offer: OfferWithLinks;
  channel: Channel;
  attempts: Array<{ id: string }>;
};

type GeneratedPublicationPayload = PublicationPayload & {
  messageSource: MessageGenerationResult["source"];
  aiModel?: string | undefined;
  aiGenerationDurationMs?: number | undefined;
  aiValidationPassed: boolean;
  aiValidationReasons: string[];
  generatedAt: string;
};

function emptyMetrics(): JobMetrics {
  return {
    scheduled: 0,
    published: 0,
    exported: 0,
    failed: 0,
    retried: 0,
    expired: 0,
    skipped: 0,
  };
}

function mergeMetrics(target: JobMetrics, source: JobMetrics) {
  for (const key of Object.keys(target) as Array<keyof JobMetrics>) {
    target[key] += source[key];
  }
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
    minimumDiscountPercentage: channel.minDiscountPercentage?.toString() ?? null,
    productRepeatIntervalDays: channel.productRepeatIntervalDays,
    allowedMarketplaces: asStringArray(channel.allowedMarketplaces),
    allowedCategories: asStringArray(channel.allowedCategories),
  };
}

function getBaseUrl() {
  return (process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
}

function trackingUrlForSlug(slug: string) {
  return `${getBaseUrl()}/go/${encodeURIComponent(slug)}`;
}

async function messagePayloadFor(
  offer: OfferWithLinks,
  channel: Channel,
): Promise<GeneratedPublicationPayload | null> {
  const link = offer.affiliateLinks.find((item) => item.active);

  if (!link) {
    return null;
  }

  const trackingUrl = trackingUrlForSlug(link.slug);
  const generated = await generateMessageForOffer({
    title: offer.title,
    marketplace: offer.marketplace,
    category: offer.category,
    originalPrice: offer.originalPrice.toString(),
    currentPrice: offer.currentPrice.toString(),
    discountPercentage: offer.discountPercentage.toString(),
    couponCode: offer.couponCode,
    couponExpiration: offer.couponExpiration,
    freeShipping: offer.freeShipping,
    rating: offer.rating?.toString() ?? null,
    salesCount: offer.salesCount,
    trackingUrl,
  });

  return {
    offerId: offer.id,
    channelId: channel.id,
    trackingUrl,
    message: generated.message,
    imageUrl: offer.imageUrl,
    messageSource: generated.source,
    aiModel: generated.aiModel,
    aiGenerationDurationMs: generated.aiGenerationDurationMs,
    aiValidationPassed: generated.aiValidationPassed,
    aiValidationReasons: generated.aiValidationReasons,
    generatedAt: generated.generatedAt.toISOString(),
  };
}

function getTelegramChatId(channel: Channel) {
  const configuration = channel.configuration;

  if (configuration && typeof configuration === "object" && !Array.isArray(configuration)) {
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

async function lastProductPublication(channelId: string, productId?: string | null) {
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
      aiModel: payload.aiModel ?? null,
      aiGenerationDurationMs: payload.aiGenerationDurationMs ?? null,
      aiValidationPassed: payload.aiValidationPassed,
      aiValidationReasons: payload.aiValidationReasons,
      generatedAt: new Date(payload.generatedAt),
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
    prisma.channel.findMany({
      where: { enabled: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  for (const offer of offers) {
    let offerScheduled = false;

    for (const channel of channels) {
      if (offerScheduled) {
        break;
      }

      const publisher = publisherForChannel(channel);

      if (!publisher) {
        metrics.skipped += 1;
        continue;
      }

      const policy = channelPolicy(channel);
      const compatibility = isOfferCompatibleWithChannel(
        {
          marketplace: offer.marketplace,
          category: offer.category,
          score: offer.score,
          discountPercentage: offer.discountPercentage.toString(),
        },
        policy,
      );

      if (!compatibility.ok) {
        metrics.skipped += 1;
        continue;
      }

      const [publicationsToday, lastPublication, productPublication] = await Promise.all([
        channelDailyCount(channel.id, now),
        lastChannelPublication(channel.id),
        lastProductPublication(channel.id, offer.productId),
      ]);
      const windowResult = canScheduleInWindow({
        channel: policy,
        now,
        publicationsToday,
        lastPublicationAt: lastPublication?.publishedAt ?? lastPublication?.scheduledAt ?? null,
        lastProductPublicationAt:
          productPublication?.publishedAt ?? productPublication?.scheduledAt ?? null,
      });

      if (!windowResult.ok) {
        metrics.skipped += 1;
        continue;
      }

      const payload = await messagePayloadFor(offer, channel);

      if (!payload) {
        metrics.skipped += 1;
        continue;
      }

      const lock = await acquireLock(`publication:${channel.id}:${offer.id}`, 60_000);

      if (!lock.acquired) {
        metrics.skipped += 1;
        continue;
      }

      try {
        const created = await prisma.$transaction(async (tx) => {
          const publication = await createPublicationIdempotently(tx, offer, channel, payload, now);
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
          metrics.skipped += 1;
        }
      } finally {
        await lock.release();
      }
    }
  }

  return metrics;
}

async function payloadFromPublication(publication: PublicationWithRelations): Promise<PublicationPayload | null> {
  const payload = publication.messagePayload;

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;

    if (typeof record.message === "string" && typeof record.trackingUrl === "string") {
      return {
        offerId: publication.offerId,
        channelId: publication.channelId,
        trackingUrl: record.trackingUrl,
        message: record.message,
        imageUrl: typeof record.imageUrl === "string" ? record.imageUrl : publication.offer.imageUrl,
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
    result.status === "PUBLISHED" ? "SUCCESS" : result.status === "EXPORTED" ? "EXPORTED" : "FAILED";

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
  const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);
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
        data: { status: "PUBLICATION_FAILED", errorMessage: "Publisher unavailable." },
      });
      continue;
    }

    const result = await publisher.publish(payload);
    const attemptNumber = publication.attempts.length + 1;
    await recordPublicationResult(publication, result, attemptNumber, maxAttempts);

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
  const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);
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

export async function runWorkerCycle(now = new Date()) {
  const startedAt = new Date();
  const metrics = emptyMetrics();
  const idempotencyKey = `worker-cycle:${startedAt.toISOString()}:${process.pid}`;
  const run = await prisma.automationRun.create({
    data: {
      name: "phase-2b-worker-cycle",
      status: "RUNNING",
      idempotencyKey,
      startedAt,
    },
  });

  try {
    mergeMetrics(metrics, await expireInvalidOffers(now));
    mergeMetrics(metrics, await scheduleReadyOffers(now));
    mergeMetrics(metrics, await retryFailedPublications(now));
    mergeMetrics(metrics, await publishScheduledOffers(now));

    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        metrics,
      },
    });

    return metrics;
  } catch (error) {
    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        metrics,
        errorMessage: error instanceof Error ? error.message : "Worker cycle failed.",
      },
    });
    throw error;
  }
}

let loopStarted = false;

export async function startWorker(options: { once?: boolean; pollIntervalMs?: number } = {}) {
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
  const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);

  startWorker({ once, pollIntervalMs }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Worker failed.");
    process.exit(1);
  });
}
