import { describe, expect, it, vi } from "vitest";
import {
  applyAffiliateLinksBatch,
  extractMercadoLivreExternalId,
  parseAffiliateLinksCsv,
  parsePipeAffiliateLinks,
  previewAffiliateLinksBatch,
  validateMercadoLivreProductUrl,
} from "./affiliate-links";

describe("affiliate link batch parsers", () => {
  it("parses pipe input by externalId and productUrl", () => {
    expect(
      parsePipeAffiliateLinks(
        [
          "MLB1234567890|https://meli.la/abc123",
          "https://produto.mercadolivre.com.br/MLB-9876543210|https://meli.la/xyz987",
        ].join("\n"),
      ),
    ).toEqual({
      entries: [
        {
          line: 1,
          externalId: "MLB1234567890",
          affiliateUrl: "https://meli.la/abc123",
        },
        {
          line: 2,
          productUrl:
            "https://produto.mercadolivre.com.br/MLB-9876543210",
          affiliateUrl: "https://meli.la/xyz987",
        },
      ],
      issues: [],
    });
  });

  it("reports malformed pipe lines", () => {
    expect(parsePipeAffiliateLinks("MLB1234567890")).toMatchObject({
      entries: [],
      issues: [{ line: 1, code: "INVALID_FORMAT" }],
    });
  });

  it("parses CSV with BOM and comma", () => {
    const result = parseAffiliateLinksCsv(
      "\uFEFFexternalId,productUrl,affiliateUrl\nMLB1234567890,,https://meli.la/abc",
    );
    expect(result.issues).toEqual([]);
    expect(result.entries[0]).toMatchObject({
      externalId: "MLB1234567890",
      affiliateUrl: "https://meli.la/abc",
    });
  });

  it("parses semicolon-separated CSV", () => {
    const result = parseAffiliateLinksCsv(
      "externalId;productUrl;affiliateUrl\n;https://produto.mercadolivre.com.br/MLB-1234567890;https://meli.la/abc",
    );
    expect(result.issues).toEqual([]);
    expect(result.entries[0]?.productUrl).toContain("MLB-1234567890");
  });
});

describe("Mercado Livre product identifiers", () => {
  it("extracts a canonical external ID", () => {
    expect(
      extractMercadoLivreExternalId(
        "https://produto.mercadolivre.com.br/MLB-1234567890",
      ),
    ).toBe("MLB1234567890");
  });

  it("validates an official product URL", () => {
    expect(
      validateMercadoLivreProductUrl(
        "https://produto.mercadolivre.com.br/MLB-1234567890",
      ),
    ).toMatchObject({ ok: true, externalId: "MLB1234567890" });
  });

  it("rejects a lookalike product host", () => {
    expect(
      validateMercadoLivreProductUrl(
        "https://mercadolivre.com.br.evil.example/MLB-1234567890",
      ),
    ).toMatchObject({ ok: false });
  });
});

function storedOffer(affiliateUrl: string | null = null) {
  return {
    id: "offer-1",
    productId: "product-1",
    version: 1,
    marketplace: "MERCADO_LIVRE",
    externalProductId: "MLB1234567890",
    title: "Produto existente",
    description: null,
    category: "MLB1000",
    imageUrl: null,
    productUrl:
      "https://produto.mercadolivre.com.br/MLB-1234567890",
    affiliateUrl,
    affiliateLabel: null,
    affiliateEligibility: "UNKNOWN",
    sellerId: null,
    officialStoreId: null,
    sourceCategoryId: "MLB1000",
    bestSellerPosition: 8,
    sourceHighlightId: "MLB1234567890",
    sourceHighlightType: "ITEM",
    resolutionStrategy: "ITEM_DIRECT",
    originalPrice: null,
    currentPrice: { toString: () => "100" },
    couponCode: null,
    couponExpiration: null,
    commissionPercentage: null,
    rating: null,
    salesCount: null,
    shippingStatus: "UNKNOWN",
    stockStatus: "IN_STOCK",
    minimumScoreApplied: 70,
  };
}

function databaseWithProduct(offer = storedOffer()) {
  return {
    product: {
      findFirst: vi.fn().mockResolvedValue({
        id: "product-1",
        externalProductId: "MLB1234567890",
        offers: [offer],
      }),
    },
    marketplaceAccount: {
      findFirst: vi.fn().mockResolvedValue({ id: "account-1" }),
    },
    importJob: {
      create: vi.fn().mockResolvedValue({ id: "job-1" }),
      update: vi.fn().mockResolvedValue({ id: "job-1" }),
    },
    importJobItem: {
      create: vi.fn().mockResolvedValue({ id: "item-1" }),
    },
    offer: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe("affiliate link batch preview", () => {
  it("finds a product by externalId and detects a different link", async () => {
    const database = databaseWithProduct();
    const preview = await previewAffiliateLinksBatch(
      [
        {
          line: 1,
          externalId: "MLB1234567890",
          affiliateUrl: "https://meli.la/new",
        },
      ],
      { database: database as never },
    );

    expect(preview.counts.valid).toBe(1);
    expect(preview.items[0]).toMatchObject({
      status: "VALID",
      productId: "product-1",
      offerId: "offer-1",
    });
  });

  it("detects an already applied link and a duplicate line", async () => {
    const database = databaseWithProduct(storedOffer("https://meli.la/same"));
    const preview = await previewAffiliateLinksBatch(
      [
        {
          line: 1,
          externalId: "MLB1234567890",
          affiliateUrl: "https://meli.la/same",
        },
        {
          line: 2,
          externalId: "MLB1234567890",
          affiliateUrl: "https://meli.la/other",
        },
      ],
      { database: database as never },
    );

    expect(preview.items.map((item) => item.status)).toEqual([
      "ALREADY_UPDATED",
      "DUPLICATE",
    ]);
  });

  it("accepts a new product URL for official resolution", async () => {
    const database = databaseWithProduct();
    database.product.findFirst.mockResolvedValue(null);
    const preview = await previewAffiliateLinksBatch(
      [
        {
          line: 1,
          productUrl:
            "https://produto.mercadolivre.com.br/MLB-1234567890",
          affiliateUrl: "https://meli.la/new",
        },
      ],
      { database: database as never },
    );

    expect(preview.items[0]).toMatchObject({
      status: "VALID",
      createsProduct: true,
    });
  });
});

describe("applyAffiliateLinksBatch", () => {
  it("uses ingestion to create a new offer version with the link", async () => {
    const database = databaseWithProduct();
    const ingest = vi.fn().mockResolvedValue({
      ok: true,
      offerId: "offer-2",
      productId: "product-1",
      status: "READY_TO_PUBLISH",
      statusReason: "ready",
      offerCreated: true,
      productCreated: false,
      version: 2,
    });
    const result = await applyAffiliateLinksBatch(
      {
        entries: [
          {
            line: 1,
            externalId: "MLB1234567890",
            affiliateUrl: "https://meli.la/new",
          },
        ],
      },
      {
        database: database as never,
        ingest: ingest as never,
      },
    );

    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        externalProductId: "MLB1234567890",
        affiliateUrl: "https://meli.la/new",
        sourceCategoryId: "MLB1000",
        bestSellerPosition: 8,
      }),
      { minScore: 70 },
    );
    expect(database.offer.updateMany).toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "SUCCEEDED",
      updated: 1,
      readyToPublish: 1,
    });
  });

  it("resolves a new product through the official connector without duplication", async () => {
    const database = databaseWithProduct();
    database.product.findFirst.mockResolvedValue(null);
    const getItem = vi.fn().mockResolvedValue({
      marketplace: "MERCADO_LIVRE",
      externalProductId: "MLB1234567890",
      title: "Produto novo",
      productUrl:
        "https://produto.mercadolivre.com.br/MLB-1234567890",
      currentPrice: 90,
      shippingStatus: "UNKNOWN",
      stockStatus: "IN_STOCK",
    });
    const ingest = vi.fn().mockResolvedValue({
      ok: true,
      offerId: "offer-new",
      productId: "product-new",
      status: "READY_TO_PUBLISH",
      statusReason: "ready",
      offerCreated: true,
      productCreated: true,
      version: 1,
    });
    const result = await applyAffiliateLinksBatch(
      {
        entries: [
          {
            line: 1,
            productUrl:
              "https://produto.mercadolivre.com.br/MLB-1234567890",
            affiliateUrl: "https://meli.la/new",
          },
        ],
      },
      {
        database: database as never,
        ingest: ingest as never,
        createConnector: vi.fn().mockResolvedValue({ getItem } as never),
      },
    );

    expect(getItem).toHaveBeenCalledWith("MLB1234567890");
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(1);
  });

  it("records a partially invalid batch without cancelling valid lines", async () => {
    const database = databaseWithProduct();
    const ingest = vi.fn().mockResolvedValue({
      ok: true,
      offerId: "offer-2",
      productId: "product-1",
      status: "READY_TO_PUBLISH",
      statusReason: "ready",
      offerCreated: true,
      productCreated: false,
      version: 2,
    });
    const result = await applyAffiliateLinksBatch(
      {
        entries: [
          {
            line: 1,
            externalId: "MLB1234567890",
            affiliateUrl: "https://meli.la/valid",
          },
          {
            line: 2,
            externalId: "MLB9999999999",
            affiliateUrl: "https://meli.la.evil.example/invalid",
          },
        ],
      },
      { database: database as never, ingest: ingest as never },
    );

    expect(result).toMatchObject({
      status: "SUCCEEDED_WITH_ERRORS",
      updated: 1,
      ignored: 1,
      invalidLinks: 1,
    });
    expect(database.importJobItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stage: "AFFILIATE_LINK_VALIDATION",
          status: "FAILED",
          errorCode: "INVALID_LINK",
        }),
      }),
    );
  });
});
