import { beforeEach, describe, expect, it, vi } from "vitest";

const ingestOfferInTransaction = vi.hoisted(() => vi.fn());

vi.mock("@affiliate/ingestion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@affiliate/ingestion")>()),
  ingestOfferInTransaction,
}));

import { generateAndApplyShopeeAffiliateLink } from "./operational";

const currentOffer = {
  id: "offer-v1",
  marketplace: "SHOPEE",
  externalProductId: "52511551718",
  title: "Produto",
  description: null,
  category: "CASA",
  sourceCategoryId: "10",
  imageUrl: "https://cf.shopee.com.br/image",
  productUrl: "https://shopee.com.br/product/344381236/52511551718",
  affiliateUrl: null,
  originalPrice: 120,
  currentPrice: 100,
  discountPercentage: 16.67,
  rating: 4.8,
  status: "READY_FOR_AFFILIATE_LINK",
  version: 1,
};

describe("Shopee affiliate-link application pipeline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the Product URL and versioned ingestion to reach READY_TO_PUBLISH", async () => {
    const provider = {
      kind: "OPEN_API" as const,
      resolve: vi.fn(async () => ({
        status: "VERIFIED" as const,
        affiliateUrl: "https://s.shopee.com.br/generated",
        provider: "SHOPEE_OPEN_API",
      })),
    };
    const firstReadTx = {
      offer: { findFirst: vi.fn(async () => null) },
    };
    const applyTx = {
      $executeRaw: vi.fn(async () => 1),
      offer: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(currentOffer)
          .mockResolvedValueOnce(null),
      },
      publication: { create: vi.fn() },
    };
    let transaction = 0;
    const database = {
      offer: {
        findUnique: vi.fn(async () => ({
          marketplace: "SHOPEE",
          externalProductId: currentOffer.externalProductId,
        })),
        findFirst: vi.fn(async () => currentOffer),
      },
      $transaction: vi.fn(async (callback: (tx: never) => Promise<unknown>) => {
        transaction += 1;
        return callback((transaction === 1 ? firstReadTx : applyTx) as never);
      }),
    };
    ingestOfferInTransaction.mockResolvedValue({
      ok: true,
      offerId: "offer-v2",
      productId: "product-1",
      status: "READY_TO_PUBLISH",
      statusReason: "READY",
    });

    await expect(
      generateAndApplyShopeeAffiliateLink({
        offerId: currentOffer.id,
        subIds: ["sourcedatafeed", "bulk"],
        linkProvider: provider,
        database: database as never,
      }),
    ).resolves.toEqual({
      status: "LINKED",
      offerId: "offer-v2",
      itemId: currentOffer.externalProductId,
      attempts: 1,
      linkStatus: "GENERATED",
      offerStatus: "READY_TO_PUBLISH",
    });
    expect(provider.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceProductUrl: currentOffer.productUrl,
        candidateAffiliateUrl: null,
      }),
      { subIds: ["sourcedatafeed", "bulk"] },
    );
    expect(ingestOfferInTransaction).toHaveBeenCalledWith(
      applyTx,
      expect.objectContaining({
        productUrl: currentOffer.productUrl,
        affiliateUrl: "https://s.shopee.com.br/generated",
      }),
      expect.objectContaining({ minScore: 70 }),
    );
    expect(applyTx.publication.create).not.toHaveBeenCalled();
  });
});
