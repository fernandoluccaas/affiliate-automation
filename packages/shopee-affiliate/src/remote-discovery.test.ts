import { describe, expect, it, vi } from "vitest";
import type { LockHandle } from "@affiliate/redis";
import { SHOPEE_CATEGORY_CATALOG } from "./config";
import { ShopeeOpenApiError } from "./open-api";
import {
  listShopeeOfficialFeeds,
  previewShopeeRemoteDiscovery,
  runShopeeAutomatedDiscovery,
  type ShopeeRemoteFeedClient,
} from "./remote-discovery";
import type { ShopeeOperationalPersistence } from "./operational";

const environment = {
  SHOPEE_AFFILIATE_ENABLED: "true",
  SHOPEE_AFFILIATE_MODE: "HYBRID",
  SHOPEE_OPEN_API_APP_ID: "configured",
  SHOPEE_OPEN_API_SECRET: "configured",
  SHOPEE_DISCOVERY_SOURCE: "OPEN_API_FEED",
  SHOPEE_REMOTE_DISCOVERY_MAX_PAGES: "10",
  SHOPEE_REMOTE_DISCOVERY_MAX_ITEMS: "10000",
} as NodeJS.ProcessEnv;

function feed(referenceId: string, date = "20260819") {
  return {
    datafeedId: `${referenceId}_FULL_${date}`,
    referenceId,
    datafeedName: `Feed ${referenceId}`,
    description: "Fixture sanitizada",
    totalCount: 10,
    date,
    feedMode: "FULL" as const,
  };
}

function columns(itemId: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    itemid: itemId,
    title: `Produto ${itemId}`,
    price: "120",
    sale_price: "80",
    discount_percentage: "33.33",
    item_rating: "4.9",
    global_category1: "Home & Living",
    global_category2: "",
    global_catid1: "home",
    global_catid2: "",
    global_item_attributes: "{}",
    image_link: `https://down-br.img.susercontent.com/file/${itemId}`,
    image_link_3: "",
    product_link: `https://shopee.com.br/produto-i.123.${itemId}`,
    "product_short link": `https://shopee.com.br/universal-link/product/123/${itemId}`,
    description: "",
    ...overrides,
  });
}

function page(input: {
  offset: number;
  limit?: number;
  ids?: string[];
  totalCount?: number;
  hasMore?: boolean;
}) {
  const ids = input.ids ?? [];
  return {
    rows: ids.map((itemId) => ({ columns: columns(itemId), updateType: null })),
    pageInfo: {
      offset: input.offset,
      limit: input.limit ?? 500,
      totalCount: input.totalCount ?? input.offset + ids.length,
      hasMore: input.hasMore ?? false,
    },
  };
}

function client(input: {
  feeds?: unknown;
  pages?: Record<string, unknown>;
  available?: boolean;
}) {
  return {
    contractAvailable: input.available ?? true,
    listFeeds: vi.fn(async () => input.feeds ?? { feeds: [] }),
    getFeedPage: vi.fn(
      async ({ datafeedId, offset }: { datafeedId: string; offset: number }) =>
        input.pages?.[`${datafeedId}:${offset}`] ??
        input.pages?.[String(offset)],
    ),
  } satisfies ShopeeRemoteFeedClient;
}

describe("Shopee official feed listing", () => {
  it("performs zero requests without explicit live confirmation", async () => {
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

  it("calls listItemFeeds in FULL mode and returns sanitized contract fields", async () => {
    const remote = client({ feeds: { feeds: [feed("ref-b"), feed("ref-a")] } });
    const result = await listShopeeOfficialFeeds({
      confirmLiveCall: true,
      environment,
      client: remote,
    });
    expect(remote.listFeeds).toHaveBeenCalledWith({ feedMode: "FULL" });
    expect(result).toMatchObject({ status: "SUCCEEDED", externalRequests: 1 });
    if (result.status === "SUCCEEDED") {
      expect(result.feeds.map((item) => item.referenceId)).toEqual([
        "ref-a",
        "ref-b",
      ]);
    }
  });

  it("blocks DELTA and unavailable adapters before HTTP", async () => {
    const remote = client({ available: false });
    expect(
      await listShopeeOfficialFeeds({
        confirmLiveCall: true,
        feedMode: "DELTA",
        environment,
        client: remote,
      }),
    ).toMatchObject({
      errorCode: "SHOPEE_REMOTE_DISCOVERY_DELTA_NOT_SUPPORTED",
      externalRequests: 0,
    });
    expect(remote.listFeeds).not.toHaveBeenCalled();
  });
});

describe("Shopee offset feed discovery", () => {
  it("completes on a full last page with hasMore=true without a terminal request", async () => {
    const remote = client({
      pages: {
        "0": page({
          offset: 0,
          limit: 2,
          ids: ["100", "101"],
          totalCount: 4,
          hasMore: true,
        }),
        "2": page({
          offset: 2,
          limit: 2,
          ids: ["102", "103"],
          totalCount: 4,
          hasMore: true,
        }),
      },
    });
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      pageSize: 2,
      environment,
      client: remote,
    });
    expect(result).toMatchObject({
      status: "PREVIEW_COMPLETED",
      complete: true,
      pagesFetched: 2,
      itemsReceived: 4,
      itemsNormalized: 4,
      databaseWrites: 0,
      publicationsCreated: 0,
    });
    expect(remote.getFeedPage.mock.calls.map(([call]) => call.offset)).toEqual([
      0, 2,
    ]);
  });

  it("accepts the official empty terminal page when totalCount is revalidated", async () => {
    const remote = client({
      pages: {
        "0": page({
          offset: 0,
          limit: 2,
          ids: ["100", "101"],
          totalCount: 3,
          hasMore: true,
        }),
        "2": page({ offset: 2, limit: 2, ids: [], totalCount: 2 }),
      },
    });
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      pageSize: 2,
      environment,
      client: remote,
    });
    expect(result).toMatchObject({
      status: "PREVIEW_COMPLETED",
      complete: true,
      pagesFetched: 2,
      itemsReceived: 2,
    });
    expect(remote.getFeedPage.mock.calls.map(([call]) => call.offset)).toEqual([
      0, 2,
    ]);
  });

  it("accepts hasMore=false on a partial-sized page that reaches totalCount", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({
        pages: {
          "0": page({ offset: 0, ids: ["100", "101"], totalCount: 2 }),
        },
      }),
    });
    expect(result).toMatchObject({
      status: "PREVIEW_COMPLETED",
      complete: true,
    });
  });

  it.each([
    [
      "hasMore=true with empty rows before totalCount",
      { "0": page({ offset: 0, ids: [], totalCount: 1, hasMore: true }) },
      "SHOPEE_REMOTE_DISCOVERY_PAGINATION_INCONSISTENT",
    ],
    [
      "a repeated offset without progress",
      {
        "0": page({ offset: 0, ids: ["100"], totalCount: 3, hasMore: true }),
        "1": page({ offset: 0, ids: ["101"], totalCount: 3, hasMore: true }),
      },
      "SHOPEE_REMOTE_DISCOVERY_PAGINATION_INCONSISTENT",
    ],
    [
      "a regressive offset",
      {
        "0": page({
          offset: 0,
          ids: ["100", "101"],
          totalCount: 4,
          hasMore: true,
        }),
        "2": page({ offset: 1, ids: ["102"], totalCount: 4, hasMore: true }),
      },
      "SHOPEE_REMOTE_DISCOVERY_PAGINATION_INCONSISTENT",
    ],
    [
      "hasMore=false before the totalCount boundary",
      { "0": page({ offset: 0, ids: ["100"], totalCount: 2 }) },
      "SHOPEE_REMOTE_DISCOVERY_TOTAL_COUNT_INCONSISTENT",
    ],
  ])("fails safely for %s", async (_label, pages, errorCode) => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({ pages }),
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      errorCode,
      complete: false,
    });
  });

  it("honors page size and conservative max-page limits", async () => {
    const remote = client({
      pages: {
        "0": page({
          offset: 0,
          limit: 3,
          ids: ["100"],
          totalCount: 4,
          hasMore: true,
        }),
      },
    });
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      pageSize: 3,
      maxPages: 1,
      maxItems: 3,
      environment,
      client: remote,
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      errorCode: "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED",
      pagesFetched: 1,
    });
    expect(remote.getFeedPage).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, limit: 3 }),
    );
  });

  it("returns an expected partial preview when maxItems truncates a page", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      maxItems: 2,
      environment,
      client: client({
        pages: {
          "0": page({
            offset: 0,
            ids: ["100", "101", "102"],
            totalCount: 4,
            hasMore: true,
          }),
        },
      }),
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      complete: false,
      errorCode: "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED",
      itemsReceived: 2,
      databaseWrites: 0,
      publicationsCreated: 0,
    });
  });

  it("rejects invalid columns per item and preserves valid candidates", async () => {
    const rawPage = page({ offset: 0, ids: ["100"], totalCount: 2 });
    rawPage.rows.push({ columns: "{", updateType: null });
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({ pages: { "0": rawPage } }),
    });
    expect(result).toMatchObject({
      status: "PREVIEW_COMPLETED",
      itemsReceived: 2,
      itemsNormalized: 1,
      itemsRejected: 1,
    });
    expect(result.selected.map((item) => item.itemId)).toEqual(["100"]);
  });

  it("fails closed when a FULL page unexpectedly contains updateType", async () => {
    const rawPage = page({ offset: 0, ids: ["100"] });
    (
      rawPage.rows[0] as { columns: string; updateType: string | null }
    ).updateType = "UPDATE";
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({ pages: { "0": rawPage } }),
    });
    expect(result).toMatchObject({
      status: "PARTIAL",
      complete: false,
      errorCode: "SHOPEE_REMOTE_DISCOVERY_DELTA_NOT_SUPPORTED",
    });
  });

  it("does not retry schema/auth/rate errors and retries one transient transport failure", async () => {
    const noRetry = vi
      .fn()
      .mockRejectedValue(
        new ShopeeOpenApiError("SHOPEE_OPEN_API_RATE_LIMITED", true),
      );
    const failed = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: {
        contractAvailable: true,
        listFeeds: vi.fn(),
        getFeedPage: noRetry,
      },
    });
    expect(failed.errorCode).toBe("SHOPEE_OPEN_API_RATE_LIMITED");
    expect(noRetry).toHaveBeenCalledOnce();

    const retry = vi
      .fn()
      .mockRejectedValueOnce(
        new ShopeeOpenApiError("SHOPEE_OPEN_API_REQUEST_FAILED", true),
      )
      .mockResolvedValueOnce(page({ offset: 0, ids: ["100"] }));
    const succeeded = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: {
        contractAvailable: true,
        listFeeds: vi.fn(),
        getFeedPage: retry,
      },
    });
    expect(succeeded.status).toBe("PREVIEW_COMPLETED");
    expect(retry).toHaveBeenCalledTimes(2);
  });
});

describe("Shopee reference and multi-feed selection", () => {
  it("resolves the newest datafeedId for a stable referenceId", async () => {
    const remote = client({
      feeds: {
        feeds: [feed("stable", "20260818"), feed("stable", "20260819")],
      },
      pages: {
        "stable_FULL_20260819:0": page({ offset: 0, ids: ["100"] }),
      },
    });
    const result = await previewShopeeRemoteDiscovery({
      referenceIds: ["stable"],
      confirmLiveCall: true,
      environment,
      client: remote,
    });
    expect(result.feed?.datafeedId).toBe("stable_FULL_20260819");
    expect(remote.getFeedPage).toHaveBeenCalledWith(
      expect.objectContaining({ datafeedId: "stable_FULL_20260819" }),
    );
  });

  it("processes feeds sequentially and deduplicates the same item across feeds", async () => {
    const remote = client({
      pages: {
        "feed-a:0": page({ offset: 0, ids: ["100", "101"] }),
        "feed-b:0": page({ offset: 0, ids: ["100", "102"] }),
      },
    });
    const result = await previewShopeeRemoteDiscovery({
      feedIds: ["feed-a", "feed-b"],
      confirmLiveCall: true,
      environment,
      client: remote,
    });
    expect(result).toMatchObject({ feedsProcessed: 2, duplicates: 1 });
    expect(
      remote.getFeedPage.mock.calls.map(([call]) => call.datafeedId),
    ).toEqual(["feed-a", "feed-b"]);
    expect(new Set(result.selected.map((item) => item.itemId)).size).toBe(
      result.selected.length,
    );
  });

  it("uses shared round-robin ranking and keeps at most twelve bounded winners", async () => {
    const categoryFixtures = [
      ["Mobile & Gadgets", "Mobile Phones"],
      ["Home & Living", ""],
      ["Women Clothes", ""],
      ["Watches", ""],
      ["Spare Parts and Accessories for Vehicles", ""],
      ["Home Appliances", ""],
    ] as const;
    const rows = categoryFixtures.flatMap(
      ([category1, category2], categoryIndex) =>
        [0, 1, 2].map((position) => ({
          columns: columns(String(1000 + categoryIndex * 10 + position), {
            global_category1: category1,
            global_category2: category2,
          }),
          updateType: null,
        })),
    );
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      environment,
      client: client({
        pages: {
          "0": {
            rows,
            pageInfo: {
              offset: 0,
              limit: 500,
              totalCount: rows.length,
              hasMore: false,
            },
          },
        },
      }),
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

  it("keeps only a bounded candidate pool for a large conceptual feed", async () => {
    const ids = Array.from({ length: 150 }, (_, index) =>
      String(20_000 + index),
    );
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      categories: SHOPEE_CATEGORY_CATALOG.map((category) => ({
        ...category,
        enabled: category.id === "CASA",
      })),
      environment,
      client: client({ pages: { "0": page({ offset: 0, ids }) } }),
    });
    expect(result.itemsNormalized).toBe(150);
    expect(result.candidatePoolSize).toBeLessThanOrEqual(20);
    expect(result.selected).toHaveLength(2);
  });

  it("preserves recent-selection filtering across source changes", async () => {
    const result = await previewShopeeRemoteDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      recentItemIds: ["100"],
      categories: SHOPEE_CATEGORY_CATALOG.map((category) => ({
        ...category,
        enabled: category.id === "CASA",
      })),
      environment,
      client: client({
        pages: { "0": page({ offset: 0, ids: ["100", "101"] }) },
      }),
    });
    expect(result.selected.map((item) => item.itemId)).toEqual(["101"]);
  });
});

describe("Shopee remote import safety", () => {
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

  function persistence(): ShopeeOperationalPersistence {
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
    };
  }

  it("does no HTTP or writes without both confirmations", async () => {
    const remote = client({
      pages: { "0": page({ offset: 0, ids: ["100"] }) },
    });
    const result = await runShopeeAutomatedDiscovery({
      feedId: "feed-1",
      confirmLiveCall: false,
      confirmImport: true,
      environment,
      client: remote,
    });
    expect(result).toMatchObject({ externalRequests: 0, writes: 0 });
    expect(remote.getFeedPage).not.toHaveBeenCalled();
  });

  it("refuses writes from a truncated catalog", async () => {
    const storage = persistence();
    const result = await runShopeeAutomatedDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      confirmImport: true,
      maxPages: 1,
      environment,
      client: client({
        pages: {
          "0": page({
            offset: 0,
            ids: ["100"],
            totalCount: 501,
            hasMore: true,
          }),
        },
      }),
      persistence: storage,
      acquireDiscoveryLock: vi.fn(async () => lock()),
    });
    expect(result).toMatchObject({ status: "PARTIAL", writes: 0 });
    expect(storage.persistWinner).not.toHaveBeenCalled();
  });

  it("imports complete winners, preserves zero Publications and releases the lock", async () => {
    const storage = persistence();
    const ownedLock = lock();
    const result = await runShopeeAutomatedDiscovery({
      feedId: "feed-1",
      confirmLiveCall: true,
      confirmImport: true,
      environment,
      client: client({ pages: { "0": page({ offset: 0, ids: ["100"] }) } }),
      persistence: storage,
      acquireDiscoveryLock: vi.fn(async () => ownedLock),
    });
    expect(result).toMatchObject({
      status: "IMPORTED",
      writes: 1,
      publicationsCreated: 0,
      messagesSent: 0,
    });
    expect(storage.persistWinner).toHaveBeenCalledOnce();
    expect(ownedLock.release).toHaveBeenCalledOnce();
  });
});
