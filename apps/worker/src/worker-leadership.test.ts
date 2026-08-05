import { describe, expect, it, vi } from "vitest";
import type { LockHandle } from "@affiliate/redis";
import { runWithWorkerLeadership, WORKER_LEADER_KEY } from "./worker-leadership";

function handle(input: Partial<LockHandle> = {}): LockHandle {
  return {
    key: WORKER_LEADER_KEY,
    token: "never-log-this-token",
    acquired: true,
    mode: "redis-url",
    extend: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
    ...input,
  };
}

describe("worker singleton leadership", () => {
  it("allows only one of two workers to execute", async () => {
    let held = false;
    const acquire = vi.fn(async () => {
      if (held) {
        return handle({
          acquired: false,
          failureReason: "LOCK_ALREADY_HELD",
        });
      }
      held = true;
      const lock = handle();
      lock.release = vi.fn(async () => {
        held = false;
      });
      return lock;
    });
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const firstRun = vi.fn(async () => wait);
    const secondRun = vi.fn(async () => undefined);
    const first = runWithWorkerLeadership({
      acquire,
      run: firstRun,
      instanceId: "worker-one",
    });
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledOnce());
    const second = await runWithWorkerLeadership({
      acquire,
      run: secondRun,
      instanceId: "worker-two",
    });
    finish();
    await first;

    expect(second).toEqual({
      status: "WORKER_ALREADY_ACTIVE",
      instanceId: "worker-two",
    });
    expect(secondRun).not.toHaveBeenCalled();
  });

  it("allows a safe takeover only after the previous owner releases", async () => {
    let held = false;
    const acquire = vi.fn(async () => {
      if (held) {
        return handle({ acquired: false, failureReason: "LOCK_ALREADY_HELD" });
      }
      held = true;
      const lock = handle();
      lock.release = vi.fn(async () => {
        held = false;
      });
      return lock;
    });
    const firstRun = vi.fn(async () => "first");
    const secondRun = vi.fn(async () => "second");

    await expect(
      runWithWorkerLeadership({ acquire, run: firstRun, instanceId: "first-owner" }),
    ).resolves.toMatchObject({ status: "COMPLETED", result: "first" });
    await expect(
      runWithWorkerLeadership({ acquire, run: secondRun, instanceId: "second-owner" }),
    ).resolves.toMatchObject({ status: "COMPLETED", result: "second" });
    expect(firstRun).toHaveBeenCalledOnce();
    expect(secondRun).toHaveBeenCalledOnce();
  });

  it("fails closed when required Redis is unavailable", async () => {
    const run = vi.fn(async () => undefined);
    const result = await runWithWorkerLeadership({
      run,
      instanceId: "worker-safe",
      acquire: vi.fn(async () =>
        handle({
          acquired: false,
          mode: "unavailable",
          failureReason: "REDIS_UNAVAILABLE",
        }),
      ),
    });
    expect(result.status).toBe("REDIS_UNAVAILABLE");
    expect(run).not.toHaveBeenCalled();
  });

  it("stops work after leadership renewal is lost", async () => {
    let renew!: () => Promise<void>;
    const lock = handle({ extend: vi.fn(async () => false) });
    const resultPromise = runWithWorkerLeadership({
      instanceId: "worker-lost",
      acquire: vi.fn(async () => lock),
      setIntervalFn: ((callback: () => Promise<void>) => {
        renew = callback;
        return { unref: vi.fn() } as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
      run: async (signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    });
    await vi.waitFor(() => expect(renew).toBeTypeOf("function"));
    await renew();
    await expect(resultPromise).resolves.toMatchObject({
      status: "LEADERSHIP_LOST",
    });
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("records renewal evidence without exposing ownership and never resumes after loss", async () => {
    let renew!: () => void;
    const events: string[] = [];
    const lock = handle({ extend: vi.fn(async () => false) });
    const resultPromise = runWithWorkerLeadership({
      instanceId: "worker-evidence",
      key: "affiliate:test:worker:leader:evidence-0001",
      acquire: vi.fn(async () => lock),
      onEvent: (event) => {
        events.push(event);
      },
      setIntervalFn: ((callback: () => void) => {
        renew = callback;
        return { unref: vi.fn() } as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
      run: async (signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
    });
    await vi.waitFor(() => expect(renew).toBeTypeOf("function"));
    renew();
    await expect(resultPromise).resolves.toMatchObject({ status: "LEADERSHIP_LOST" });
    expect(events).toEqual(["ACQUIRED", "RENEWAL_FAILED", "RELEASED"]);
    expect(JSON.stringify(events)).not.toContain(lock.token);
  });

  it("releases an acquired lock without starting work when shutdown wins acquisition", async () => {
    const controller = new AbortController();
    const lock = handle();
    let finishAcquire!: () => void;
    const acquire = vi.fn(
      () =>
        new Promise<LockHandle>((resolve) => {
          finishAcquire = () => resolve(lock);
        }),
    );
    const run = vi.fn(async () => undefined);
    const result = runWithWorkerLeadership({
      signal: controller.signal,
      acquire,
      run,
      instanceId: "worker-shutdown",
    });
    await vi.waitFor(() => expect(finishAcquire).toBeTypeOf("function"));
    controller.abort();
    finishAcquire();
    await expect(result).resolves.toMatchObject({ status: "LEADERSHIP_LOST" });
    expect(run).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("releases only through the owned lock handle and never exposes its token", async () => {
    const lock = handle();
    const result = await runWithWorkerLeadership({
      instanceId: "worker-owned",
      acquire: vi.fn(async () => lock),
      run: async () => "done",
    });
    expect(lock.release).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(lock.token);
  });
});
