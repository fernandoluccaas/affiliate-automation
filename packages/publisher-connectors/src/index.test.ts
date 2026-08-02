import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssistedWhatsAppChannelPublisher,
  DisabledWhatsAppWebPublisher,
  ManualExportPublisher,
  TelegramPublisher,
  type PublicationPayload,
} from "./index";

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
    expect(result.rawResponse).toMatchObject({
      exportedOnly: true,
      message: payload.message,
    });
  });
});

describe("WhatsApp Channel publishers", () => {
  it("prepares assisted output without claiming delivery", async () => {
    await expect(
      new AssistedWhatsAppChannelPublisher().publish(payload),
    ).resolves.toEqual({
      status: "AWAITING_MANUAL_PUBLICATION",
      publicationMode: "ASSISTED",
      mediaFallbackUsed: false,
    });
  });

  it("keeps Web automation inert regardless of feature flags", async () => {
    process.env.WHATSAPP_CHANNEL_WEB_EXPERIMENTAL_ENABLED = "true";
    await expect(new DisabledWhatsAppWebPublisher().publish(payload)).resolves.toMatchObject({
      status: "DISABLED",
      errorCode: "WHATSAPP_WEB_AUTOMATION_NOT_AUTHORIZED",
    });
  });
});

describe("TelegramPublisher retry classification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns Retry-After for Telegram 429 without a text fallback burst", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 90 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new TelegramPublisher({
      botToken: "secret-token",
      chatId: "chat-1",
    }).publish(payload);

    expect(result).toMatchObject({
      status: "FAILED",
      failureKind: "TRANSIENT",
      errorCode: "TELEGRAM_429",
      retryAfterSeconds: 90,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies Telegram 500 as transient", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ ok: false }),
      }),
    );

    await expect(
      new TelegramPublisher({
        botToken: "secret-token",
        chatId: "chat-1",
      }).publish({ ...payload, imageUrl: null }),
    ).resolves.toMatchObject({
      status: "FAILED",
      failureKind: "TRANSIENT",
      errorCode: "TELEGRAM_HTTP_500",
    });
  });

  it("classifies invalid chat errors as permanent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          error_code: 400,
          description: "Bad Request: chat not found",
        }),
      }),
    );

    await expect(
      new TelegramPublisher({
        botToken: "secret-token",
        chatId: "chat-1",
      }).publish({ ...payload, imageUrl: null }),
    ).resolves.toMatchObject({
      status: "FAILED",
      failureKind: "PERMANENT",
      errorCode: "TELEGRAM_400",
    });
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

  it("sends Telegram JSON as UTF-8 without mojibake", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 789 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const message =
      "\u{1F525} Produto em promoção\n\u{1F6D2} Confira\nSão Luís\nPreço válido";
    await new TelegramPublisher({
      botToken: "secret-token",
      chatId: "chat-1",
      timeoutMs: 1000,
    }).publish({ ...payload, imageUrl: null, message });

    const [, request] = fetchMock.mock.calls[0]!;
    const body = String((request as RequestInit).body);
    const parsed = JSON.parse(body) as { text: string };

    expect((request as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(parsed.text).toBe(message);
    expect(body).toContain("\u{1F525}");
    expect(body).toContain("\u{1F6D2}");
    expect(body).toContain("São Luís");
    expect(body).toContain("Preço válido");
    expect(body).not.toContain("Ã°Å¸");
    expect(body).not.toContain("Ãƒ");
    expect(body).not.toContain("Ã‚");
  });
});
