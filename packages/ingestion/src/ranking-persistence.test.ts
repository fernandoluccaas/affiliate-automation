import {
  Prisma,
  type OfferStatus,
  type Prisma as PrismaTypes,
} from "@affiliate/database";
import { describe, expect, it } from "vitest";
import {
  ingestOfferInTransaction,
  type AffiliateFailureMetadata,
} from "./index";

type DatabaseRecord = Record<string, unknown>;

class FakeTransaction {
  products: DatabaseRecord[] = [];
  offers: DatabaseRecord[] = [];
  publishedOfferIds = new Set<string>();

  product = {
    findUnique: async (args: {
      where: {
        marketplace_externalProductId: {
          marketplace: string;
          externalProductId: string;
        };
      };
    }) =>
      this.products.find(
        (product) =>
          product.marketplace ===
            args.where.marketplace_externalProductId.marketplace &&
          product.externalProductId ===
            args.where.marketplace_externalProductId.externalProductId,
      ) ?? null,
    upsert: async (args: {
      where: {
        marketplace_externalProductId: {
          marketplace: string;
          externalProductId: string;
        };
      };
      update: DatabaseRecord;
      create: DatabaseRecord;
    }) => {
      const existing = this.products.find(
        (product) =>
          product.marketplace ===
            args.where.marketplace_externalProductId.marketplace &&
          product.externalProductId ===
            args.where.marketplace_externalProductId.externalProductId,
      );

      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }

      const product = {
        id: `product-${this.products.length + 1}`,
        ...args.create,
      };
      this.products.push(product);
      return product;
    },
  };

  offer = {
    findFirst: async (args: {
      where?: DatabaseRecord;
      orderBy?: { version?: "desc" };
      select?: DatabaseRecord;
    }) => {
      const where = args.where ?? {};

      if (
        typeof where.productId === "string" &&
        typeof where.offerFingerprint === "string"
      ) {
        return (
          this.offers.find(
            (offer) =>
              offer.productId === where.productId &&
              offer.offerFingerprint === where.offerFingerprint,
          ) ?? null
        );
      }

      if (
        typeof where.productId === "string" &&
        args.orderBy?.version === "desc"
      ) {
        const latest = this.offers
          .filter((offer) => offer.productId === where.productId)
          .sort(
            (left, right) =>
              Number(right.version ?? 0) - Number(left.version ?? 0),
          )[0];
        return latest ? { version: latest.version } : null;
      }

      return null;
    },
    create: async (args: { data: DatabaseRecord }) => {
      const offer = {
        id: `offer-${this.offers.length + 1}`,
        statusReason: null,
        score: null,
        scoreCompletenessPercentage: null,
        ...args.data,
      };
      this.offers.push(offer);
      return offer;
    },
    update: async (args: { where: { id: string }; data: DatabaseRecord }) => {
      const offer = this.offers.find(
        (candidate) => candidate.id === args.where.id,
      );

      if (!offer) {
        throw new Error("Offer not found.");
      }

      Object.assign(offer, args.data);
      return offer;
    },
  };

  publication = {
    count: async (args: { where: { offerId: string } }) =>
      this.publishedOfferIds.has(args.where.offerId) ? 1 : 0,
  };

  coupon = {
    deleteMany: async () => ({ count: 0 }),
    create: async (args: { data: DatabaseRecord }) => args.data,
  };

  offerScore = {
    create: async (args: { data: DatabaseRecord }) => args.data,
  };

  affiliateLink = {
    findUnique: async () => null,
    findFirst: async () => null,
    create: async (args: { data: DatabaseRecord }) => args.data,
  };
}

const transientFailure: AffiliateFailureMetadata = {
  stage: "LINK_GENERATION",
  status: 503,
  code: "UPSTREAM_UNAVAILABLE",
  message: "Falha transitoria ao gerar o link.",
  retryable: true,
  sessionExpired: false,
  productIneligible: false,
  attempts: 3,
};

function rankedOffer(
  bestSellerPosition: number,
  affiliateFailure: AffiliateFailureMetadata | null = transientFailure,
) {
  return {
    marketplace: "MERCADO_LIVRE",
    externalProductId: "MLB123",
    title: "Produto do ranking",
    category: "Smartphones",
    sourceCategoryId: "MLB1055",
    bestSellerPosition,
    sourceHighlightId: "MLB-PRODUCT-123",
    sourceHighlightType: "PRODUCT",
    resolutionStrategy: "PRODUCT_CHILD_BUY_BOX",
    productUrl: "https://produto.mercadolivre.com.br/MLB-123",
    currentPrice: 499.9,
    affiliateEligibility: "UNKNOWN",
    affiliateFailure,
    trackingStrategy: "DIRECT_AFFILIATE_LINK",
    shippingStatus: "UNKNOWN",
    stockStatus: "IN_STOCK",
  };
}

function catalogPdpOffer(
  currentPrice: number,
  sellerId = "seller-1",
  selectedItemId = "MLB4827891325",
) {
  return {
    marketplace: "MERCADO_LIVRE",
    externalProductId: "MLB62081577",
    title: "Smartphone de catalogo",
    category: "MLB1055",
    sourceCategoryId: "MLB1055",
    bestSellerPosition: 1,
    sourceHighlightId: "MLB62081577",
    sourceHighlightType: "PRODUCT",
    resolutionStrategy: "PRODUCT_CATALOG_CANONICAL_PDP",
    productUrl: "https://www.mercadolivre.com.br/p/MLB62081577",
    affiliateUrl: "https://meli.la/catalog-pdp",
    affiliateEligibility: "ELIGIBLE",
    affiliateFailure: null,
    affiliateLabel: "default-tag",
    sellerId,
    resolvedItemId: selectedItemId,
    selectedCatalogItemId: selectedItemId,
    currentPrice,
    trackingStrategy: "DIRECT_AFFILIATE_LINK",
    shippingStatus: "FREE",
    stockStatus: "UNKNOWN",
  };
}

async function ingest(tx: FakeTransaction, input: unknown) {
  return ingestOfferInTransaction(
    tx as unknown as PrismaTypes.TransactionClient,
    input,
    {
      now: new Date("2026-07-28T12:00:00.000Z"),
      minScore: 0,
    },
  );
}

describe("ranking and affiliate failure persistence", () => {
  it("persists discovery origin and an isolated affiliate failure", async () => {
    const tx = new FakeTransaction();

    const result = await ingest(tx, rankedOffer(8));

    expect(result).toMatchObject({
      offerCreated: true,
      status: "READY_FOR_AFFILIATE_LINK",
    });
    expect(tx.offers[0]).toMatchObject({
      sourceCategoryId: "MLB1055",
      bestSellerPosition: 8,
      sourceHighlightId: "MLB-PRODUCT-123",
      sourceHighlightType: "PRODUCT",
      resolutionStrategy: "PRODUCT_CHILD_BUY_BOX",
      affiliateFailure: transientFailure,
    });
  });

  it("updates rank-only observations without duplicating the offer", async () => {
    const tx = new FakeTransaction();
    const first = await ingest(tx, rankedOffer(8));
    const second = await ingest(tx, rankedOffer(9));

    expect(second).toMatchObject({
      offerCreated: false,
      offerReused: true,
      offerUpdated: true,
      version: 1,
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(tx.offers).toHaveLength(1);
    expect(tx.offers[0]?.bestSellerPosition).toBe(9);
  });

  it("clears stale affiliate failure metadata after recovery", async () => {
    const tx = new FakeTransaction();
    await ingest(tx, rankedOffer(8));

    await ingest(tx, rankedOffer(8, null));

    expect(tx.offers).toHaveLength(1);
    expect(tx.offers[0]?.affiliateFailure).toBe(Prisma.DbNull);
  });

  it("updates only operational ranking metadata on a historical offer", async () => {
    const tx = new FakeTransaction();
    await ingest(tx, rankedOffer(8));
    const historical = tx.offers[0]!;
    historical.status = "PUBLISHED" satisfies OfferStatus;
    historical.title = "Titulo historico";
    tx.publishedOfferIds.add(String(historical.id));

    const result = await ingest(tx, {
      ...rankedOffer(9),
      title: "Titulo novo que nao pode sobrescrever o snapshot",
    });

    expect(result).toMatchObject({
      status: "PUBLISHED",
      offerCreated: false,
      offerUpdated: true,
      version: 1,
    });
    expect(tx.offers).toHaveLength(1);
    expect(historical.title).toBe("Titulo historico");
    expect(historical.bestSellerPosition).toBe(9);
  });

  it("keeps canonical catalog PRODUCT identity idempotent when the selected seller and item change", async () => {
    const tx = new FakeTransaction();
    const first = await ingest(tx, catalogPdpOffer(1429, "seller-1"));
    const second = await ingest(
      tx,
      catalogPdpOffer(1429, "seller-2", "MLB7282181302"),
    );

    expect(first).toMatchObject({
      productCreated: true,
      offerCreated: true,
      version: 1,
    });
    expect(second).toMatchObject({
      productCreated: false,
      offerCreated: false,
      offerReused: true,
      version: 1,
    });
    expect(tx.products).toHaveLength(1);
    expect(tx.products[0]?.externalProductId).toBe("MLB62081577");
    expect(tx.offers).toHaveLength(1);
  });

  it("creates a new catalog offer version when the summary price changes", async () => {
    const tx = new FakeTransaction();
    const first = await ingest(tx, catalogPdpOffer(1429));
    const second = await ingest(tx, catalogPdpOffer(1399));

    expect(first.version).toBe(1);
    expect(second).toMatchObject({
      productCreated: false,
      offerCreated: true,
      offerReused: false,
      version: 2,
    });
    expect(tx.products).toHaveLength(1);
    expect(tx.offers).toHaveLength(2);
  });

  it("updates canonical catalog ranking without duplicating Product or Offer", async () => {
    const tx = new FakeTransaction();
    await ingest(tx, catalogPdpOffer(1429));
    const result = await ingest(tx, {
      ...catalogPdpOffer(1429),
      bestSellerPosition: 2,
    });

    expect(result).toMatchObject({
      productCreated: false,
      offerCreated: false,
      offerReused: true,
      version: 1,
    });
    expect(tx.products).toHaveLength(1);
    expect(tx.offers).toHaveLength(1);
    expect(tx.offers[0]?.bestSellerPosition).toBe(2);
  });
});
