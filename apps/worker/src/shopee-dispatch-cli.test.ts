import { describe, expect, it, vi } from "vitest";
import { executeShopeeDispatchCommand } from "./shopee-dispatch-cli";

const readyPreview = {
  status: "READY",
  allowed: true,
  reason: null,
  publicationId: "publication-fixture",
  offerId: "offer-fixture",
  channelId: "channel-fixture",
  channelType: "TELEGRAM",
  trackingUrlValid: true,
  trackingUrlReason: null,
  canonicalAffiliateLink: true,
  externalRequests: 0,
  writes: 0,
  messagesSent: 0,
  stateModified: false,
} as const;

describe("Shopee controlled dispatch CLI", () => {
  it("keeps preview read-only", async () => {
    const activateTelegram = vi.fn();
    const telegram = vi.fn();
    const result = await executeShopeeDispatchCommand(
      [
        "preview",
        "--publication-id",
        "publication-fixture",
        "--channel-id",
        "channel-fixture",
      ],
      {
        preview: vi.fn(async () => readyPreview),
        activateTelegram,
        telegram,
      },
    );
    expect(result).toMatchObject({
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
    });
    expect(activateTelegram).not.toHaveBeenCalled();
    expect(telegram).not.toHaveBeenCalled();
  });

  it("requires explicit send confirmation", async () => {
    const activateTelegram = vi.fn();
    const telegram = vi.fn();
    await expect(
      executeShopeeDispatchCommand(
        [
          "send",
          "--publication-id",
          "publication-fixture",
          "--channel-id",
          "channel-fixture",
        ],
        {
          preview: vi.fn(async () => readyPreview),
          activateTelegram,
          telegram,
        },
      ),
    ).rejects.toThrow("SHOPEE_DISPATCH_NOT_CONFIRMED");
    expect(activateTelegram).not.toHaveBeenCalled();
    expect(telegram).not.toHaveBeenCalled();
  });

  it("activates before reusing the targeted production Telegram dispatcher", async () => {
    const events: string[] = [];
    const now = new Date("2026-08-25T12:00:00.000Z");
    const activateTelegram = vi.fn(async () => {
      events.push("activate");
      return {
        ok: true,
        status: "ACTIVATED",
        publicationId: "publication-fixture",
        channelId: "channel-fixture",
      } as const;
    });
    const telegram = vi.fn(async () => {
      events.push("publish");
      return { published: 1 };
    });
    const result = await executeShopeeDispatchCommand(
      [
        "send",
        "--publication-id",
        "publication-fixture",
        "--channel-id",
        "channel-fixture",
        "--confirm-send",
      ],
      {
        preview: vi.fn(async () => readyPreview),
        activateTelegram,
        telegram,
        now: () => now,
      },
    );
    expect(result).toEqual({ published: 1 });
    expect(activateTelegram).toHaveBeenCalledWith({
      publicationId: "publication-fixture",
      channelId: "channel-fixture",
      now,
    });
    expect(telegram).toHaveBeenCalledWith(
      "publication-fixture",
      "channel-fixture",
      now,
    );
    expect(events).toEqual(["activate", "publish"]);
  });

  it("does not call a transport when preview is blocked", async () => {
    const activateTelegram = vi.fn();
    const telegram = vi.fn();
    const result = await executeShopeeDispatchCommand(
      [
        "send",
        "--publication-id",
        "publication-fixture",
        "--channel-id",
        "channel-fixture",
        "--confirm-send",
      ],
      {
        preview: vi.fn(
          async () =>
            ({
              ...readyPreview,
              status: "BLOCKED",
              allowed: false,
              reason: "SHOPEE_TRACKING_URL_NOT_PUBLIC_HTTPS",
              trackingUrlValid: false,
              trackingUrlReason: "PRIVATE_HOST",
            }) as const,
        ),
        activateTelegram,
        telegram,
      },
    );
    expect((result as { status: string }).status).toBe("BLOCKED");
    expect(activateTelegram).not.toHaveBeenCalled();
    expect(telegram).not.toHaveBeenCalled();
  });

  it("does not publish when controlled activation is blocked", async () => {
    const telegram = vi.fn();
    const result = await executeShopeeDispatchCommand(
      [
        "send",
        "--publication-id",
        "publication-fixture",
        "--channel-id",
        "channel-fixture",
        "--confirm-send",
      ],
      {
        preview: vi.fn(async () => readyPreview),
        activateTelegram: vi.fn(
          async () =>
            ({
              ok: false,
              code: "SHOPEE_CONTROLLED_PUBLICATION_NOT_ACTIVATABLE",
            }) as const,
        ),
        telegram,
      },
    );
    expect(result).toMatchObject({
      status: "BLOCKED",
      allowed: false,
      reason: "SHOPEE_CONTROLLED_PUBLICATION_NOT_ACTIVATABLE",
      writes: 0,
      messagesSent: 0,
      stateModified: false,
    });
    expect(telegram).not.toHaveBeenCalled();
  });
});
