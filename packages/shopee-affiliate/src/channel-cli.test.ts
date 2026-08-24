import { describe, expect, it, vi } from "vitest";
import { runShopeeChannelCli } from "./channel-cli";

describe("Shopee Channel CLI", () => {
  it("keeps help and preview safe", async () => {
    const inspect = vi.fn().mockResolvedValue({ writes: 0 });
    const update = vi.fn();
    const help = await runShopeeChannelCli(["enable", "--help"], {
      inspect,
      update,
    });
    expect(help.output).toMatchObject({
      status: "USAGE",
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(update).not.toHaveBeenCalled();
    await runShopeeChannelCli(["preview", "--channel-id", "channel-1"], {
      inspect,
    });
    expect(inspect).toHaveBeenCalledWith({ channelId: "channel-1" });
  });

  it("does not mutate without exact confirmation", async () => {
    const update = vi.fn();
    const result = await runShopeeChannelCli(
      ["enable", "--channel-id", "channel-1"],
      { update },
    );
    expect(result.output).toMatchObject({
      status: "NOT_CONFIRMED",
      writes: 0,
      stateModified: false,
    });
    expect(update).not.toHaveBeenCalled();
  });
});
