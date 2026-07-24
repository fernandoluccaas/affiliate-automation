import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualExportPublisher, TelegramPublisher, type PublicationPayload } from "./index";

const payload: PublicationPayload = {
  offerId: "offer-1",
  channelId: "channel-1",
  trackingUrl: "https://example.com/go/slug",
  message: "Mensagem confirmada",
  imageUrl: "https://example.com/image.jpg",
};

describe("ManualExportPublisher", () => {
  it("exports without marking external publication as published", async () => {
    const result = await new ManualExportPublisher().publish(payload);

    expect(result.status).toBe("EXPORTED");
    expect(result.rawResponse).toMatchObject({ exportedOnly: true, message: payload.message });
  });
});

describe("TelegramPublisher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes an image with sanitized response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 123 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new TelegramPublisher({
      botToken: "secret-token",
      chatId: "chat-1",
      timeoutMs: 1000,
    }).publish(payload);

    expect(result).toMatchObject({ status: "PUBLISHED", externalId: "123" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/sendPhoto"),
      expect.objectContaining({
        body: expect.stringContaining(payload.message),
      }),
    );
    expect(JSON.stringify(result.rawResponse)).not.toContain("secret-token");
  });

  it("falls back to text when image publication fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ ok: false, description: "bad image" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 456 } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new TelegramPublisher({
      botToken: "secret-token",
      chatId: "chat-1",
      timeoutMs: 1000,
    }).publish(payload);

    expect(result).toMatchObject({ status: "PUBLISHED", externalId: "456" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
