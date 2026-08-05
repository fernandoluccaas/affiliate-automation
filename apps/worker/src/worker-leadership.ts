import { randomUUID } from "node:crypto";
import { acquireLock, type LockHandle } from "@affiliate/redis";

export const WORKER_LEADER_KEY = "affiliate:worker:leader";

export type WorkerLeadershipResult<T> =
  | { status: "COMPLETED"; instanceId: string; result: T }
  | {
      status: "WORKER_ALREADY_ACTIVE" | "REDIS_UNAVAILABLE" | "LEADERSHIP_LOST";
      instanceId: string;
    };

export function workerLeaderTtlMs(env: NodeJS.ProcessEnv = process.env) {
  const seconds = Number(env.WORKER_LEADER_TTL_SECONDS ?? 45);
  return Number.isFinite(seconds) && seconds >= 15
    ? Math.min(seconds, 300) * 1_000
    : 45_000;
}

export async function runWithWorkerLeadership<T>(input: {
  run: (signal: AbortSignal, instanceId: string) => Promise<T>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  acquire?: (
    key: string,
    ttlMs: number,
    options: { requireRedis: boolean },
  ) => Promise<LockHandle>;
  instanceId?: string;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): Promise<WorkerLeadershipResult<T>> {
  const env = input.env ?? process.env;
  const ttlMs = workerLeaderTtlMs(env);
  const instanceId = input.instanceId ?? randomUUID();
  const acquire = input.acquire ?? acquireLock;
  const lock = await acquire(WORKER_LEADER_KEY, ttlMs, { requireRedis: true });
  if (!lock.acquired) {
    return {
      status:
        lock.failureReason === "REDIS_UNAVAILABLE" || lock.mode === "unavailable"
          ? "REDIS_UNAVAILABLE"
          : "WORKER_ALREADY_ACTIVE",
      instanceId,
    };
  }

  const controller = new AbortController();
  const externalStop = () => controller.abort();
  input.signal?.addEventListener("abort", externalStop, { once: true });
  let leadershipLost = false;
  let renewalRunning = false;
  const setIntervalFn = input.setIntervalFn ?? setInterval;
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval;
  const renewal = setIntervalFn(async () => {
    if (renewalRunning || controller.signal.aborted) return;
    renewalRunning = true;
    try {
      if (!(await lock.extend(ttlMs))) {
        leadershipLost = true;
        controller.abort();
      }
    } catch {
      leadershipLost = true;
      controller.abort();
    } finally {
      renewalRunning = false;
    }
  }, Math.max(5_000, Math.floor(ttlMs / 3)));
  renewal.unref?.();

  try {
    const result = await input.run(controller.signal, instanceId);
    return leadershipLost
      ? { status: "LEADERSHIP_LOST", instanceId }
      : { status: "COMPLETED", instanceId, result };
  } finally {
    clearIntervalFn(renewal);
    input.signal?.removeEventListener("abort", externalStop);
    await lock.release().catch(() => undefined);
  }
}
