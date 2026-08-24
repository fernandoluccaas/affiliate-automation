import { describe, expect, it, vi } from "vitest";
import type { LockHandle } from "@affiliate/redis";
import {
  deriveShopeeProductionMode,
  runShopeeProductionCycle,
  type ShopeeProductionStore,
} from "./production";
import { resolveShopeeAffiliateConfiguration } from "./config";

const readyEnvironment = {
  SHOPEE_PUBLICATION_ENABLED: "true",
  SHOPEE_AUTO_DISTRIBUTION_ENABLED: "true",
  SHOPEE_EXTERNAL_SENDS_ENABLED: "false",
  SHOPEE_PUBLICATION_TELEGRAM_ENABLED: "true",
} as NodeJS.ProcessEnv;

function lock(acquired = true): LockHandle {
  return {
    key: "shopee:production-distribution",
    token: "owner-fixture",
    acquired,
    mode: "redis-url",
    ...(acquired ? {} : { failureReason: "LOCK_ALREADY_HELD" as const }),
    extend: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  };
}

function store(
  latest: Awaited<ReturnType<ShopeeProductionStore["latest"]>> = null,
) {
  const value: ShopeeProductionStore = {
    latest: vi.fn(async () => latest),
    recover: vi.fn(async () => true),
    start: vi.fn(async () => ({ id: "run-fixture" })),
    finish: vi.fn(async () => undefined),
  };
  return value;
}

describe("Shopee production orchestration", () => {
  it("derives OFF, DRY_RUN, READY and LIVE without trusting one flag", () => {
    const configuration = resolveShopeeAffiliateConfiguration({});
    expect(
      deriveShopeeProductionMode({
        configuration,
        configuredChannelCount: 0,
        publicTrackingReady: false,
      }),
    ).toBe("OFF");
    expect(
      deriveShopeeProductionMode({
        configuration: resolveShopeeAffiliateConfiguration({
          SHOPEE_PUBLICATION_ENABLED: "true",
        }),
        configuredChannelCount: 0,
        publicTrackingReady: false,
      }),
    ).toBe("DRY_RUN");
    expect(
      deriveShopeeProductionMode({
        configuration: resolveShopeeAffiliateConfiguration(readyEnvironment),
        configuredChannelCount: 1,
        publicTrackingReady: false,
      }),
    ).toBe("READY");
    expect(
      deriveShopeeProductionMode({
        configuration: resolveShopeeAffiliateConfiguration({
          ...readyEnvironment,
          SHOPEE_EXTERNAL_SENDS_ENABLED: "true",
        }),
        configuredChannelCount: 1,
        publicTrackingReady: true,
      }),
    ).toBe("LIVE");
  });

  it("never derives LIVE without a public tracking base", () => {
    expect(
      deriveShopeeProductionMode({
        configuration: resolveShopeeAffiliateConfiguration({
          ...readyEnvironment,
          SHOPEE_EXTERNAL_SENDS_ENABLED: "true",
        }),
        configuredChannelCount: 1,
        publicTrackingReady: false,
      }),
    ).toBe("READY");
  });

  it.each([
    ["https://affiliate.example.com", "LIVE"],
    ["http://affiliate.example.com", "READY"],
    ["http://localhost:3000", "READY"],
  ] as const)(
    "derives %s tracking configuration as %s through the production entrypoint",
    async (appBaseUrl, expectedMode) => {
      const result = await runShopeeProductionCycle({
        confirmRun: false,
        preview: true,
        environment: {
          ...readyEnvironment,
          SHOPEE_EXTERNAL_SENDS_ENABLED: "true",
          APP_BASE_URL: appBaseUrl,
        },
        configuredChannelCount: 1,
      });
      expect(result.mode).toBe(expectedMode);
    },
  );

  it("keeps preview at zero writes, requests and messages", async () => {
    const result = await runShopeeProductionCycle({
      confirmRun: false,
      preview: true,
      environment: readyEnvironment,
      configuredChannelCount: 1,
    });
    expect(result).toMatchObject({
      status: "PREVIEW",
      mode: "READY",
      writes: 0,
      externalRequests: 0,
      messagesSent: 0,
      stateModified: false,
    });
  });

  it("skips a second worker while the owned lock is held", async () => {
    const result = await runShopeeProductionCycle({
      confirmRun: true,
      environment: readyEnvironment,
      configuredChannelCount: 1,
      acquireProductionLock: vi.fn(async () => lock(false)),
      store: store(),
    });
    expect(result.status).toBe("SKIPPED_LOCKED");
    expect(result.writes).toBe(0);
  });

  it("recovers a stale run only after acquiring the lock", async () => {
    const memory = store({
      id: "stale-run",
      status: "RUNNING",
      startedAt: new Date("2026-08-24T00:00:00.000Z"),
    });
    const owned = lock();
    const result = await runShopeeProductionCycle({
      confirmRun: true,
      now: new Date("2026-08-24T01:00:00.000Z"),
      environment: readyEnvironment,
      configuredChannelCount: 1,
      acquireProductionLock: vi.fn(async () => owned),
      store: memory,
      plan: async () => ({ candidates: 1, publicationsCreated: 1 }),
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(memory.recover).toHaveBeenCalledWith(
      "stale-run",
      new Date("2026-08-24T01:00:00.000Z"),
    );
    expect(owned.release).toHaveBeenCalledOnce();
  });

  it("isolates Telegram and WhatsApp stage failures", async () => {
    const memory = store();
    const result = await runShopeeProductionCycle({
      confirmRun: true,
      environment: readyEnvironment,
      configuredChannelCount: 1,
      acquireProductionLock: vi.fn(async () => lock()),
      store: memory,
      dispatchTelegram: async () => {
        throw new Error("SHOPEE_TELEGRAM_STAGE_FAILED");
      },
      queueWhatsApp: async () => ({ whatsappQueued: 1 }),
    });
    expect(result.status).toBe("SUCCEEDED_WITH_ERRORS");
    expect(result.metrics.whatsappQueued).toBe(1);
    expect(memory.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "PARTIAL" }),
    );
  });
});
