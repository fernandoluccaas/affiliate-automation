import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  applyManualShopeeAffiliateLink,
  importShopeeOperationalOffers,
  isPublicShopeeRedirectAddress,
  loadRecentShopeeItemIds,
  loadShopeeOperationalOfferState,
  resolveManualShopeeShortLink,
  type ShopeeOperationalPersistence,
  type ShopeeWinnerPersistenceResult,
} from "./operational";
import type { ShopeeAffiliateLinkProvider } from "./types";

const files = [
  fileURLToPath(
    new URL("../fixtures/shopee-official-br-sanitized.csv", import.meta.url),
  ),
  fileURLToPath(
    new URL("../fixtures/shopee-brasil-sanitized.csv", import.meta.url),
  ),
];
const datafeedEnvironment = {
  SHOPEE_AFFILIATE_ENABLED: "true",
  SHOPEE_AFFILIATE_MODE: "DATAFEED",
};
const hybridEnvironment = {
  ...datafeedEnvironment,
  SHOPEE_AFFILIATE_MODE: "HYBRID",
  SHOPEE_OPEN_API_APP_ID: "fixture-app",
  SHOPEE_OPEN_API_SECRET: "fixture-secret",
};
const publicDns = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);

function persistence(
  overrides: Partial<ShopeeOperationalPersistence> = {},
): ShopeeOperationalPersistence {
  return {
    findDuplicateImport: vi.fn(async () => null),
    startImport: vi.fn(async () => ({ id: "job-fixture" })),
    persistWinner: vi.fn(async (input) => {
      const resolved = input.linkProvider
        ? await input.linkProvider.resolve(input.winner.product, {
            subIds: input.subIds,
          })
        : null;
      const ready = resolved?.status === "VERIFIED";
      return {
        ok: ready,
        offerId: `offer-${input.winner.product.itemId}`,
        productId: `product-${input.winner.product.itemId}`,
        status: ready
          ? ("READY_TO_PUBLISH" as const)
          : ("READY_FOR_AFFILIATE_LINK" as const),
        statusReason: ready ? "READY" : "PENDING",
        productCreated: true,
        offerCreated: true,
        linkStatus: ready ? ("GENERATED" as const) : ("PENDING" as const),
      } satisfies ShopeeWinnerPersistenceResult;
    }),
    recordFailure: vi.fn(async () => undefined),
    finishImport: vi.fn(async () => undefined),
    ...overrides,
  };
}

const generatedProvider: ShopeeAffiliateLinkProvider = {
  kind: "OPEN_API",
  resolve: vi.fn(async () => ({
    status: "VERIFIED" as const,
    affiliateUrl: "https://s.shopee.com.br/fixture",
    provider: "SHOPEE_OPEN_API",
  })),
};

describe("Shopee operational Datafeed import", () => {
  it("loads recent selections from successful operational job items", async () => {
    const findMany = vi.fn(async () => [
      { sourceId: "100001" },
      { sourceId: null },
    ]);
    await expect(
      loadRecentShopeeItemIds({
        database: { importJobItem: { findMany } } as never,
        now: new Date("2026-08-20T12:00:00Z"),
        windowDays: 7,
      }),
    ).resolves.toEqual(["100001"]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          importJob: {
            marketplace: "SHOPEE",
            importType: "SHOPEE_DATAFEED_OPERATIONAL",
          },
          status: { not: "FAILED" },
        }),
      }),
    );
  });

  it("reports only the current commercial version of each offer", async () => {
    const database = {
      offer: {
        findMany: vi.fn(async () => [
          {
            id: "offer-1-v2",
            title: "Produto 1",
            externalProductId: "1",
            status: "READY_TO_PUBLISH",
            statusReason: "READY",
            updatedAt: new Date("2026-01-02T00:00:00Z"),
          },
          {
            id: "offer-1-v1",
            title: "Produto 1",
            externalProductId: "1",
            status: "READY_FOR_AFFILIATE_LINK",
            statusReason: "AFFILIATE_LINK_REQUIRED",
            updatedAt: new Date("2026-01-01T00:00:00Z"),
          },
          {
            id: "offer-2-v1",
            title: "Produto 2",
            externalProductId: "2",
            status: "READY_FOR_AFFILIATE_LINK",
            statusReason: "AFFILIATE_LINK_REQUIRED",
            updatedAt: new Date("2026-01-03T00:00:00Z"),
          },
        ]),
      },
    };

    await expect(
      loadShopeeOperationalOfferState(database as never),
    ).resolves.toEqual({
      offerCounts: { pending: 1, ready: 1 },
      pendingOffers: [
        {
          id: "offer-2-v1",
          title: "Produto 2",
          externalProductId: "2",
          statusReason: "AFFILIATE_LINK_REQUIRED",
        },
      ],
    });
  });

  it("keeps preview free of database writes and Publications", async () => {
    const storage = persistence();
    const result = await importShopeeOperationalOffers({
      files,
      environment: datafeedEnvironment,
      confirmImport: false,
      persistence: storage,
    });
    expect(result.status).toBe("PREVIEW_COMPLETED");
    expect(result.stateModified).toBe(false);
    expect(result.publicationsCreated).toBe(0);
    expect(result.messagesSent).toBe(0);
    expect(result.preview.selected.length).toBeLessThanOrEqual(12);
    expect(storage.startImport).not.toHaveBeenCalled();
    expect(storage.persistWinner).not.toHaveBeenCalled();
  });

  it("persists only selected winners after explicit confirmation and generates links", async () => {
    const storage = persistence();
    const result = await importShopeeOperationalOffers({
      files,
      environment: hybridEnvironment,
      confirmImport: true,
      persistence: storage,
      linkProvider: generatedProvider,
      subIds: ["sourcedatafeed"],
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.metrics.selected).toBeGreaterThan(0);
    expect(result.metrics.selected).toBeLessThanOrEqual(12);
    expect(storage.persistWinner).toHaveBeenCalledTimes(
      result.metrics.selected,
    );
    expect(result.metrics.linksGenerated).toBe(result.metrics.selected);
    expect(result.metrics.readyToPublish).toBe(result.metrics.selected);
    expect(result.publicationsCreated).toBe(0);
    expect(result.messagesSent).toBe(0);
    expect(generatedProvider.resolve).toHaveBeenCalledWith(
      expect.any(Object),
      { subIds: ["sourcedatafeed"] },
    );
    expect(storage.finishImport).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "SUCCEEDED",
        summary: expect.objectContaining({ publicationsCreated: 0 }),
      }),
    );
  });

  it("keeps offers pending when Open API is disabled", async () => {
    const storage = persistence();
    const result = await importShopeeOperationalOffers({
      files,
      environment: datafeedEnvironment,
      confirmImport: true,
      persistence: storage,
    });
    expect(result.status).toBe("SUCCEEDED_WITH_ERRORS");
    expect(result.metrics.pendingAffiliateLink).toBe(result.metrics.selected);
    expect(result.metrics.readyToPublish).toBe(0);
    expect(result.metrics.linksGenerated).toBe(0);
  });

  it("returns an idempotent duplicate without persisting winners again", async () => {
    const storage = persistence({
      findDuplicateImport: vi.fn(async () => ({ id: "existing-job" })),
    });
    const result = await importShopeeOperationalOffers({
      files,
      environment: datafeedEnvironment,
      confirmImport: true,
      persistence: storage,
    });
    expect(result.status).toBe("DUPLICATE");
    expect(result.importJobId).toBe("existing-job");
    expect(result.stateModified).toBe(false);
    expect(storage.startImport).not.toHaveBeenCalled();
    expect(storage.persistWinner).not.toHaveBeenCalled();
  });

  it("isolates a winner failure and completes the ImportJob partially", async () => {
    let calls = 0;
    const storage = persistence({
      persistWinner: vi.fn(async (input) => {
        calls += 1;
        if (calls === 1) throw new Error("private upstream details");
        return {
          ok: true,
          offerId: `offer-${input.position}`,
          productId: `product-${input.position}`,
          status: "READY_TO_PUBLISH" as const,
          statusReason: "READY",
          offerCreated: true,
          linkStatus: "GENERATED" as const,
        } satisfies ShopeeWinnerPersistenceResult;
      }),
    });
    const result = await importShopeeOperationalOffers({
      files,
      environment: hybridEnvironment,
      confirmImport: true,
      persistence: storage,
      linkProvider: generatedProvider,
    });
    expect(result.status).toBe("SUCCEEDED_WITH_ERRORS");
    expect(result.metrics.failed).toBe(1);
    expect(result.metrics.readyToPublish).toBe(result.metrics.selected - 1);
    expect(storage.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        position: 1,
        errorCode: "SHOPEE_OPERATIONAL_ITEM_FAILED",
      }),
    );
  });
});

describe("Shopee manual affiliate fallback", () => {
  it("applies a matching manual link through the versioned ingestion pipeline", async () => {
    const transaction = { $executeRaw: vi.fn(async () => 1) };
    const database = {
      offer: {
        findUnique: vi.fn(async () => ({
          marketplace: "SHOPEE",
          externalProductId: "52511551718",
          title: "Produto",
          description: null,
          category: "CASA",
          sourceCategoryId: "10",
          imageUrl: "https://cf.shopee.com.br/image",
          productUrl:
            "https://shopee.com.br/produto-i.344381236.52511551718",
          originalPrice: 120,
          currentPrice: 100,
          discountPercentage: 16.67,
          rating: 4.8,
        })),
      },
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    };
    const ingestOffer = vi.fn(async () => ({
      status: "READY_TO_PUBLISH",
      offerId: "offer-v2",
      productId: "product-1",
    }));

    await expect(
      applyManualShopeeAffiliateLink({
        offerId: "offer-v1",
        affiliateUrl: "https://s.shopee.com.br/2qTd2QTWJk",
        database: database as never,
        fetch: vi.fn(
          async () =>
            new Response(null, {
              status: 302,
              headers: {
                location:
                  "https://shopee.com.br/opaanlp/344381236/52511551718?utm_medium=affiliates&utm_source=example",
              },
            }),
        ),
        resolveDns: publicDns,
        ingestOffer: ingestOffer as never,
      }),
    ).resolves.toMatchObject({ status: "READY_TO_PUBLISH" });
    expect(ingestOffer).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        marketplace: "SHOPEE",
        externalProductId: "52511551718",
        productUrl:
          "https://shopee.com.br/produto-i.344381236.52511551718",
        affiliateUrl: "https://s.shopee.com.br/2qTd2QTWJk",
      }),
      expect.objectContaining({ minScore: 70 }),
    );
  });

  it("does not invoke ingestion when an opaanlp destination mismatches", async () => {
    const transaction = vi.fn();
    const ingestOffer = vi.fn();
    const database = {
      offer: {
        findUnique: vi.fn(async () => ({
          marketplace: "SHOPEE",
          externalProductId: "52511551718",
          title: "Produto",
          description: null,
          category: "CASA",
          sourceCategoryId: "10",
          imageUrl: "https://cf.shopee.com.br/image",
          productUrl:
            "https://shopee.com.br/produto-i.344381236.52511551718",
          originalPrice: 120,
          currentPrice: 100,
          discountPercentage: 16.67,
          rating: 4.8,
        })),
      },
      $transaction: transaction,
    };

    await expect(
      applyManualShopeeAffiliateLink({
        offerId: "offer-v1",
        affiliateUrl: "https://s.shopee.com.br/2qTd2QTWJk",
        database: database as never,
        fetch: vi.fn(
          async () =>
            new Response(null, {
              status: 302,
              headers: {
                location:
                  "https://shopee.com.br/opaanlp/344381236/99999999999",
              },
            }),
        ),
        resolveDns: publicDns,
        ingestOffer: ingestOffer as never,
      }),
    ).rejects.toThrow("SHOPEE_AFFILIATE_LINK_PRODUCT_MISMATCH");
    expect(transaction).not.toHaveBeenCalled();
    expect(ingestOffer).not.toHaveBeenCalled();
  });

  it("accepts the observed opaanlp redirect when the itemId matches", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://shopee.com.br/opaanlp/344381236/52511551718?utm_medium=affiliates&utm_source=example",
          },
        }),
    );
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/2qTd2QTWJk",
        expectedItemId: "52511551718",
        fetch: request,
        resolveDns: publicDns,
      }),
    ).resolves.toBe(
      "https://shopee.com.br/opaanlp/344381236/52511551718?utm_medium=affiliates&utm_source=example",
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects an opaanlp redirect that resolves to another item", async () => {
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/2qTd2QTWJk",
        expectedItemId: "52511551718",
        fetch: vi.fn(
          async () =>
            new Response(null, {
              status: 302,
              headers: {
                location:
                  "https://shopee.com.br/opaanlp/344381236/99999999999",
              },
            }),
          ),
        resolveDns: publicDns,
      }),
    ).rejects.toThrow("SHOPEE_AFFILIATE_LINK_PRODUCT_MISMATCH");
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:192.168.0.1",
    "::ffff:c0a8:1",
    "2001:db8::1",
    "2002:c0a8:1::1",
  ])("classifies private or special address %s as unsafe", (address) => {
    expect(isPublicShopeeRedirectAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "classifies public address %s as safe",
    (address) => {
      expect(isPublicShopeeRedirectAddress(address)).toBe(true);
    },
  );

  it("blocks a private DNS answer before HTTP", async () => {
    const request = vi.fn();
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/fixture",
        expectedItemId: "456",
        fetch: request,
        resolveDns: vi.fn(async () => [
          { address: "192.168.1.5", family: 4 },
        ]),
      }),
    ).rejects.toThrow("SHOPEE_MANUAL_LINK_SSRF_BLOCKED");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects redirect loops and hosts outside the minimal allowlist", async () => {
    const loopFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://s.shopee.com.br/fixture" },
        }),
    );
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/fixture",
        expectedItemId: "456",
        fetch: loopFetch,
        resolveDns: publicDns,
      }),
    ).rejects.toThrow("SHOPEE_MANUAL_LINK_REDIRECT_LOOP");
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/fixture",
        expectedItemId: "456",
        fetch: vi.fn(
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://evil.example/product/123/456" },
            }),
        ),
        resolveDns: publicDns,
      }),
    ).rejects.toThrow("SHOPEE_MANUAL_LINK_REDIRECT_REJECTED");
  });

  it("rejects a non-redirect response even if it carries a Location header", async () => {
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/fixture",
        expectedItemId: "456",
        fetch: vi.fn(
          async () =>
            new Response(null, {
              status: 200,
              headers: {
                location: "https://shopee.com.br/produto-i.123.456",
              },
            }),
        ),
        resolveDns: publicDns,
      }),
    ).rejects.toThrow("SHOPEE_MANUAL_LINK_REDIRECT_REJECTED");
  });

  it("fails closed for DNS errors, missing itemId and redirect exhaustion", async () => {
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/fixture",
        expectedItemId: "456",
        fetch: vi.fn(),
        resolveDns: vi.fn(async () => {
          throw new Error("private DNS detail");
        }),
      }),
    ).rejects.toThrow("SHOPEE_MANUAL_LINK_DNS_FAILED");
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/fixture",
        expectedItemId: "456",
        fetch: vi.fn(
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://shopee.com.br/product" },
            }),
        ),
        resolveDns: publicDns,
      }),
    ).rejects.toThrow("SHOPEE_AFFILIATE_LINK_ITEM_ID_MISSING");

    let hop = 0;
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/start",
        expectedItemId: "456",
        fetch: vi.fn(async () => {
          hop += 1;
          return new Response(null, {
            status: 302,
            headers: { location: `https://s.shopee.com.br/hop-${hop}` },
          });
        }),
        resolveDns: publicDns,
        maxRedirects: 2,
      }),
    ).rejects.toThrow("SHOPEE_MANUAL_LINK_REDIRECT_LIMIT");
  });

  it("applies the timeout while DNS resolution is pending", async () => {
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/fixture",
        expectedItemId: "456",
        fetch: vi.fn(),
        resolveDns: vi.fn(
          () =>
            new Promise<Array<{ address: string; family: number }>>(
              () => undefined,
            ),
        ),
        timeoutMs: 1,
      }),
    ).rejects.toThrow("SHOPEE_MANUAL_LINK_TIMEOUT");
  });
});
