import { describe, expect, it, vi } from "vitest";
import type { Channel, Offer, Prisma } from "@affiliate/database";
import { createPublicationIdempotently } from "./index";

vi.mock("@affiliate/database", async () => {
  const actual = await vi.importActual<typeof import("@affiliate/database")>("@affiliate/database");
  return {
    ...actual,
    prisma: {},
  };
});

describe("createPublicationIdempotently", () => {
  it("uses a stable channel and offer idempotency key", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "publication-1" });
    const tx = { publication: { upsert } } as unknown as Prisma.TransactionClient;
    const offer = {
      id: "offer-1",
      affiliateLinks: [],
    } as unknown as Offer & { affiliateLinks: [] };
    const channel = { id: "channel-1" } as Channel;
    const payload = {
      offerId: "offer-1",
      channelId: "channel-1",
      trackingUrl: "https://example.com/go/slug",
      message: "Mensagem",
      messageSource: "DETERMINISTIC_FALLBACK" as const,
      aiProvider: "DETERMINISTIC" as const,
      aiValidationPassed: false,
      aiValidationReasons: ["OPENAI_API_KEY is not configured."],
      generatedAt: "2026-07-23T12:00:00.000Z",
    };
    const now = new Date("2026-07-23T12:00:00.000Z");

    await createPublicationIdempotently(tx, offer, channel, payload, now);

    expect(upsert).toHaveBeenCalledWith({
      where: { idempotencyKey: "publication:channel-1:offer-1" },
      update: {},
      create: expect.objectContaining({
        idempotencyKey: "publication:channel-1:offer-1",
        status: "SCHEDULED",
        scheduledAt: now,
        messageSource: "DETERMINISTIC_FALLBACK",
        aiProvider: "DETERMINISTIC",
        aiValidationPassed: false,
      }),
    });
  });
});
