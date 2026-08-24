import { describe, expect, it } from "vitest";
import {
  auditShopeeProductionStatus,
  evaluateShopeePublicationOffer,
  planShopeePublications,
  type ShopeePublicationChannel,
  type ShopeePublicationCreateInput,
  type ShopeePublicationOffer,
  type ShopeePublicationStore,
} from "./publication";

function offer(
  overrides: Partial<ShopeePublicationOffer> = {},
): ShopeePublicationOffer {
  return {
    id: "offer-1",
    productId: "product-1",
    marketplace: "SHOPEE",
    externalProductId: "1001",
    version: 1,
    status: "READY_TO_PUBLISH",
    title: "Produto sanitizado",
    category: "CASA",
    imageUrl: "https://down-br.img.susercontent.com/file/example",
    affiliateUrl: "https://s.shopee.com.br/AbCdEf",
    originalPrice: "120.00",
    currentPrice: "90.00",
    discountPercentage: "25",
    couponCode: null,
    couponExpiration: null,
    freeShipping: false,
    shippingStatus: "UNKNOWN",
    score: 90,
    sourceCategoryId: "cat-1",
    bestSellerPosition: null,
    sourceHighlightId: null,
    sourceHighlightType: null,
    resolutionStrategy: "OPEN_API_FEED",
    affiliateLinks: [
      {
        id: "link-1",
        slug: "shopee-link-1",
        destination: "https://s.shopee.com.br/AbCdEf",
        active: true,
      },
    ],
    ...overrides,
  };
}

const channel: ShopeePublicationChannel = {
  id: "channel-1",
  type: "TELEGRAM",
  enabled: true,
  allowedMarketplaces: ["SHOPEE"],
  allowedCategories: [],
  minimumScore: 70,
  minimumDiscountPercentage: null,
};

class MemoryStore implements ShopeePublicationStore {
  readonly created = new Map<string, ShopeePublicationCreateInput>();

  constructor(
    readonly offers: ShopeePublicationOffer[] = [offer()],
    readonly channels: ShopeePublicationChannel[] = [channel],
  ) {}

  async listReadyOffers() {
    return this.offers;
  }

  async loadOfferById(offerId: string) {
    const selected = this.offers.find((candidate) => candidate.id === offerId);
    return selected ? { offer: selected, isCurrent: true } : null;
  }

  async listChannels() {
    return this.channels;
  }

  async publicationExists(key: string) {
    return this.created.has(key);
  }

  async createControlledPublication(input: ShopeePublicationCreateInput) {
    await Promise.resolve();
    if (this.created.has(input.idempotencyKey)) {
      return { id: "publication-existing", created: false };
    }
    this.created.set(input.idempotencyKey, input);
    return { id: `publication-${this.created.size}`, created: true };
  }
}

const enabledEnvironment = {
  SHOPEE_PUBLICATION_ENABLED: "true",
  SHOPEE_PUBLICATION_MAX_PER_CYCLE: "2",
  APP_BASE_URL: "https://affiliate.test",
} as NodeJS.ProcessEnv;

describe("controlled Shopee publication", () => {
  it("surfaces stale production state through read-only audit findings", () => {
    const status = {
      mode: "DRY_RUN",
      enabled: true,
      publicationEnabled: true,
      autoDistributionEnabled: true,
      externalSendsEnabled: false,
      publicTracking: {
        ready: false,
        configured: false,
        reason: "NOT_HTTPS",
      },
      telegramEnabled: false,
      whatsappEnabled: false,
      configuredShopeeChannels: {
        total: 0,
        telegram: 0,
        whatsapp: 0,
        manual: 0,
      },
      candidateCount: 3,
      plannedCount: 1,
      publishedToday: 0,
      dailyLimit: 12,
      nextAllowedPublicationAt: null,
      lastPublicationAt: null,
      lastPublicationStatus: null,
      lastErrorCode: null,
      freshness: { fresh: 2, stale: 2 },
      ranking: { candidatePool: 3 },
      enrichment: { enabled: false, maxItems: 24 },
      lastProductionRun: null,
      telegram: { pending: 0, sentToday: 0, failed: 0, deliveryUncertain: 0 },
      whatsapp: {
        pending: 0,
        queued: 0,
        sentToday: 0,
        failed: 0,
        deliveryUncertain: 0,
      },
      lock: { held: false, owner: null, ttlMs: 0, mode: "unavailable" },
      externalRequests: 0,
      stateModified: false,
    } as const;
    const findings = auditShopeeProductionStatus(status);
    expect(findings.map((finding) => finding.code)).toEqual([
      "SHOPEE_STALE_OFFERS_PENDING",
      "SHOPEE_DISTRIBUTION_WITHOUT_CHANNEL",
    ]);
    expect(
      auditShopeeProductionStatus({
        ...status,
        externalSendsEnabled: true,
      }).map((finding) => finding.code),
    ).toContain("SHOPEE_PUBLIC_TRACKING_URL_NOT_CONFIGURED");
  });

  it("rejects an offer without a canonical AffiliateLink", () => {
    expect(
      evaluateShopeePublicationOffer(
        offer({ affiliateUrl: null, affiliateLinks: [] }),
      ),
    ).toBe("SHOPEE_AFFILIATE_LINK_MISSING");
  });

  it("rejects an offer from the wrong marketplace", () => {
    expect(
      evaluateShopeePublicationOffer(offer({ marketplace: "AMAZON" })),
    ).toBe("SHOPEE_OFFER_WRONG_MARKETPLACE");
  });

  it("uses only the canonical AffiliateLink destination and internal slug", async () => {
    const store = new MemoryStore();
    const result = await planShopeePublications({
      store,
      environment: enabledEnvironment,
      confirmCreatePublication: true,
    });
    expect(result.publicationsCreated).toBe(1);
    const created = [...store.created.values()][0]!;
    expect(created.affiliateDestination).toBe("https://s.shopee.com.br/AbCdEf");
    expect(created.trackingUrl).toBe("https://affiliate.test/go/shopee-link-1");
  });

  it("persists intact Portuguese and emoji through the production path", async () => {
    const store = new MemoryStore(
      [
        offer({
          id: "offer-0",
          productId: "product-0",
          title: "É promoção válida: coração e ação",
          freeShipping: true,
          shippingStatus: "FREE",
        }),
      ],
      [{ ...channel, id: "channel-0" }],
    );
    const result = await planShopeePublications({
      store,
      environment: enabledEnvironment,
      confirmCreatePublication: true,
    });
    const message = [...store.created.values()][0]?.message ?? "";
    expect(result.publicationsCreated).toBe(1);
    for (const expected of [
      "PREÇO",
      "É",
      "R$",
      "á",
      "ç",
      "✅",
      "🛒",
      "🤯",
    ]) {
      expect(message).toContain(expected);
    }
    for (const suspicious of ["├", "┬", "Ô£", "­ƒ", "Ã§", "âœ"]) {
      expect(message).not.toContain(suspicious);
    }
  });

  it("reports an existing Publication as a duplicate", async () => {
    const store = new MemoryStore();
    store.created.set(
      "publication:channel-1:offer-1",
      {} as ShopeePublicationCreateInput,
    );
    const result = await planShopeePublications({
      store,
      environment: enabledEnvironment,
      confirmCreatePublication: true,
    });
    expect(result.duplicates).toBe(1);
    expect(result.publicationsCreated).toBe(0);
  });

  it("is race-safe when two planners target the same Offer/channel", async () => {
    const store = new MemoryStore();
    const [first, second] = await Promise.all([
      planShopeePublications({
        store,
        environment: enabledEnvironment,
        confirmCreatePublication: true,
      }),
      planShopeePublications({
        store,
        environment: enabledEnvironment,
        confirmCreatePublication: true,
      }),
    ]);
    expect(first.publicationsCreated + second.publicationsCreated).toBe(1);
    expect(store.created).toHaveLength(1);
  });

  it("keeps preview read-only", async () => {
    const store = new MemoryStore();
    const result = await planShopeePublications({
      store,
      environment: enabledEnvironment,
      preview: true,
    });
    expect(result.status).toBe("PREVIEW_COMPLETED");
    expect(result.writes).toBe(0);
    expect(result.publicationsCreated).toBe(0);
    expect(result.messagesSent).toBe(0);
    expect(result.stateModified).toBe(false);
    expect(store.created).toHaveLength(0);
  });

  it("loads and plans only the requested current Offer", async () => {
    const store = new MemoryStore([
      offer({ id: "offer-not-requested", productId: "product-other" }),
      offer({ id: "offer-canary", productId: "product-canary" }),
    ]);
    const result = await planShopeePublications({
      store,
      environment: enabledEnvironment,
      offerId: "offer-canary",
      preview: true,
    });
    expect(result.candidates).toBe(1);
    expect(result.planned).toBe(1);
    expect(result.decisions).toEqual([
      expect.objectContaining({ offerId: "offer-canary", result: "PLANNED" }),
    ]);
  });

  it("fails closed when the requested Offer does not exist", async () => {
    const store = new MemoryStore();
    const result = await planShopeePublications({
      store,
      environment: enabledEnvironment,
      offerId: "missing-offer",
      preview: true,
    });
    expect(result).toMatchObject({
      candidates: 0,
      planned: 0,
      reasons: { SHOPEE_OFFER_NOT_FOUND: 1 },
      writes: 0,
      stateModified: false,
    });
  });

  it("fails closed when the requested Offer is not the current version", async () => {
    const store = new MemoryStore();
    store.loadOfferById = async () => ({
      offer: offer(),
      isCurrent: false,
    });
    const result = await planShopeePublications({
      store,
      environment: enabledEnvironment,
      offerId: "offer-1",
      preview: true,
    });
    expect(result.reasons).toEqual({ SHOPEE_OFFER_NOT_CURRENT: 1 });
    expect(result.planned).toBe(0);
  });

  it("fails closed without reading the store when disabled", async () => {
    let reads = 0;
    const store = new MemoryStore();
    store.listReadyOffers = async () => {
      reads += 1;
      return [offer()];
    };
    const result = await planShopeePublications({
      store,
      environment: {},
      preview: true,
    });
    expect(result.status).toBe("DISABLED");
    expect(result.reasons).toEqual({ SHOPEE_PUBLICATION_DISABLED: 1 });
    expect(reads).toBe(0);
  });
});
