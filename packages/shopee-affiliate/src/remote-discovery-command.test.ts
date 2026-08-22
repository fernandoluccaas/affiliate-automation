import { describe, expect, it, vi } from "vitest";
import {
  getShopeeRemoteDiscoveryExitCode,
  runShopeeRemoteDiscoveryCommand,
} from "./remote-discovery-command";

const environment = {
  SHOPEE_AFFILIATE_ENABLED: "true",
  SHOPEE_AFFILIATE_MODE: "HYBRID",
  SHOPEE_OPEN_API_APP_ID: "private-app-value-123",
  SHOPEE_OPEN_API_SECRET: "private-secret-value-456",
} as NodeJS.ProcessEnv;

describe("Shopee remote discovery CLI contract", () => {
  it("shows help with exit code zero and no confirmation or effects", async () => {
    const preview = vi.fn();
    const listFeeds = vi.fn();
    const result = await runShopeeRemoteDiscoveryCommand(
      ["preview", "--help"],
      { environment, preview, listFeeds },
    );
    expect(result).toMatchObject({
      status: "SHOPEE_REMOTE_DISCOVERY_HELP",
      externalRequests: 0,
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(
      getShopeeRemoteDiscoveryExitCode(["preview", "--help"], result),
    ).toBe(0);
    expect(preview).not.toHaveBeenCalled();
    expect(listFeeds).not.toHaveBeenCalled();
  });

  it("exits zero only for a deliberately limited partial preview", () => {
    expect(
      getShopeeRemoteDiscoveryExitCode(["preview", "--max-pages", "1"], {
        status: "PARTIAL",
        errorCode: "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED",
      }),
    ).toBe(0);
    expect(
      getShopeeRemoteDiscoveryExitCode(["run", "--max-pages", "1"], {
        status: "PARTIAL",
        errorCode: "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED",
      }),
    ).toBe(1);
  });

  it.each([
    "SHOPEE_OPEN_API_SCHEMA_MISMATCH",
    "SHOPEE_REMOTE_DISCOVERY_PAGINATION_INCONSISTENT",
  ])("keeps %s non-zero for preview", (errorCode) => {
    expect(
      getShopeeRemoteDiscoveryExitCode(["preview"], {
        status: "PARTIAL",
        errorCode,
      }),
    ).toBe(1);
  });

  it("returns a read-only fail-closed status without credentials", async () => {
    const result = await runShopeeRemoteDiscoveryCommand(["status"], {
      environment,
    });
    expect(result).toMatchObject({
      status: "SHOPEE_REMOTE_DISCOVERY_STATUS",
      source: "LOCAL_FILE",
      remoteDiscoveryReady: false,
      remoteDiscoveryLockConfigured: false,
      contract: "OFFICIAL_V2_FULL",
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

  it("requires an explicit or configured feed selection for preview", async () => {
    const preview = vi.fn();
    const result = await runShopeeRemoteDiscoveryCommand(
      ["preview", "--confirm-live-call"],
      { environment, preview },
    );
    expect(result).toMatchObject({
      errorCode: "SHOPEE_REMOTE_FEED_SELECTION_REQUIRED",
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
        feedIds: ["feed-1"],
        confirmLiveCall: true,
        confirmImport: true,
      }),
    );
  });

  it("prints only sanitized official feed metadata", async () => {
    const result = await runShopeeRemoteDiscoveryCommand(
      ["feeds", "--confirm-live-call"],
      {
        environment,
        listFeeds: vi.fn(async () => ({
          status: "SUCCEEDED" as const,
          feeds: [
            {
              datafeedId: "ref_FULL_2026-08-19",
              referenceId: "ref",
              datafeedName: "Feed sanitizado",
              description: "must-not-be-printed",
              totalCount: 10_000,
              date: "20260819",
              feedMode: "FULL" as const,
            },
          ],
          externalRequests: 1,
          writes: 0 as const,
          stateModified: false as const,
        })),
      },
    );
    expect(result).toMatchObject({
      feeds: [
        {
          referenceId: "ref",
          datafeedId: "ref_FULL_2026-08-19",
          name: "Feed sanitizado",
          totalCount: 10_000,
          date: "20260819",
          feedMode: "FULL",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-printed");
  });

  it("forwards stable references and bounded smoke overrides", async () => {
    const preview = vi.fn(async () => ({
      status: "PREVIEW_COMPLETED" as const,
      writes: 0,
    }));
    await runShopeeRemoteDiscoveryCommand(
      [
        "preview",
        "--reference-id",
        "ref-a",
        "--reference-id",
        "ref-b",
        "--page-size",
        "3",
        "--max-pages",
        "1",
        "--max-items",
        "3",
        "--confirm-live-call",
      ],
      { environment, preview: preview as never },
    );
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceIds: ["ref-a", "ref-b"],
        pageSize: 3,
        maxPages: 1,
        maxItems: 3,
        confirmLiveCall: true,
      }),
    );
  });
});
