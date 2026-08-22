import { createHash } from "node:crypto";
import { acquireLock, type LockHandle } from "@affiliate/redis";
import {
  DEFAULT_SHOPEE_FILTERS,
  DEFAULT_SHOPEE_RANKING_WEIGHTS,
  DEFAULT_SHOPEE_SELECTION,
  SHOPEE_CATEGORY_CATALOG,
  resolveShopeeAffiliateConfiguration,
} from "./config";
import {
  createShopeeRankedCandidate,
  compareShopeeRankedCandidates,
  filterShopeeCandidate,
  matchShopeeCategory,
  mergeShopeeDatafeedProducts,
  selectShopeeRoundRobin,
} from "./discovery";
import {
  SHOPEE_ITEM_FEED_MAX_PAGE_SIZE,
  SHOPEE_OFFICIAL_FEED_CONTRACT,
  ShopeeGetItemFeedDataResponseSchema,
  ShopeeListItemFeedsResponseSchema,
  parseShopeeOfficialFeedColumns,
  type ShopeeFeedMode,
  type ShopeeItemFeedPage,
  type ShopeeOfficialFeed,
} from "./official-feed-contract";
import { ShopeeOpenApiClient, ShopeeOpenApiError } from "./open-api";
import {
  generateShopeeAffiliateLinksBulk,
  persistShopeeOperationalWinners,
  type ShopeeOperationalPersistence,
  type ShopeePreparedImportResult,
} from "./operational";
import type {
  ShopeeCategoryRule,
  ShopeeDatafeedProduct,
  ShopeeDiscoveryFilters,
  ShopeeLogicalCategory,
  ShopeeRankedCandidate,
  ShopeeRankingWeights,
} from "./types";

export const SHOPEE_REMOTE_FEED_CONTRACT_STATUS = SHOPEE_OFFICIAL_FEED_CONTRACT;
const CANDIDATE_POOL_LIMIT = 100;

export type ShopeeRemoteFeed = ShopeeOfficialFeed;
export type ShopeeRemoteFeedPage = ShopeeItemFeedPage;

export interface ShopeeRemoteFeedClient {
  readonly contractAvailable: boolean;
  listFeeds(input: {
    feedMode?: ShopeeFeedMode;
    signal?: AbortSignal;
  }): Promise<unknown>;
  getFeedPage(input: {
    datafeedId: string;
    offset: number;
    limit: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export type ShopeeRemoteFeedListResult =
  | {
      status: "SUCCEEDED";
      feeds: ShopeeRemoteFeed[];
      externalRequests: number;
      writes: 0;
      stateModified: false;
    }
  | {
      status: "FAILED";
      errorCode: string;
      feeds: [];
      externalRequests: number;
      writes: 0;
      stateModified: false;
    };

export type ShopeeRemoteDiscoveryResult = {
  status: "PREVIEW_COMPLETED" | "PARTIAL" | "FAILED";
  source: "OPEN_API_FEED";
  complete: boolean;
  feed: ShopeeRemoteFeed | null;
  feeds: ShopeeRemoteFeed[];
  feedsDiscovered: number;
  feedsSelected: number;
  feedsProcessed: number;
  currentFeed: string | null;
  feedTotalCount: number | null;
  pagesFetched: number;
  itemsReceived: number;
  itemsNormalized: number;
  itemsRejected: number;
  duplicates: number;
  eligible: number;
  candidatePoolSize: number;
  eligibleByCategory: Record<string, number>;
  selected: ShopeeRankedCandidate[];
  apiRequests: number;
  durationMs: number;
  errorCode: string | null;
  databaseWrites: 0;
  publicationsCreated: 0;
  messagesSent: 0;
  stateModified: false;
};

export type PreparedShopeeRemoteDiscovery = {
  result: ShopeeRemoteDiscoveryResult;
  winners: Array<{
    candidate: ShopeeRankedCandidate;
    product: ShopeeDatafeedProduct;
  }>;
};

export type ShopeeAutomatedDiscoveryResult = {
  status: "PREVIEW_COMPLETED" | "IMPORTED" | "DUPLICATE" | "PARTIAL" | "FAILED";
  preview: ShopeeRemoteDiscoveryResult;
  importResult: ShopeePreparedImportResult | null;
  externalRequests: number;
  writes: number;
  publicationsCreated: 0;
  messagesSent: 0;
  stateModified: boolean;
  errorCode: string | null;
};

export class OfficialShopeeRemoteFeedClient implements ShopeeRemoteFeedClient {
  readonly contractAvailable = true;

  constructor(private readonly client: ShopeeOpenApiClient) {}

  listFeeds(input: { feedMode?: ShopeeFeedMode }) {
    return this.client.listItemFeeds(input.feedMode);
  }

  getFeedPage(input: { datafeedId: string; offset: number; limit: number }) {
    return this.client.getItemFeedData(input);
  }
}

export function createOfficialShopeeRemoteFeedClient(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  return new OfficialShopeeRemoteFeedClient(
    new ShopeeOpenApiClient(
      {
        appId: environment.SHOPEE_OPEN_API_APP_ID ?? "",
        secret: environment.SHOPEE_OPEN_API_SECRET ?? "",
      },
      {
        timeoutMs: configuration.openApiTimeoutMs,
        rateLimitPerHour: configuration.openApiRateLimitPerHour,
      },
    ),
  );
}

function safeCode(error: unknown) {
  if (error instanceof ShopeeOpenApiError) return error.code;
  const message = error instanceof Error ? error.message : "";
  return /^SHOPEE_[A-Z0-9_]+$/.test(message)
    ? message
    : "SHOPEE_REMOTE_DISCOVERY_FAILED";
}

function validIdentifier(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null;
}

function parseFeedList(value: unknown) {
  const parsed = ShopeeListItemFeedsResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  return parsed.data.feeds.sort(
    (left, right) =>
      left.referenceId.localeCompare(right.referenceId) ||
      right.date.localeCompare(left.date) ||
      left.datafeedId.localeCompare(right.datafeedId),
  );
}

function parsePage(value: unknown) {
  const parsed = ShopeeGetItemFeedDataResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  return parsed.data;
}

function preflight(environment: NodeJS.ProcessEnv) {
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  if (!configuration.enabled) {
    throw new ShopeeOpenApiError("SHOPEE_AFFILIATE_DISABLED");
  }
  if (!configuration.openApiReady) {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_NOT_READY");
  }
  return configuration;
}

export async function listShopeeOfficialFeeds(input: {
  confirmLiveCall: boolean;
  feedMode?: ShopeeFeedMode;
  environment?: NodeJS.ProcessEnv;
  client?: ShopeeRemoteFeedClient;
  signal?: AbortSignal;
}): Promise<ShopeeRemoteFeedListResult> {
  let externalRequests = 0;
  try {
    if (!input.confirmLiveCall) {
      throw new ShopeeOpenApiError("SHOPEE_REMOTE_DISCOVERY_NOT_CONFIRMED");
    }
    if (input.feedMode === "DELTA") {
      throw new ShopeeOpenApiError(
        "SHOPEE_REMOTE_DISCOVERY_DELTA_NOT_SUPPORTED",
      );
    }
    const environment = input.environment ?? process.env;
    preflight(environment);
    const client =
      input.client ?? createOfficialShopeeRemoteFeedClient(environment);
    if (!client.contractAvailable) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_FEED_CONTRACT_UNAVAILABLE");
    }
    externalRequests += 1;
    const feeds = parseFeedList(
      await client.listFeeds({
        feedMode: input.feedMode ?? "FULL",
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    ).filter((feed) => feed.feedMode === "FULL");
    return {
      status: "SUCCEEDED",
      feeds,
      externalRequests,
      writes: 0,
      stateModified: false,
    };
  } catch (error) {
    return {
      status: "FAILED",
      errorCode: safeCode(error),
      feeds: [],
      externalRequests,
      writes: 0,
      stateModified: false,
    };
  }
}

function emptyResult(startedAt: number): ShopeeRemoteDiscoveryResult {
  return {
    status: "FAILED",
    source: "OPEN_API_FEED",
    complete: false,
    feed: null,
    feeds: [],
    feedsDiscovered: 0,
    feedsSelected: 0,
    feedsProcessed: 0,
    currentFeed: null,
    feedTotalCount: null,
    pagesFetched: 0,
    itemsReceived: 0,
    itemsNormalized: 0,
    itemsRejected: 0,
    duplicates: 0,
    eligible: 0,
    candidatePoolSize: 0,
    eligibleByCategory: {},
    selected: [],
    apiRequests: 0,
    durationMs: Math.round(performance.now() - startedAt),
    errorCode: null,
    databaseWrites: 0,
    publicationsCreated: 0,
    messagesSent: 0,
    stateModified: false,
  };
}

type PrepareInput = {
  feedId?: string;
  feedIds?: readonly string[];
  referenceIds?: readonly string[];
  feedMode?: ShopeeFeedMode;
  pageSize?: number;
  maxPages?: number;
  maxItems?: number;
  confirmLiveCall: boolean;
  environment?: NodeJS.ProcessEnv;
  client?: ShopeeRemoteFeedClient;
  signal?: AbortSignal;
  categories?: ShopeeCategoryRule[];
  filters?: Partial<ShopeeDiscoveryFilters>;
  weights?: Partial<ShopeeRankingWeights>;
  recentItemIds?: readonly string[];
  maxTotal?: number;
  maxPerShop?: number;
};

function uniqueIdentifiers(values: readonly string[]) {
  const unique = [...new Set(values)];
  if (unique.length > 20 || unique.some((value) => !validIdentifier(value))) {
    throw new ShopeeOpenApiError("SHOPEE_REMOTE_FEED_ID_INVALID");
  }
  return unique;
}

function currentFeedsForReferences(
  feeds: readonly ShopeeRemoteFeed[],
  referenceIds: readonly string[],
) {
  return referenceIds.map((referenceId) => {
    const current = feeds
      .filter(
        (feed) => feed.referenceId === referenceId && feed.feedMode === "FULL",
      )
      .sort(
        (left, right) =>
          right.date.localeCompare(left.date) ||
          right.datafeedId.localeCompare(left.datafeedId),
      )[0];
    if (!current) {
      throw new ShopeeOpenApiError("SHOPEE_REMOTE_REFERENCE_ID_NOT_FOUND");
    }
    return current;
  });
}

function manualFeed(datafeedId: string): ShopeeRemoteFeed {
  return {
    datafeedId,
    referenceId: datafeedId,
    datafeedName: datafeedId,
    description: "",
    totalCount: 0,
    date: "19700101",
    feedMode: "FULL",
  };
}

function validateLimits(input: {
  pageSize: number;
  maxPages: number;
  maxItems: number;
}) {
  if (
    !Number.isSafeInteger(input.pageSize) ||
    input.pageSize < 1 ||
    input.pageSize > SHOPEE_ITEM_FEED_MAX_PAGE_SIZE ||
    !Number.isSafeInteger(input.maxPages) ||
    input.maxPages < 1 ||
    input.maxPages > 500 ||
    !Number.isSafeInteger(input.maxItems) ||
    input.maxItems < 1 ||
    input.maxItems > 500_000
  ) {
    throw new ShopeeOpenApiError("SHOPEE_REMOTE_DISCOVERY_LIMIT_INVALID");
  }
}

export async function prepareShopeeRemoteDiscovery(
  input: PrepareInput,
): Promise<PreparedShopeeRemoteDiscovery> {
  const startedAt = performance.now();
  const result = emptyResult(startedAt);
  const winnersByItem = new Map<string, ShopeeDatafeedProduct>();
  const conflicts = new Map<string, number>();
  const seenItemIds = new Set<string>();
  try {
    if (!input.confirmLiveCall) {
      throw new ShopeeOpenApiError("SHOPEE_REMOTE_DISCOVERY_NOT_CONFIRMED");
    }
    if (input.feedMode === "DELTA") {
      throw new ShopeeOpenApiError(
        "SHOPEE_REMOTE_DISCOVERY_DELTA_NOT_SUPPORTED",
      );
    }
    const environment = input.environment ?? process.env;
    const configuration = preflight(environment);
    const client =
      input.client ?? createOfficialShopeeRemoteFeedClient(environment);
    if (!client.contractAvailable) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_FEED_CONTRACT_UNAVAILABLE");
    }
    const pageSize = input.pageSize ?? configuration.remoteDiscoveryPageSize;
    const maxPages = input.maxPages ?? configuration.remoteDiscoveryMaxPages;
    const maxItems = input.maxItems ?? configuration.remoteDiscoveryMaxItems;
    validateLimits({ pageSize, maxPages, maxItems });

    const explicitFeedIds = uniqueIdentifiers([
      ...(input.feedId ? [input.feedId] : []),
      ...(input.feedIds ?? []),
    ]);
    const explicitReferences = uniqueIdentifiers(input.referenceIds ?? []);
    if (explicitFeedIds.length > 0 && explicitReferences.length > 0) {
      throw new ShopeeOpenApiError("SHOPEE_REMOTE_FEED_SELECTION_AMBIGUOUS");
    }
    const references =
      explicitReferences.length > 0
        ? explicitReferences
        : explicitFeedIds.length === 0
          ? configuration.remoteDiscoveryReferenceIds
          : [];
    let feeds: ShopeeRemoteFeed[];
    if (references.length > 0) {
      result.apiRequests += 1;
      const discovered = parseFeedList(
        await client.listFeeds({
          feedMode: "FULL",
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
      result.feedsDiscovered = discovered.length;
      feeds = currentFeedsForReferences(discovered, references);
    } else {
      const legacyIds = configuration.remoteDiscoveryFeedIds;
      const selectedIds =
        explicitFeedIds.length > 0 ? explicitFeedIds : legacyIds;
      if (selectedIds.length === 0) {
        throw new ShopeeOpenApiError("SHOPEE_REMOTE_FEED_SELECTION_REQUIRED");
      }
      if (
        legacyIds.length > 0 &&
        explicitFeedIds.some((id) => !legacyIds.includes(id))
      ) {
        throw new ShopeeOpenApiError("SHOPEE_REMOTE_FEED_NOT_ENABLED");
      }
      feeds = selectedIds.map(manualFeed);
    }
    result.feeds = feeds;
    result.feed = feeds[0] ?? null;
    result.feedsSelected = feeds.length;

    const categories = input.categories ?? [...SHOPEE_CATEGORY_CATALOG];
    const filters = { ...DEFAULT_SHOPEE_FILTERS, ...input.filters };
    const weights = { ...DEFAULT_SHOPEE_RANKING_WEIGHTS, ...input.weights };
    const recent = new Set(input.recentItemIds ?? []);
    const pools = new Map<ShopeeLogicalCategory, ShopeeRankedCandidate[]>(
      categories.filter((item) => item.enabled).map((item) => [item.id, []]),
    );
    const eligible = new Map<string, number>();
    let paginationError: string | null = null;
    let reachedLimit = false;

    const consider = (product: ShopeeDatafeedProduct) => {
      const duplicate = seenItemIds.has(product.itemId);
      if (duplicate) result.duplicates += 1;
      else seenItemIds.add(product.itemId);
      const previous = winnersByItem.get(product.itemId);
      if (duplicate && !previous) return;
      const candidateProduct = previous
        ? mergeShopeeDatafeedProducts(previous, product, conflicts)
        : product;
      const category = matchShopeeCategory(candidateProduct, categories);
      if (!category || recent.has(candidateProduct.itemId)) {
        if (!duplicate) result.itemsRejected += 1;
        return;
      }
      if (filterShopeeCandidate(candidateProduct, filters)) {
        if (!duplicate) result.itemsRejected += 1;
        return;
      }
      if (!duplicate) {
        eligible.set(category.id, (eligible.get(category.id) ?? 0) + 1);
      }
      for (const existingPool of pools.values()) {
        const existingIndex = existingPool.findIndex(
          (item) => item.itemId === product.itemId,
        );
        if (existingIndex >= 0) existingPool.splice(existingIndex, 1);
      }
      const pool = pools.get(category.id) ?? [];
      pool.push(
        createShopeeRankedCandidate({
          product: candidateProduct,
          category: category.id,
          weights,
        }),
      );
      pool.sort(compareShopeeRankedCandidates);
      const removed = pool.splice(
        Math.min(CANDIDATE_POOL_LIMIT, Math.max(category.maxPerCategory, 20)),
      );
      for (const candidate of removed) {
        winnersByItem.delete(candidate.itemId);
      }
      pools.set(category.id, pool);
      if (pool.some((item) => item.itemId === candidateProduct.itemId)) {
        winnersByItem.set(candidateProduct.itemId, candidateProduct);
      } else {
        winnersByItem.delete(candidateProduct.itemId);
      }
    };

    for (const feed of feeds) {
      result.currentFeed = feed.referenceId;
      let offset = 0;
      const offsets = new Set<number>();
      while (true) {
        if (
          result.pagesFetched >= maxPages ||
          result.itemsReceived >= maxItems
        ) {
          reachedLimit = true;
          break;
        }
        if (offsets.has(offset)) {
          paginationError = "SHOPEE_REMOTE_DISCOVERY_OFFSET_LOOP";
          break;
        }
        offsets.add(offset);
        let rawPage: unknown;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          result.apiRequests += 1;
          try {
            rawPage = await client.getFeedPage({
              datafeedId: feed.datafeedId,
              offset,
              limit: pageSize,
              ...(input.signal ? { signal: input.signal } : {}),
            });
            break;
          } catch (error) {
            const retryable =
              error instanceof ShopeeOpenApiError &&
              error.retryable &&
              ![
                "SHOPEE_OPEN_API_RATE_LIMITED",
                "SHOPEE_OPEN_API_LOCAL_RATE_LIMITED",
              ].includes(error.code);
            if (retryable && attempt === 1) continue;
            paginationError = safeCode(error);
            break;
          }
        }
        if (paginationError) break;
        const page = parsePage(rawPage);
        const nextOffset = page.pageInfo.offset + page.rows.length;
        if (
          page.pageInfo.offset !== offset ||
          page.pageInfo.limit > pageSize ||
          page.rows.length > page.pageInfo.limit ||
          page.rows.length > pageSize ||
          page.pageInfo.offset > page.pageInfo.totalCount ||
          !Number.isSafeInteger(nextOffset) ||
          nextOffset > page.pageInfo.totalCount
        ) {
          paginationError = "SHOPEE_REMOTE_DISCOVERY_PAGINATION_INCONSISTENT";
          break;
        }
        result.feedTotalCount = page.pageInfo.totalCount;
        result.pagesFetched += 1;
        if (page.rows.some((row) => row.updateType !== null)) {
          paginationError = "SHOPEE_REMOTE_DISCOVERY_DELTA_NOT_SUPPORTED";
          break;
        }
        const remainingItems = maxItems - result.itemsReceived;
        const rowsToProcess = page.rows.slice(0, remainingItems);
        result.itemsReceived += rowsToProcess.length;
        if (rowsToProcess.length < page.rows.length) reachedLimit = true;
        for (const row of rowsToProcess) {
          const normalized = parseShopeeOfficialFeedColumns(row.columns);
          if (!normalized.ok) {
            result.itemsRejected += 1;
            continue;
          }
          result.itemsNormalized += 1;
          consider(normalized.product);
        }
        if (reachedLimit) break;

        // Shopee may report hasMore=true on the last full page. The catalog is
        // complete once the rows themselves reach the page's current boundary.
        if (page.rows.length > 0 && nextOffset >= page.pageInfo.totalCount) {
          break;
        }

        // The official terminal probe (offset === totalCount) is also valid.
        if (
          page.rows.length === 0 &&
          page.pageInfo.offset === page.pageInfo.totalCount &&
          !page.pageInfo.hasMore
        ) {
          break;
        }
        if (!page.pageInfo.hasMore) {
          if (nextOffset < page.pageInfo.totalCount) {
            paginationError =
              "SHOPEE_REMOTE_DISCOVERY_TOTAL_COUNT_INCONSISTENT";
          }
          break;
        }
        if (page.rows.length === 0 || nextOffset <= offset) {
          paginationError = "SHOPEE_REMOTE_DISCOVERY_PAGINATION_INCONSISTENT";
          break;
        }
        offset = nextOffset;
      }
      result.feedsProcessed += 1;
      if (paginationError || reachedLimit) break;
    }

    const selection = selectShopeeRoundRobin({
      pools,
      categories,
      maxTotal: Math.min(
        12,
        input.maxTotal ?? DEFAULT_SHOPEE_SELECTION.maxTotalPerSession,
      ),
      backfill: DEFAULT_SHOPEE_SELECTION.backfill,
      maxPerShop: input.maxPerShop ?? configuration.maxPerShopPerSession,
    });
    result.eligibleByCategory = Object.fromEntries(
      [...eligible.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    result.eligible = [...eligible.values()].reduce(
      (total, count) => total + count,
      0,
    );
    result.candidatePoolSize = [...pools.values()].reduce(
      (total, pool) => total + pool.length,
      0,
    );
    result.selected = selection.selected;
    result.complete = !reachedLimit && !paginationError;
    result.status = result.complete ? "PREVIEW_COMPLETED" : "PARTIAL";
    result.errorCode =
      paginationError ??
      (reachedLimit ? "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED" : null);
    result.durationMs = Math.round(performance.now() - startedAt);
    return {
      result,
      winners: selection.selected.flatMap((candidate) => {
        const product = winnersByItem.get(candidate.itemId);
        return product ? [{ candidate, product }] : [];
      }),
    };
  } catch (error) {
    result.status = result.pagesFetched > 0 ? "PARTIAL" : "FAILED";
    result.errorCode = safeCode(error);
    result.durationMs = Math.round(performance.now() - startedAt);
    return { result, winners: [] };
  }
}

export async function previewShopeeRemoteDiscovery(input: PrepareInput) {
  return (await prepareShopeeRemoteDiscovery(input)).result;
}

type AcquireDiscoveryLock = (
  key: string,
  ttlMs: number,
  options: { env: NodeJS.ProcessEnv; requireRedis: true },
) => Promise<LockHandle>;

export async function runShopeeAutomatedDiscovery(
  input: PrepareInput & {
    confirmImport: boolean;
    persistence?: ShopeeOperationalPersistence;
    bulkLinker?: typeof generateShopeeAffiliateLinksBulk;
    acquireDiscoveryLock?: AcquireDiscoveryLock;
  },
): Promise<ShopeeAutomatedDiscoveryResult> {
  const environment = input.environment ?? process.env;
  if (!input.confirmLiveCall) {
    const preview = emptyResult(performance.now());
    preview.errorCode = "SHOPEE_REMOTE_DISCOVERY_NOT_CONFIRMED";
    return {
      status: "FAILED",
      preview,
      importResult: null,
      externalRequests: 0,
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: false,
      errorCode: preview.errorCode,
    };
  }
  let lock: LockHandle | null = null;
  try {
    if (input.confirmImport) {
      const acquire = input.acquireDiscoveryLock ?? acquireLock;
      lock = await acquire("shopee:remote-discovery", 15 * 60_000, {
        env: environment,
        requireRedis: true,
      });
      if (!lock.acquired) {
        const errorCode =
          lock.failureReason === "LOCK_ALREADY_HELD"
            ? "SHOPEE_REMOTE_DISCOVERY_ALREADY_RUNNING"
            : "SHOPEE_REMOTE_DISCOVERY_REDIS_REQUIRED";
        const preview = emptyResult(performance.now());
        preview.errorCode = errorCode;
        return {
          status: "FAILED",
          preview,
          importResult: null,
          externalRequests: 0,
          writes: 0,
          publicationsCreated: 0,
          messagesSent: 0,
          stateModified: false,
          errorCode,
        };
      }
    }
    const prepared = await prepareShopeeRemoteDiscovery(input);
    if (!prepared.result.complete) {
      return {
        status: prepared.result.status === "PARTIAL" ? "PARTIAL" : "FAILED",
        preview: prepared.result,
        importResult: null,
        externalRequests: prepared.result.apiRequests,
        writes: 0,
        publicationsCreated: 0,
        messagesSent: 0,
        stateModified: false,
        errorCode: prepared.result.errorCode,
      };
    }
    if (!input.confirmImport) {
      return {
        status: "PREVIEW_COMPLETED",
        preview: prepared.result,
        importResult: null,
        externalRequests: prepared.result.apiRequests,
        writes: 0,
        publicationsCreated: 0,
        messagesSent: 0,
        stateModified: false,
        errorCode: null,
      };
    }
    const checksum = createHash("sha256")
      .update(
        JSON.stringify({
          source: "OPEN_API_FEED",
          feeds: prepared.result.feeds.map((feed) => feed.datafeedId).sort(),
          items: prepared.winners
            .map(({ candidate, product }) => ({
              itemId: product.itemId,
              title: product.title,
              salePrice: product.salePrice,
              originalPrice: product.originalPrice,
              discountPercentage: product.discountPercentage,
              itemRating: product.itemRating,
              category: candidate.category,
              sourceProductUrl: product.sourceProductUrl,
              imageUrl: product.imageUrl,
            }))
            .sort((left, right) => left.itemId.localeCompare(right.itemId)),
        }),
      )
      .digest("hex");
    const sourceIds = prepared.result.feeds
      .map((feed) => feed.referenceId)
      .sort();
    const importResult = await persistShopeeOperationalWinners({
      winners: prepared.winners,
      selected: prepared.result.selected,
      checksum,
      source: `OPEN_API_FEED:${sourceIds.join("+")}`,
      confirmImport: true,
      environment,
      subIds: ["sourceopenapi", "autolink"],
      ...(input.persistence ? { persistence: input.persistence } : {}),
      ...(input.bulkLinker ? { bulkLinker: input.bulkLinker } : {}),
    });
    return {
      status: importResult.status === "DUPLICATE" ? "DUPLICATE" : "IMPORTED",
      preview: prepared.result,
      importResult,
      externalRequests: prepared.result.apiRequests,
      writes: importResult.stateModified ? 1 : 0,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: importResult.stateModified,
      errorCode: null,
    };
  } finally {
    await lock?.release().catch(() => undefined);
  }
}
