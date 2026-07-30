import { describe, expect, it, vi } from "vitest";
import type { Channel, Offer, Prisma } from "@affiliate/database";
import { createMercadoLivreDiscoveryMetrics } from "@affiliate/marketplace-discovery";
import { generateMessageForOffer } from "@affiliate/ai-copywriter";
import {
  createPublicationIdempotently,
  getChannelMessageFooter,
  headlineFromMessagePayload,
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

    Object.assign(actual.prisma, {
      offer: {
        findMany: vi.fn().mockResolvedValue([offer]),
        update: offerUpdate,
      },
      channel: { findMany: vi.fn().mockResolvedValue([channel]) },
      publication: {
        count: vi.fn().mockResolvedValue(0),
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
