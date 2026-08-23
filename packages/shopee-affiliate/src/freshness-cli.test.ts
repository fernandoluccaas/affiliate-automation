import { describe, expect, it, vi } from "vitest";
import { runShopeeFreshnessCli } from "./freshness-cli";

describe("Shopee freshness CLI", () => {
  it("keeps help read-only", async () => {
    const loadStatus = vi.fn();
    const expire = vi.fn();
    await runShopeeFreshnessCli(["--help"], { loadStatus, expire });
    expect(loadStatus).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
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
});
