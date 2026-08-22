import { describe, expect, it, vi } from "vitest";
import { runShopeeScheduledDiscoveryCommand } from "./scheduled-discovery-command";

describe("Shopee scheduled discovery CLI", () => {
  it("returns safe help with zero effects", async () => {
    const status = vi.fn();
    const result = await runShopeeScheduledDiscoveryCommand(["--help"], {
      status,
    });
    expect(result).toMatchObject({
      status: "SHOPEE_SCHEDULED_DISCOVERY_HELP",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(status).not.toHaveBeenCalled();
  });

  it("delegates status without any live operation", async () => {
    const status = vi.fn(async () => ({
      status: "SHOPEE_SCHEDULED_DISCOVERY_STATUS" as const,
      externalRequests: 0 as const,
      writes: 0 as const,
      stateModified: false as const,
    }));
    const result = await runShopeeScheduledDiscoveryCommand(["status"], {
      status: status as never,
    });
    expect(result).toMatchObject({
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(status).toHaveBeenCalledOnce();
  });

  it("rejects unknown commands before every effect", async () => {
    const status = vi.fn();
    const result = await runShopeeScheduledDiscoveryCommand(["run"], {
      status,
    });
    expect(result).toEqual({
      status: "FAILED",
      errorCode: "SHOPEE_SCHEDULED_DISCOVERY_COMMAND_INVALID",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(status).not.toHaveBeenCalled();
  });
});
