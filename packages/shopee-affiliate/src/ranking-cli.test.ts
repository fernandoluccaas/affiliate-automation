import { describe, expect, it, vi } from "vitest";
import {
  previewPersistedShopeeRanking,
  runShopeeRankingCli,
} from "./ranking-cli";

describe("Shopee ranking CLI", () => {
  it("keeps help read-only", async () => {
    const preview = vi.fn();
    const result = await runShopeeRankingCli(["preview", "--help"], {
      preview,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      status: "USAGE",
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
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

  it("queries only offers that can enter the production publication pipeline", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await previewPersistedShopeeRanking({
      offer: { findMany },
    } as never);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          marketplace: "SHOPEE",
          status: "READY_TO_PUBLISH",
        },
      }),
    );
  });
});
