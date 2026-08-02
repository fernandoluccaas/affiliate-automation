import { describe, expect, it, vi } from "vitest";
import type { Channel, Offer, Prisma } from "@affiliate/database";
import { createMercadoLivreDiscoveryMetrics } from "@affiliate/marketplace-discovery";
import { generateMessageForOffer } from "@affiliate/ai-copywriter";
import {
  compareReadyOfferPriority,
  createLockedWorkerDependencies,
  createPublicationIdempotently,
  getChannelMessageFooter,
  hasAssistedGroupPendingCapacity,
  headlineFromMessagePayload,
  isExperimentalWhatsAppGroup,
  publicationRetryDelayMs,
  publishScheduledOffers,
  resolvePublicationUrl,
  runWorkerCycle,
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
      "ACHADINHO DO DIA\n\nProduto teste\n\nPor: R$ 345,99\n\nCompre aqui:\nhttps://example.com/go/slug",
    source: "DETERMINISTIC_FALLBACK",
    aiProvider: "DETERMINISTIC",
    aiValidationPassed: false,
    aiValidationReasons: [],
    generatedAt: new Date("2026-07-24T12:00:00.000Z"),
  }),
}));

describe("promotional message channel context", () => {
  it("reads only an explicitly configured footer", () => {
    expect(getChannelMessageFooter({ messageFooter: "Siga o canal" })).toBe(
      "Siga o canal",
    );
    expect(getChannelMessageFooter({ footer: "  Rodapé  " })).toBe("Rodapé");
    expect(getChannelMessageFooter({ chatId: "123" })).toBeNull();
  });

  it("extracts the first non-empty line as the headline", () => {
    expect(
      headlineFromMessagePayload({ message: "\n  PROMO DO DIA  \n\nProduto" }),
    ).toBe("PROMO DO DIA");
    expect(headlineFromMessagePayload({ message: 123 })).toBeNull();
  });
});

describe("assisted WhatsApp group capacity", () => {
  it("applies pending limits independently per group", () => {
    const group = (id: string, maxPendingPublications: number) =>
      ({
        id,
        type: "WHATSAPP_GROUPS",
        configuration: {
          publicationMode: "ASSISTED",
          maxPendingPublications,
        },
      }) as unknown as Channel;

    expect(hasAssistedGroupPendingCapacity(group("group-a", 3), 3)).toBe(false);
    expect(hasAssistedGroupPendingCapacity(group("group-b", 3), 0)).toBe(true);
  });
});

describe("experimental WhatsApp group isolation", () => {
  it("selects only WHATSAPP_GROUPS configured as WEB_EXPERIMENTAL", () => {
    expect(
      isExperimentalWhatsAppGroup({
        type: "WHATSAPP_GROUPS",
        configuration: { publicationMode: "WEB_EXPERIMENTAL" },
      } as unknown as Channel),
    ).toBe(true);
    expect(
      isExperimentalWhatsAppGroup({
        type: "WHATSAPP_GROUPS",
        configuration: { publicationMode: "ASSISTED" },
      } as unknown as Channel),
    ).toBe(false);
    expect(
      isExperimentalWhatsAppGroup({
        type: "TELEGRAM",
        configuration: { publicationMode: "WEB_EXPERIMENTAL" },
      } as unknown as Channel),
    ).toBe(false);
  });
});

vi.mock("@affiliate/redis", () => ({
  acquireLock: vi.fn().mockResolvedValue({
    acquired: true,
    release: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("createPublicationIdempotently", () => {
  it("uses bounded exponential publication retry delays and honors Retry-After", () => {
    expect(
      [1, 2, 3, 4, 5].map((attempt) => publicationRetryDelayMs(attempt)),
    ).toEqual([60_000, 300_000, 900_000, 1_800_000, 1_800_000]);
    expect(publicationRetryDelayMs(1, 90)).toBe(90_000);
  });

  it("prioritizes never-published, score, discount, ranking and recency deterministically", () => {
    const base = {
      publishedAt: null,
      score: 80,
      discountPercentage: 10,
      bestSellerPosition: 8,
      collectedAt: new Date("2026-07-30T10:00:00.000Z"),
    };
    const offers = [
      { ...base, id: "published", publishedAt: new Date() },
      { ...base, id: "rank-2", bestSellerPosition: 2 },
      { ...base, id: "discount", discountPercentage: 20 },
      { ...base, id: "score", score: 90 },
      { ...base, id: "rank-1", bestSellerPosition: 1 },
    ];

    expect(
      offers.sort(compareReadyOfferPriority).map((offer) => offer.id),
    ).toEqual(["score", "discount", "rank-1", "rank-2", "published"]);
  });

  it("uses direct affiliate URL for Mercado Livre offers", () => {
    const offer = {
      marketplace: "MERCADO_LIVRE",
      trackingStrategy: "DIRECT_AFFILIATE_LINK",
      affiliateUrl: "https://www.mercadolivre.com.br/sec/affiliate",
      affiliateLinks: [
        {
          id: "link-1",
          slug: "mlb1",
          destination: "https://www.mercadolivre.com.br/sec/affiliate",
          active: true,
        },
      ],
    };

    expect(resolvePublicationUrl(offer as never)).toEqual({
      url: "https://www.mercadolivre.com.br/sec/affiliate",
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
      sourceCategoryId: "MLB123",
      bestSellerPosition: 8,
      sourceHighlightId: "MLBSPARSE",
      sourceHighlightType: "ITEM",
      resolutionStrategy: "ITEM_DIRECT",
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
    const publicationCount = vi.fn().mockResolvedValue(0);

    Object.assign(actual.prisma, {
      offer: {
        findMany: vi.fn().mockResolvedValue([offer]),
        update: offerUpdate,
      },
      channel: { findMany: vi.fn().mockResolvedValue([channel]) },
      publication: {
        count: publicationCount,
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([
          {
            messagePayload: {
              message: "HEADLINE RECENTE\n\nProduto anterior",
            },
          },
        ]),
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
    expect(publicationCount).toHaveBeenCalledWith({
      where: expect.objectContaining({
        channelId: "channel-1",
        scheduledAt: {
          gte: new Date("2026-07-24T03:00:00.000Z"),
          lt: new Date("2026-07-25T03:00:00.000Z"),
        },
      }),
    });
    expect(vi.mocked(generateMessageForOffer)).toHaveBeenCalledWith(
      expect.objectContaining({
        seed: "channel-1:offer-sparse",
        recentHeadlines: ["HEADLINE RECENTE"],
        footer: null,
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          offerId: "offer-sparse",
          channelId: "channel-1",
          status: "SCHEDULED",
          originalPriceSnapshot: null,
          discountPercentageSnapshot: null,
          shippingStatusSnapshot: "UNKNOWN",
          sourceCategoryIdSnapshot: "MLB123",
          bestSellerPositionSnapshot: 8,
          sourceHighlightIdSnapshot: "MLBSPARSE",
          sourceHighlightTypeSnapshot: "ITEM",
          resolutionStrategySnapshot: "ITEM_DIRECT",
        }),
      }),
    );
  });

  it("creates one assisted WhatsApp pending snapshot without marking it published", async () => {
    const actual = await import("@affiliate/database");
    const now = new Date("2026-08-02T12:00:00.000Z");
    const offer = {
      id: "offer-whatsapp-v1",
      productId: "product-whatsapp",
      title: "Produto Mercado Livre",
      externalProductId: "MLB123",
      marketplace: "MERCADO_LIVRE",
      category: "Eletronicos",
      imageUrl: "https://cdn.example.com/image.jpg",
      originalPrice: 120,
      currentPrice: 90,
      discountPercentage: 25,
      couponCode: null,
      couponExpiration: null,
      freeShipping: true,
      shippingStatus: "FREE",
      stockStatus: "IN_STOCK",
      score: 90,
      scoreCompletenessPercentage: 100,
      affiliateUrl: "https://meli.la/whatsapp",
      trackingStrategy: "DIRECT_AFFILIATE_LINK",
      version: 1,
      sourceCategoryId: "MLB1000",
      bestSellerPosition: 1,
      sourceHighlightId: "MLB123",
      sourceHighlightType: "ITEM",
      resolutionStrategy: "ITEM_DIRECT",
      affiliateLinks: [],
      collectedAt: now,
      publishedAt: null,
    };
    const channel = {
      id: "channel-whatsapp",
      name: "Grupo principal",
      type: "WHATSAPP_GROUPS",
      enabled: true,
      timezone: "America/Fortaleza",
      dailyPublicationLimit: 10,
      minimumIntervalMinutes: 0,
      allowedStartTime: null,
      allowedEndTime: null,
      minimumScore: 0,
      minDiscountPercentage: 0,
      productRepeatIntervalDays: 0,
      allowedMarketplaces: ["MERCADO_LIVRE"],
      allowedCategories: [],
      configuration: {
        publicationMode: "ASSISTED",
        groupDisplayName: "Grupo principal",
        maxPendingPublications: 5,
        sendImage: true,
      },
      createdAt: now,
      updatedAt: now,
    };
    let publicationCreated = false;
    const upsert = vi.fn().mockImplementation(() => {
      publicationCreated = true;
      return { id: "publication-whatsapp" };
    });
    const findFirst = vi
      .fn()
      .mockImplementation((input: { where?: { idempotencyKey?: string } }) =>
        input?.where?.idempotencyKey && publicationCreated
          ? { id: "publication-whatsapp" }
          : null,
      );
    const offerUpdate = vi.fn().mockResolvedValue(offer);
    Object.assign(actual.prisma, {
      offer: {
        findMany: vi.fn().mockResolvedValue([offer]),
        update: offerUpdate,
      },
      channel: { findMany: vi.fn().mockResolvedValue([channel]) },
      publication: {
        count: vi.fn().mockResolvedValue(0),
        findFirst,
        findMany: vi.fn().mockResolvedValue([]),
        upsert,
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback({ publication: { upsert }, offer: { update: offerUpdate } }),
      ),
    });

    const first = await scheduleReadyOffers(now);
    expect(first).toMatchObject({
      scheduled: 1,
      published: 0,
      whatsappGroupAssistedPrepared: 1,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          idempotencyKey: "publication:channel-whatsapp:offer-whatsapp-v1",
        },
        create: expect.objectContaining({
          status: "AWAITING_MANUAL_PUBLICATION",
          imageUrlSnapshot: "https://cdn.example.com/image.jpg",
          metadata: expect.objectContaining({
            publicationMode: "ASSISTED",
            whatsappDestinationType: "GROUP",
            groupDisplayNameSnapshot: "Grupo principal",
          }),
        }),
      }),
    );
    expect(offerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SCHEDULED" }),
      }),
    );

    const second = await scheduleReadyOffers(now);
    expect(second.scheduled).toBe(0);
    expect(second.skipReasons.DUPLICATE_PUBLICATION).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("does not create new assisted publications for legacy WHATSAPP_CHANNEL records", async () => {
    const actual = await import("@affiliate/database");
    const upsert = vi.fn();
    Object.assign(actual.prisma, {
      offer: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "offer-legacy",
            marketplace: "MERCADO_LIVRE",
            category: null,
            score: 90,
            scoreCompletenessPercentage: 100,
            discountPercentage: 20,
            stockStatus: "IN_STOCK",
            shippingStatus: "FREE",
            affiliateLinks: [],
          },
        ]),
      },
      channel: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "legacy-channel",
            type: "WHATSAPP_CHANNEL",
            enabled: true,
            timezone: "America/Fortaleza",
            dailyPublicationLimit: 3,
            minimumIntervalMinutes: 60,
            allowedStartTime: null,
            allowedEndTime: null,
            minimumScore: 0,
            minDiscountPercentage: 0,
            productRepeatIntervalDays: 0,
            allowedMarketplaces: [],
            allowedCategories: [],
            configuration: { publicationMode: "ASSISTED" },
          },
        ]),
      },
      publication: { upsert },
    });

    const metrics = await scheduleReadyOffers(
      new Date("2026-08-02T12:00:00.000Z"),
    );

    expect(metrics.scheduled).toBe(0);
    expect(metrics.skipReasons.CHANNEL_TYPE_UNAVAILABLE).toBe(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("schedules the same Offer version once for each compatible channel", async () => {
    const actual = await import("@affiliate/database");
    const now = new Date("2026-07-30T12:00:00.000Z");
    const offer = {
      id: "offer-multi-channel",
      productId: "product-multi",
      title: "Oferta para dois canais",
      externalProductId: "MLB-MULTI",
      marketplace: "MERCADO_LIVRE",
      category: "Tecnologia",
      imageUrl: null,
      originalPrice: 200,
      currentPrice: 100,
      discountPercentage: 50,
      couponCode: null,
      couponExpiration: null,
      freeShipping: true,
      shippingStatus: "FREE",
      stockStatus: "IN_STOCK",
      score: 90,
      scoreCompletenessPercentage: 80,
      affiliateUrl: "https://meli.la/multi",
      trackingStrategy: "DIRECT_AFFILIATE_LINK",
      version: 1,
      collectedAt: now,
      bestSellerPosition: 1,
      affiliateLinks: [],
    };
    const channelBase = {
      name: "Grupo",
      type: "WHATSAPP_GROUPS",
      enabled: true,
      timezone: "America/Sao_Paulo",
      dailyPublicationLimit: 10,
      minimumIntervalMinutes: 0,
      allowedStartTime: null,
      allowedEndTime: null,
      minimumScore: 0,
      minDiscountPercentage: 0,
      productRepeatIntervalDays: 0,
      allowedMarketplaces: ["MERCADO_LIVRE"],
      allowedCategories: [],
      configuration: {
        publicationMode: "ASSISTED",
        groupDisplayName: "Grupo",
        maxPendingPublications: 3,
      },
      createdAt: now,
      updatedAt: now,
    };
    const channels = [
      {
        ...channelBase,
        id: "channel-general",
        configuration: {
          ...channelBase.configuration,
          groupDisplayName: "Grupo geral",
        },
      },
      {
        ...channelBase,
        id: "channel-tech",
        configuration: {
          ...channelBase.configuration,
          groupDisplayName: "Grupo tecnologia",
        },
      },
    ];
    const upsert = vi.fn().mockImplementation(({ create }) => ({
      ...create,
      id: `publication-${create.channelId}`,
      createdAt: now,
      updatedAt: now,
    }));
    const offerUpdate = vi.fn().mockResolvedValue(offer);

    Object.assign(actual.prisma, {
      offer: {
        findMany: vi.fn().mockResolvedValue([offer]),
        update: offerUpdate,
      },
      channel: { findMany: vi.fn().mockResolvedValue(channels) },
      publication: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        upsert,
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
        callback({
          publication: { upsert },
          offer: { update: offerUpdate },
        }),
      ),
    });

    const metrics = await scheduleReadyOffers(now);

    expect(metrics.scheduled).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls.map(([input]) => input.create.channelId)).toEqual([
      "channel-general",
      "channel-tech",
    ]);
  });

  it("publishes at most one queued row per channel after restart", async () => {
    const actual = await import("@affiliate/database");
    const now = new Date("2026-07-30T12:00:00.000Z");
    const offer = {
      id: "offer-queued",
      imageUrl: null,
      affiliateLinks: [],
    };
    const channel = (id: string) => ({
      id,
      type: "MANUAL_EXPORT",
      configuration: null,
    });
    const publication = (id: string, channelId: string) => ({
      id,
      offerId: offer.id,
      channelId,
      status: "SCHEDULED",
      messagePayload: {
        offerId: offer.id,
        channelId,
        trackingUrl: "https://meli.la/queued",
        message: "Mensagem",
      },
      offer,
      channel: channel(channelId),
      attempts: [],
    });
    const attemptCreate = vi.fn().mockResolvedValue({});
    const publicationUpdate = vi.fn().mockResolvedValue({});
    Object.assign(actual.prisma, {
      publication: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            publication("publication-a1", "channel-a"),
            publication("publication-a2", "channel-a"),
            publication("publication-b1", "channel-b"),
          ]),
        update: publicationUpdate,
      },
      publicationAttempt: { create: attemptCreate },
    });

    const metrics = await publishScheduledOffers(now);

    expect(metrics.exported).toBe(2);
    expect(attemptCreate).toHaveBeenCalledTimes(2);
    expect(
      attemptCreate.mock.calls.map(([input]) => input.data.publicationId),
    ).toEqual(["publication-a1", "publication-b1"]);
  });

  it("persists Telegram Retry-After and blocks immediate retry", async () => {
    const actual = await import("@affiliate/database");
    const now = new Date("2026-07-30T12:00:00.000Z");
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousChat = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "test-chat";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 90 },
        }),
      }),
    );
    const publicationUpdate = vi.fn().mockResolvedValue({});
    Object.assign(actual.prisma, {
      publication: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "publication-429",
            offerId: "offer-429",
            channelId: "channel-429",
            status: "SCHEDULED",
            messagePayload: {
              offerId: "offer-429",
              channelId: "channel-429",
              trackingUrl: "https://meli.la/retry",
              message: "Mensagem",
            },
            offer: {
              id: "offer-429",
              imageUrl: null,
              affiliateLinks: [],
            },
            channel: {
              id: "channel-429",
              type: "TELEGRAM",
              configuration: null,
            },
            attempts: [],
          },
        ]),
        update: publicationUpdate,
      },
      publicationAttempt: { create: vi.fn().mockResolvedValue({}) },
      systemAlert: { create: vi.fn().mockResolvedValue({}) },
    });

    const metrics = await publishScheduledOffers(now);

    expect(metrics.failed).toBe(1);
    expect(publicationUpdate).toHaveBeenCalledWith({
      where: { id: "publication-429" },
      data: expect.objectContaining({
        status: "FAILED",
        scheduledAt: new Date("2026-07-30T12:01:30.000Z"),
      }),
    });

    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previousChat;
    vi.unstubAllGlobals();
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

function workerJobMetrics(
  overrides: Partial<{
    readyOffersFound: number;
    scheduled: number;
    published: number;
    exported: number;
    failed: number;
    retried: number;
    expired: number;
    skipped: number;
  }> = {},
) {
  return {
    readyOffersFound: 0,
    scheduled: 0,
    published: 0,
    exported: 0,
    failed: 0,
    retried: 0,
    expired: 0,
    skipped: 0,
    skipReasons: {},
    ...overrides,
  };
}

describe("continuous worker Redis coordination", () => {
  function rawDependencies() {
    return {
      discovery: vi.fn().mockResolvedValue({ operationalMetrics: {} }),
      publication: vi.fn().mockResolvedValue({}),
      retry: vi.fn().mockResolvedValue({}),
      maintenance: vi.fn().mockResolvedValue({}),
    };
  }

  const cadences = {
    discovery: 60_000,
    publication: 60_000,
    retry: 60_000,
    maintenance: 60_000,
  };

  it("blocks required workloads while Redis is down and recovers without restart", async () => {
    const raw = rawDependencies();
    const recordOutcome = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const acquire = vi
      .fn()
      .mockResolvedValueOnce({
        key: "worker:continuous:discovery",
        token: "down",
        acquired: false,
        mode: "redis-url",
        failureReason: "REDIS_UNAVAILABLE",
        extend: vi.fn().mockResolvedValue(false),
        release: vi.fn().mockResolvedValue(undefined),
      })
      .mockResolvedValueOnce({
        key: "worker:continuous:discovery",
        token: "recovered",
        acquired: true,
        mode: "redis-url",
        extend: vi.fn().mockResolvedValue(true),
        release,
      });
    const locked = createLockedWorkerDependencies(raw, cadences, {
      acquireLock: acquire,
      requireRedis: true,
      recordOutcome,
    });
    const now = new Date("2026-07-30T16:00:00.000Z");

    await expect(locked.discovery(now)).resolves.toMatchObject({
      workerComponentOutcome: {
        status: "FAILED",
        lockBackend: "UNAVAILABLE",
        rootCause: "REDIS_UNAVAILABLE",
      },
    });
    expect(raw.discovery).not.toHaveBeenCalled();
    await expect(locked.discovery(now)).resolves.toMatchObject({
      workerComponentOutcome: {
        status: "SUCCEEDED",
        lockBackend: "AVAILABLE",
      },
    });
    expect(raw.discovery).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledWith(
      "discovery",
      now,
      expect.objectContaining({ rootCause: "REDIS_UNAVAILABLE" }),
    );
  });

  it("classifies an occupied lock as SKIPPED instead of Redis unavailable", async () => {
    const raw = rawDependencies();
    const recordOutcome = vi.fn().mockResolvedValue(undefined);
    const locked = createLockedWorkerDependencies(raw, cadences, {
      requireRedis: true,
      recordOutcome,
      acquireLock: vi.fn().mockResolvedValue({
        key: "worker:continuous:publication",
        token: "held",
        acquired: false,
        mode: "redis-url",
        failureReason: "LOCK_ALREADY_HELD",
        extend: vi.fn().mockResolvedValue(false),
        release: vi.fn().mockResolvedValue(undefined),
      }),
    });

    await expect(locked.publication(new Date())).resolves.toMatchObject({
      workerComponentOutcome: {
        status: "SKIPPED",
        lockBackend: "AVAILABLE",
        rootCause: "LOCK_ALREADY_HELD",
      },
    });
    expect(raw.publication).not.toHaveBeenCalled();
  });

  it("keeps optional development mode permissive when lock acquisition fails", async () => {
    const raw = rawDependencies();
    const locked = createLockedWorkerDependencies(raw, cadences, {
      requireRedis: false,
      recordOutcome: vi.fn(),
      acquireLock: vi.fn().mockRejectedValue(new Error("connection failed")),
    });

    await expect(locked.maintenance(new Date())).resolves.toMatchObject({
      workerComponentOutcome: {
        status: "SUCCEEDED",
        lockBackend: "UNAVAILABLE",
        rootCause: "REDIS_UNAVAILABLE",
      },
    });
    expect(raw.maintenance).toHaveBeenCalledTimes(1);
  });
});

describe("runWorkerCycle", () => {
  it("records a partial cycle and continues refresh, scheduling, retries and publishing after discovery fails", async () => {
    const actual = await import("@affiliate/database");
    const now = new Date("2026-07-28T20:00:00.000Z");
    const automationRunUpdate = vi.fn().mockResolvedValue({});
    const systemAlertCreate = vi.fn().mockResolvedValue({});
    Object.assign(actual.prisma, {
      automationRun: {
        create: vi.fn().mockResolvedValue({ id: "worker-run-1" }),
        update: automationRunUpdate,
      },
      systemAlert: { create: systemAlertCreate },
    });
    const discovery = vi.fn().mockResolvedValue({
      ok: false,
      status: "FAILED",
      metrics: createMercadoLivreDiscoveryMetrics(),
      errorCode: "MELI_API_UNAVAILABLE",
      errorMessage: "Mercado Livre discovery failed with HTTP 503.",
    });
    const refresh = vi
      .fn()
      .mockResolvedValue({ ...workerJobMetrics(), selected: 2, refreshed: 2 });
    const schedule = vi
      .fn()
      .mockResolvedValue(workerJobMetrics({ scheduled: 1 }));
    const retry = vi.fn().mockResolvedValue(workerJobMetrics({ retried: 1 }));
    const publish = vi
      .fn()
      .mockResolvedValue(workerJobMetrics({ published: 1 }));
    const processLinkJobs = vi.fn().mockResolvedValue({
      selected: 0,
      processed: 0,
      failed: 0,
    });

    const result = await runWorkerCycle(now, {
      expireInvalidOffers: vi
        .fn()
        .mockResolvedValue(workerJobMetrics({ expired: 1 })),
      collectMercadoLivreCandidates: discovery,
      processAffiliateLinkJobs: processLinkJobs,
      refreshMercadoLivreOffers: refresh,
      scheduleReadyOffers: schedule,
      retryFailedPublications: retry,
      publishScheduledOffers: publish,
    } as never);

    expect(discovery).toHaveBeenCalledWith(now);
    expect(processLinkJobs).toHaveBeenCalledWith({ limit: 10 });
    expect(refresh).toHaveBeenCalledWith(now);
    expect(schedule).toHaveBeenCalledWith(now);
    expect(retry).toHaveBeenCalledWith(now);
    expect(publish).toHaveBeenCalledWith(now);
    expect(result).toMatchObject({
      expired: 1,
      scheduled: 1,
      retried: 1,
      published: 1,
      stages: {
        discovery: {
          status: "FAILED",
          errorCode: "MELI_API_UNAVAILABLE",
        },
        refresh: { status: "SUCCEEDED" },
        schedule: { status: "SUCCEEDED" },
        publish: { status: "SUCCEEDED" },
      },
    });
    expect(automationRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "worker-run-1" },
        data: expect.objectContaining({
          status: "PARTIAL",
          finishedAt: expect.any(Date),
          errorMessage: expect.stringContaining("MELI_API_UNAVAILABLE"),
        }),
      }),
    );
    expect(systemAlertCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "worker.discovery",
          severity: "ERROR",
          metadata: expect.objectContaining({
            runId: "worker-run-1",
            errorCode: "MELI_API_UNAVAILABLE",
          }),
        }),
      }),
    );
  });

  it("finishes a fully successful cycle as SUCCEEDED without an error message", async () => {
    const actual = await import("@affiliate/database");
    const automationRunUpdate = vi.fn().mockResolvedValue({});
    const systemAlertCreate = vi.fn().mockResolvedValue({});
    Object.assign(actual.prisma, {
      automationRun: {
        create: vi.fn().mockResolvedValue({ id: "worker-run-success" }),
        update: automationRunUpdate,
      },
      systemAlert: { create: systemAlertCreate },
    });
    const now = new Date("2026-07-28T20:30:00.000Z");

    const result = await runWorkerCycle(now, {
      expireInvalidOffers: vi.fn().mockResolvedValue(workerJobMetrics()),
      collectMercadoLivreCandidates: vi.fn().mockResolvedValue({
        ok: true,
        status: "SUCCEEDED",
        importJobId: "import-success",
        metrics: createMercadoLivreDiscoveryMetrics(),
      }),
      processAffiliateLinkJobs: vi.fn().mockResolvedValue({
        selected: 0,
        processed: 0,
        failed: 0,
      }),
      refreshMercadoLivreOffers: vi.fn().mockResolvedValue({
        ...workerJobMetrics(),
        selected: 0,
        refreshed: 0,
        unchanged: 0,
        newVersions: 0,
        notFound: 0,
        affiliateUrlsPreserved: 0,
        itemsFetched: 0,
        priceApiFetched: 0,
        priceFallbackUsed: 0,
        priceUnavailable: 0,
        failures: [],
      }),
      scheduleReadyOffers: vi
        .fn()
        .mockResolvedValue(workerJobMetrics({ scheduled: 1 })),
      retryFailedPublications: vi.fn().mockResolvedValue(workerJobMetrics()),
      publishScheduledOffers: vi
        .fn()
        .mockResolvedValue(workerJobMetrics({ published: 1 })),
    } as never);

    expect(result).toMatchObject({
      scheduled: 1,
      published: 1,
      stages: {
        expire: { status: "SUCCEEDED" },
        discovery: { status: "SUCCEEDED" },
        "affiliate-links": { status: "SUCCEEDED" },
        refresh: { status: "SUCCEEDED" },
        schedule: { status: "SUCCEEDED" },
        retry: { status: "SUCCEEDED" },
        publish: { status: "SUCCEEDED" },
      },
    });
    expect(automationRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "worker-run-success" },
        data: expect.objectContaining({
          status: "SUCCEEDED",
          finishedAt: expect.any(Date),
          errorMessage: null,
        }),
      }),
    );
    expect(systemAlertCreate).not.toHaveBeenCalled();
  });

  it("sanitizes a thrown stage error and still executes later independent stages", async () => {
    const actual = await import("@affiliate/database");
    const secret = "session-secret-value";
    const automationRunUpdate = vi.fn().mockResolvedValue({});
    const systemAlertCreate = vi.fn().mockResolvedValue({});
    Object.assign(actual.prisma, {
      automationRun: {
        create: vi.fn().mockResolvedValue({ id: "worker-run-2" }),
        update: automationRunUpdate,
      },
      systemAlert: { create: systemAlertCreate },
    });
    const publish = vi.fn().mockResolvedValue(workerJobMetrics());

    await runWorkerCycle(new Date("2026-07-28T21:00:00.000Z"), {
      expireInvalidOffers: vi.fn().mockResolvedValue(workerJobMetrics()),
      collectMercadoLivreCandidates: vi
        .fn()
        .mockRejectedValue(new Error(`Cookie: sid=${secret}`)),
      processAffiliateLinkJobs: vi.fn().mockResolvedValue({
        selected: 0,
        processed: 0,
        failed: 0,
      }),
      refreshMercadoLivreOffers: vi.fn().mockResolvedValue({
        ...workerJobMetrics(),
        selected: 0,
        refreshed: 0,
      }),
      scheduleReadyOffers: vi.fn().mockResolvedValue(workerJobMetrics()),
      retryFailedPublications: vi.fn().mockResolvedValue(workerJobMetrics()),
      publishScheduledOffers: publish,
    } as never);

    expect(publish).toHaveBeenCalled();
    expect(
      JSON.stringify([
        automationRunUpdate.mock.calls,
        systemAlertCreate.mock.calls,
      ]),
    ).not.toContain(secret);
  });
});
