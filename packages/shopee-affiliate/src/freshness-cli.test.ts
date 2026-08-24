import { describe, expect, it, vi } from "vitest";
import { runShopeeFreshnessCli } from "./freshness-cli";

describe("Shopee freshness CLI", () => {
  it("keeps help read-only", async () => {
    const loadStatus = vi.fn();
    const expire = vi.fn();
    const check = vi.fn();
    const result = await runShopeeFreshnessCli(["expire", "--help"], {
      loadStatus,
      expire,
      check,
    });
    expect(result.output).toMatchObject({
      status: "USAGE",
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(loadStatus).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation for maintenance", async () => {
    const expire = vi.fn();
    const result = await runShopeeFreshnessCli(["expire"], { expire });
    expect(result.output).toMatchObject({
      errorCode: "SHOPEE_FRESHNESS_NOT_CONFIRMED",
      writes: 0,
      stateModified: false,
    });
    expect(expire).not.toHaveBeenCalled();
  });

  it("reports fresh and stale counts without external requests", async () => {
    const result = await runShopeeFreshnessCli(["status"], {
      loadStatus: vi.fn().mockResolvedValue({
        fresh: 3,
        stale: 2,
        maxOfferAgeHours: 24,
        refreshBeforePublication: true,
      }),
    });
    expect(result.output).toMatchObject({
      fresh: 3,
      stale: 2,
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
  });

  it("does not read, refresh, or write an unconfirmed canary", async () => {
    const check = vi.fn();
    const result = await runShopeeFreshnessCli(
      ["check", "--publication-id", "publication-canary"],
      { check },
    );
    expect(result).toMatchObject({
      exitCode: 2,
      output: {
        status: "NOT_CONFIRMED",
        externalRequests: 0,
        writes: 0,
        messagesSent: 0,
        stateModified: false,
      },
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("checks exactly one confirmed Publication through the existing service", async () => {
    const check = vi.fn().mockResolvedValue({
      publicationId: "publication-canary",
      offerId: "offer-canary",
      allowed: true,
      reason: "SHOPEE_OFFER_FRESH",
      refreshAttempted: true,
      refreshSucceeded: true,
      externalRequests: 1,
      writes: 1,
      stateModified: true,
    });
    const result = await runShopeeFreshnessCli(
      ["check", "--publication-id", "publication-canary", "--confirm-refresh"],
      { check },
    );
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ publicationId: "publication-canary" }),
    );
    expect(result.output).toMatchObject({
      publicationId: "publication-canary",
      offerId: "offer-canary",
      allowed: true,
      messagesSent: 0,
    });
  });

  it("rejects repeated Publication ids before calling the service", async () => {
    const check = vi.fn();
    const result = await runShopeeFreshnessCli(
      [
        "check",
        "--publication-id",
        "one",
        "--publication-id",
        "two",
        "--confirm-refresh",
      ],
      { check },
    );
    expect(result.output).toMatchObject({
      errorCode: "SHOPEE_FRESHNESS_PUBLICATION_ID_INVALID",
      writes: 0,
      stateModified: false,
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("rejects a missing Publication id value before calling the service", async () => {
    const check = vi.fn();
    const result = await runShopeeFreshnessCli(
      ["check", "--publication-id", "--confirm-refresh"],
      { check },
    );
    expect(result.output).toMatchObject({
      errorCode: "SHOPEE_FRESHNESS_PUBLICATION_ID_INVALID",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(check).not.toHaveBeenCalled();
  });
});
