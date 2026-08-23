import { describe, expect, it, vi } from "vitest";
import { runShopeeDistributionCli } from "./distribution-cli";

describe("Shopee distribution CLI", () => {
  it("keeps help and status free from database and external calls", async () => {
    const plan = vi.fn();
    await expect(
      runShopeeDistributionCli(["--help"], { plan }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const status = await runShopeeDistributionCli(["status"], { plan });
    expect(status.output).toMatchObject({
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(plan).not.toHaveBeenCalled();
  });

  it("uses the read-only publication preview", async () => {
    const plan = vi.fn().mockResolvedValue({
      status: "PREVIEW_COMPLETED",
      writes: 0,
      messagesSent: 0,
    });
    const result = await runShopeeDistributionCli(["preview"], {
      plan,
      environment: { SHOPEE_PUBLICATION_ENABLED: "true" },
    });
    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({ preview: true }),
    );
    expect(result.output).toMatchObject({
      status: "SHOPEE_DISTRIBUTION_PREVIEW",
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
  });
});
