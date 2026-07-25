import { describe, expect, it } from "vitest";
import type { Marketplace, OfferStatus, Prisma, ShippingStatus, StockStatus } from "@affiliate/database";
import { createOfferFingerprint, ingestOfferInTransaction } from "./offer-ingest";
import { offerFormSchema, parseDecimalInput, type OfferFormValues } from "./offer-form-schema";

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
  productId: string;
  version: number;
  offerFingerprint: string;
  title: string;
  description: string | null;
  category: string | null;
  imageUrl: string | null;
  productUrl: string;
  affiliateUrl: string | null;
  affiliateLabel: string | null;
  affiliateEligibility: "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN";
  sellerId: string | null;
  officialStoreId: string | null;
  trackingStrategy: "INTERNAL_REDIRECT" | "DIRECT_AFFILIATE_LINK";
  originalPrice: number | null;
  currentPrice: number;
  discountPercentage: number | null;
  couponCode: string | null;
  couponExpiration: Date | null;
  commissionPercentage: number | null;
  rating: number | null;
  salesCount: number | null;
  freeShipping: boolean;
  shippingStatus: ShippingStatus;
  stockStatus: StockStatus;
  status: OfferStatus;
  statusReason: string | null;
  score: number | null;
  scoreCompletenessPercentage: number | null;
};

type AffiliateLinkRecord = {
  id: string;
  offerId: string;
  slug: string;
  destination: string;
};

type PublicationRecord = {
  id: string;
  offerId: string;
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
    affiliateEligibility: "UNKNOWN",
    originalPrice: 100,
    currentPrice: 40,
    couponCode: "PROMO10",
    couponExpiration: new Date("2026-01-02T00:00:00.000Z"),
    commissionPercentage: 20,
    rating: 5,
    salesCount: 100000,
    ...overrides,
    freeShipping: overrides.freeShipping ?? (overrides.shippingStatus ?? "FREE") === "FREE",
    shippingStatus: overrides.shippingStatus ?? "FREE",
    stockStatus: overrides.stockStatus ?? "IN_STOCK",
  };
}

class FakeTransaction {
  products: ProductRecord[] = [];
  offers: OfferRecord[] = [];
  affiliateLinks: AffiliateLinkRecord[] = [];
  publications: PublicationRecord[] = [];
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
      where?: Record<string, unknown>;
      orderBy?: { version?: "desc" };
      select?: Record<string, boolean>;
    }) => {
      const where = args.where ?? {};

      if (typeof where.productId === "string" && typeof where.offerFingerprint === "string") {
        return (
          this.offers.find(
            (offer) =>
              offer.productId === where.productId && offer.offerFingerprint === where.offerFingerprint,
          ) ?? null
        );
      }

      if (typeof where.productId === "string" && args.orderBy?.version === "desc") {
        const offer = this.offers
          .filter((item) => item.productId === where.productId)
          .sort((left, right) => right.version - left.version)[0];
        return offer && args.select?.version ? { version: offer.version } : (offer ?? null);
      }

      if (
        typeof where.marketplace === "string" &&
        typeof where.productId === "object" &&
        where.productId !== null &&
        "not" in where.productId &&
        Array.isArray(where.OR)
      ) {
        const productFilter = where.productId as { not: string };
        const conditions = where.OR as Array<{ productUrl?: string; affiliateUrl?: string }>;

        return (
          this.offers.find(
            (offer) =>
              offer.marketplace === where.marketplace &&
              offer.productId !== productFilter.not &&
              conditions.some(
                (condition) =>
                  condition.productUrl === offer.productUrl ||
                  condition.affiliateUrl === offer.affiliateUrl,
              ),
          ) ?? null
        );
      }

      return null;
    },
    create: async (args: {
      data: Omit<OfferRecord, "id" | "statusReason" | "score" | "scoreCompletenessPercentage">;
    }) => {
      const offer = {
        ...args.data,
        id: `offer-${this.offers.length + 1}`,
        statusReason: null,
        score: null,
        scoreCompletenessPercentage: null,
      };
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

  publication = {
    count: async (args: { where: { offerId: string } }) =>
      this.publications.filter((publication) => publication.offerId === args.where.offerId).length,
  };

  coupon = {
    deleteMany: async (args: { where: { offerId: string } }) => {
      this.coupons = this.coupons.filter((coupon) => coupon.offerId !== args.where.offerId);
      return { count: 0 };
    },
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
    create: async (args: {
      data: { offerId: string; slug: string; destination: string; marketplace: Marketplace };
    }) => {
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

async function ingestRawWithFake(tx: FakeTransaction, input: unknown) {
  return ingestOfferInTransaction(tx as unknown as Prisma.TransactionClient, input, {
    now: new Date("2026-01-01T00:00:00.000Z"),
    minScore: 70,
  });
}

describe("offer form normalization", () => {
  it.each([
    ["299,99", 299.99],
    ["299.99", 299.99],
    ["1.299,99", 1299.99],
  ])("normalizes %s to %s", (input, expected) => {
    expect(parseDecimalInput(input)).toBe(expected);
  });

  it("normalizes empty optional fields without producing NaN", () => {
    const parsed = offerFormSchema.parse({
      marketplace: "SHOPEE",
      externalProductId: "produto-opcional-001",
      title: "Produto teste sem dados enriquecidos",
      productUrl: "https://shopee.com.br/produto",
      currentPrice: "299,99",
      stockStatus: "UNKNOWN",
      shippingStatus: "UNKNOWN",
      category: "",
      description: "",
      imageUrl: "",
      affiliateUrl: "",
      originalPrice: "",
      couponCode: "",
      couponExpiration: "",
      commissionPercentage: "",
      rating: "",
      salesCount: "",
    });

    expect(parsed).toMatchObject({
      currentPrice: 299.99,
      stockStatus: "UNKNOWN",
      shippingStatus: "UNKNOWN",
    });
    expect(parsed.originalPrice).toBeUndefined();
    expect(parsed.affiliateUrl).toBeUndefined();
    expect(parsed.commissionPercentage).toBeUndefined();
    expect(parsed.rating).toBeUndefined();
    expect(parsed.salesCount).toBeUndefined();
    expect(parsed.couponExpiration).toBeUndefined();
  });

  it("rejects non-empty arbitrary numeric text", () => {
    expect(() =>
      offerFormSchema.parse({
        marketplace: "SHOPEE",
        externalProductId: "produto-opcional-001",
        title: "Produto teste sem dados enriquecidos",
        productUrl: "https://shopee.com.br/produto",
        currentPrice: "duzentos",
        stockStatus: "UNKNOWN",
        shippingStatus: "UNKNOWN",
      }),
    ).toThrow();
  });
});

describe("ingestOfferInTransaction", () => {
  it("reuses the same Product for the same marketplace and externalProductId", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer());
    await ingestWithFake(tx, validOffer({ currentPrice: 35 }));

    expect(tx.products).toHaveLength(1);
  });

  it("creates a different Product for a different externalProductId", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer());
    await ingestWithFake(
      tx,
      validOffer({
        externalProductId: "sku-2",
        productUrl: "https://example.com/product-2",
        affiliateUrl: "https://example.com/affiliate-2",
      }),
    );

    expect(tx.products).toHaveLength(2);
  });

  it("ingests the first condition as Offer version 1", async () => {
    const tx = new FakeTransaction();
    const result = await ingestWithFake(tx, validOffer());

    expect(result).toMatchObject({
      ok: true,
      status: "READY_TO_PUBLISH",
      discountPercentage: 60,
    });
    expect(tx.offers).toHaveLength(1);
    expect(tx.offers[0]?.version).toBe(1);
    expect(tx.offerScores).toHaveLength(1);
    expect(tx.affiliateLinks).toHaveLength(1);
    expect(tx.coupons).toHaveLength(1);
  });

  it("creates Offer version 2 for a new material condition", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer());
    await ingestWithFake(tx, validOffer({ currentPrice: 35 }));

    expect(tx.offers).toHaveLength(2);
    expect(tx.offers[1]?.version).toBe(2);
  });

  it("creates a new Offer when currentPrice changes", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer({ currentPrice: 40 }));
    await ingestWithFake(tx, validOffer({ currentPrice: 39 }));

    expect(tx.offers).toHaveLength(2);
  });

  it("creates a new Offer when originalPrice changes", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer({ originalPrice: 100 }));
    await ingestWithFake(tx, validOffer({ originalPrice: 110 }));

    expect(tx.offers).toHaveLength(2);
  });

  it("creates a new Offer when couponCode changes", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer({ couponCode: "PROMO10" }));
    await ingestWithFake(tx, validOffer({ couponCode: "PROMO20" }));

    expect(tx.offers).toHaveLength(2);
  });

  it("creates a new Offer when couponExpiration changes", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer({ couponExpiration: new Date("2026-01-02T00:00:00.000Z") }));
    await ingestWithFake(tx, validOffer({ couponExpiration: new Date("2026-01-03T00:00:00.000Z") }));

    expect(tx.offers).toHaveLength(2);
  });

  it("creates a new Offer when affiliateUrl changes", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer({ affiliateUrl: "https://example.com/affiliate-a" }));
    await ingestWithFake(tx, validOffer({ affiliateUrl: "https://example.com/affiliate-b" }));

    expect(tx.offers).toHaveLength(2);
  });

  it("does not duplicate the same fingerprint", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer());
    await ingestWithFake(tx, validOffer());

    expect(tx.offers).toHaveLength(1);
    expect(tx.affiliateLinks).toHaveLength(1);
  });

  it("does not overwrite a published Offer", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer({ title: "Titulo historico" }));
    tx.offers[0]!.status = "PUBLISHED";
    tx.publications.push({ id: "publication-1", offerId: tx.offers[0]!.id });
    await ingestWithFake(tx, validOffer({ title: "Titulo atual alterado" }));

    expect(tx.offers).toHaveLength(1);
    expect(tx.offers[0]?.title).toBe("Titulo historico");
  });

  it("keeps Offer v1 tracking intact and creates a separate link for v2", async () => {
    const tx = new FakeTransaction();

    await ingestWithFake(tx, validOffer({ affiliateUrl: "https://example.com/affiliate-v1" }));
    const v1Link = tx.affiliateLinks[0]!;
    await ingestWithFake(
      tx,
      validOffer({
        currentPrice: 35,
        affiliateUrl: "https://example.com/affiliate-v2",
      }),
    );

    expect(tx.offers).toHaveLength(2);
    expect(tx.affiliateLinks).toHaveLength(2);
    expect(v1Link.destination).toBe("https://example.com/affiliate-v1");
    expect(tx.affiliateLinks[1]?.offerId).toBe(tx.offers[1]?.id);
    expect(tx.affiliateLinks[1]?.destination).toBe("https://example.com/affiliate-v2");
  });

  it("persists an offer without original price and leaves discount unavailable", async () => {
    const tx = new FakeTransaction();
    const result = await ingestWithFake(
      tx,
      validOffer({
        originalPrice: undefined,
        couponCode: undefined,
        couponExpiration: undefined,
      }),
    );

    expect(result.status).toBe("READY_TO_PUBLISH");
    expect(result.discountPercentage).toBeNull();
    expect(tx.offers[0]?.originalPrice).toBeNull();
    expect(tx.offers[0]?.discountPercentage).toBeNull();
    expect(tx.offerScores[0]?.completenessPercentage).toBeLessThan(100);
  });

  it("accepts missing coupon without creating coupon records", async () => {
    const tx = new FakeTransaction();
    const result = await ingestWithFake(
      tx,
      validOffer({
        couponCode: undefined,
        couponExpiration: undefined,
      }),
    );

    expect(result.status).toBe("READY_TO_PUBLISH");
    expect(tx.coupons).toHaveLength(0);
    expect(tx.offers[0]?.couponCode).toBeNull();
  });

  it("keeps a valid Mercado Livre offer waiting for an affiliate link", async () => {
    const tx = new FakeTransaction();
    const result = await ingestWithFake(
      tx,
      validOffer({
        marketplace: "MERCADO_LIVRE",
        affiliateUrl: undefined,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      status: "READY_FOR_AFFILIATE_LINK",
    });
    expect(tx.affiliateLinks).toHaveLength(0);
    expect(tx.offers[0]?.affiliateUrl).toBeNull();
  });

  it("accepts missing image and sparse enrichment fields as null", async () => {
    const tx = new FakeTransaction();
    const result = await ingestWithFake(
      tx,
      validOffer({
        imageUrl: undefined,
        commissionPercentage: undefined,
        rating: undefined,
        salesCount: undefined,
        shippingStatus: "UNKNOWN",
        freeShipping: undefined,
        stockStatus: "UNKNOWN",
      }),
    );

    expect(result.status).toBe("READY_TO_PUBLISH");
    expect(tx.offers[0]?.commissionPercentage).toBeNull();
    expect(tx.offers[0]?.rating).toBeNull();
    expect(tx.offers[0]?.salesCount).toBeNull();
    expect(tx.offers[0]?.shippingStatus).toBe("UNKNOWN");
    expect(tx.offers[0]?.freeShipping).toBe(false);
    expect(result.scoreCompletenessPercentage).toBeLessThan(100);
  });

  it("ingests the exact minimal optional-fields regression payload", async () => {
    const tx = new FakeTransaction();
    const result = await ingestRawWithFake(tx, {
      marketplace: "SHOPEE",
      externalProductId: "produto-opcional-001",
      title: "Produto teste sem dados enriquecidos",
      productUrl: "https://shopee.com.br/produto",
      currentPrice: "299,99",
      stockStatus: "UNKNOWN",
      shippingStatus: "UNKNOWN",
      category: "",
      description: "",
      imageUrl: "",
      affiliateUrl: "",
      originalPrice: "",
      couponCode: "",
      couponExpiration: "",
      commissionPercentage: "",
      rating: "",
      salesCount: "",
    });

    expect(result).toMatchObject({
      ok: false,
      status: "READY_FOR_AFFILIATE_LINK",
      discountPercentage: null,
    });
    expect(tx.offers[0]).toMatchObject({
      currentPrice: 299.99,
      originalPrice: null,
      discountPercentage: null,
      affiliateUrl: null,
      shippingStatus: "UNKNOWN",
      stockStatus: "UNKNOWN",
      commissionPercentage: null,
      rating: null,
      salesCount: null,
    });
    expect(Number.isNaN(tx.offers[0]?.currentPrice)).toBe(false);
    expect(tx.affiliateLinks).toHaveLength(0);
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

describe("createOfferFingerprint", () => {
  it("uses only normalized material offer facts", () => {
    const first = createOfferFingerprint({
      productId: "product-1",
      originalPrice: "100",
      currentPrice: "40.0",
      couponCode: " PROMO10 ",
      couponExpiration: "2026-01-02T00:00:00.000Z",
      affiliateUrl: "HTTPS://Example.com/Affiliate/",
      shippingStatus: "FREE",
      stockStatus: "IN_STOCK",
    });
    const second = createOfferFingerprint({
      productId: "product-1",
      originalPrice: 100,
      currentPrice: 40,
      couponCode: "promo10",
      couponExpiration: new Date("2026-01-02T00:00:00.000Z"),
      affiliateUrl: "https://example.com/Affiliate",
      shippingStatus: "FREE",
      stockStatus: "IN_STOCK",
    });

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });
});
