import { describe, expect, it, vi } from "vitest";
import {
  parseShopeeAffiliateLinksCliArgs,
  runShopeeAffiliateLinksCli,
} from "./affiliate-links-cli";

const environment = {
  SHOPEE_AFFILIATE_ENABLED: "true",
  SHOPEE_AFFILIATE_MODE: "HYBRID",
  SHOPEE_OPEN_API_APP_ID: "fixture-app",
  SHOPEE_OPEN_API_SECRET: "fixture-secret",
};

function bulkResult(status: "SUCCEEDED" | "SUCCEEDED_WITH_ERRORS" | "FAILED") {
  return {
    status,
    source: "MANUAL_BULK" as const,
    requested: 1,
    eligible: 1,
    attempted: 1,
    linked: status === "FAILED" ? 0 : 1,
    alreadyLinked: 0,
    failed: status === "SUCCEEDED" ? 0 : 1,
    notAttempted: 0,
    readyToPublish: status === "FAILED" ? 0 : 1,
    remainingPending: status === "SUCCEEDED" ? 0 : 1,
    linksRequested: 1,
    linksGenerated: status === "FAILED" ? 0 : 1,
    linksReused: 0,
    linksFailed: status === "SUCCEEDED" ? 0 : 1,
    linksSkipped: 0,
    apiAttempts: 1,
    retryAttempts: 0,
    durationMs: 1,
    externalRequests: 1,
    writes: status === "FAILED" ? 0 : 1,
    publicationsCreated: 0 as const,
    messagesSent: 0 as const,
    items: [],
  };
}

describe("Shopee affiliate-link CLI", () => {
  it("requires explicit confirmation without invoking the service", async () => {
    const generate = vi.fn();
    await expect(
      runShopeeAffiliateLinksCli(["generate", "--pending"], {
        environment,
        generate,
      }),
    ).resolves.toEqual({
      exitCode: 2,
      output: {
        status: "FAILED",
        errorCode: "SHOPEE_BULK_LINK_NOT_CONFIRMED",
        externalRequests: 0,
        writes: 0,
        stateModified: false,
      },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs a confirmed sanitized generation with bounded max", async () => {
    const generate = vi.fn(async () => bulkResult("SUCCEEDED"));
    const result = await runShopeeAffiliateLinksCli(
      ["generate", "--pending", "--max", "6", "--confirm-generate"],
      { environment, generate: generate as never },
    );
    expect(result.exitCode).toBe(0);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmGenerate: true,
        maxItems: 6,
        subIds: ["sourcedatafeed", "bulk"],
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /fixture-app|fixture-secret|authorization|signature/i,
    );
  });

  it("supports dry-run and coherent partial/global exit codes", async () => {
    const dryRun = vi.fn(async () => ({
      ...bulkResult("SUCCEEDED"),
      status: "DRY_RUN" as const,
      externalRequests: 0,
      writes: 0,
    }));
    await expect(
      runShopeeAffiliateLinksCli(["generate", "--dry-run"], {
        environment,
        generate: dryRun as never,
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    for (const [status, exitCode] of [
      ["SUCCEEDED_WITH_ERRORS", 1],
      ["FAILED", 2],
    ] as const) {
      await expect(
        runShopeeAffiliateLinksCli(["generate", "--confirm-generate"], {
          environment,
          generate: vi.fn(async () => bulkResult(status)) as never,
        }),
      ).resolves.toMatchObject({ exitCode });
    }
  });

  it("validates max and exposes read-only status without credentials", async () => {
    expect(() =>
      parseShopeeAffiliateLinksCliArgs(["generate", "--max", "13"]),
    ).toThrow("SHOPEE_BULK_LINK_MAX_INVALID");
    const result = await runShopeeAffiliateLinksCli(["status"], {
      environment,
      loadState: vi.fn(async () => ({
        offerCounts: { pending: 11, ready: 2 },
        pendingOffers: [],
      })),
    });
    expect(result).toMatchObject({
      exitCode: 0,
      output: {
        openApiReady: true,
        autoLinkEnabled: false,
        readyForAffiliateLink: 11,
        readyToPublish: 2,
        stateModified: false,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/fixture-app|fixture-secret/i);
  });
});
