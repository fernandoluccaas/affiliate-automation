import { describe, expect, it } from "vitest";
import type { Marketplace, OfferStatus, Prisma, StockStatus } from "@affiliate/database";
import { ingestOfferInTransaction } from "./offer-ingest";
import type { OfferFormValues } from "./offer-form-schema";

type ProductRecord = {
  id: string;
  marketplace: Marketplace;
  externalProductId: string;
  title: string;
  productUrl: string;
};

type OfferRecord = {
  id: string;
  marketplace: Marketplace;
  externalProductId: string;
  title: string;
  productUrl: string;
  affiliateUrl: string | null;
  status: OfferStatus;
  statusReason: string | null;
  score: number | null;
  stockStatus: StockStatus;
};

type AffiliateLinkRecord = {
  id: string;
  offerId: string;
  slug: string;
};

type UpsertArgs<TRecord extends { marketplace: Marketplace; externalProductId: string }> = {
  where: { marketplace_externalProductId: { marketplace: Marketplace; externalProductId: string } };
  update: Partial<TRecord>;
  create: TRecord;
};

function validOffer(overrides: Partial<OfferFormValues> = {}): OfferFormValues {
  return {
    marketplace: "SHOPEE",
    externalProductId: "sku-1",
    title: "Oferta manual valida",
    description: "Produto cadastrado manualmente",
    category: "Casa",
    imageUrl: "https://example.com/image.jpg",
    productUrl: "https://example.com/product",
    affiliateUrl: "https://example.com/affiliate",
    originalPrice: 100,
    currentPrice: 40,
    couponCode: "PROMO10",
    couponExpiration: new Date("2026-01-02T00:00:00.000Z"),
    commissionPercentage: 20,
    rating: 5,
    salesCount: 100000,
    freeShipping: true,
    stockStatus: "IN_STOCK",
    ...overrides,
  };
}

class FakeTransaction {
  products: ProductRecord[] = [];
  offers: OfferRecord[] = [];
  affiliateLinks: AffiliateLinkRecord[] = [];
  offerScores: Array<Record<string, unknown>> = [];
  coupons: Array<Record<string, unknown>> = [];

  product = {
    upsert: async (args: UpsertArgs<ProductRecord>) => {
      const found = this.products.find(
        (product) =>
          product.marketplace === args.where.marketplace_externalProductId.marketplace &&
          product.externalProductId === args.where.marketplace_externalProductId.externalProductId,
      );

      if (found) {
        Object.assign(found, args.update);
        return found;
      }

      const product = { ...args.create, id: `product-${this.products.length + 1}` };
      this.products.push(product);
      return product;
    },
  };

  offer = {
    findFirst: async (args: {
      where: {
        marketplace: Marketplace;
        externalProductId: { not: string };
        OR: Array<{ productUrl?: string; affiliateUrl?: string }>;
      };
    }) =>
      this.offers.find(
        (offer) =>
          offer.marketplace === args.where.marketplace &&
          offer.externalProductId !== args.where.externalProductId.not &&
          args.where.OR.some(
            (condition) =>
              condition.productUrl === offer.productUrl ||
              condition.affiliateUrl === offer.affiliateUrl,
          ),
      ) ?? null,
    upsert: async (args: UpsertArgs<OfferRecord>) => {
      const found = this.offers.find(
        (offer) =>
          offer.marketplace === args.where.marketplace_externalProductId.marketplace &&
          offer.externalProductId === args.where.marketplace_externalProductId.externalProductId,
      );

      if (found) {
        Object.assign(found, args.update);
        return found;
      }

      const offer = { ...args.create, id: `offer-${this.offers.length + 1}` };
      this.offers.push(offer);
      return offer;
    },
    update: async (args: { where: { id: string }; data: Partial<OfferRecord> }) => {
      const offer = this.offers.find((item) => item.id === args.where.id);

      if (!offer) {
        throw new Error("Offer not found.");
      }

      Object.assign(offer, args.data);
      return offer;
    },
  };

  coupon = {
    deleteMany: async () => ({ count: 0 }),
    create: async (args: { data: Record<string, unknown> }) => {
      this.coupons.push(args.data);
      return args.data;
    },
  };

  offerScore = {
    create: async (args: { data: Record<string, unknown> }) => {
      this.offerScores.push(args.data);
      return args.data;
    },
  };

  affiliateLink = {
    findUnique: async (args: { where: { slug: string } }) =>
      this.affiliateLinks.find((link) => link.slug === args.where.slug) ?? null,
    findFirst: async (args: { where: { offerId: string } }) =>
      this.affiliateLinks.find((link) => link.offerId === args.where.offerId) ?? null,
    create: async (args: { data: { offerId: string; slug: string } }) => {
      const link = { id: `link-${this.affiliateLinks.length + 1}`, ...args.data };
      this.affiliateLinks.push(link);
      return link;
    },
  };
}

async function ingestWithFake(tx: FakeTransaction, input: OfferFormValues) {
  return ingestOfferInTransaction(tx as unknown as Prisma.TransactionClient, input, {
    now: new Date("2026-01-01T00:00:00.000Z"),
    minScore: 70,
  });
}

describe("ingestOfferInTransaction", () => {
  it("ingests a valid offer with score, affiliate link and READY_TO_PUBLISH", async () => {
    const tx = new FakeTransaction();
    const result = await ingestWithFake(tx, validOffer());

    expect(result).toMatchObject({
      ok: true,
      status: "READY_TO_PUBLISH",
      discountPercentage: 60,
    });
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(tx.products).toHaveLength(1);
    expect(tx.offers[0]?.status).toBe("READY_TO_PUBLISH");
    expect(tx.offerScores).toHaveLength(1);
    expect(tx.affiliateLinks).toHaveLength(1);
    expect(tx.coupons).toHaveLength(1);
  });

  it("rejects an offer with invalid prices", async () => {
    const tx = new FakeTransaction();
    const result = await ingestWithFake(tx, validOffer({ currentPrice: 120 }));

    expect(result).toMatchObject({
      ok: false,
      status: "REJECTED_INVALID_DATA",
    });
    expect(result.statusReason).toContain("Current price");
    expect(tx.offers[0]?.status).toBe("REJECTED_INVALID_DATA");
  });

  it("rejects an offer with an expired coupon", async () => {
    const tx = new FakeTransaction();
    const result = await ingestWithFake(
      tx,
      validOffer({ couponExpiration: new Date("2025-12-31T23:59:59.000Z") }),
    );

    expect(result).toMatchObject({
      ok: false,
      status: "REJECTED_EXPIRED",
    });
    expect(tx.offers[0]?.statusReason).toBe("Coupon is expired.");
  });
});
