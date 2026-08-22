import { describe, expect, it, vi } from "vitest";
import type { ShopeeScheduledDiscoveryTickResult } from "./scheduled-discovery";
import {
  getShopeeScheduledDiscoveryExitCode,
  runShopeeScheduledDiscoveryCommand,
} from "./scheduled-discovery-command";

const safeEnvironment = {
  SHOPEE_AUTO_LINK_AFTER_IMPORT: "false",
} as NodeJS.ProcessEnv;

function tickResult(
  status: ShopeeScheduledDiscoveryTickResult["status"],
  overrides: Partial<ShopeeScheduledDiscoveryTickResult> = {},
): ShopeeScheduledDiscoveryTickResult {
  return {
    status,
    autoRunReady: true,
    due: status !== "SKIPPED_NOT_DUE",
    runId: status === "SUCCEEDED" ? "scheduled-run" : null,
    nextScheduledRunAt: "2026-08-23T12:00:00.000Z",
    metrics: {
      durationMs: 0,
      feedsProcessed: 0,
      itemsReceived: 0,
      selected: 0,
      imported: 0,
      linksGenerated: 0,
      linksReused: 0,
      failed: 0,
      pendingAffiliateLink: 0,
      readyToPublish: 0,
      externalRequests: 0,
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      complete: false,
      errorCode: null,
    },
    externalRequests: 0,
    writes: 0,
    publicationsCreated: 0,
    messagesSent: 0,
    stateModified: false,
    errorCode: null,
    ...overrides,
  };
}

const confirmations = ["tick", "--confirm-live-call", "--confirm-import"];

describe("Shopee scheduled discovery CLI", () => {
  it("returns safe help with exit code zero and documents controlled tick", async () => {
    const status = vi.fn();
    const tick = vi.fn();
    const result = await runShopeeScheduledDiscoveryCommand(
      ["tick", "--help"],
      { status, tick },
    );
    expect(result).toMatchObject({
      status: "SHOPEE_SCHEDULED_DISCOVERY_HELP",
      usage: expect.arrayContaining([
        "npm run shopee:discovery:auto:status",
        expect.stringContaining("shopee:discovery:auto:tick"),
      ]),
      externalRequests: 0,
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(getShopeeScheduledDiscoveryExitCode(result)).toBe(0);
    expect(status).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });

  it("keeps status safe, read-only and confirmation-free", async () => {
    const status = vi.fn(async () => ({
      status: "SHOPEE_SCHEDULED_DISCOVERY_STATUS" as const,
      externalRequests: 0 as const,
      writes: 0 as const,
      stateModified: false as const,
    }));
    const tick = vi.fn();
    const result = await runShopeeScheduledDiscoveryCommand(["status"], {
      status: status as never,
      tick,
    });
    expect(result).toMatchObject({
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(getShopeeScheduledDiscoveryExitCode(result)).toBe(0);
    expect(status).toHaveBeenCalledOnce();
    expect(tick).not.toHaveBeenCalled();
  });

  it("blocks tick before every effect without live-call confirmation", async () => {
    const tick = vi.fn();
    const result = await runShopeeScheduledDiscoveryCommand(
      ["tick", "--confirm-import"],
      { environment: safeEnvironment, tick },
    );
    expect(result).toEqual({
      status: "FAILED",
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_LIVE_CALL_NOT_CONFIRMED",
      externalRequests: 0,
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(tick).not.toHaveBeenCalled();
  });

  it("blocks tick before every effect without import confirmation", async () => {
    const tick = vi.fn();
    const result = await runShopeeScheduledDiscoveryCommand(
      ["tick", "--confirm-live-call"],
      { environment: safeEnvironment, tick },
    );
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_IMPORT_NOT_CONFIRMED",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(tick).not.toHaveBeenCalled();
  });

  it("requires a separate generate confirmation when auto-link is enabled", async () => {
    const tick = vi.fn();
    const result = await runShopeeScheduledDiscoveryCommand(confirmations, {
      environment: { SHOPEE_AUTO_LINK_AFTER_IMPORT: "true" },
      tick,
    });
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_GENERATE_NOT_CONFIRMED",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(tick).not.toHaveBeenCalled();
  });

  it("does not require generate confirmation when auto-link is disabled", async () => {
    const tick = vi.fn(async () => tickResult("SUCCEEDED"));
    const result = await runShopeeScheduledDiscoveryCommand(confirmations, {
      environment: safeEnvironment,
      tick,
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(tick).toHaveBeenCalledOnce();
  });

  it("calls only the scheduled tick once with all auto-link confirmations", async () => {
    const now = new Date("2026-08-22T12:00:00.000Z");
    const environment = {
      SHOPEE_AUTO_LINK_AFTER_IMPORT: "true",
    } as NodeJS.ProcessEnv;
    const status = vi.fn();
    const tick = vi.fn(async () => tickResult("SUCCEEDED"));
    const result = await runShopeeScheduledDiscoveryCommand(
      [...confirmations, "--confirm-generate"],
      { environment, now, status, tick },
    );
    expect(result.status).toBe("SUCCEEDED");
    expect(tick).toHaveBeenCalledExactlyOnceWith({ environment, now });
    expect(status).not.toHaveBeenCalled();
    expect(result).toMatchObject({ publicationsCreated: 0, messagesSent: 0 });
  });

  it("keeps cadence sovereign when confirmed tick is not due", async () => {
    const tick = vi.fn(async () => tickResult("SKIPPED_NOT_DUE"));
    const result = await runShopeeScheduledDiscoveryCommand(confirmations, {
      environment: safeEnvironment,
      tick,
    });
    expect(result).toMatchObject({
      status: "SKIPPED_NOT_DUE",
      externalRequests: 0,
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(getShopeeScheduledDiscoveryExitCode(result)).toBe(0);
    expect(tick).toHaveBeenCalledOnce();
  });

  it.each([
    ["SKIPPED_LOCKED", 0],
    ["DISABLED", 0],
    ["SUCCEEDED", 0],
    ["NOT_READY", 2],
    ["FAILED", 2],
    ["PARTIAL", 1],
  ] as const)(
    "maps tick status %s to exit code %i",
    async (status, exitCode) => {
      const tick = vi.fn(async () => tickResult(status));
      const result = await runShopeeScheduledDiscoveryCommand(confirmations, {
        environment: safeEnvironment,
        tick,
      });
      expect(result.status).toBe(status);
      expect(getShopeeScheduledDiscoveryExitCode(result)).toBe(exitCode);
    },
  );

  it("returns non-zero for confirmation failures", async () => {
    const result = await runShopeeScheduledDiscoveryCommand(["tick"], {
      environment: safeEnvironment,
      tick: vi.fn(),
    });
    expect(getShopeeScheduledDiscoveryExitCode(result)).toBe(2);
  });

  it("rejects unknown commands before every effect", async () => {
    const status = vi.fn();
    const tick = vi.fn();
    const result = await runShopeeScheduledDiscoveryCommand(["run"], {
      status,
      tick,
    });
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_COMMAND_INVALID",
      externalRequests: 0,
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(status).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });
});
