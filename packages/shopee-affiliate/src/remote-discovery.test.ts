import { describe, expect, it, vi } from "vitest";
import type { LockHandle } from "@affiliate/redis";
import type {
  ShopeeDatafeedProduct,
  ShopeeRemoteFeedClient,
  ShopeeOperationalPersistence,
} from "./index";
import { SHOPEE_CATEGORY_CATALOG } from "./config";
import {
  listShopeeOfficialFeeds,
  previewShopeeRemoteDiscovery,
  runShopeeAutomatedDiscovery,
} from "./remote-discovery";
import { ShopeeOpenApiError } from "./open-api";

const environment = {
  SHOPEE_AFFILIATE_ENABLED: "true",
  SHOPEE_AFFILIATE_MODE: "HYBRID",
  SHOPEE_OPEN_API_APP_ID: "configured",
  SHOPEE_OPEN_API_SECRET: "configured",
  SHOPEE_REMOTE_DISCOVERY_MAX_PAGES: "10",
  SHOPEE_REMOTE_DISCOVERY_MAX_ITEMS: "10000",
} as NodeJS.ProcessEnv;

function product(
  itemId: string,
  overrides: Partial<ShopeeDatafeedProduct> = {},
): ShopeeDatafeedProduct {
  return {
    itemId,
    title: `Produto ${itemId}`,
    description: null,
    originalPrice: 120,
    salePrice: 80,
    discountPercentage: 33.33,
    itemRating: 4.9,
    shopRating: 4.8,
    likeCount: 100,
    condition: "new",
    crossBorder: false,
    category1: "Home & Living",
    category1Id: "home",
    category2: null,
    category2Id: null,
    category3: null,
    category3Id: null,
    shopName: `Loja ${itemId}`,
    imageUrl: `https://down-br.img.susercontent.com/file/${itemId}`,
    secondaryImageUrl: null,
    sourceProductUrl: `https://shopee.com.br/produto-i.123.${itemId}`,
    candidateAffiliateUrl: null,
    verifiedAffiliateUrl: null,
    modelIds: null,
    modelNames: null,
    commissionAvailable: false,
    salesCountAvailable: false,
    source: "OPEN_API_FEED",
    sources: ["OPEN_API_FEED"],
    ...overrides,
  };
}

function client(input: {
  feeds?: unknown;
  pages?: Record<string, unknown>;
  pageError?: Error;
  available?: boolean;
}) {
  return {
    contractAvailable: input.available ?? true,
    listFeeds: vi.fn(async () => input.feeds ?? { feeds: [] }),
    getFeedPage: vi.fn(async ({ cursor }: { cursor: string | null }) => {
      if (input.pageError) throw input.pageError;
      return input.pages?.[cursor ?? "first"];
    }),
  } satisfies ShopeeRemoteFeedClient;
}

function page(items: unknown[], nextCursor: string | null = null) {
  return { feedId: "feed-1", items, nextCursor };
}

describe("Shopee remote feed contract gate", () => {
  it("performs zero requests when live access is not explicitly confirmed", async () => {
    const remote = client({});
    const result = await listShopeeOfficialFeeds({
      confirmLiveCall: false,
      environment,
      client: remote,
    });
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "SHOPEE_REMOTE_DISCOVERY_NOT_CONFIRMED",
      externalRequests: 0,
      writes: 0,
    });
    expect(remote.listFeeds).not.toHaveBeenCalled();
  });

  it("fails closed before HTTP while the official feed contract is unavailable", async () => {
    const remote = client({ available: false });
    const result = await listShopeeOfficialFeeds({
      confirmLiveCall: true,
      environment,
      client: remote,
    });
    expect(result).toMatchObject({
      errorCode: "SHOPEE_OPEN_API_FEED_CONTRACT_UNAVAILABLE",
      externalRequests: 0,
    });
    expect(remote.listFeeds).not.toHaveBeenCalled();
  });

  it("parses an empty feed list", async () => {
    const result = await listShopeeOfficialFeeds({
      confirmLiveCall: true,
      environment,
      client: client({ feeds: { feeds: [] } }),
    });
    expect(result).toMatchObject({ status: "SUCCEEDED", feeds: [] });
  });

  it("sanitizes and deterministically orders multiple feeds", async () => {
    const result = await listShopeeOfficialFeeds({
      confirmLiveCall: true,
      environment,
      client: client({
        feeds: {
          feeds: [
            { feedId: "z-feed", name: "Zeta" },
            { feedId: "a-feed", name: "Alpha", updatedAt: "2026-08-20" },
          ],
        },
      }),
    });
    expect(result.status).toBe("SUCCEEDED");
    if (result.status === "SUCCEEDED") {
      expect(result.feeds.map((feed) => feed.feedId)).toEqual([
        "a-feed",
        "z-feed",
      ]);
      expect(result.feeds[0]).toEqual({
        feedId: "a-feed",
        name: "Alpha",
        updatedAt: "2026-08-20",
        status: null,
      });
    }
  });

  it("rejects incomplete feed metadata as schema drift", async () => {
    const result = await listShopeeOfficialFeeds({
      confirmLiveCall: true,
      environment,
      client: client({ feeds: { feeds: [{ feedId: "feed-1" }] } }),
    });
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "SHOPEE_OPEN_API_SCHEMA_MISMATCH",
      externalRequests: 1,
    });
  });
});

describe("Shopee remote discovery preview", () => {
  it("reads one page and reuses category, filtering and ranking rules", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({ pages: { first: page([product("100")]) } }),
    });
    expect(result).toMatchObject({
      status: "PREVIEW_COMPLETED",
      source: "OPEN_API_FEED",
      pagesFetched: 1,
      itemsReceived: 1,
      itemsNormalized: 1,
      apiRequests: 1,
      databaseWrites: 0,
      publicationsCreated: 0,
      messagesSent: 0,
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({
      itemId: "100",
      category: "CASA",
    });
  });

  it("uses the opaque cursor and stops at the documented end signal", async () => {
    const remote = client({
      pages: {
        first: page([product("100")], "cursor-2"),
        "cursor-2": page([product("101")]),
      },
    });
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: remote,
    });
    expect(result.pagesFetched).toBe(2);
    expect(result.apiRequests).toBe(2);
    expect(remote.getFeedPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "cursor-2" }),
    );
  });

  it("detects cursor loops and exposes only a partial read without writes", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({
        pages: {
          first: page([product("100")], "repeat"),
          repeat: page([product("101")], "repeat"),
        },
      }),
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      errorCode: "SHOPEE_REMOTE_DISCOVERY_CURSOR_LOOP",
      databaseWrites: 0,
      stateModified: false,
    });
  });

  it("stops at the configured page limit", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment: {
        ...environment,
        SHOPEE_REMOTE_DISCOVERY_MAX_PAGES: "1",
      },
      client: client({
        pages: { first: page([product("100")], "cursor-2") },
      }),
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      errorCode: "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED",
      pagesFetched: 1,
    });
  });

  it("deduplicates the same item between pages", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({
        pages: {
          first: page([product("100")], "next"),
          next: page([product("100", { description: "mais completo" })]),
        },
      }),
    });
    expect(result.duplicates).toBe(1);
    expect(result.selected).toHaveLength(1);
  });

  it("rejects unexpected normalized item shapes without guessing fields", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({ pages: { first: page([{ itemId: "100" }]) } }),
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      errorCode: "SHOPEE_OPEN_API_SCHEMA_MISMATCH",
      databaseWrites: 0,
    });
  });

  it("rejects a feed outside the explicit allowlist before requesting a page", async () => {
    const remote = client({ pages: { first: page([product("100")]) } });
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment: {
        ...environment,
        SHOPEE_REMOTE_DISCOVERY_FEED_IDS: "feed-2",
      },
      client: remote,
    });
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "SHOPEE_REMOTE_FEED_NOT_ENABLED",
      apiRequests: 0,
    });
    expect(remote.getFeedPage).not.toHaveBeenCalled();
  });

  it("preserves a transient rate-limit as partial and does not retry forever", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({
        pageError: new ShopeeOpenApiError("SHOPEE_OPEN_API_RATE_LIMITED", true),
      }),
    });
    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "SHOPEE_OPEN_API_RATE_LIMITED",
      apiRequests: 1,
    });
  });

  it("retries one transient request failure and then succeeds", async () => {
    const getFeedPage = vi
      .fn()
      .mockRejectedValueOnce(
        new ShopeeOpenApiError("SHOPEE_OPEN_API_REQUEST_FAILED", true),
      )
      .mockResolvedValueOnce(page([product("100")]));
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: {
        contractAvailable: true,
        listFeeds: vi.fn(),
        getFeedPage,
      },
    });
    expect(result).toMatchObject({
      status: "PREVIEW_COMPLETED",
      apiRequests: 2,
    });
    expect(getFeedPage).toHaveBeenCalledTimes(2);
  });

  it("keeps already read candidates in a partial preview after a mid-stream rate limit", async () => {
    const getFeedPage = vi
      .fn()
      .mockResolvedValueOnce(page([product("100")], "next"))
      .mockRejectedValueOnce(
        new ShopeeOpenApiError("SHOPEE_OPEN_API_RATE_LIMITED", true),
      );
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      categories: SHOPEE_CATEGORY_CATALOG.map((category) => ({
        ...category,
        enabled: category.id === "CASA",
      })),
      client: {
        contractAvailable: true,
        listFeeds: vi.fn(),
        getFeedPage,
      },
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      errorCode: "SHOPEE_OPEN_API_RATE_LIMITED",
      pagesFetched: 1,
      apiRequests: 2,
      databaseWrites: 0,
    });
    expect(result.selected).toHaveLength(1);
  });

  it("preserves recent-selection and maximum-two-per-category behavior", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      recentItemIds: ["100"],
      categories: SHOPEE_CATEGORY_CATALOG.map((category) => ({
        ...category,
        enabled: category.id === "CASA",
      })),
      client: client({
        pages: {
          first: page([
            product("100"),
            product("101"),
            product("102"),
            product("103"),
          ]),
        },
      }),
    });
    expect(result.selected.map((item) => item.itemId)).toEqual(["101", "102"]);
    expect(result.itemsRejected).toBe(1);
  });

  it("reuses six-category round robin and caps the remote selection at twelve", async () => {
    const categoryFixtures = [
      ["Mobile & Gadgets", "Mobile Phones"],
      ["Home & Living", null],
      ["Women Clothes", null],
      ["Watches", null],
      ["Spare Parts and Accessories for Vehicles", null],
      ["Home Appliances", null],
    ] as const;
    const items = categoryFixtures.flatMap(
      ([category1, category2], categoryIndex) =>
        [0, 1, 2].map((position) => {
          const itemId = String(1_000 + categoryIndex * 10 + position);
          return product(itemId, { category1, category2 });
        }),
    );
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({ pages: { first: page(items) } }),
    });
    expect(result.selected).toHaveLength(12);
    expect(result.selected.map((item) => item.category)).toEqual([
      "CELULARES",
      "CASA",
      "MODA",
      "RELOGIOS",
      "AUTOMOTIVO",
      "ELETRODOMESTICOS",
      "CELULARES",
      "CASA",
      "MODA",
      "RELOGIOS",
      "AUTOMOTIVO",
      "ELETRODOMESTICOS",
    ]);
  });

  it("uses the shared deterministic score ordering instead of page order", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      categories: SHOPEE_CATEGORY_CATALOG.map((category) => ({
        ...category,
        enabled: category.id === "CASA",
        maxPerCategory: 1,
      })),
      client: client({
        pages: {
          first: page([
            product("100", { discountPercentage: 20, itemRating: 4.7 }),
            product("101", { discountPercentage: 60, itemRating: 5 }),
          ]),
        },
      }),
    });
    expect(result.selected.map((item) => item.itemId)).toEqual(["101"]);
  });
});

describe("Shopee automated one-shot pipeline", () => {
  function lock(acquired = true): LockHandle {
    return {
      key: "shopee:remote-discovery",
      token: "owner",
      acquired,
      mode: "redis-url",
      ...(acquired ? {} : { failureReason: "LOCK_ALREADY_HELD" as const }),
      extend: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
  }

  function persistence(
    overrides: Partial<ShopeeOperationalPersistence> = {},
  ): ShopeeOperationalPersistence {
    return {
      findDuplicateImport: vi.fn(async () => null),
      startImport: vi.fn(async () => ({ id: "job-1" })),
      persistWinner: vi.fn(async () => ({
        ok: false,
        productId: "product-1",
        offerId: "offer-1",
        productCreated: true,
        offerCreated: true,
        status: "READY_FOR_AFFILIATE_LINK" as const,
        statusReason: "AFFILIATE_LINK_REQUIRED",
        linkStatus: "PENDING" as const,
      })),
      recordFailure: vi.fn(async () => undefined),
      finishImport: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it("does not acquire a lock, call externally or write without confirmation", async () => {
    const remote = client({ pages: { first: page([product("100")]) } });
    const acquire = vi.fn();
    const result = await runShopeeAutomatedDiscovery({
      feedId: "feed-1",
      confirmLiveCall: false,
      confirmImport: true,
      environment,
      client: remote,
      acquireDiscoveryLock: acquire,
    });
    expect(result).toMatchObject({ externalRequests: 0, writes: 0 });
    expect(acquire).not.toHaveBeenCalled();
    expect(remote.getFeedPage).not.toHaveBeenCalled();
  });

  it("fails closed before API access when the distributed lock is held", async () => {
    const remote = client({ pages: { first: page([product("100")]) } });
    const result = await runShopeeAutomatedDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      confirmImport: true,
      environment,
      client: remote,
      acquireDiscoveryLock: vi.fn(async () => lock(false)),
    });
    expect(result.errorCode).toBe("SHOPEE_REMOTE_DISCOVERY_ALREADY_RUNNING");
    expect(result.externalRequests).toBe(0);
    expect(remote.getFeedPage).not.toHaveBeenCalled();
  });

  it("keeps preview read-only even when auto-link is enabled", async () => {
    const result = await runShopeeAutomatedDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      confirmImport: false,
      environment: { ...environment, SHOPEE_AUTO_LINK_AFTER_IMPORT: "true" },
      client: client({ pages: { first: page([product("100")]) } }),
    });
    expect(result).toMatchObject({
      status: "PREVIEW_COMPLETED",
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
    });
  });

  it("imports only selected winners and releases the owned lock", async () => {
    const storage = persistence();
    const ownedLock = lock();
    const result = await runShopeeAutomatedDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      confirmImport: true,
      environment,
      client: client({ pages: { first: page([product("100")]) } }),
      persistence: storage,
      acquireDiscoveryLock: vi.fn(async () => ownedLock),
    });
    expect(result).toMatchObject({
      status: "IMPORTED",
      writes: 1,
      publicationsCreated: 0,
      messagesSent: 0,
    });
    expect(storage.persistWinner).toHaveBeenCalledTimes(1);
    expect(ownedLock.release).toHaveBeenCalledTimes(1);
  });

  it("is idempotent when the remote commercial fingerprint was already imported", async () => {
    const storage = persistence({
      findDuplicateImport: vi.fn(async () => ({ id: "existing-job" })),
    });
    const result = await runShopeeAutomatedDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      confirmImport: true,
      environment,
      client: client({ pages: { first: page([product("100")]) } }),
      persistence: storage,
      acquireDiscoveryLock: vi.fn(async () => lock()),
    });
    expect(result).toMatchObject({ status: "DUPLICATE", writes: 0 });
    expect(storage.persistWinner).not.toHaveBeenCalled();
  });

  it("keeps auto-link disabled by default for remote imports", async () => {
    const bulkLinker = vi.fn();
    await runShopeeAutomatedDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      confirmImport: true,
      environment,
      client: client({ pages: { first: page([product("100")]) } }),
      persistence: persistence(),
      acquireDiscoveryLock: vi.fn(async () => lock()),
      bulkLinker: bulkLinker as never,
    });
    expect(bulkLinker).not.toHaveBeenCalled();
  });

  it("delegates optional HYBRID auto-linking after the remote import commit", async () => {
    const bulkLinker = vi.fn(async () => ({
      status: "SUCCEEDED",
      source: "IMPORT",
      requested: 1,
      eligible: 1,
      attempted: 1,
      linked: 1,
      alreadyLinked: 0,
      failed: 0,
      notAttempted: 0,
      readyToPublish: 1,
      remainingPending: 0,
      linksRequested: 1,
      linksGenerated: 1,
      linksReused: 0,
      linksFailed: 0,
      linksSkipped: 0,
      apiAttempts: 1,
      retryAttempts: 0,
      durationMs: 1,
      externalRequests: 1,
      writes: 1,
      publicationsCreated: 0,
      messagesSent: 0,
      items: [],
    }));
    const storage = persistence();
    await runShopeeAutomatedDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      confirmImport: true,
      environment: { ...environment, SHOPEE_AUTO_LINK_AFTER_IMPORT: "true" },
      client: client({ pages: { first: page([product("100")]) } }),
      persistence: storage,
      acquireDiscoveryLock: vi.fn(async () => lock()),
      bulkLinker: bulkLinker as never,
    });
    expect(
      vi.mocked(storage.persistWinner).mock.invocationCallOrder[0],
    ).toBeLessThan(bulkLinker.mock.invocationCallOrder[0]!);
    expect(bulkLinker).toHaveBeenCalledWith(
      expect.objectContaining({ confirmGenerate: true }),
    );
  });
});
