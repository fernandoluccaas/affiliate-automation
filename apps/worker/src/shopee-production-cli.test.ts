import { describe, expect, it, vi } from "vitest";
import { executeShopeeProductionCommand } from "./shopee-production-cli";

describe("Shopee production CLI", () => {
  it("does not run a production tick without confirmation", async () => {
    const tick = vi.fn();
    await expect(
      executeShopeeProductionCommand(["tick"], { tick }),
    ).rejects.toThrow("SHOPEE_PRODUCTION_NOT_CONFIRMED");
    expect(tick).not.toHaveBeenCalled();
  });

  it("keeps preview at zero effects", async () => {
    const preview = vi.fn(async () => ({
      status: "PREVIEW" as const,
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    }));
    const result = await executeShopeeProductionCommand(["preview"], {
      status: vi.fn(
        async () =>
          ({
            mode: "READY",
            configuredShopeeChannels: { total: 1, telegram: 1, whatsapp: 0 },
          }) as never,
      ),
      preview: preview as never,
    });
    expect(result).toMatchObject({
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
  });
});
