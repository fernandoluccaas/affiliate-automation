import { randomUUID } from "node:crypto";
import { acquireLock, type LockHandle } from "@affiliate/redis";

export const WORKER_LEADER_KEY = "affiliate:worker:leader";

export type WorkerLeadershipEvent =
  | "ACQUIRED"
  | "ACQUIRE_REJECTED"
  | "RENEWED"
  | "RENEWAL_FAILED"
  | "RELEASED"
  | "RELEASE_FAILED";

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
  key?: string;
  onEvent?: (event: WorkerLeadershipEvent) => void | Promise<void>;
}): Promise<WorkerLeadershipResult<T>> {
  const env = input.env ?? process.env;
  const ttlMs = workerLeaderTtlMs(env);
  const instanceId = input.instanceId ?? randomUUID();
  const acquire = input.acquire ?? acquireLock;
  const key = input.key ?? WORKER_LEADER_KEY;
  const emit = async (event: WorkerLeadershipEvent) => {
    await input.onEvent?.(event);
  };
  if (input.signal?.aborted) {
    await emit("ACQUIRE_REJECTED");
    return { status: "LEADERSHIP_LOST", instanceId };
  }
  const lock = await acquire(key, ttlMs, { requireRedis: true });
  if (!lock.acquired) {
    await emit("ACQUIRE_REJECTED");
    return {
      status:
        lock.failureReason === "REDIS_UNAVAILABLE" || lock.mode === "unavailable"
          ? "REDIS_UNAVAILABLE"
          : "WORKER_ALREADY_ACTIVE",
      instanceId,
    };
  }
  if (input.signal?.aborted) {
    try {
      await lock.release();
      await emit("RELEASED");
    } catch {
      await emit("RELEASE_FAILED");
    }
    return { status: "LEADERSHIP_LOST", instanceId };
  }
  await emit("ACQUIRED");

  const controller = new AbortController();
  const externalStop = () => controller.abort();
  input.signal?.addEventListener("abort", externalStop, { once: true });
  let leadershipLost = false;
  let renewalRunning = false;
  let pendingRenewal: Promise<void> = Promise.resolve();
  const setIntervalFn = input.setIntervalFn ?? setInterval;
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval;
  const renewal = setIntervalFn(() => {
    if (renewalRunning || controller.signal.aborted) return;
    renewalRunning = true;
    pendingRenewal = (async () => {
      try {
        if (await lock.extend(ttlMs)) {
          await emit("RENEWED");
          return;
        }
        leadershipLost = true;
        await emit("RENEWAL_FAILED");
        controller.abort();
      } catch {
        leadershipLost = true;
        await emit("RENEWAL_FAILED");
        controller.abort();
      } finally {
        renewalRunning = false;
      }
    })();
  }, Math.max(5_000, Math.floor(ttlMs / 3)));
  renewal.unref?.();

  try {
    const result = await input.run(controller.signal, instanceId);
    return leadershipLost
      ? { status: "LEADERSHIP_LOST", instanceId }
      : { status: "COMPLETED", instanceId, result };
  } finally {
    clearIntervalFn(renewal);
    await pendingRenewal.catch(() => undefined);
    input.signal?.removeEventListener("abort", externalStop);
    try {
      await lock.release();
      await emit("RELEASED");
    } catch {
      await emit("RELEASE_FAILED");
    }
  }
}
