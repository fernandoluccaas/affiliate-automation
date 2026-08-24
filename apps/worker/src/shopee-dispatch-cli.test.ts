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
    const telegram = vi.fn();
    const result = await executeShopeeDispatchCommand(
      [
        "preview",
        "--publication-id",
        "publication-fixture",
        "--channel-id",
        "channel-fixture",
      ],
      { preview: vi.fn(async () => readyPreview), telegram },
    );
    expect(result).toMatchObject({
      externalRequests: 0,
      writes: 0,
      messagesSent: 0,
    });
    expect(telegram).not.toHaveBeenCalled();
  });

  it("requires explicit send confirmation", async () => {
    await expect(
      executeShopeeDispatchCommand(
        [
          "send",
          "--publication-id",
          "publication-fixture",
          "--channel-id",
          "channel-fixture",
        ],
        { preview: vi.fn(async () => readyPreview) },
      ),
    ).rejects.toThrow("SHOPEE_DISPATCH_NOT_CONFIRMED");
  });

  it("reuses the production Telegram dispatcher after every gate passes", async () => {
    const telegram = vi.fn(async () => ({ published: 1 }));
    const result = await executeShopeeDispatchCommand(
      [
        "send",
        "--publication-id",
        "publication-fixture",
        "--channel-id",
        "channel-fixture",
        "--confirm-send",
      ],
      { preview: vi.fn(async () => readyPreview), telegram },
    );
    expect(result).toEqual({ published: 1 });
    expect(telegram).toHaveBeenCalledWith(
      "publication-fixture",
      "channel-fixture",
    );
  });

  it("does not call a transport when preview is blocked", async () => {
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
        telegram,
      },
    );
    expect((result as { status: string }).status).toBe("BLOCKED");
    expect(telegram).not.toHaveBeenCalled();
  });
});
