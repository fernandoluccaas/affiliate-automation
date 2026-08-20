import { describe, expect, it, vi } from "vitest";
import { runShopeeRemoteDiscoveryCommand } from "./remote-discovery-command";

const environment = {
  SHOPEE_AFFILIATE_ENABLED: "true",
  SHOPEE_AFFILIATE_MODE: "HYBRID",
  SHOPEE_OPEN_API_APP_ID: "private-app-value-123",
  SHOPEE_OPEN_API_SECRET: "private-secret-value-456",
} as NodeJS.ProcessEnv;

describe("Shopee remote discovery CLI contract", () => {
  it("returns a read-only fail-closed status without credentials", async () => {
    const result = await runShopeeRemoteDiscoveryCommand(["status"], {
      environment,
    });
    expect(result).toMatchObject({
      status: "SHOPEE_REMOTE_DISCOVERY_STATUS",
      source: "LOCAL_FILE",
      remoteDiscoveryReady: false,
      contract: "WAITING_FOR_OFFICIAL_CONTRACT",
      externalRequests: 0,
      writes: 0,
    });
    expect(JSON.stringify(result)).not.toContain(
      environment.SHOPEE_OPEN_API_SECRET,
    );
    expect(JSON.stringify(result)).not.toContain(
      environment.SHOPEE_OPEN_API_APP_ID,
    );
  });

  it("blocks feed listing before calling the service without confirmation", async () => {
    const listFeeds = vi.fn();
    const result = await runShopeeRemoteDiscoveryCommand(["feeds"], {
      environment,
      listFeeds,
    });
    expect(result).toMatchObject({
      errorCode: "SHOPEE_REMOTE_DISCOVERY_NOT_CONFIRMED",
      externalRequests: 0,
      writes: 0,
    });
    expect(listFeeds).not.toHaveBeenCalled();
  });

  it("requires an explicit feed for preview", async () => {
    const preview = vi.fn();
    const result = await runShopeeRemoteDiscoveryCommand(
      ["preview", "--confirm-live-call"],
      { environment, preview },
    );
    expect(result).toMatchObject({
      errorCode: "SHOPEE_REMOTE_FEED_ID_REQUIRED",
    });
    expect(preview).not.toHaveBeenCalled();
  });

  it("keeps run at zero effects until import is separately confirmed", async () => {
    const run = vi.fn();
    const result = await runShopeeRemoteDiscoveryCommand(
      ["run", "--feed", "feed-1", "--confirm-live-call"],
      { environment, run },
    );
    expect(result).toMatchObject({
      errorCode: "SHOPEE_REMOTE_IMPORT_NOT_CONFIRMED",
      externalRequests: 0,
      writes: 0,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("forwards both explicit confirmations to the one-shot pipeline", async () => {
    const run = vi.fn(async () => ({
      status: "IMPORTED" as const,
      externalRequests: 2,
      writes: 1,
    }));
    const result = await runShopeeRemoteDiscoveryCommand(
      ["run", "--feed", "feed-1", "--confirm-live-call", "--confirm-import"],
      { environment, run: run as never },
    );
    expect(result.status).toBe("IMPORTED");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        feedId: "feed-1",
        confirmLiveCall: true,
        confirmImport: true,
      }),
    );
  });
});
