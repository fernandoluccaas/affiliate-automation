import { describe, expect, it, vi } from "vitest";
import { runShopeeRankingCli } from "./ranking-cli";

describe("Shopee ranking CLI", () => {
  it("keeps help read-only", async () => {
    const preview = vi.fn();
    const result = await runShopeeRankingCli(["--help"], { preview });
    expect(result.exitCode).toBe(0);
    expect(preview).not.toHaveBeenCalled();
  });

  it("returns only the read-only persisted preview", async () => {
    const preview = vi.fn().mockResolvedValue({
      status: "SHOPEE_RANKING_PREVIEW",
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
    const result = await runShopeeRankingCli(["preview"], { preview });
    expect(result.output).toMatchObject({
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
  });
});
