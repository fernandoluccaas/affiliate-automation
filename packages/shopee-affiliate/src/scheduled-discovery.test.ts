import { describe, expect, it, vi } from "vitest";
import type { LockHandle } from "@affiliate/redis";
import type { ShopeeAutomatedDiscoveryResult } from "./remote-discovery";
import {
  calculateShopeeScheduledDiscoveryDue,
  getShopeeScheduledDiscoveryStatus,
  runShopeeScheduledDiscoveryTick,
  type ShopeeScheduledDiscoveryStore,
  type ShopeeScheduledRunRecord,
} from "./scheduled-discovery";

const now = new Date("2026-08-22T12:00:00.000Z");

function readyEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    SHOPEE_AFFILIATE_ENABLED: "true",
    SHOPEE_AFFILIATE_MODE: "HYBRID",
    SHOPEE_OPEN_API_APP_ID: "configured",
    SHOPEE_OPEN_API_SECRET: "configured",
    SHOPEE_DISCOVERY_SOURCE: "OPEN_API_FEED",
    SHOPEE_AUTOMATED_DISCOVERY_ENABLED: "true",
    SHOPEE_AUTOMATED_DISCOVERY_INTERVAL_HOURS: "24",
    SHOPEE_REMOTE_DISCOVERY_REFERENCE_IDS: "reference-a,reference-b",
    SHOPEE_REMOTE_DISCOVERY_PAGE_SIZE: "500",
    SHOPEE_REMOTE_DISCOVERY_MAX_PAGES: "250",
    SHOPEE_REMOTE_DISCOVERY_MAX_ITEMS: "120000",
    REDIS_URL: "redis://fixture.invalid:6379",
    ...overrides,
  };
}

function runRecord(
  overrides: Partial<ShopeeScheduledRunRecord> = {},
): ShopeeScheduledRunRecord {
  return {
    id: "run-1",
    status: "SUCCEEDED",
    startedAt: new Date("2026-08-21T12:00:00.000Z"),
    finishedAt: new Date("2026-08-21T12:10:00.000Z"),
    metrics: {},
    errorMessage: null,
    ...overrides,
  };
}

function store(initial: ShopeeScheduledRunRecord | null = null) {
  let latest = initial;
  const api: ShopeeScheduledDiscoveryStore = {
    findLatest: vi.fn(async () => latest),
    start: vi.fn(async ({ startedAt }) => {
      latest = runRecord({
        id: "scheduled-run",
        status: "RUNNING",
        startedAt,
        finishedAt: null,
      });
      return { id: "scheduled-run" };
    }),
    finish: vi.fn(async (input) => {
      latest = runRecord({
        id: input.id,
        status: input.status,
        startedAt: latest?.startedAt ?? now,
        finishedAt: input.finishedAt,
        metrics: input.metrics,
        errorMessage: input.errorCode,
      });
    }),
    finishAbandoned: vi.fn(async (input) => {
      const current = latest;
      if (!current || current.id !== input.id || current.status !== "RUNNING") {
        return false;
      }
      latest = runRecord({
        id: input.id,
        status: "FAILED",
        startedAt: current.startedAt,
        finishedAt: input.finishedAt,
        metrics: input.metrics,
        errorMessage: input.errorCode,
      });
      return true;
    }),
  };
  return { api, latest: () => latest };
}

function lock(acquired = true, failureReason?: LockHandle["failureReason"]) {
  return {
    key: "shopee:remote-discovery",
    token: "private-owner-token",
    acquired,
    mode: "redis-url" as const,
    ...(failureReason ? { failureReason } : {}),
    extend: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  } satisfies LockHandle;
}

function discoveryResult(
  overrides: Partial<ShopeeAutomatedDiscoveryResult> = {},
): ShopeeAutomatedDiscoveryResult {
  return {
    status: "IMPORTED",
    preview: {
      status: "PREVIEW_COMPLETED",
      source: "OPEN_API_FEED",
      complete: true,
      feed: null,
      feeds: [],
      feedsDiscovered: 2,
      feedsSelected: 2,
      feedsProcessed: 2,
      currentFeed: "reference-b",
      feedTotalCount: 100_000,
      pagesFetched: 220,
      itemsReceived: 110_000,
      itemsNormalized: 110_000,
      itemsRejected: 96_166,
      duplicates: 400,
      eligible: 13_834,
      candidatePoolSize: 120,
      eligibleByCategory: {},
      selected: [],
      apiRequests: 221,
      durationMs: 10_000,
      errorCode: null,
      databaseWrites: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: false,
    },
    importResult: {
      status: "SUCCEEDED_WITH_ERRORS",
      importJobId: "import-1",
      metrics: {
        selected: 12,
        created: 12,
        updated: 0,
        linksGenerated: 0,
        linksReused: 0,
        readyToPublish: 0,
        pendingAffiliateLink: 12,
        failed: 0,
      },
      stateModified: true,
      publicationsCreated: 0,
      messagesSent: 0,
    },
    externalRequests: 221,
    writes: 1,
    publicationsCreated: 0,
    messagesSent: 0,
    stateModified: true,
    errorCode: null,
    ...overrides,
  };
}

function dependencies(
  input: {
    store?: ReturnType<typeof store>;
    lock?: LockHandle;
    result?: ShopeeAutomatedDiscoveryResult;
    run?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const state = input.store ?? store();
  const ownedLock = input.lock ?? lock();
  const run = input.run ?? vi.fn(async () => input.result ?? discoveryResult());
  const loadRecentItemIds = vi.fn(async () => ["recent-item"]);
  return {
    state,
    ownedLock,
    run,
    loadRecentItemIds,
    value: {
      store: state.api,
      acquireDiscoveryLock: vi.fn(async () => ownedLock),
      runDiscovery: run,
      loadRecentItemIds,
      finishedAt: () => new Date("2026-08-22T12:10:00.000Z"),
    },
  };
}

describe("Shopee scheduled discovery cadence", () => {
  it("is due immediately when no prior run exists", () => {
    expect(
      calculateShopeeScheduledDiscoveryDue({
        now,
        intervalMs: 86_400_000,
        lastRun: null,
      }),
    ).toMatchObject({
      due: true,
      nextRunAt: null,
      lastRunStale: false,
      staleRunRecoveryAt: null,
    });
  });

  it("calculates deterministic due state with a fake clock", () => {
    const lastRun = runRecord({
      startedAt: new Date("2026-08-22T00:00:00.000Z"),
    });
    expect(
      calculateShopeeScheduledDiscoveryDue({
        now: new Date("2026-08-22T23:59:59.999Z"),
        intervalMs: 86_400_000,
        lastRun,
      }),
    ).toMatchObject({ due: false });
    expect(
      calculateShopeeScheduledDiscoveryDue({
        now: new Date("2026-08-23T00:00:00.000Z"),
        intervalMs: 86_400_000,
        lastRun,
      }),
    ).toMatchObject({ due: true });
  });

  it("stays disabled with zero lock, run or write effects", async () => {
    const deps = dependencies();
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment({
        SHOPEE_AUTOMATED_DISCOVERY_ENABLED: "false",
      }),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "DISABLED",
      externalRequests: 0,
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
    });
    expect(deps.value.acquireDiscoveryLock).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.state.api.start).not.toHaveBeenCalled();
  });

  it("reports NOT_READY for incomplete configuration", async () => {
    const deps = dependencies();
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment({
        SHOPEE_REMOTE_DISCOVERY_REFERENCE_IDS: "",
      }),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "NOT_READY",
      autoRunReady: false,
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_NOT_READY",
    });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("skips a valid configuration before the persisted cadence is due", async () => {
    const state = store(
      runRecord({ startedAt: new Date("2026-08-22T11:58:00.000Z") }),
    );
    const deps = dependencies({ store: state });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result.status).toBe("SKIPPED_NOT_DUE");
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("keeps a recent RUNNING lease not due without lock or recovery", async () => {
    const running = runRecord({
      status: "RUNNING",
      startedAt: new Date(now.getTime() - 30 * 60_000),
      finishedAt: null,
    });
    const state = store(running);
    const deps = dependencies({ store: state });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "SKIPPED_NOT_DUE",
      due: false,
      nextScheduledRunAt: new Date(
        running.startedAt.getTime() + 60 * 60_000,
      ).toISOString(),
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(deps.value.acquireDiscoveryLock).not.toHaveBeenCalled();
    expect(state.api.finishAbandoned).not.toHaveBeenCalled();
    expect(state.api.start).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("uses the exact lock TTL boundary for stale RUNNING eligibility", () => {
    const startedAt = new Date("2026-08-22T05:49:49.069Z");
    const running = runRecord({ status: "RUNNING", startedAt });
    const staleAt = new Date(startedAt.getTime() + 60 * 60_000);
    expect(
      calculateShopeeScheduledDiscoveryDue({
        now: new Date(staleAt.getTime() - 1),
        intervalMs: 86_400_000,
        lastRun: running,
      }),
    ).toMatchObject({
      due: false,
      lastRunStale: false,
      nextRunAt: staleAt,
      staleRunRecoveryAt: staleAt,
    });
    expect(
      calculateShopeeScheduledDiscoveryDue({
        now: staleAt,
        intervalMs: 86_400_000,
        lastRun: running,
      }),
    ).toMatchObject({
      due: true,
      lastRunStale: true,
      nextRunAt: staleAt,
      staleRunRecoveryAt: staleAt,
    });
  });

  it.each(["SUCCEEDED", "PARTIAL", "FAILED"] as const)(
    "keeps the normal daily cadence for a completed %s run",
    (status) => {
      const completed = runRecord({
        status,
        startedAt: new Date("2026-08-22T00:00:00.000Z"),
      });
      expect(
        calculateShopeeScheduledDiscoveryDue({
          now: new Date("2026-08-22T23:59:59.999Z"),
          intervalMs: 86_400_000,
          lastRun: completed,
        }),
      ).toMatchObject({
        due: false,
        lastRunStale: false,
        staleRunRecoveryAt: null,
      });
      expect(
        calculateShopeeScheduledDiscoveryDue({
          now: new Date("2026-08-23T00:00:00.000Z"),
          intervalMs: 86_400_000,
          lastRun: completed,
        }),
      ).toMatchObject({ due: true, lastRunStale: false });
    },
  );

  it("keeps a stale RUNNING record untouched while its lock is occupied", async () => {
    const running = runRecord({
      status: "RUNNING",
      startedAt: new Date(now.getTime() - 60 * 60_000),
      finishedAt: null,
    });
    const state = store(running);
    const occupied = lock(false, "LOCK_ALREADY_HELD");
    const deps = dependencies({ store: state, lock: occupied });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "SKIPPED_LOCKED",
      due: true,
      externalRequests: 0,
      writes: 0,
    });
    expect(state.latest()).toMatchObject({ id: running.id, status: "RUNNING" });
    expect(state.api.finishAbandoned).not.toHaveBeenCalled();
    expect(state.api.start).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("recovers the same stale RUNNING record under lock before one new discovery", async () => {
    const running = runRecord({
      id: "abandoned-run",
      status: "RUNNING",
      startedAt: new Date(now.getTime() - 60 * 60_000),
      finishedAt: null,
    });
    const state = store(running);
    const deps = dependencies({ store: state });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(state.api.findLatest).toHaveBeenCalledTimes(2);
    expect(state.api.finishAbandoned).toHaveBeenCalledExactlyOnceWith({
      id: "abandoned-run",
      finishedAt: now,
      metrics: expect.objectContaining({
        abandoned: true,
        abandonedRunsRecovered: 1,
        errorCode: "SHOPEE_SCHEDULED_DISCOVERY_ABANDONED",
        publicationsCreated: 0,
        messagesSent: 0,
      }),
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_ABANDONED",
    });
    expect(state.api.start).toHaveBeenCalledWith({
      idempotencyKey: expect.stringContaining(":recovery:abandoned-run"),
      startedAt: now,
    });
    expect(
      vi.mocked(state.api.finishAbandoned).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(state.api.start).mock.invocationCallOrder[0]!);
    expect(deps.run).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      writes: 2,
      stateModified: true,
      publicationsCreated: 0,
      messagesSent: 0,
      metrics: {
        abandonedRunsRecovered: 1,
        writes: 2,
        publicationsCreated: 0,
        messagesSent: 0,
      },
    });
    expect(deps.ownedLock.release).toHaveBeenCalledOnce();
  });

  it("does not abandon a run that completed before the post-lock reread", async () => {
    const running = runRecord({
      id: "racing-run",
      status: "RUNNING",
      startedAt: new Date(now.getTime() - 60 * 60_000),
      finishedAt: null,
    });
    const completed = runRecord({
      ...running,
      status: "SUCCEEDED",
      finishedAt: now,
    });
    const state = store(running);
    vi.mocked(state.api.findLatest)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completed);
    const deps = dependencies({ store: state });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result.status).toBe("SKIPPED_NOT_DUE");
    expect(state.api.finishAbandoned).not.toHaveBeenCalled();
    expect(state.api.start).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.ownedLock.release).toHaveBeenCalledOnce();
  });

  it("does not overwrite a different RUNNING record found after the lock", async () => {
    const observed = runRecord({
      id: "observed-stale-run",
      status: "RUNNING",
      startedAt: new Date(now.getTime() - 60 * 60_000),
      finishedAt: null,
    });
    const replacement = runRecord({
      id: "replacement-stale-run",
      status: "RUNNING",
      startedAt: observed.startedAt,
      finishedAt: null,
    });
    const state = store(observed);
    vi.mocked(state.api.findLatest)
      .mockResolvedValueOnce(observed)
      .mockResolvedValueOnce(replacement);
    const deps = dependencies({ store: state });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "SKIPPED_LOCKED",
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_STATE_CHANGED",
    });
    expect(state.api.finishAbandoned).not.toHaveBeenCalled();
    expect(state.api.start).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("handles a legitimate completion racing the conditional abandoned update", async () => {
    const running = runRecord({
      id: "conditional-race-run",
      status: "RUNNING",
      startedAt: new Date(now.getTime() - 60 * 60_000),
      finishedAt: null,
    });
    const completed = runRecord({
      ...running,
      status: "SUCCEEDED",
      finishedAt: now,
    });
    const state = store(running);
    vi.mocked(state.api.findLatest)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(completed);
    vi.mocked(state.api.finishAbandoned).mockResolvedValueOnce(false);
    const deps = dependencies({ store: state });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result.status).toBe("SKIPPED_NOT_DUE");
    expect(state.api.finishAbandoned).toHaveBeenCalledOnce();
    expect(state.api.start).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("fails safely and releases its lock when abandoned marking fails", async () => {
    const running = runRecord({
      id: "recovery-failure-run",
      status: "RUNNING",
      startedAt: new Date(now.getTime() - 60 * 60_000),
      finishedAt: null,
    });
    const state = store(running);
    vi.mocked(state.api.finishAbandoned).mockRejectedValueOnce(
      new Error("database details"),
    );
    const deps = dependencies({ store: state });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_STALE_RECOVERY_FAILED",
      externalRequests: 0,
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(JSON.stringify(result)).not.toContain("database details");
    expect(state.api.start).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.ownedLock.release).toHaveBeenCalledOnce();
  });

  it("allows only one pipeline across two logical instances", async () => {
    const running = runRecord({
      id: "shared-abandoned-run",
      status: "RUNNING",
      startedAt: new Date(now.getTime() - 60 * 60_000),
      finishedAt: null,
    });
    const state = store(running);
    const first = dependencies({ store: state });
    const firstResult = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: first.value,
    });
    const second = dependencies({ store: state });
    const secondResult = await runShopeeScheduledDiscoveryTick({
      now: new Date(now.getTime() + 1),
      environment: readyEnvironment(),
      dependencies: second.value,
    });
    expect(firstResult.status).toBe("SUCCEEDED");
    expect(secondResult.status).toBe("SKIPPED_NOT_DUE");
    expect(first.run).toHaveBeenCalledOnce();
    expect(second.run).not.toHaveBeenCalled();
    expect(state.api.finishAbandoned).toHaveBeenCalledOnce();
    expect(state.api.start).toHaveBeenCalledOnce();
  });

  it("runs one due FULL multi-reference discovery and preserves recent selection", async () => {
    const deps = dependencies();
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      runId: "scheduled-run",
      publicationsCreated: 0,
      messagesSent: 0,
      metrics: {
        feedsProcessed: 2,
        itemsReceived: 110_000,
        imported: 12,
        pendingAffiliateLink: 12,
        complete: true,
      },
    });
    expect(deps.run).toHaveBeenCalledWith(
      expect.objectContaining({
        feedMode: "FULL",
        referenceIds: ["reference-a", "reference-b"],
        pageSize: 500,
        maxPages: 250,
        maxItems: 120_000,
        recentItemIds: ["recent-item"],
        confirmLiveCall: true,
        confirmImport: true,
      }),
    );
    expect(deps.loadRecentItemIds).toHaveBeenCalledWith({
      windowDays: 7,
      now,
    });
    expect(deps.ownedLock.release).toHaveBeenCalledOnce();
  });

  it("does not execute twice after a logical restart inside the cadence", async () => {
    const state = store();
    const first = dependencies({ store: state });
    await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: first.value,
    });
    const restarted = dependencies({ store: state });
    const second = await runShopeeScheduledDiscoveryTick({
      now: new Date(now.getTime() + 120_000),
      environment: readyEnvironment(),
      dependencies: restarted.value,
    });
    expect(second.status).toBe("SKIPPED_NOT_DUE");
    expect(restarted.run).not.toHaveBeenCalled();
    expect(state.api.start).toHaveBeenCalledTimes(1);
  });

  it("rechecks due state after the lock to close concurrent tick races", async () => {
    const state = store();
    const deps = dependencies({ store: state });
    vi.mocked(state.api.findLatest)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        runRecord({ startedAt: new Date("2026-08-22T11:59:00.000Z") }),
      );
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result.status).toBe("SKIPPED_NOT_DUE");
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.ownedLock.release).toHaveBeenCalledOnce();
  });

  it("skips an occupied Redis lock without a second pipeline", async () => {
    const occupied = lock(false, "LOCK_ALREADY_HELD");
    const deps = dependencies({ lock: occupied });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "SKIPPED_LOCKED",
      errorCode: "SHOPEE_REMOTE_DISCOVERY_ALREADY_RUNNING",
      externalRequests: 0,
      writes: 0,
    });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("fails closed when required Redis is unavailable", async () => {
    const unavailable = {
      ...lock(false, "REDIS_UNAVAILABLE"),
      mode: "unavailable" as const,
    };
    const deps = dependencies({ lock: unavailable });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "NOT_READY",
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_REDIS_REQUIRED",
    });
  });
});

describe("Shopee scheduled discovery outcomes", () => {
  it("records PARTIAL and zero writes when discovery is incomplete", async () => {
    const partial = discoveryResult({
      status: "PARTIAL",
      preview: {
        ...discoveryResult().preview,
        status: "PARTIAL",
        complete: false,
        errorCode: "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED",
      },
      importResult: null,
      writes: 0,
      stateModified: false,
      errorCode: "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED",
    });
    const deps = dependencies({ result: partial });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      writes: 0,
      stateModified: false,
      publicationsCreated: 0,
      messagesSent: 0,
      errorCode: "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED",
    });
    expect(deps.state.api.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PARTIAL" }),
    );
  });

  it("reports pending links when auto-link is disabled", async () => {
    const deps = dependencies();
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment({
        SHOPEE_AUTO_LINK_AFTER_IMPORT: "false",
      }),
      dependencies: deps.value,
    });
    expect(result.metrics).toMatchObject({
      linksGenerated: 0,
      pendingAffiliateLink: 12,
      readyToPublish: 0,
    });
  });

  it("reports successful and partial auto-link metrics without Publications", async () => {
    const linked = discoveryResult();
    linked.importResult = {
      ...linked.importResult!,
      metrics: {
        ...linked.importResult!.metrics,
        linksGenerated: 10,
        readyToPublish: 10,
        pendingAffiliateLink: 2,
      },
      autoLinkResult: {
        status: "SUCCEEDED_WITH_ERRORS",
        source: "IMPORT",
        requested: 12,
        eligible: 12,
        attempted: 12,
        linked: 10,
        alreadyLinked: 0,
        failed: 2,
        notAttempted: 0,
        readyToPublish: 10,
        remainingPending: 2,
        linksRequested: 12,
        linksGenerated: 10,
        linksReused: 0,
        linksFailed: 2,
        linksSkipped: 0,
        apiAttempts: 12,
        retryAttempts: 0,
        durationMs: 100,
        externalRequests: 12,
        writes: 10,
        publicationsCreated: 0,
        messagesSent: 0,
        items: [],
      },
    };
    const deps = dependencies({ result: linked });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment({
        SHOPEE_AUTO_LINK_AFTER_IMPORT: "true",
      }),
      dependencies: deps.value,
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      publicationsCreated: 0,
      messagesSent: 0,
      metrics: {
        linksGenerated: 10,
        failed: 2,
        pendingAffiliateLink: 2,
        readyToPublish: 10,
        publicationsCreated: 0,
        messagesSent: 0,
      },
    });
  });

  it("releases the lock and records a sanitized failure after an exception", async () => {
    const run = vi.fn(async () => {
      throw new Error("sensitive failure details");
    });
    const deps = dependencies({ run });
    const result = await runShopeeScheduledDiscoveryTick({
      now,
      environment: readyEnvironment(),
      dependencies: deps.value,
    });
    expect(result.errorCode).toBe("SHOPEE_SCHEDULED_DISCOVERY_FAILED");
    expect(JSON.stringify(result)).not.toContain("sensitive failure details");
    expect(deps.ownedLock.release).toHaveBeenCalledOnce();
    expect(deps.state.api.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "FAILED" }),
    );
  });
});

describe("Shopee scheduled discovery status", () => {
  it("reports stale RUNNING recovery eligibility without writes or Redis probes", async () => {
    const startedAt = new Date(now.getTime() - 60 * 60_000);
    const state = store(
      runRecord({
        status: "RUNNING",
        startedAt,
        finishedAt: null,
      }),
    );
    const status = await getShopeeScheduledDiscoveryStatus({
      now,
      environment: readyEnvironment(),
      store: state.api,
    });
    expect(status).toMatchObject({
      due: true,
      lastRunStatus: "RUNNING",
      lastRunStale: true,
      staleRunRecoveryAt: new Date(
        startedAt.getTime() + 60 * 60_000,
      ).toISOString(),
      lockState: "CONFIGURED_NOT_PROBED",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(state.api.start).not.toHaveBeenCalled();
    expect(state.api.finish).not.toHaveBeenCalled();
    expect(state.api.finishAbandoned).not.toHaveBeenCalled();
  });

  it("is read-only and exposes persisted sanitized metrics", async () => {
    const state = store(
      runRecord({
        metrics: {
          durationMs: 600_000,
          feedsProcessed: 2,
          itemsReceived: 110_000,
          selected: 12,
          imported: 12,
          linksGenerated: 10,
          linksReused: 2,
          failed: 0,
          pendingAffiliateLink: 0,
          readyToPublish: 12,
          errorCode: null,
        },
      }),
    );
    const status = await getShopeeScheduledDiscoveryStatus({
      now,
      environment: readyEnvironment(),
      store: state.api,
    });
    expect(status).toMatchObject({
      autoRunReady: true,
      due: true,
      intervalHours: 24,
      lastFeedsProcessed: 2,
      lastItemsReceived: 110_000,
      lastSelected: 12,
      lastImported: 12,
      lastLinksGenerated: 10,
      lastReadyToPublish: 12,
      lockState: "CONFIGURED_NOT_PROBED",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(state.api.start).not.toHaveBeenCalled();
    expect(state.api.finish).not.toHaveBeenCalled();
  });
});
