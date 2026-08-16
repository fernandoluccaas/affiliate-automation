import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  importShopeeOperationalOffers,
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
      subIds: ["source_datafeed"],
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
  it("validates the final product itemId without following the short link in tests", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location: "https://shopee.com.br/produto-i.123.456",
          },
        }),
    );
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/fixture",
        expectedItemId: "456",
        fetch: request,
      }),
    ).resolves.toBe("https://shopee.com.br/produto-i.123.456");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects manual fallback that resolves to another item", async () => {
    await expect(
      resolveManualShopeeShortLink({
        shortLink: "https://s.shopee.com.br/fixture",
        expectedItemId: "456",
        fetch: vi.fn(
          async () =>
            new Response(null, {
              status: 302,
              headers: {
                location: "https://shopee.com.br/produto-i.123.999",
              },
            }),
        ),
      }),
    ).rejects.toThrow("SHOPEE_MANUAL_LINK_REDIRECT_REJECTED");
  });
});
