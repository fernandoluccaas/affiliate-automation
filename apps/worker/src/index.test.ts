import { describe, expect, it, vi } from "vitest";
import type { Channel, Offer, Prisma } from "@affiliate/database";
import {
  createPublicationIdempotently,
  resolvePublicationUrl,
  scheduleReadyOffers,
} from "./index";

vi.mock("@affiliate/database", async () => {
  const actual = await vi.importActual<typeof import("@affiliate/database")>(
    "@affiliate/database",
  );
  return {
    ...actual,
    prisma: {},
  };
});

vi.mock("@affiliate/ai-copywriter", () => ({
  generateMessageForOffer: vi.fn().mockResolvedValue({
    message:
      "\u{1F525} Produto teste\n\nPor R$ 345,99\n\n\u{1F6D2} Confira:\nhttps://example.com/go/slug\n\n#publi - link de afiliado",
    source: "DETERMINISTIC_FALLBACK",
    aiProvider: "DETERMINISTIC",
    aiValidationPassed: false,
    aiValidationReasons: [],
    generatedAt: new Date("2026-07-24T12:00:00.000Z"),
  }),
}));

vi.mock("@affiliate/redis", () => ({
  acquireLock: vi.fn().mockResolvedValue({
    acquired: true,
    release: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("createPublicationIdempotently", () => {
  it("uses direct affiliate URL for Mercado Livre offers", () => {
    const offer = {
      marketplace: "MERCADO_LIVRE",
      trackingStrategy: "DIRECT_AFFILIATE_LINK",
      affiliateUrl: "https://mercadolivre.com/sec/affiliate",
      affiliateLinks: [
        {
          id: "link-1",
          slug: "mlb1",
          destination: "https://mercadolivre.com/sec/affiliate",
          active: true,
        },
      ],
    };

    expect(resolvePublicationUrl(offer as never)).toEqual({
      url: "https://mercadolivre.com/sec/affiliate",
      affiliateLinkId: null,
    });
    expect(resolvePublicationUrl(offer as never)?.url).not.toContain("/go/");
  });

  it("imports Mercado Livre jobs with the shared ingestion package", async () => {
    const jobs = await import("@affiliate/marketplace-discovery");

    expect(typeof jobs.collectMercadoLivreCandidates).toBe("function");
    expect(typeof jobs.refreshMercadoLivreOffers).toBe("function");
  });

  it("does not publish Mercado Livre offers without affiliate URL", () => {
    const offer = {
      marketplace: "MERCADO_LIVRE",
      trackingStrategy: "DIRECT_AFFILIATE_LINK",
      affiliateUrl: null,
      affiliateLinks: [],
    };

    expect(resolvePublicationUrl(offer as never)).toBeNull();
  });

  it("only queries READY_TO_PUBLISH offers for scheduling", async () => {
    const actual = await import("@affiliate/database");
    const findManyOffers = vi.fn().mockResolvedValue([]);
    const findManyChannels = vi.fn().mockResolvedValue([]);
    Object.assign(actual.prisma, {
      offer: { findMany: findManyOffers },
      channel: { findMany: findManyChannels },
    });

    await scheduleReadyOffers(new Date("2026-07-24T12:00:00.000Z"));

    expect(findManyOffers).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "READY_TO_PUBLISH" },
      }),
    );
  });

  it("schedules a sparse READY_TO_PUBLISH offer for a channel without optional minimums", async () => {
    const actual = await import("@affiliate/database");
    const now = new Date("2026-07-24T12:00:00.000Z");
    const offer = {
      id: "offer-sparse",
      productId: "product-1",
      title: "Produto teste sem dados enriquecidos",
      externalProductId: "produto-opcional-001",
      marketplace: "SHOPEE",
      category: null,
      imageUrl: null,
      originalPrice: null,
      currentPrice: 345.99,
      discountPercentage: null,
      couponCode: null,
      couponExpiration: null,
      freeShipping: false,
      shippingStatus: "UNKNOWN",
      stockStatus: "UNKNOWN",
      score: 100,
      scoreCompletenessPercentage: 10,
      affiliateUrl: "https://example.com/affiliate",
      version: 1,
      affiliateLinks: [
        {
          id: "link-1",
          slug: "produto-opcional-001",
          destination: "https://example.com/affiliate",
          active: true,
        },
      ],
    };
    const channel = {
      id: "channel-1",
      name: "Telegram teste",
      type: "TELEGRAM",
      enabled: true,
      timezone: "America/Fortaleza",
      dailyPublicationLimit: 10,
      minimumIntervalMinutes: 0,
      allowedStartTime: null,
      allowedEndTime: null,
      minimumScore: 0,
      minDiscountPercentage: 0,
      productRepeatIntervalDays: 0,
      allowedMarketplaces: ["SHOPEE"],
      allowedCategories: [],
      configuration: { chatId: "chat-1" },
      createdAt: now,
      updatedAt: now,
    };
    const upsert = vi.fn().mockResolvedValue({
      id: "publication-1",
      createdAt: now,
      updatedAt: now,
    });
    const offerUpdate = vi.fn().mockResolvedValue(offer);

    Object.assign(actual.prisma, {
      offer: {
        findMany: vi.fn().mockResolvedValue([offer]),
        update: offerUpdate,
      },
      channel: { findMany: vi.fn().mockResolvedValue([channel]) },
      publication: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
        upsert,
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback({ publication: { upsert }, offer: { update: offerUpdate } }),
      ),
    });

    const metrics = await scheduleReadyOffers(now);

    expect(metrics).toMatchObject({
      readyOffersFound: 1,
      scheduled: 1,
      skipped: 0,
      skipReasons: {},
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          offerId: "offer-sparse",
          channelId: "channel-1",
          status: "SCHEDULED",
          originalPriceSnapshot: null,
          discountPercentageSnapshot: null,
          shippingStatusSnapshot: "UNKNOWN",
        }),
      }),
    );
  });

  it("uses a stable channel and offer idempotency key", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "publication-1" });
    const tx = {
      publication: { upsert },
    } as unknown as Prisma.TransactionClient;
    const offer = {
      id: "offer-1",
      title: "Oferta v1",
      externalProductId: "sku-1",
      marketplace: "SHOPEE",
      category: "Casa",
      originalPrice: 100,
      currentPrice: 40,
      discountPercentage: 60,
      couponCode: "PROMO10",
      couponExpiration: new Date("2026-07-24T12:00:00.000Z"),
      freeShipping: true,
      affiliateUrl: "https://example.com/affiliate",
      version: 1,
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
        offerTitleSnapshot: "Oferta v1",
        productExternalIdSnapshot: "sku-1",
        offerVersionSnapshot: 1,
        trackingUrlSnapshot: "https://example.com/go/slug",
      }),
    });
  });

  it("uses different idempotency keys for different Offer versions", async () => {
    const upsert = vi.fn().mockResolvedValue({ id: "publication" });
    const tx = {
      publication: { upsert },
    } as unknown as Prisma.TransactionClient;
    const channel = { id: "channel-1" } as Channel;
    const payload = {
      offerId: "offer-1",
      channelId: "channel-1",
      trackingUrl: "https://example.com/go/slug",
      message: "Mensagem",
      messageSource: "DETERMINISTIC_FALLBACK" as const,
      aiProvider: "DETERMINISTIC" as const,
      aiValidationPassed: false,
      aiValidationReasons: [],
      generatedAt: "2026-07-23T12:00:00.000Z",
    };
    const now = new Date("2026-07-23T12:00:00.000Z");
    const baseOffer = {
      title: "Oferta",
      externalProductId: "sku-1",
      marketplace: "SHOPEE",
      originalPrice: 100,
      currentPrice: 40,
      discountPercentage: 60,
      freeShipping: false,
      affiliateLinks: [],
    };

    await createPublicationIdempotently(
      tx,
      { ...baseOffer, id: "offer-v1", version: 1 } as unknown as Offer & {
        affiliateLinks: [];
      },
      channel,
      { ...payload, offerId: "offer-v1" },
      now,
    );
    await createPublicationIdempotently(
      tx,
      { ...baseOffer, id: "offer-v2", version: 2 } as unknown as Offer & {
        affiliateLinks: [];
      },
      channel,
      { ...payload, offerId: "offer-v2" },
      now,
    );

    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { idempotencyKey: "publication:channel-1:offer-v1" },
      }),
    );
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { idempotencyKey: "publication:channel-1:offer-v2" },
      }),
    );
  });
});
