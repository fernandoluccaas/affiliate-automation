import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@affiliate/database";
import {
  acquireLock,
  getRedisKeyFingerprint,
} from "@affiliate/redis";
import { resolveShopeeAffiliateConfiguration } from "./config";
import type { ShopeeAffiliateConfiguration } from "./types";
import { resolveShopeePublicTrackingReadiness } from "./tracking-url";

export const SHOPEE_PRODUCTION_RUN_NAME = "shopee-production-distribution";
export const SHOPEE_PRODUCTION_LOCK_KEY = "shopee:production-distribution";
export const SHOPEE_PRODUCTION_LOCK_TTL_MS = 5 * 60_000;
export const SHOPEE_PRODUCTION_STALE_MS = 15 * 60_000;

export type ShopeeProductionMode = "OFF" | "DRY_RUN" | "READY" | "LIVE";

export function deriveShopeeProductionMode(input: {
  configuration: ShopeeAffiliateConfiguration;
  configuredChannelCount: number;
  publicTrackingReady: boolean;
}): ShopeeProductionMode {
  const { configuration, configuredChannelCount, publicTrackingReady } = input;
  if (!configuration.publicationEnabled) return "OFF";
  const channelGate =
    configuration.publicationTelegramEnabled ||
    configuration.publicationWhatsAppEnabled;
  if (
    !configuration.autoDistributionEnabled ||
    !channelGate ||
    configuredChannelCount === 0
  ) {
    return "DRY_RUN";
  }
  return configuration.externalSendsEnabled && publicTrackingReady
    ? "LIVE"
    : "READY";
}

export type ShopeeProductionMetrics = {
  candidates: number;
  ranked: number;
  enriched: number;
  publicationsCreated: number;
  freshnessChecked: number;
  telegramAttempted: number;
  telegramSent: number;
  whatsappQueued: number;
  whatsappSent: number;
  skipped: number;
  duplicates: number;
  externalRequests: number;
  writes: number;
  durationMs: number;
};

function emptyMetrics(): ShopeeProductionMetrics {
  return {
    candidates: 0,
    ranked: 0,
    enriched: 0,
    publicationsCreated: 0,
    freshnessChecked: 0,
    telegramAttempted: 0,
    telegramSent: 0,
    whatsappQueued: 0,
    whatsappSent: 0,
    skipped: 0,
    duplicates: 0,
    externalRequests: 0,
    writes: 0,
    durationMs: 0,
  };
}

export interface ShopeeProductionStore {
  latest(): Promise<{ id: string; status: string; startedAt: Date } | null>;
  recover(id: string, finishedAt: Date): Promise<boolean>;
  start(input: {
    idempotencyKey: string;
    startedAt: Date;
  }): Promise<{ id: string }>;
  finish(input: {
    id: string;
    status: "SUCCEEDED" | "PARTIAL" | "FAILED";
    finishedAt: Date;
    metrics: ShopeeProductionMetrics;
    errorCode: string | null;
  }): Promise<void>;
}

export function createPrismaShopeeProductionStore(): ShopeeProductionStore {
  return {
    latest: () =>
      prisma.automationRun.findFirst({
        where: { name: SHOPEE_PRODUCTION_RUN_NAME },
        orderBy: { startedAt: "desc" },
        select: { id: true, status: true, startedAt: true },
      }),
    async recover(id, finishedAt) {
      const result = await prisma.automationRun.updateMany({
        where: { id, status: "RUNNING" },
        data: {
          status: "FAILED",
          finishedAt,
          errorMessage: "SHOPEE_PRODUCTION_RUN_ABANDONED",
        },
      });
      return result.count === 1;
    },
    start: (input) =>
      prisma.automationRun.create({
        data: {
          name: SHOPEE_PRODUCTION_RUN_NAME,
          status: "RUNNING",
          idempotencyKey: input.idempotencyKey,
          startedAt: input.startedAt,
          metrics: emptyMetrics(),
        },
        select: { id: true },
      }),
    async finish(input) {
      await prisma.automationRun.update({
        where: { id: input.id },
        data: {
          status: input.status,
          finishedAt: input.finishedAt,
          metrics: input.metrics as unknown as Prisma.InputJsonValue,
          errorMessage: input.errorCode,
        },
      });
    },
  };
}

type ProductionOperation = () => Promise<Partial<ShopeeProductionMetrics>>;

export async function runShopeeProductionCycle(input: {
  confirmRun: boolean;
  preview?: boolean;
  now?: Date;
  environment?: NodeJS.ProcessEnv;
  configuredChannelCount?: number;
  store?: ShopeeProductionStore;
  acquireProductionLock?: typeof acquireLock;
  plan?: ProductionOperation;
  dispatchTelegram?: ProductionOperation;
  queueWhatsApp?: ProductionOperation;
}) {
  const startedAt = input.now ?? new Date();
  const configuration = resolveShopeeAffiliateConfiguration(
    input.environment ?? process.env,
  );
  const mode = deriveShopeeProductionMode({
    configuration,
    configuredChannelCount: input.configuredChannelCount ?? 0,
    publicTrackingReady: resolveShopeePublicTrackingReadiness(
      input.environment ?? process.env,
    ).ready,
  });
  if (input.preview) {
    return {
      status: "PREVIEW",
      mode,
      metrics: emptyMetrics(),
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    } as const;
  }
  if (!input.confirmRun) throw new Error("SHOPEE_PRODUCTION_NOT_CONFIRMED");
  if (mode === "OFF" || mode === "DRY_RUN") {
    return {
      status: "DISABLED",
      mode,
      metrics: emptyMetrics(),
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    } as const;
  }
  const lock = await (input.acquireProductionLock ?? acquireLock)(
    SHOPEE_PRODUCTION_LOCK_KEY,
    SHOPEE_PRODUCTION_LOCK_TTL_MS,
    { env: input.environment ?? process.env, requireRedis: true },
  );
  if (!lock.acquired) {
    return {
      status: "SKIPPED_LOCKED",
      mode,
      metrics: emptyMetrics(),
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    } as const;
  }
  const store = input.store ?? createPrismaShopeeProductionStore();
  let runId: string | null = null;
  const metrics = emptyMetrics();
  const errors: string[] = [];
  const renewal = setInterval(
    () => {
      void lock.extend(SHOPEE_PRODUCTION_LOCK_TTL_MS);
    },
    Math.max(1_000, Math.floor(SHOPEE_PRODUCTION_LOCK_TTL_MS / 3)),
  );
  renewal.unref?.();
  try {
    const latest = await store.latest();
    if (
      latest?.status === "RUNNING" &&
      startedAt.getTime() - latest.startedAt.getTime() >
        SHOPEE_PRODUCTION_STALE_MS
    ) {
      if (await store.recover(latest.id, startedAt)) metrics.writes += 1;
    } else if (latest?.status === "RUNNING") {
      return {
        status: "SKIPPED_LOCKED",
        mode,
        metrics,
        externalRequests: 0,
        writes: 0,
        messagesSent: 0,
        stateModified: false,
      } as const;
    }
    const started = await store.start({
      idempotencyKey: `${SHOPEE_PRODUCTION_RUN_NAME}:${startedAt.toISOString()}:${randomUUID()}`,
      startedAt,
    });
    runId = started.id;
    metrics.writes += 1;
    for (const operation of [
      input.plan,
      input.dispatchTelegram,
      input.queueWhatsApp,
    ]) {
      if (!operation) continue;
      try {
        Object.assign(
          metrics,
          Object.fromEntries(
            Object.entries(await operation()).map(([key, value]) => [
              key,
              (metrics[key as keyof ShopeeProductionMetrics] as number) +
                Number(value ?? 0),
            ]),
          ),
        );
      } catch (error) {
        errors.push(
          error instanceof Error && /^SHOPEE_[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "SHOPEE_PRODUCTION_STAGE_FAILED",
        );
      }
    }
    metrics.durationMs = Math.max(0, Date.now() - startedAt.getTime());
    const status = errors.length > 0 ? "PARTIAL" : "SUCCEEDED";
    await store.finish({
      id: started.id,
      status,
      finishedAt: new Date(),
      metrics,
      errorCode: errors[0] ?? null,
    });
    metrics.writes += 1;
    return {
      status: errors.length > 0 ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED",
      mode,
      runId: started.id,
      metrics,
      externalRequests: metrics.externalRequests,
      writes: metrics.writes,
      messagesSent: metrics.telegramSent + metrics.whatsappSent,
      stateModified: metrics.writes > 0,
    } as const;
  } catch (error) {
    if (runId) {
      await store.finish({
        id: runId,
        status: "FAILED",
        finishedAt: new Date(),
        metrics,
        errorCode: "SHOPEE_PRODUCTION_FAILED",
      });
    }
    throw error;
  } finally {
    clearInterval(renewal);
    await lock.release();
  }
}

export async function inspectShopeeProductionLock(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const lock = await getRedisKeyFingerprint(
    SHOPEE_PRODUCTION_LOCK_KEY,
    environment,
  );
  return {
    held: lock.exists,
    owner: lock.fingerprint?.slice(0, 12) ?? null,
    ttlMs: lock.ttlMs,
    mode: lock.mode,
  };
}
