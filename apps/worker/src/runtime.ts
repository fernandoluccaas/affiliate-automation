import { prisma, type Prisma } from "@affiliate/database";
import {
  DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WORKER_STALE_AFTER_MS,
  resolveWorkerHealthStatus,
} from "@affiliate/shared";

export const WORKER_STATUS_KEY = "worker:continuous:status";
export const WORKER_CONTROLS_KEY = "worker:continuous:controls";

const MINUTE_MS = 60_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export type WorkerComponent =
  "discovery" | "publication" | "retry" | "maintenance";

export type WorkerCadences = Record<WorkerComponent, number>;

export type WorkerControls = {
  discoveryPaused: boolean;
  publicationPaused: boolean;
};

export type WorkerOperationalMetrics = {
  discoveryRuns: number;
  discoverySucceeded: number;
  discoveryPartial: number;
  discoveryFailed: number;
  offersDiscovered: number;
  offersUpdated: number;
  affiliateLinksGenerated: number;
  affiliateLinksReused: number;
  offersEvaluated: number;
  offersScheduled: number;
  offersSkipped: number;
  publicationsAttempted: number;
  publicationsSucceeded: number;
  publicationsFailed: number;
  publicationsRetried: number;
  aiGenerated: number;
  aiFallbackUsed: number;
};

export type WorkerOperationalStatus = {
  state: "ONLINE" | "OFFLINE";
  startedAt: string;
  heartbeatAt: string;
  stoppedAt?: string;
  processId: number;
  nextRuns: Record<WorkerComponent, string>;
  lastRuns: Partial<
    Record<
      WorkerComponent,
      {
        status: "SUCCEEDED" | "PARTIAL" | "FAILED" | "PAUSED";
        at: string;
        durationMs: number;
      }
    >
  >;
  lastError: {
    component: WorkerComponent;
    at: string;
    code: "WORKER_COMPONENT_FAILED";
  } | null;
  metrics: WorkerOperationalMetrics;
};

export type ContinuousWorkerDependencies = Record<
  WorkerComponent,
  (now: Date) => Promise<unknown>
>;

export type ContinuousWorkerOptions = {
  dependencies: ContinuousWorkerDependencies;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cadences?: WorkerCadences;
  heartbeatIntervalMs?: number;
  shutdownTimeoutMs?: number;
  now?: () => Date;
  sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  processId?: number;
  logger?: (entry: Record<string, unknown>) => void;
};

function positiveMinutes(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getWorkerCadences(
  env: NodeJS.ProcessEnv = process.env,
): WorkerCadences {
  return {
    discovery:
      positiveMinutes(env.WORKER_DISCOVERY_INTERVAL_MINUTES, 30) * MINUTE_MS,
    publication:
      positiveMinutes(env.WORKER_PUBLICATION_INTERVAL_MINUTES, 5) * MINUTE_MS,
    retry: positiveMinutes(env.WORKER_RETRY_INTERVAL_MINUTES, 10) * MINUTE_MS,
    maintenance:
      positiveMinutes(env.WORKER_MAINTENANCE_INTERVAL_MINUTES, 60) * MINUTE_MS,
  };
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function readWorkerControls(): Promise<WorkerControls> {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: WORKER_CONTROLS_KEY },
    select: { value: true },
  });
  const value = setting ? asRecord(setting.value) : {};

  return {
    discoveryPaused: value.discoveryPaused === true,
    publicationPaused: value.publicationPaused === true,
  };
}

export async function setWorkerControls(input: Partial<WorkerControls>) {
  const current = await readWorkerControls();
  const controls: WorkerControls = { ...current, ...input };

  await prisma.systemSetting.upsert({
    where: { key: WORKER_CONTROLS_KEY },
    update: { value: controls },
    create: { key: WORKER_CONTROLS_KEY, value: controls },
  });

  return controls;
}

export async function readWorkerOperationalStatus() {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: WORKER_STATUS_KEY },
    select: { value: true, updatedAt: true },
  });

  return setting
    ? {
        value: asRecord(setting.value) as WorkerOperationalStatus,
        updatedAt: setting.updatedAt,
      }
    : null;
}

export function classifyWorkerStatus(
  heartbeatAt: Date | string | null | undefined,
  now = new Date(),
  staleAfterMs = DEFAULT_WORKER_STALE_AFTER_MS,
  storedState: unknown = "ONLINE",
) {
  return resolveWorkerHealthStatus({
    storedState,
    heartbeatAt,
    now,
    staleAfterMs,
  });
}

async function persistStatus(status: WorkerOperationalStatus) {
  await prisma.systemSetting.upsert({
    where: { key: WORKER_STATUS_KEY },
    update: { value: status as unknown as Prisma.InputJsonValue },
    create: {
      key: WORKER_STATUS_KEY,
      value: status as unknown as Prisma.InputJsonValue,
    },
  });
}

function defaultSleep(durationMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted || durationMs <= 0) {
      resolve();
      return;
    }

    const timeout = setTimeout(done, durationMs);
    signal.addEventListener("abort", done, { once: true });

    function done() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Worker shutdown timed out.")),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isPaused(component: WorkerComponent, controls: WorkerControls) {
  return component === "discovery"
    ? controls.discoveryPaused
    : component === "publication" || component === "retry"
      ? controls.publicationPaused
      : false;
}

const COMPONENTS: WorkerComponent[] = [
  "discovery",
  "publication",
  "retry",
  "maintenance",
];

function emptyOperationalMetrics(): WorkerOperationalMetrics {
  return {
    discoveryRuns: 0,
    discoverySucceeded: 0,
    discoveryPartial: 0,
    discoveryFailed: 0,
    offersDiscovered: 0,
    offersUpdated: 0,
    affiliateLinksGenerated: 0,
    affiliateLinksReused: 0,
    offersEvaluated: 0,
    offersScheduled: 0,
    offersSkipped: 0,
    publicationsAttempted: 0,
    publicationsSucceeded: 0,
    publicationsFailed: 0,
    publicationsRetried: 0,
    aiGenerated: 0,
    aiFallbackUsed: 0,
  };
}

function mergeOperationalMetrics(
  target: WorkerOperationalMetrics,
  result: unknown,
) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const metrics = (result as Record<string, unknown>).operationalMetrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return;

  for (const key of Object.keys(target) as Array<
    keyof WorkerOperationalMetrics
  >) {
    const value = (metrics as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      target[key] += value;
    }
  }
}

export async function runContinuousWorker(options: ContinuousWorkerOptions) {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const cadences =
    options.cadences ?? getWorkerCadences(options.env ?? process.env);
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS;
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const startedAt = now();
  const processId = options.processId ?? process.pid;
  const runId = `continuous:${startedAt.toISOString()}:${processId}`;
  const logger =
    options.logger ??
    ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));
  const nextRuns = Object.fromEntries(
    COMPONENTS.map((component) => [component, startedAt]),
  ) as Record<WorkerComponent, Date>;
  const lastRuns: WorkerOperationalStatus["lastRuns"] = {};
  let lastError: WorkerOperationalStatus["lastError"] = null;
  const metrics = emptyOperationalMetrics();
  let nextHeartbeatAt = startedAt;

  const status = (
    state: WorkerOperationalStatus["state"],
    at: Date,
  ): WorkerOperationalStatus => ({
    state,
    startedAt: startedAt.toISOString(),
    heartbeatAt: at.toISOString(),
    ...(state === "OFFLINE" ? { stoppedAt: at.toISOString() } : {}),
    processId,
    nextRuns: Object.fromEntries(
      COMPONENTS.map((component) => [
        component,
        nextRuns[component].toISOString(),
      ]),
    ) as Record<WorkerComponent, string>,
    lastRuns,
    lastError,
    metrics,
  });

  await persistStatus(status("ONLINE", startedAt));

  while (!options.signal.aborted) {
    const tickAt = now();
    const controls = await readWorkerControls();

    for (const component of COMPONENTS) {
      if (options.signal.aborted) break;
      if (tickAt < nextRuns[component]) continue;

      const componentStartedAt = Date.now();
      if (isPaused(component, controls)) {
        lastRuns[component] = {
          status: "PAUSED",
          at: tickAt.toISOString(),
          durationMs: 0,
        };
        logger({
          timestamp: tickAt.toISOString(),
          component,
          runId,
          status: "PAUSED",
          durationMs: 0,
        });
      } else {
        const activeHeartbeat = setInterval(() => {
          void persistStatus(status("ONLINE", now())).catch(() => undefined);
        }, heartbeatIntervalMs);

        try {
          const result = await options.dependencies[component](tickAt);
          mergeOperationalMetrics(metrics, result);
          let componentStatus: "SUCCEEDED" | "PARTIAL" | "FAILED" = "SUCCEEDED";
          if (component === "discovery") {
            metrics.discoveryRuns += 1;
            const discoveryStatus =
              result && typeof result === "object" && !Array.isArray(result)
                ? (result as Record<string, unknown>).discoveryStatus
                : null;
            if (discoveryStatus === "PARTIAL") {
              metrics.discoveryPartial += 1;
              componentStatus = "PARTIAL";
            } else if (discoveryStatus === "FAILED") {
              metrics.discoveryFailed += 1;
              componentStatus = "FAILED";
            } else {
              metrics.discoverySucceeded += 1;
            }
          }
          lastRuns[component] = {
            status: componentStatus,
            at: tickAt.toISOString(),
            durationMs: Math.max(0, Date.now() - componentStartedAt),
          };
          if (componentStatus === "FAILED") {
            lastError = {
              component,
              at: tickAt.toISOString(),
              code: "WORKER_COMPONENT_FAILED",
            };
          }
          logger({
            timestamp: tickAt.toISOString(),
            component,
            runId,
            status: componentStatus,
            durationMs: lastRuns[component].durationMs,
          });
        } catch {
          if (component === "discovery") {
            metrics.discoveryRuns += 1;
            metrics.discoveryFailed += 1;
          }
          lastRuns[component] = {
            status: "FAILED",
            at: tickAt.toISOString(),
            durationMs: Math.max(0, Date.now() - componentStartedAt),
          };
          lastError = {
            component,
            at: tickAt.toISOString(),
            code: "WORKER_COMPONENT_FAILED",
          };
          logger({
            timestamp: tickAt.toISOString(),
            component,
            runId,
            status: "FAILED",
            durationMs: lastRuns[component].durationMs,
            errorCode: "WORKER_COMPONENT_FAILED",
          });
        } finally {
          clearInterval(activeHeartbeat);
        }
      }

      // Always schedule from the current run, never replay missed intervals.
      nextRuns[component] = new Date(tickAt.getTime() + cadences[component]);
    }

    const afterJobs = now();
    if (afterJobs >= nextHeartbeatAt) {
      await persistStatus(status("ONLINE", afterJobs));
      nextHeartbeatAt = new Date(afterJobs.getTime() + heartbeatIntervalMs);
    }

    const nextWakeAt = Math.min(
      nextHeartbeatAt.getTime(),
      ...COMPONENTS.map((component) => nextRuns[component].getTime()),
    );
    await sleep(Math.max(0, nextWakeAt - now().getTime()), options.signal);
  }

  const stoppedAt = now();
  const offlineStatus = status("OFFLINE", stoppedAt);
  try {
    await settleWithin(persistStatus(offlineStatus), shutdownTimeoutMs);
  } catch {
    logger({
      timestamp: stoppedAt.toISOString(),
      component: "worker",
      runId,
      status: "FAILED",
      errorCode: "WORKER_OFFLINE_PERSIST_FAILED",
    });
  }
  return offlineStatus;
}
