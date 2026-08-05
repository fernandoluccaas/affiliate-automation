import { appendFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@affiliate/database";
import {
  runContinuousWorker,
  type ContinuousWorkerDependencies,
  type WorkerCadences,
} from "./runtime";
import {
  runWithWorkerLeadership,
  WORKER_LEADER_KEY,
  type WorkerLeadershipEvent,
} from "./worker-leadership";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TEST_KEY_PATTERN = /^affiliate:test:worker:leader:[a-f0-9-]{16,80}$/;

export type BurnInConfiguration = {
  mode: "BURN_IN";
  leaderKey: string;
  smoke: boolean;
  cycleIntervalMs: number;
};

export function validateBurnInEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; config: BurnInConfiguration } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (env.WORKER_BURN_IN_MODE !== "true") errors.push("WORKER_BURN_IN_MODE_REQUIRED");
  if (env.WHATSAPP_WEB_DRY_RUN !== "true") errors.push("WHATSAPP_WEB_DRY_RUN_REQUIRED");
  if (env.WORKER_REQUIRE_REDIS !== "true") errors.push("WORKER_REQUIRE_REDIS_REQUIRED");
  if (env.AFFILIATE_SUPERVISOR_MODE !== "BURN_IN") {
    errors.push("BURN_IN_SUPERVISOR_MODE_REQUIRED");
  }
  if (!/^[a-f0-9]{16,64}$/i.test(env.AFFILIATE_SUPERVISOR_INSTANCE_ID ?? "")) {
    errors.push("BURN_IN_SUPERVISOR_INSTANCE_REQUIRED");
  }

  const smoke = env.WORKER_BURN_IN_SMOKE === "true";
  const override = env.WORKER_LEADER_KEY_OVERRIDE;
  if (smoke && (!override || !TEST_KEY_PATTERN.test(override))) {
    errors.push("BURN_IN_ISOLATED_TEST_KEY_REQUIRED");
  }
  if (!smoke && override) errors.push("WORKER_LEADER_KEY_OVERRIDE_FORBIDDEN");

  const requestedInterval = Number(env.WORKER_BURN_IN_CYCLE_INTERVAL_MS ?? 5_000);
  if (!Number.isFinite(requestedInterval) || requestedInterval < 500) {
    errors.push("BURN_IN_CYCLE_INTERVAL_INVALID");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      mode: "BURN_IN",
      leaderKey: smoke ? override! : WORKER_LEADER_KEY,
      smoke,
      cycleIntervalMs: Math.min(60_000, Math.floor(requestedInterval)),
    },
  };
}

export function createBurnInDependencies(): ContinuousWorkerDependencies {
  const blocked = async () => ({
    burnInBlocked: true,
    workerComponentOutcome: {
      status: "SKIPPED" as const,
      lockBackend: "AVAILABLE" as const,
    },
  });
  return {
    discovery: blocked,
    publication: blocked,
    retry: blocked,
    maintenance: blocked,
  };
}

function eventFile(env: NodeJS.ProcessEnv) {
  const root = resolve(WORKSPACE_ROOT, ".local/ops");
  const candidate = resolve(env.AFFILIATE_BURN_IN_EVENT_FILE ?? join(root, "burn-in-events.jsonl"));
  const relativePath = relative(root, candidate);
  return !relativePath.startsWith("..") && !isAbsolute(relativePath)
    ? candidate
    : null;
}

async function emitEvent(
  env: NodeJS.ProcessEnv,
  event: string,
  instanceId: string,
) {
  const file = eventFile(env);
  if (!file) throw new Error("BURN_IN_EVENT_FILE_INVALID");
  await mkdir(dirname(file), { recursive: true });
  await appendFile(
    file,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "worker",
      event,
      instanceId: instanceId.slice(0, 12),
    })}\n`,
    "utf8",
  );
}

export async function assertBurnInDatabaseReady(
  client: typeof prisma = prisma,
  workspaceRoot = WORKSPACE_ROOT,
) {
  await client.$queryRaw`SELECT 1`;
  const expected = (
    await readdir(join(workspaceRoot, "prisma/migrations"), { withFileTypes: true })
  ).filter((entry) => entry.isDirectory()).length;
  const rows = await client.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `;
  if (Number(rows[0]?.count ?? -1) !== expected) {
    throw new Error("BURN_IN_MIGRATIONS_PENDING");
  }
}

export async function startBurnInWorker(input: {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
} = {}) {
  const env = input.env ?? process.env;
  const validation = validateBurnInEnvironment(env);
  if (!validation.ok) throw new Error(validation.errors.join(","));
  await assertBurnInDatabaseReady();

  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  input.signal?.addEventListener("abort", stop, { once: true });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const componentStopFile = env.AFFILIATE_COMPONENT_STOP_FILE;
  const stopMonitor = componentStopFile
    ? setInterval(() => {
        if (existsSync(componentStopFile)) stop();
      }, 250)
    : null;
  stopMonitor?.unref();
  const leadership = { renewals: 0, renewalFailures: 0 };
  const safetyCounters = {
    externalEffectsObserved: 0,
    businessChangesObserved: 0,
  };
  let currentInstance = env.AFFILIATE_SUPERVISOR_INSTANCE_ID!;
  const onLeadershipEvent = async (event: WorkerLeadershipEvent) => {
    if (event === "RENEWED") leadership.renewals += 1;
    if (event === "RENEWAL_FAILED") leadership.renewalFailures += 1;
    await emitEvent(env, `LEADERSHIP_${event}`, currentInstance);
  };
  const cadence = validation.config.cycleIntervalMs;
  const cadences: WorkerCadences = {
    discovery: cadence,
    publication: cadence,
    retry: cadence,
    maintenance: cadence,
  };

  try {
    return await runWithWorkerLeadership({
      env,
      key: validation.config.leaderKey,
      signal: shutdown.signal,
      onEvent: onLeadershipEvent,
      run: async (leadershipSignal, instanceId) => {
        currentInstance = instanceId;
        await emitEvent(env, "BURN_IN_RUNTIME_STARTED", instanceId);
        const result = await runContinuousWorker({
          dependencies: createBurnInDependencies(),
          signal: leadershipSignal,
          env,
          cadences,
          heartbeatIntervalMs: Math.min(2_000, cadence),
          instanceId,
          mode: "BURN_IN",
          leadershipMetrics: () => leadership,
          safetyCounters: () => safetyCounters,
        });
        await emitEvent(env, "BURN_IN_RUNTIME_STOPPED", instanceId);
        return result;
      },
    });
  } finally {
    input.signal?.removeEventListener("abort", stop);
    if (stopMonitor) clearInterval(stopMonitor);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await prisma.$disconnect();
  }
}
