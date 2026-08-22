import { prisma, Prisma } from "@affiliate/database";
import { acquireLock, type LockHandle } from "@affiliate/redis";
import { resolveShopeeAffiliateConfiguration } from "./config";
import {
  runShopeeAutomatedDiscovery,
  type ShopeeAutomatedDiscoveryResult,
} from "./remote-discovery";
import { loadRecentShopeeItemIds } from "./operational";

export const SHOPEE_SCHEDULED_DISCOVERY_NAME =
  "shopee-scheduled-discovery" as const;
export const SHOPEE_SCHEDULED_DISCOVERY_LOCK_KEY =
  "shopee:remote-discovery" as const;
export const SHOPEE_SCHEDULED_DISCOVERY_LOCK_TTL_MS = 60 * 60_000;
export const SHOPEE_SCHEDULED_DISCOVERY_ABANDONED_ERROR =
  "SHOPEE_SCHEDULED_DISCOVERY_ABANDONED" as const;
export const SHOPEE_SCHEDULED_DISCOVERY_STALE_RECOVERY_FAILED =
  "SHOPEE_SCHEDULED_DISCOVERY_STALE_RECOVERY_FAILED" as const;
export const SHOPEE_SCHEDULED_DISCOVERY_STATE_CHANGED =
  "SHOPEE_SCHEDULED_DISCOVERY_STATE_CHANGED" as const;

type ScheduledRunStatus = "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";

export type ShopeeScheduledRunRecord = {
  id: string;
  status: ScheduledRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  metrics: unknown;
  errorMessage: string | null;
};

export interface ShopeeScheduledDiscoveryStore {
  findLatest(): Promise<ShopeeScheduledRunRecord | null>;
  start(input: {
    idempotencyKey: string;
    startedAt: Date;
  }): Promise<{ id: string }>;
  finish(input: {
    id: string;
    status: Exclude<ScheduledRunStatus, "RUNNING">;
    finishedAt: Date;
    metrics: Record<string, unknown>;
    errorCode: string | null;
  }): Promise<void>;
  finishAbandoned(input: {
    id: string;
    finishedAt: Date;
    metrics: Record<string, unknown>;
    errorCode: typeof SHOPEE_SCHEDULED_DISCOVERY_ABANDONED_ERROR;
  }): Promise<boolean>;
}

export type ShopeeScheduledDiscoveryMetrics = {
  durationMs: number;
  feedsProcessed: number;
  itemsReceived: number;
  selected: number;
  imported: number;
  linksGenerated: number;
  linksReused: number;
  failed: number;
  pendingAffiliateLink: number;
  readyToPublish: number;
  externalRequests: number;
  writes: number;
  publicationsCreated: 0;
  messagesSent: 0;
  complete: boolean;
  errorCode: string | null;
  abandonedRunsRecovered: number;
};

export type ShopeeScheduledDiscoveryStatus = {
  status: "SHOPEE_SCHEDULED_DISCOVERY_STATUS";
  automatedDiscoveryEnabled: boolean;
  autoRunReady: boolean;
  due: boolean;
  intervalHours: number;
  intervalMs: number;
  lastScheduledRunAt: string | null;
  nextScheduledRunAt: string | null;
  lastRunStatus: ScheduledRunStatus | null;
  lastRunStale: boolean;
  staleRunRecoveryAt: string | null;
  lastRunDurationMs: number | null;
  lastFeedsProcessed: number;
  lastItemsReceived: number;
  lastSelected: number;
  lastImported: number;
  lastLinksGenerated: number;
  lastLinksReused: number;
  lastFailed: number;
  lastPendingAffiliateLink: number;
  lastReadyToPublish: number;
  lastErrorCode: string | null;
  configuredReferenceIds: string[];
  configuredFeedIds: string[];
  pageSize: number;
  maxPages: number;
  maxItems: number;
  lockState: "CONFIGURED_NOT_PROBED" | "MISSING";
  externalRequests: 0;
  writes: 0;
  stateModified: false;
};

export type ShopeeScheduledDiscoveryTickResult = {
  status:
    | "DISABLED"
    | "NOT_READY"
    | "SKIPPED_NOT_DUE"
    | "SKIPPED_LOCKED"
    | "SUCCEEDED"
    | "PARTIAL"
    | "FAILED";
  autoRunReady: boolean;
  due: boolean;
  runId: string | null;
  nextScheduledRunAt: string | null;
  metrics: ShopeeScheduledDiscoveryMetrics;
  externalRequests: number;
  writes: number;
  publicationsCreated: 0;
  messagesSent: 0;
  stateModified: boolean;
  errorCode: string | null;
};

type AcquireScheduledLock = (
  key: string,
  ttlMs: number,
  options: { env: NodeJS.ProcessEnv; requireRedis: true },
) => Promise<LockHandle>;

export type ShopeeScheduledDiscoveryDependencies = {
  store?: ShopeeScheduledDiscoveryStore;
  acquireDiscoveryLock?: AcquireScheduledLock;
  runDiscovery?: typeof runShopeeAutomatedDiscovery;
  loadRecentItemIds?: typeof loadRecentShopeeItemIds;
  finishedAt?: () => Date;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function safeErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^SHOPEE_[A-Z0-9_]+$/.test(message)
    ? message
    : "SHOPEE_SCHEDULED_DISCOVERY_FAILED";
}

export function createPrismaShopeeScheduledDiscoveryStore(): ShopeeScheduledDiscoveryStore {
  return {
    async findLatest() {
      return prisma.automationRun.findFirst({
        where: { name: SHOPEE_SCHEDULED_DISCOVERY_NAME },
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          metrics: true,
          errorMessage: true,
        },
      });
    },
    async start(input) {
      return prisma.automationRun.create({
        data: {
          name: SHOPEE_SCHEDULED_DISCOVERY_NAME,
          status: "RUNNING",
          idempotencyKey: input.idempotencyKey,
          startedAt: input.startedAt,
          metrics: {
            publicationsCreated: 0,
            messagesSent: 0,
          },
        },
        select: { id: true },
      });
    },
    async finish(input) {
      await prisma.automationRun.update({
        where: { id: input.id },
        data: {
          status: input.status,
          finishedAt: input.finishedAt,
          metrics: input.metrics as Prisma.InputJsonValue,
          errorMessage: input.errorCode,
        },
      });
    },
    async finishAbandoned(input) {
      const result = await prisma.automationRun.updateMany({
        where: { id: input.id, status: "RUNNING" },
        data: {
          status: "FAILED",
          finishedAt: input.finishedAt,
          metrics: input.metrics as Prisma.InputJsonValue,
          errorMessage: input.errorCode,
        },
      });
      return result.count === 1;
    },
  };
}

export function calculateShopeeScheduledDiscoveryDue(input: {
  now: Date;
  intervalMs: number;
  lastRun: Pick<ShopeeScheduledRunRecord, "startedAt" | "status"> | null;
}) {
  if (input.lastRun?.status === "RUNNING") {
    const staleRunRecoveryAt = new Date(
      input.lastRun.startedAt.getTime() +
        SHOPEE_SCHEDULED_DISCOVERY_LOCK_TTL_MS,
    );
    const lastRunStale = input.now >= staleRunRecoveryAt;
    return {
      due: lastRunStale,
      nextRunAt: staleRunRecoveryAt,
      lastRunStale,
      staleRunRecoveryAt,
    };
  }
  const nextRunAt = input.lastRun
    ? new Date(input.lastRun.startedAt.getTime() + input.intervalMs)
    : null;
  return {
    due: !nextRunAt || input.now >= nextRunAt,
    nextRunAt,
    lastRunStale: false,
    staleRunRecoveryAt: null,
  };
}

function emptyMetrics(errorCode: string | null = null) {
  return {
    durationMs: 0,
    feedsProcessed: 0,
    itemsReceived: 0,
    selected: 0,
    imported: 0,
    linksGenerated: 0,
    linksReused: 0,
    failed: 0,
    pendingAffiliateLink: 0,
    readyToPublish: 0,
    externalRequests: 0,
    writes: 0,
    publicationsCreated: 0 as const,
    messagesSent: 0 as const,
    complete: false,
    errorCode,
    abandonedRunsRecovered: 0,
  } satisfies ShopeeScheduledDiscoveryMetrics;
}

function abandonedRunMetrics(input: { startedAt: Date; recoveredAt: Date }) {
  return {
    ...emptyMetrics(SHOPEE_SCHEDULED_DISCOVERY_ABANDONED_ERROR),
    durationMs: Math.max(
      0,
      input.recoveredAt.getTime() - input.startedAt.getTime(),
    ),
    failed: 1,
    writes: 1,
    abandonedRunsRecovered: 1,
    abandoned: true,
    recoveredAt: input.recoveredAt.toISOString(),
  };
}

function metricsFromDiscovery(
  result: ShopeeAutomatedDiscoveryResult,
): ShopeeScheduledDiscoveryMetrics {
  const imported = result.importResult?.metrics;
  const autoLink = result.importResult?.autoLinkResult;
  const linkFailures = autoLink?.failed ?? 0;
  return {
    durationMs: result.preview.durationMs,
    feedsProcessed: result.preview.feedsProcessed,
    itemsReceived: result.preview.itemsReceived,
    selected: result.preview.selected.length,
    imported: (imported?.created ?? 0) + (imported?.updated ?? 0),
    linksGenerated: imported?.linksGenerated ?? 0,
    linksReused: imported?.linksReused ?? 0,
    failed: (imported?.failed ?? 0) + linkFailures,
    pendingAffiliateLink: imported?.pendingAffiliateLink ?? 0,
    readyToPublish: imported?.readyToPublish ?? 0,
    externalRequests:
      result.externalRequests + (autoLink?.externalRequests ?? 0),
    writes: result.writes,
    publicationsCreated: 0,
    messagesSent: 0,
    complete: result.preview.complete,
    errorCode: result.errorCode,
    abandonedRunsRecovered: 0,
  };
}

function statusFromResult(
  result: ShopeeAutomatedDiscoveryResult,
  metrics: ShopeeScheduledDiscoveryMetrics,
): "SUCCEEDED" | "PARTIAL" | "FAILED" {
  if (result.status === "FAILED") return "FAILED";
  if (
    result.status === "PARTIAL" ||
    metrics.failed > 0 ||
    result.importResult?.autoLinkResult?.status === "SUCCEEDED_WITH_ERRORS"
  ) {
    return "PARTIAL";
  }
  return "SUCCEEDED";
}

export async function getShopeeScheduledDiscoveryStatus(
  input: {
    now?: Date;
    environment?: NodeJS.ProcessEnv;
    store?: ShopeeScheduledDiscoveryStore;
  } = {},
): Promise<ShopeeScheduledDiscoveryStatus> {
  const now = input.now ?? new Date();
  const configuration = resolveShopeeAffiliateConfiguration(
    input.environment ?? process.env,
  );
  const latest = await (
    input.store ?? createPrismaShopeeScheduledDiscoveryStore()
  ).findLatest();
  const due = calculateShopeeScheduledDiscoveryDue({
    now,
    intervalMs: configuration.automatedDiscoveryIntervalMs,
    lastRun: latest,
  });
  const metrics = asRecord(latest?.metrics);
  return {
    status: "SHOPEE_SCHEDULED_DISCOVERY_STATUS",
    automatedDiscoveryEnabled: configuration.automatedDiscoveryEnabled,
    autoRunReady: configuration.remoteDiscoveryAutoRunReady,
    due: configuration.remoteDiscoveryAutoRunReady && due.due,
    intervalHours: configuration.automatedDiscoveryIntervalHours,
    intervalMs: configuration.automatedDiscoveryIntervalMs,
    lastScheduledRunAt: latest?.startedAt.toISOString() ?? null,
    nextScheduledRunAt: due.nextRunAt?.toISOString() ?? null,
    lastRunStatus: latest?.status ?? null,
    lastRunStale: due.lastRunStale,
    staleRunRecoveryAt: due.staleRunRecoveryAt?.toISOString() ?? null,
    lastRunDurationMs:
      latest && typeof metrics.durationMs === "number"
        ? nonNegativeInteger(metrics.durationMs)
        : null,
    lastFeedsProcessed: nonNegativeInteger(metrics.feedsProcessed),
    lastItemsReceived: nonNegativeInteger(metrics.itemsReceived),
    lastSelected: nonNegativeInteger(metrics.selected),
    lastImported: nonNegativeInteger(metrics.imported),
    lastLinksGenerated: nonNegativeInteger(metrics.linksGenerated),
    lastLinksReused: nonNegativeInteger(metrics.linksReused),
    lastFailed: nonNegativeInteger(metrics.failed),
    lastPendingAffiliateLink: nonNegativeInteger(metrics.pendingAffiliateLink),
    lastReadyToPublish: nonNegativeInteger(metrics.readyToPublish),
    lastErrorCode:
      typeof metrics.errorCode === "string"
        ? metrics.errorCode
        : (latest?.errorMessage ?? null),
    configuredReferenceIds: configuration.remoteDiscoveryReferenceIds,
    configuredFeedIds: configuration.remoteDiscoveryFeedIds,
    pageSize: configuration.remoteDiscoveryPageSize,
    maxPages: configuration.remoteDiscoveryMaxPages,
    maxItems: configuration.remoteDiscoveryMaxItems,
    lockState: configuration.remoteDiscoveryLockConfigured
      ? "CONFIGURED_NOT_PROBED"
      : "MISSING",
    externalRequests: 0,
    writes: 0,
    stateModified: false,
  };
}

function skippedResult(input: {
  status: ShopeeScheduledDiscoveryTickResult["status"];
  autoRunReady: boolean;
  due: boolean;
  nextScheduledRunAt: string | null;
  errorCode?: string | null;
}) {
  const metrics = emptyMetrics(input.errorCode ?? null);
  return {
    status: input.status,
    autoRunReady: input.autoRunReady,
    due: input.due,
    runId: null,
    nextScheduledRunAt: input.nextScheduledRunAt,
    metrics,
    externalRequests: 0,
    writes: 0,
    publicationsCreated: 0 as const,
    messagesSent: 0 as const,
    stateModified: false,
    errorCode: input.errorCode ?? null,
  } satisfies ShopeeScheduledDiscoveryTickResult;
}

export async function runShopeeScheduledDiscoveryTick(
  input: {
    now?: Date;
    environment?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    dependencies?: ShopeeScheduledDiscoveryDependencies;
  } = {},
): Promise<ShopeeScheduledDiscoveryTickResult> {
  const now = input.now ?? new Date();
  const environment = input.environment ?? process.env;
  const dependencies = input.dependencies ?? {};
  const store =
    dependencies.store ?? createPrismaShopeeScheduledDiscoveryStore();
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  const latest = await store.findLatest();
  const due = calculateShopeeScheduledDiscoveryDue({
    now,
    intervalMs: configuration.automatedDiscoveryIntervalMs,
    lastRun: latest,
  });
  const nextScheduledRunAt = due.nextRunAt?.toISOString() ?? null;
  if (!configuration.automatedDiscoveryEnabled) {
    return skippedResult({
      status: "DISABLED",
      autoRunReady: false,
      due: false,
      nextScheduledRunAt,
    });
  }
  if (!configuration.remoteDiscoveryAutoRunReady) {
    return skippedResult({
      status: "NOT_READY",
      autoRunReady: false,
      due: false,
      nextScheduledRunAt,
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_NOT_READY",
    });
  }
  if (!due.due) {
    return skippedResult({
      status: "SKIPPED_NOT_DUE",
      autoRunReady: true,
      due: false,
      nextScheduledRunAt,
    });
  }

  const acquire = dependencies.acquireDiscoveryLock ?? acquireLock;
  const lock = await acquire(
    SHOPEE_SCHEDULED_DISCOVERY_LOCK_KEY,
    SHOPEE_SCHEDULED_DISCOVERY_LOCK_TTL_MS,
    { env: environment, requireRedis: true },
  );
  if (!lock.acquired) {
    const unavailable =
      lock.failureReason === "REDIS_UNAVAILABLE" || lock.mode === "unavailable";
    return skippedResult({
      status: unavailable ? "NOT_READY" : "SKIPPED_LOCKED",
      autoRunReady: !unavailable,
      due: true,
      nextScheduledRunAt,
      errorCode: unavailable
        ? "SHOPEE_SCHEDULED_DISCOVERY_REDIS_REQUIRED"
        : "SHOPEE_REMOTE_DISCOVERY_ALREADY_RUNNING",
    });
  }

  let runId: string | null = null;
  let recoveryWrites = 0;
  let recoveredRunId: string | null = null;
  try {
    const latestAfterLock = await store.findLatest();
    const dueAfterLock = calculateShopeeScheduledDiscoveryDue({
      now,
      intervalMs: configuration.automatedDiscoveryIntervalMs,
      lastRun: latestAfterLock,
    });
    const observedStaleRunId = due.lastRunStale ? latest?.id : null;
    if (dueAfterLock.lastRunStale) {
      if (!observedStaleRunId || latestAfterLock?.id !== observedStaleRunId) {
        return skippedResult({
          status: "SKIPPED_LOCKED",
          autoRunReady: true,
          due: true,
          nextScheduledRunAt:
            dueAfterLock.staleRunRecoveryAt?.toISOString() ?? null,
          errorCode: SHOPEE_SCHEDULED_DISCOVERY_STATE_CHANGED,
        });
      }
      let recovered = false;
      try {
        recovered = await store.finishAbandoned({
          id: observedStaleRunId,
          finishedAt: now,
          metrics: abandonedRunMetrics({
            startedAt: latestAfterLock.startedAt,
            recoveredAt: now,
          }),
          errorCode: SHOPEE_SCHEDULED_DISCOVERY_ABANDONED_ERROR,
        });
      } catch {
        throw new Error(SHOPEE_SCHEDULED_DISCOVERY_STALE_RECOVERY_FAILED);
      }
      if (!recovered) {
        const latestAfterRecoveryRace = await store.findLatest();
        const dueAfterRecoveryRace = calculateShopeeScheduledDiscoveryDue({
          now,
          intervalMs: configuration.automatedDiscoveryIntervalMs,
          lastRun: latestAfterRecoveryRace,
        });
        return skippedResult({
          status: dueAfterRecoveryRace.lastRunStale
            ? "SKIPPED_LOCKED"
            : "SKIPPED_NOT_DUE",
          autoRunReady: true,
          due: dueAfterRecoveryRace.lastRunStale,
          nextScheduledRunAt:
            dueAfterRecoveryRace.nextRunAt?.toISOString() ?? null,
          ...(dueAfterRecoveryRace.lastRunStale
            ? { errorCode: SHOPEE_SCHEDULED_DISCOVERY_STATE_CHANGED }
            : {}),
        });
      }
      recoveryWrites = 1;
      recoveredRunId = observedStaleRunId;
    }
    if (!dueAfterLock.due) {
      return skippedResult({
        status: "SKIPPED_NOT_DUE",
        autoRunReady: true,
        due: false,
        nextScheduledRunAt: dueAfterLock.nextRunAt?.toISOString() ?? null,
      });
    }
    const bucket = Math.floor(
      now.getTime() / configuration.automatedDiscoveryIntervalMs,
    );
    const started = await store.start({
      idempotencyKey: recoveredRunId
        ? `${SHOPEE_SCHEDULED_DISCOVERY_NAME}:${bucket}:recovery:${recoveredRunId}`
        : `${SHOPEE_SCHEDULED_DISCOVERY_NAME}:${bucket}`,
      startedAt: now,
    });
    runId = started.id;
    const recentItemIds = await (
      dependencies.loadRecentItemIds ?? loadRecentShopeeItemIds
    )({
      windowDays: configuration.recentSelectionWindowDays,
      now,
    });
    const delegatedLock: LockHandle = {
      ...lock,
      // The scheduler owns the acquired handle and releases it in its finally.
      release: async () => undefined,
    };
    const result = await (
      dependencies.runDiscovery ?? runShopeeAutomatedDiscovery
    )({
      confirmLiveCall: true,
      confirmImport: true,
      feedMode: "FULL",
      referenceIds: configuration.remoteDiscoveryReferenceIds,
      pageSize: configuration.remoteDiscoveryPageSize,
      maxPages: configuration.remoteDiscoveryMaxPages,
      maxItems: configuration.remoteDiscoveryMaxItems,
      recentItemIds,
      environment,
      ...(input.signal ? { signal: input.signal } : {}),
      acquireDiscoveryLock: async () => delegatedLock,
    });
    const discoveryMetrics = metricsFromDiscovery(result);
    const metrics = recoveryWrites
      ? {
          ...discoveryMetrics,
          writes: discoveryMetrics.writes + recoveryWrites,
          abandonedRunsRecovered: recoveryWrites,
        }
      : discoveryMetrics;
    const status = statusFromResult(result, metrics);
    const finishedAt = dependencies.finishedAt?.() ?? new Date();
    await store.finish({
      id: started.id,
      status,
      finishedAt,
      metrics,
      errorCode: result.errorCode,
    });
    return {
      status,
      autoRunReady: true,
      due: true,
      runId: started.id,
      nextScheduledRunAt: new Date(
        now.getTime() + configuration.automatedDiscoveryIntervalMs,
      ).toISOString(),
      metrics,
      externalRequests: metrics.externalRequests,
      writes: metrics.writes,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: result.stateModified || recoveryWrites > 0,
      errorCode: result.errorCode,
    };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    const metrics = {
      ...emptyMetrics(errorCode),
      writes: recoveryWrites,
      abandonedRunsRecovered: recoveryWrites,
    };
    if (runId) {
      await store
        .finish({
          id: runId,
          status: "FAILED",
          finishedAt: dependencies.finishedAt?.() ?? new Date(),
          metrics,
          errorCode,
        })
        .catch(() => undefined);
    }
    return {
      status: "FAILED",
      autoRunReady: true,
      due: true,
      runId,
      nextScheduledRunAt: new Date(
        now.getTime() + configuration.automatedDiscoveryIntervalMs,
      ).toISOString(),
      metrics,
      externalRequests: 0,
      writes: recoveryWrites,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: recoveryWrites > 0,
      errorCode,
    };
  } finally {
    await lock.release().catch(() => undefined);
  }
}
