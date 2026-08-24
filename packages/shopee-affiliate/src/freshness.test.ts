import { describe, expect, it, vi } from "vitest";
import {
  ensureShopeePublicationFreshness,
  evaluateShopeeOfferFreshness,
  expireStaleShopeeOffers,
  type ShopeeFreshnessRecord,
  type ShopeeFreshnessStore,
} from "./freshness";
import type { PrismaClient } from "@affiliate/database";

const now = new Date("2026-08-23T15:00:00.000Z");
const environment = {
  SHOPEE_AFFILIATE_ENABLED: "true",
  SHOPEE_AFFILIATE_MODE: "HYBRID",
  SHOPEE_OPEN_API_APP_ID: "fixture-app",
  SHOPEE_OPEN_API_SECRET: "fixture-secret",
  SHOPEE_PUBLICATION_MAX_OFFER_AGE_HOURS: "24",
  SHOPEE_REFRESH_BEFORE_PUBLICATION: "true",
} as NodeJS.ProcessEnv;

function record(
  overrides: Partial<ShopeeFreshnessRecord> = {},
): ShopeeFreshnessRecord {
  return {
    publicationId: "publication-1",
    offerId: "offer-1",
    channelId: "channel-1",
    marketplace: "SHOPEE",
    externalProductId: "100",
    currentPrice: 80,
    collectedAt: new Date("2026-08-23T14:00:00.000Z"),
    verifiedAt: null,
    duplicate: false,
    affiliateLinks: [
      { active: true, destination: "https://s.shopee.com.br/canonical" },
    ],
    ...overrides,
  };
}

class MemoryStore implements ShopeeFreshnessStore {
  refreshed = 0;
  cancelled: string[] = [];

  constructor(readonly value: ShopeeFreshnessRecord | null) {}

  async load() {
    return this.value;
  }

  async markRefreshed() {
    this.refreshed += 1;
  }

  async cancel(input: { reason: string }) {
    this.cancelled.push(input.reason);
  }
}

function enrichment(priceMin = 80) {
  return {
    itemId: "100",
    shopId: "200",
    priceMin,
    priceMax: priceMin,
    sales: 10,
    ratingStar: 4.8,
    commissionRate: 8,
    sellerCommissionRate: null,
    shopeeCommissionRate: null,
    commission: null,
    productLink: "https://shopee.com.br/product/200/100",
    offerLink: "https://s.shopee.com.br/metadata-only",
    periodStartTime: null,
    periodEndTime: null,
    available: null,
  };
}

describe("Shopee publication freshness", () => {
  it("fails closed when the requested Publication does not exist", async () => {
    const result = await ensureShopeePublicationFreshness({
      publicationId: "missing-publication",
      environment,
      now,
      store: new MemoryStore(null),
    });
    expect(result).toMatchObject({
      publicationId: "missing-publication",
      offerId: null,
      allowed: false,
      reason: "SHOPEE_OFFER_NO_LONGER_ELIGIBLE",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
  });

  it("accepts a fresh offer without Open API", async () => {
    const refreshClient = { enrichItem: vi.fn() };
    const result = await ensureShopeePublicationFreshness({
      publicationId: "publication-1",
      environment,
      now,
      store: new MemoryStore(record()),
      refreshClient,
    });
    expect(result).toMatchObject({
      allowed: true,
      reason: "SHOPEE_OFFER_FRESH",
      refreshAttempted: false,
    });
    expect(refreshClient.enrichItem).not.toHaveBeenCalled();
  });

  it("detects stale age deterministically", () => {
    expect(
      evaluateShopeeOfferFreshness({
        collectedAt: new Date("2026-08-21T15:00:00.000Z"),
        now,
        maxAgeHours: 24,
      }),
    ).toBe(false);
  });

  it("refreshes a stale unchanged offer", async () => {
    const store = new MemoryStore(
      record({ collectedAt: new Date("2026-08-21T15:00:00.000Z") }),
    );
    const result = await ensureShopeePublicationFreshness({
      publicationId: "publication-1",
      environment,
      now,
      store,
      refreshClient: { enrichItem: vi.fn().mockResolvedValue(enrichment()) },
    });
    expect(result).toMatchObject({
      allowed: true,
      refreshAttempted: true,
      refreshSucceeded: true,
    });
    expect(store.refreshed).toBe(1);
  });

  it("cancels on refresh failure", async () => {
    const store = new MemoryStore(
      record({ collectedAt: new Date("2026-08-21T15:00:00.000Z") }),
    );
    const result = await ensureShopeePublicationFreshness({
      publicationId: "publication-1",
      environment,
      now,
      store,
      refreshClient: {
        enrichItem: vi.fn().mockRejectedValue(new Error("fixture")),
      },
    });
    expect(result.reason).toBe("SHOPEE_OFFER_REFRESH_FAILED");
    expect(store.cancelled).toEqual(["SHOPEE_OFFER_REFRESH_FAILED"]);
  });

  it("cancels when refreshed commercial data no longer matches the snapshot", async () => {
    const store = new MemoryStore(
      record({ collectedAt: new Date("2026-08-21T15:00:00.000Z") }),
    );
    const result = await ensureShopeePublicationFreshness({
      publicationId: "publication-1",
      environment,
      now,
      store,
      refreshClient: { enrichItem: vi.fn().mockResolvedValue(enrichment(70)) },
    });
    expect(result.reason).toBe("SHOPEE_OFFER_NO_LONGER_ELIGIBLE");
    expect(store.refreshed).toBe(0);
  });

  it("cancels a duplicate Publication before dispatch", async () => {
    const store = new MemoryStore(record({ duplicate: true }));
    const result = await ensureShopeePublicationFreshness({
      publicationId: "publication-1",
      environment,
      now,
      store,
    });
    expect(result.reason).toBe("SHOPEE_PUBLICATION_DUPLICATE");
  });

  it("cancels when the canonical AffiliateLink is missing", async () => {
    const store = new MemoryStore(record({ affiliateLinks: [] }));
    const result = await ensureShopeePublicationFreshness({
      publicationId: "publication-1",
      environment,
      now,
      store,
    });
    expect(result.reason).toBe("SHOPEE_AFFILIATE_LINK_MISSING");
  });

  it("expires stale offers and cancels pending Publications without deleting history", async () => {
    const offerUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const publicationUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      offer: {
        findMany: vi.fn().mockResolvedValue([{ id: "offer-1" }]),
        updateMany: offerUpdateMany,
      },
      publication: { updateMany: publicationUpdateMany },
    };
    const database = {
      $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    } as unknown as PrismaClient;
    const result = await expireStaleShopeeOffers({
      confirmExpire: true,
      environment,
      now,
      database,
    });
    expect(result).toEqual({
      expired: 1,
      cancelled: 1,
      writes: 2,
      stateModified: true,
    });
    expect(publicationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED" }),
      }),
    );
    expect(offerUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REJECTED_EXPIRED" }),
      }),
    );
  });
});
