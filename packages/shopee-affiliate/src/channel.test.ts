import { describe, expect, it, vi } from "vitest";
import {
  inspectShopeeChannelPolicies,
  updateShopeeChannelPolicy,
  type ShopeeChannelPolicyRecord,
  type ShopeeChannelPolicyStore,
} from "./channel";

function memory(initial: ShopeeChannelPolicyRecord[]) {
  const records = new Map(initial.map((channel) => [channel.id, channel]));
  const updateAllowedMarketplaces = vi.fn(
    async (id: string, allowedMarketplaces: string[]) => {
      const current = records.get(id)!;
      const updated = { ...current, allowedMarketplaces };
      records.set(id, updated);
      return updated;
    },
  );
  const store: ShopeeChannelPolicyStore = {
    list: async () => [...records.values()],
    load: async (id) => records.get(id) ?? null,
    updateAllowedMarketplaces,
  };
  return { store, updateAllowedMarketplaces };
}

const telegram: ShopeeChannelPolicyRecord = {
  id: "channel-1",
  type: "TELEGRAM",
  enabled: true,
  allowedMarketplaces: ["MERCADO_LIVRE"],
};

describe("Shopee Channel policy", () => {
  it("previews without writes", async () => {
    const fixture = memory([telegram]);
    const result = await inspectShopeeChannelPolicies({
      channelId: telegram.id,
      store: fixture.store,
    });
    expect(result).toMatchObject({
      total: 1,
      writes: 0,
      externalRequests: 0,
      stateModified: false,
    });
    expect(fixture.updateAllowedMarketplaces).not.toHaveBeenCalled();
  });

  it("requires confirmation", async () => {
    await expect(
      updateShopeeChannelPolicy({
        channelId: telegram.id,
        action: "ENABLE",
        confirmed: false,
        store: memory([telegram]).store,
      }),
    ).rejects.toThrow("SHOPEE_CHANNEL_CHANGE_NOT_CONFIRMED");
  });

  it("enables Shopee while preserving Mercado Livre", async () => {
    const fixture = memory([telegram]);
    const result = await updateShopeeChannelPolicy({
      channelId: telegram.id,
      action: "ENABLE",
      confirmed: true,
      store: fixture.store,
    });
    expect(result.after.allowedMarketplaces).toEqual([
      "MERCADO_LIVRE",
      "SHOPEE",
    ]);
    expect(result.writes).toBe(1);
  });

  it("disables only Shopee", async () => {
    const fixture = memory([
      { ...telegram, allowedMarketplaces: ["MERCADO_LIVRE", "SHOPEE"] },
    ]);
    const result = await updateShopeeChannelPolicy({
      channelId: telegram.id,
      action: "DISABLE",
      confirmed: true,
      store: fixture.store,
    });
    expect(result.after.allowedMarketplaces).toEqual(["MERCADO_LIVRE"]);
  });

  it("is idempotent", async () => {
    const fixture = memory([
      { ...telegram, allowedMarketplaces: ["MERCADO_LIVRE", "SHOPEE"] },
    ]);
    const result = await updateShopeeChannelPolicy({
      channelId: telegram.id,
      action: "ENABLE",
      confirmed: true,
      store: fixture.store,
    });
    expect(result).toMatchObject({
      status: "UNCHANGED",
      writes: 0,
      stateModified: false,
    });
  });
});
