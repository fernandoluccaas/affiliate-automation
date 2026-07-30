import { prisma, type Prisma } from "@affiliate/database";

export const WORKER_STATUS_KEY = "worker:continuous:status";
export const WORKER_CONTROLS_KEY = "worker:continuous:controls";

const MINUTE_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export type WorkerComponent =
  "discovery" | "publication" | "retry" | "maintenance";

export type WorkerCadences = Record<WorkerComponent, number>;

export type WorkerControls = {
  discoveryPaused: boolean;
  publicationPaused: boolean;
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
        status: "SUCCEEDED" | "FAILED" | "PAUSED";
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
  now?: () => Date;
  sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  processId?: number;
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
  staleAfterMs = 120_000,
) {
  if (!heartbeatAt) return "OFFLINE" as const;
  const elapsed = now.getTime() - new Date(heartbeatAt).getTime();
  return elapsed <= staleAfterMs ? ("ONLINE" as const) : ("STALE" as const);
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

export async function runContinuousWorker(options: ContinuousWorkerOptions) {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const cadences =
    options.cadences ?? getWorkerCadences(options.env ?? process.env);
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const startedAt = now();
  const nextRuns = Object.fromEntries(
    COMPONENTS.map((component) => [component, startedAt]),
  ) as Record<WorkerComponent, Date>;
  const lastRuns: WorkerOperationalStatus["lastRuns"] = {};
  let lastError: WorkerOperationalStatus["lastError"] = null;
  let nextHeartbeatAt = startedAt;

  const status = (
    state: WorkerOperationalStatus["state"],
    at: Date,
  ): WorkerOperationalStatus => ({
    state,
    startedAt: startedAt.toISOString(),
    heartbeatAt: at.toISOString(),
    ...(state === "OFFLINE" ? { stoppedAt: at.toISOString() } : {}),
    processId: options.processId ?? process.pid,
    nextRuns: Object.fromEntries(
      COMPONENTS.map((component) => [
        component,
        nextRuns[component].toISOString(),
      ]),
    ) as Record<WorkerComponent, string>,
    lastRuns,
    lastError,
  });

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
      } else {
        try {
          await options.dependencies[component](tickAt);
          lastRuns[component] = {
            status: "SUCCEEDED",
            at: tickAt.toISOString(),
            durationMs: Math.max(0, Date.now() - componentStartedAt),
          };
        } catch {
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
  await persistStatus(status("OFFLINE", stoppedAt));
  return status("OFFLINE", stoppedAt);
}
