import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@affiliate/database";
import type { CouponProvider } from "@affiliate/shared";
import {
  loadCouponIntelligenceStatus,
  previewOfferCoupons,
  refreshOfferCoupons,
} from "./coupon-intelligence-service";

const now = new Date("2026-08-24T12:00:00.000Z");
const offer = {
  id: "offer-1",
  marketplace: "SHOPEE" as const,
  externalProductId: "product-1",
  sellerId: "seller-1",
  currentPrice: { toString: () => "100.00" },
  coupons: [],
};

function database(overrides: Record<string, unknown> = {}) {
  return {
    coupon: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    offer: {
      findUnique: vi.fn().mockResolvedValue(offer),
    },
    $transaction: vi.fn(),
    ...overrides,
  } as unknown as PrismaClient;
}

const enabled = {
  COUPON_INTELLIGENCE_ENABLED: "true",
  SHOPEE_COUPON_DISCOVERY_ENABLED: "true",
} as NodeJS.ProcessEnv;

describe("coupon intelligence service", () => {
  it("reports both official providers as unsupported without external work", async () => {
    const result = await loadCouponIntelligenceStatus({
      database: database(),
      environment: {},
      now,
    });
    expect(result.shopee.sourceSupported).toBe(false);
    expect(result.mercadoLivre.sourceSupported).toBe(false);
    expect(result.externalRequests).toBe(0);
    expect(result.writes).toBe(0);
  });

  it("keeps preview read-only", async () => {
    const db = database();
    const result = await previewOfferCoupons({
      offerId: "offer-1",
      database: db,
      now,
    });
    expect(result).toMatchObject({
      status: "PREVIEW",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before reading the database or provider", async () => {
    const db = database();
    const provider = {
      marketplace: "SHOPEE",
      discoverCoupons: vi.fn(),
      refreshCoupons: vi.fn(),
    } as unknown as CouponProvider;
    await expect(
      refreshOfferCoupons({
        offerId: "offer-1",
        confirmRefresh: false,
        database: db,
        providers: { SHOPEE: provider },
      }),
    ).rejects.toThrow("COUPON_REFRESH_NOT_CONFIRMED");
    expect(db.offer.findUnique).not.toHaveBeenCalled();
    expect(provider.refreshCoupons).not.toHaveBeenCalled();
  });

  it("does not write when the current official provider is unsupported", async () => {
    const db = database();
    const result = await refreshOfferCoupons({
      offerId: "offer-1",
      confirmRefresh: true,
      database: db,
      environment: enabled,
      now,
    });
    expect(result).toMatchObject({
      status: "UNSUPPORTED",
      reason: "SHOPEE_AFFILIATE_COUPON_DISCOVERY_UNAVAILABLE",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("reconciles supported mock candidates idempotently by source key", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const db = database({
      offer: { findUnique: vi.fn().mockResolvedValue(offer) },
      $transaction: vi.fn(async (callback) =>
        callback({ coupon: { upsert, updateMany } }),
      ),
    });
    const provider: CouponProvider = {
      marketplace: "SHOPEE",
      discoverCoupons: vi.fn(),
      refreshCoupons: vi.fn().mockResolvedValue({
        supported: true,
        reason: null,
        source: "SHOPEE_OFFICIAL_MOCK",
        externalRequests: 1,
        candidates: [
          {
            marketplace: "SHOPEE",
            externalCouponId: "voucher-1",
            code: "OFF10",
            benefitType: "PERCENTAGE",
            percentage: "10",
            autoApply: false,
            scope: "PRODUCT",
            sellerId: "seller-1",
            productExternalId: "product-1",
            source: "SHOPEE_OFFICIAL_MOCK",
            status: "ACTIVE",
            active: true,
            lastValidatedAt: now,
            applicability: "CONFIRMED",
            confidence: 100,
          },
        ],
      }),
    };
    const input = {
      offerId: "offer-1",
      confirmRefresh: true,
      database: db,
      environment: enabled,
      providers: { SHOPEE: provider },
      now,
    };
    await refreshOfferCoupons(input);
    await refreshOfferCoupons(input);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0]?.[0].where).toEqual(
      upsert.mock.calls[1]?.[0].where,
    );
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { code: "OFF10" },
      create: {
        code: "OFF10",
        sourceKey: "SHOPEE_OFFICIAL_MOCK:voucher-1",
      },
    });
  });

  it("persists an automatic coupon with null code and a deterministic source key", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const db = database({
      offer: { findUnique: vi.fn().mockResolvedValue(offer) },
      $transaction: vi.fn(async (callback) =>
        callback({ coupon: { upsert, updateMany } }),
      ),
    });
    const provider: CouponProvider = {
      marketplace: "SHOPEE",
      discoverCoupons: vi.fn(),
      refreshCoupons: vi.fn().mockResolvedValue({
        supported: true,
        reason: null,
        source: "SHOPEE_OFFICIAL_MOCK",
        externalRequests: 1,
        candidates: [
          {
            marketplace: "SHOPEE",
            externalCouponId: null,
            code: null,
            benefitType: "AUTOMATIC",
            percentage: "10",
            autoApply: true,
            scope: "PRODUCT",
            sellerId: "seller-1",
            productExternalId: "product-1",
            source: "SHOPEE_OFFICIAL_MOCK",
            status: "ACTIVE",
            active: true,
            lastValidatedAt: now,
            applicability: "CONFIRMED",
            confidence: 100,
          },
        ],
      }),
    };

    const result = await refreshOfferCoupons({
      offerId: "offer-1",
      confirmRefresh: true,
      database: db,
      environment: enabled,
      providers: { SHOPEE: provider },
      now,
    });

    expect(upsert).toHaveBeenCalledOnce();
    const upsertInput = upsert.mock.calls[0]?.[0];
    const expectedSourceKey =
      "SHOPEE_OFFICIAL_MOCK:AUTO:AUTOMATIC:10::::PRODUCT:seller-1:product-1";
    expect(upsertInput).toMatchObject({
      where: {
        offerId_sourceKey: {
          offerId: "offer-1",
          sourceKey: expectedSourceKey,
        },
      },
      update: {
        code: null,
        discountAmount: null,
        minimumSpend: null,
        maximumDiscount: null,
        startsAt: null,
        expiresAt: null,
      },
      create: {
        externalCouponId: null,
        sourceKey: expectedSourceKey,
        code: null,
        discountAmount: null,
        minimumSpend: null,
        maximumDiscount: null,
        startsAt: null,
        expiresAt: null,
      },
    });
    expect(upsertInput.create.sourceKey).not.toBe("");
    expect(result.bestCoupon).toMatchObject({
      code: null,
      sourceKey: expectedSourceKey,
      autoApply: true,
      benefitType: "AUTOMATIC",
    });
  });
});
