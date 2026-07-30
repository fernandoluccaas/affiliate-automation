import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyWorkerStatus,
  getWorkerCadences,
  readWorkerControls,
  runContinuousWorker,
  setWorkerControls,
  type ContinuousWorkerDependencies,
} from "./runtime";

vi.mock("@affiliate/database", async () => {
  const actual = await vi.importActual<typeof import("@affiliate/database")>(
    "@affiliate/database",
  );
  return { ...actual, prisma: {} };
});

async function mockSettings(value: unknown = null) {
  const { prisma } = await import("@affiliate/database");
  const upsert = vi.fn().mockResolvedValue({});
  Object.assign(prisma, {
    systemSetting: {
      findUnique: vi.fn().mockResolvedValue(
        value === null
          ? null
          : {
              value,
              updatedAt: new Date("2026-07-30T12:00:00.000Z"),
            },
      ),
      upsert,
    },
  });
  return { prisma, upsert };
}

function dependencies(): ContinuousWorkerDependencies {
  return {
    discovery: vi.fn().mockResolvedValue({}),
    publication: vi.fn().mockResolvedValue({}),
    retry: vi.fn().mockResolvedValue({}),
    maintenance: vi.fn().mockResolvedValue({}),
  };
}

describe("continuous worker configuration", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uses conservative independent cadence defaults", () => {
    expect(getWorkerCadences({})).toEqual({
      discovery: 30 * 60_000,
      publication: 5 * 60_000,
      retry: 10 * 60_000,
      maintenance: 60 * 60_000,
    });
  });

  it("reads cadence overrides from environment minutes", () => {
    expect(
      getWorkerCadences({
        WORKER_DISCOVERY_INTERVAL_MINUTES: "5",
        WORKER_PUBLICATION_INTERVAL_MINUTES: "2",
        WORKER_RETRY_INTERVAL_MINUTES: "3",
        WORKER_MAINTENANCE_INTERVAL_MINUTES: "15",
      }),
    ).toEqual({
      discovery: 300_000,
      publication: 120_000,
      retry: 180_000,
      maintenance: 900_000,
    });
  });

  it("persists and merges global pause controls", async () => {
    const { upsert } = await mockSettings({
      discoveryPaused: true,
      publicationPaused: false,
    });

    await expect(readWorkerControls()).resolves.toEqual({
      discoveryPaused: true,
      publicationPaused: false,
    });
    await expect(
      setWorkerControls({ publicationPaused: true }),
    ).resolves.toEqual({
      discoveryPaused: true,
      publicationPaused: true,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          value: {
            discoveryPaused: true,
            publicationPaused: true,
          },
        },
      }),
    );
  });

  it("classifies a missing, fresh and stale heartbeat", () => {
    const now = new Date("2026-07-30T12:02:00.000Z");
    expect(classifyWorkerStatus(null, now)).toBe("STALE");
    expect(classifyWorkerStatus("invalid", now)).toBe("STALE");
    expect(classifyWorkerStatus("2026-07-30T12:01:30.000Z", now)).toBe(
      "ONLINE",
    );
    expect(classifyWorkerStatus("2026-07-30T11:59:00.000Z", now)).toBe("STALE");
    expect(
      classifyWorkerStatus(
        "2026-07-30T12:01:30.000Z",
        now,
        90_000,
        "OFFLINE",
      ),
    ).toBe("OFFLINE");
  });
});

describe("runContinuousWorker", () => {
  it("runs components on independent cadences without catch-up bursts", async () => {
    const { upsert } = await mockSettings();
    const jobs = dependencies();
    jobs.discovery = vi.fn().mockResolvedValue({
      discoveryStatus: "PARTIAL",
      operationalMetrics: {
        offersDiscovered: 20,
        affiliateLinksReused: 17,
      },
    });
    const controller = new AbortController();
    let currentMs = Date.parse("2026-07-30T12:00:00.000Z");

    const result = await runContinuousWorker({
      dependencies: jobs,
      signal: controller.signal,
      cadences: {
        discovery: 10_000,
        publication: 5_000,
        retry: 7_000,
        maintenance: 20_000,
      },
      heartbeatIntervalMs: 1_000,
      now: () => new Date(currentMs),
      sleep: async (durationMs) => {
        currentMs += durationMs;
        if (currentMs >= Date.parse("2026-07-30T12:00:12.000Z")) {
          controller.abort();
        }
      },
      processId: 123,
      logger: vi.fn(),
    });

    expect(jobs.discovery).toHaveBeenCalledTimes(2);
    expect(jobs.publication).toHaveBeenCalledTimes(3);
    expect(jobs.retry).toHaveBeenCalledTimes(2);
    expect(jobs.maintenance).toHaveBeenCalledTimes(1);
    expect(result.metrics).toMatchObject({
      discoveryRuns: 2,
      discoveryPartial: 2,
      offersDiscovered: 40,
      affiliateLinksReused: 34,
    });
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: {
          value: expect.objectContaining({
            state: "OFFLINE",
            processId: 123,
          }),
        },
      }),
    );
  });

  it("pauses discovery/publication while maintenance continues", async () => {
    await mockSettings({
      discoveryPaused: true,
      publicationPaused: true,
    });
    const jobs = dependencies();
    const controller = new AbortController();

    await runContinuousWorker({
      dependencies: jobs,
      signal: controller.signal,
      cadences: {
        discovery: 60_000,
        publication: 60_000,
        retry: 60_000,
        maintenance: 60_000,
      },
      now: () => new Date("2026-07-30T12:00:00.000Z"),
      sleep: async () => controller.abort(),
      logger: vi.fn(),
    });

    expect(jobs.discovery).not.toHaveBeenCalled();
    expect(jobs.publication).not.toHaveBeenCalled();
    expect(jobs.retry).not.toHaveBeenCalled();
    expect(jobs.maintenance).toHaveBeenCalledTimes(1);
  });

  it("waits for an active component before completing shutdown", async () => {
    await mockSettings();
    const controller = new AbortController();
    let completed = false;
    const jobs = dependencies();
    jobs.discovery = vi.fn(async () => {
      controller.abort();
      await Promise.resolve();
      completed = true;
    });

    const result = await runContinuousWorker({
      dependencies: jobs,
      signal: controller.signal,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
      sleep: async () => undefined,
      logger: vi.fn(),
    });

    expect(completed).toBe(true);
    expect(result.state).toBe("OFFLINE");
    expect(jobs.publication).not.toHaveBeenCalled();
  });

  it("marks a restarted worker ONLINE before running components", async () => {
    const { upsert } = await mockSettings({
      state: "ONLINE",
      heartbeatAt: "2026-07-30T11:00:00.000Z",
    });
    const controller = new AbortController();

    await runContinuousWorker({
      dependencies: dependencies(),
      signal: controller.signal,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
      sleep: async () => controller.abort(),
      logger: vi.fn(),
    });

    expect(upsert.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        update: {
          value: expect.objectContaining({
            state: "ONLINE",
            heartbeatAt: "2026-07-30T12:00:00.000Z",
          }),
        },
      }),
    );
  });

  it("renews ONLINE heartbeat while a long component is active", async () => {
    vi.useFakeTimers();
    try {
      const { upsert } = await mockSettings();
      const controller = new AbortController();
      let finishDiscovery: (() => void) | undefined;
      const jobs = dependencies();
      jobs.discovery = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishDiscovery = resolve;
          }),
      );

      const running = runContinuousWorker({
        dependencies: jobs,
        signal: controller.signal,
        heartbeatIntervalMs: 1_000,
        now: () => new Date(),
        sleep: async () => controller.abort(),
        logger: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(2_100);
      expect(
        upsert.mock.calls.filter(
          (call) =>
            (call[0] as { update?: { value?: { state?: string } } }).update
              ?.value?.state === "ONLINE",
        ).length,
      ).toBeGreaterThanOrEqual(3);

      finishDiscovery?.();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not block shutdown when OFFLINE persistence fails", async () => {
    const { upsert } = await mockSettings();
    const controller = new AbortController();
    const jobs = dependencies();
    const logger = vi.fn();
    upsert
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockImplementation(() => new Promise(() => undefined));

    const result = await runContinuousWorker({
      dependencies: jobs,
      signal: controller.signal,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
      sleep: async () => controller.abort(),
      shutdownTimeoutMs: 5,
      logger,
    });

    expect(result.state).toBe("OFFLINE");
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "WORKER_OFFLINE_PERSIST_FAILED",
      }),
    );
  });

  it("isolates a failed component and does not persist secret errors", async () => {
    const { upsert } = await mockSettings();
    const controller = new AbortController();
    const jobs = dependencies();
    const logger = vi.fn();
    jobs.discovery = vi
      .fn()
      .mockRejectedValue(new Error("Cookie: secret-session"));

    await runContinuousWorker({
      dependencies: jobs,
      signal: controller.signal,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
      sleep: async () => controller.abort(),
      logger,
    });

    expect(jobs.publication).toHaveBeenCalled();
    expect(JSON.stringify(upsert.mock.calls)).not.toContain("secret-session");
    expect(JSON.stringify(upsert.mock.calls)).toContain(
      "WORKER_COMPONENT_FAILED",
    );
    expect(JSON.stringify(logger.mock.calls)).not.toContain("secret-session");
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "discovery",
        status: "FAILED",
        errorCode: "WORKER_COMPONENT_FAILED",
        durationMs: expect.any(Number),
      }),
    );
  });

  it("persists a specific Redis root cause without exposing backend details", async () => {
    const { upsert } = await mockSettings();
    const controller = new AbortController();
    const jobs = dependencies();
    const logger = vi.fn();
    for (const component of Object.keys(jobs) as Array<keyof typeof jobs>) {
      jobs[component] = vi.fn().mockResolvedValue({
        workerComponentOutcome: {
          status: "FAILED",
          lockBackend: "UNAVAILABLE",
          rootCause: "REDIS_UNAVAILABLE",
        },
      });
    }

    const result = await runContinuousWorker({
      dependencies: jobs,
      signal: controller.signal,
      now: () => new Date("2026-07-30T12:00:00.000Z"),
      sleep: async () => controller.abort(),
      logger,
    });

    expect(result.lockBackend).toBe("UNAVAILABLE");
    expect(result.lastError).toMatchObject({
      component: "maintenance",
      code: "WORKER_COMPONENT_FAILED",
      rootCause: "REDIS_UNAVAILABLE",
    });
    expect(JSON.stringify(upsert.mock.calls)).toContain("REDIS_UNAVAILABLE");
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        rootCause: "REDIS_UNAVAILABLE",
      }),
    );
  });
});
