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
import { ShopeeOpenApiError } from "./open-api";
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
import { validateShopeeProductOrigin, validateShopeeUrl } from "./validation";

export const SHOPEE_REMOTE_FEED_CONTRACT_STATUS =
  "WAITING_FOR_OFFICIAL_CONTRACT" as const;

export type ShopeeRemoteFeed = {
  feedId: string;
  name: string;
  updatedAt: string | null;
  status: string | null;
};

export type ShopeeRemoteFeedPage = {
  feedId: string;
  items: unknown[];
  nextCursor: string | null;
};

export interface ShopeeRemoteFeedClient {
  readonly contractAvailable: boolean;
  listFeeds(input: { signal?: AbortSignal }): Promise<unknown>;
  getFeedPage(input: {
    feedId: string;
    cursor: string | null;
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
  feed: ShopeeRemoteFeed | null;
  feedsProcessed: number;
  pagesFetched: number;
  itemsReceived: number;
  itemsNormalized: number;
  itemsRejected: number;
  duplicates: number;
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

export class UnavailableShopeeRemoteFeedClient implements ShopeeRemoteFeedClient {
  readonly contractAvailable = false;

  async listFeeds(): Promise<never> {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_FEED_CONTRACT_UNAVAILABLE");
  }

  async getFeedPage(): Promise<never> {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_FEED_CONTRACT_UNAVAILABLE");
  }
}

function safeCode(error: unknown) {
  if (error instanceof ShopeeOpenApiError) return error.code;
  const message = error instanceof Error ? error.message : "";
  return /^SHOPEE_[A-Z0-9_]+$/.test(message)
    ? message
    : "SHOPEE_REMOTE_DISCOVERY_FAILED";
}

function validateFeedId(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null;
}

function parseFeed(value: unknown): ShopeeRemoteFeed | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const feedId = validateFeedId(record.feedId);
  if (!feedId || typeof record.name !== "string" || !record.name.trim()) {
    return null;
  }
  if (
    record.updatedAt !== null &&
    record.updatedAt !== undefined &&
    typeof record.updatedAt !== "string"
  ) {
    return null;
  }
  if (
    record.status !== null &&
    record.status !== undefined &&
    typeof record.status !== "string"
  ) {
    return null;
  }
  return {
    feedId,
    name: record.name.trim().slice(0, 160),
    updatedAt:
      typeof record.updatedAt === "string"
        ? record.updatedAt.slice(0, 64)
        : null,
    status:
      typeof record.status === "string" ? record.status.slice(0, 64) : null,
  };
}

function parseFeedList(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  const feeds = (value as { feeds?: unknown }).feeds;
  if (!Array.isArray(feeds)) {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  const parsed = feeds.map(parseFeed);
  if (parsed.some((feed) => feed === null)) {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  return (parsed as ShopeeRemoteFeed[]).sort(
    (left, right) =>
      left.feedId.localeCompare(right.feedId) ||
      left.name.localeCompare(right.name),
  );
}

function parsePage(
  value: unknown,
  expectedFeedId: string,
): ShopeeRemoteFeedPage {
  if (!value || typeof value !== "object") {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  const record = value as Record<string, unknown>;
  if (record.feedId !== expectedFeedId || !Array.isArray(record.items)) {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  if (record.nextCursor !== null && typeof record.nextCursor !== "string") {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  return {
    feedId: expectedFeedId,
    items: record.items,
    nextCursor: record.nextCursor as string | null,
  };
}

function nullableString(value: unknown) {
  return value === null
    ? null
    : typeof value === "string"
      ? value.trim() || null
      : undefined;
}

function nullableNumber(value: unknown, minimum: number, maximum: number) {
  return value === null
    ? null
    : typeof value === "number" &&
        Number.isFinite(value) &&
        value >= minimum &&
        value <= maximum
      ? value
      : undefined;
}

function nullableStringList(value: unknown) {
  return value === null
    ? null
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value.map((item) => item.trim()).filter(Boolean)
      : undefined;
}

function parseNormalizedProduct(value: unknown): ShopeeDatafeedProduct {
  if (!value || typeof value !== "object") {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  const record = value as Partial<ShopeeDatafeedProduct>;
  if (
    typeof record.itemId !== "string" ||
    !/^\d+$/.test(record.itemId) ||
    typeof record.title !== "string" ||
    !record.title.trim() ||
    typeof record.salePrice !== "number" ||
    !Number.isFinite(record.salePrice) ||
    record.salePrice <= 0 ||
    typeof record.category1 !== "string" ||
    typeof record.imageUrl !== "string" ||
    typeof record.sourceProductUrl !== "string"
  ) {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  const description = nullableString(record.description);
  const originalPrice = nullableNumber(record.originalPrice, 0, 1_000_000_000);
  const discountPercentage = nullableNumber(record.discountPercentage, 0, 100);
  const itemRating = nullableNumber(record.itemRating, 0, 5);
  const shopRating = nullableNumber(record.shopRating, 0, 5);
  const likeCount = nullableNumber(
    record.likeCount,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const condition = nullableString(record.condition);
  const category1Id = nullableString(record.category1Id);
  const category2 = nullableString(record.category2);
  const category2Id = nullableString(record.category2Id);
  const category3 = nullableString(record.category3);
  const category3Id = nullableString(record.category3Id);
  const shopName = nullableString(record.shopName);
  const secondaryImageUrl = nullableString(record.secondaryImageUrl);
  const modelIds = nullableStringList(record.modelIds);
  const modelNames = nullableStringList(record.modelNames);
  if (
    [
      description,
      originalPrice,
      discountPercentage,
      itemRating,
      shopRating,
      likeCount,
      condition,
      category1Id,
      category2,
      category2Id,
      category3,
      category3Id,
      shopName,
      secondaryImageUrl,
      modelIds,
      modelNames,
    ].some((item) => item === undefined) ||
    (record.crossBorder !== null && typeof record.crossBorder !== "boolean") ||
    (secondaryImageUrl !== null &&
      !validateShopeeUrl(secondaryImageUrl as string, "IMAGE"))
  ) {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  const origin = validateShopeeProductOrigin(
    record.sourceProductUrl,
    record.itemId,
  );
  if (!origin.ok || !validateShopeeUrl(record.imageUrl, "IMAGE")) {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SCHEMA_MISMATCH");
  }
  const safeOriginalPrice = originalPrice as number | null;
  return {
    itemId: record.itemId,
    title: record.title.trim(),
    description: description as string | null,
    originalPrice:
      safeOriginalPrice !== null && safeOriginalPrice >= record.salePrice
        ? safeOriginalPrice
        : null,
    salePrice: record.salePrice,
    discountPercentage: discountPercentage as number | null,
    itemRating: itemRating as number | null,
    shopRating: shopRating as number | null,
    likeCount: likeCount as number | null,
    condition: condition as string | null,
    crossBorder: record.crossBorder,
    category1: record.category1,
    category1Id: category1Id as string | null,
    category2: category2 as string | null,
    category2Id: category2Id as string | null,
    category3: category3 as string | null,
    category3Id: category3Id as string | null,
    shopName: shopName as string | null,
    imageUrl: record.imageUrl,
    secondaryImageUrl: secondaryImageUrl as string | null,
    sourceProductUrl: origin.normalizedUrl,
    modelIds: modelIds as string[] | null,
    modelNames: modelNames as string[] | null,
    commissionAvailable: false,
    salesCountAvailable: false,
    source: "OPEN_API_FEED",
    sources: ["OPEN_API_FEED"],
    candidateAffiliateUrl: null,
    verifiedAffiliateUrl: null,
  };
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
  environment?: NodeJS.ProcessEnv;
  client?: ShopeeRemoteFeedClient;
  signal?: AbortSignal;
}): Promise<ShopeeRemoteFeedListResult> {
  let externalRequests = 0;
  try {
    if (!input.confirmLiveCall) {
      throw new ShopeeOpenApiError("SHOPEE_REMOTE_DISCOVERY_NOT_CONFIRMED");
    }
    preflight(input.environment ?? process.env);
    const client = input.client ?? new UnavailableShopeeRemoteFeedClient();
    if (!client.contractAvailable) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_FEED_CONTRACT_UNAVAILABLE");
    }
    externalRequests += 1;
    const feeds = parseFeedList(
      await client.listFeeds({
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
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
    feed: null,
    feedsProcessed: 0,
    pagesFetched: 0,
    itemsReceived: 0,
    itemsNormalized: 0,
    itemsRejected: 0,
    duplicates: 0,
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

export async function prepareShopeeRemoteDiscovery(input: {
  feedId: string;
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
}): Promise<PreparedShopeeRemoteDiscovery> {
  const startedAt = performance.now();
  const result = emptyResult(startedAt);
  const products = new Map<string, ShopeeDatafeedProduct>();
  const conflicts = new Map<string, number>();
  try {
    if (!input.confirmLiveCall) {
      throw new ShopeeOpenApiError("SHOPEE_REMOTE_DISCOVERY_NOT_CONFIRMED");
    }
    const configuration = preflight(input.environment ?? process.env);
    const feedId = validateFeedId(input.feedId);
    if (!feedId) throw new ShopeeOpenApiError("SHOPEE_REMOTE_FEED_ID_INVALID");
    if (
      configuration.remoteDiscoveryFeedIds.length > 0 &&
      !configuration.remoteDiscoveryFeedIds.includes(feedId)
    ) {
      throw new ShopeeOpenApiError("SHOPEE_REMOTE_FEED_NOT_ENABLED");
    }
    const client = input.client ?? new UnavailableShopeeRemoteFeedClient();
    if (!client.contractAvailable) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_FEED_CONTRACT_UNAVAILABLE");
    }
    let cursor: string | null = null;
    const cursors = new Set<string>();
    let reachedLimit = false;
    let paginationError: string | null = null;
    do {
      if (result.pagesFetched >= configuration.remoteDiscoveryMaxPages) {
        reachedLimit = true;
        break;
      }
      let rawPage: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        result.apiRequests += 1;
        try {
          rawPage = await client.getFeedPage({
            feedId,
            cursor,
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
          if (result.pagesFetched > 0) {
            paginationError = safeCode(error);
            break;
          }
          throw error;
        }
      }
      if (paginationError) break;
      const page = parsePage(rawPage, feedId);
      result.pagesFetched += 1;
      result.feedsProcessed = 1;
      result.itemsReceived += page.items.length;
      for (const raw of page.items) {
        if (products.size >= configuration.remoteDiscoveryMaxItems) {
          reachedLimit = true;
          break;
        }
        const product = parseNormalizedProduct(raw);
        result.itemsNormalized += 1;
        const previous = products.get(product.itemId);
        if (previous) {
          result.duplicates += 1;
          products.set(
            product.itemId,
            mergeShopeeDatafeedProducts(previous, product, conflicts),
          );
        } else {
          products.set(product.itemId, product);
        }
      }
      if (reachedLimit) break;
      cursor = page.nextCursor;
      if (cursor) {
        if (cursors.has(cursor)) {
          throw new ShopeeOpenApiError("SHOPEE_REMOTE_DISCOVERY_CURSOR_LOOP");
        }
        cursors.add(cursor);
      }
    } while (cursor);

    const categories = input.categories ?? [...SHOPEE_CATEGORY_CATALOG];
    const filters = { ...DEFAULT_SHOPEE_FILTERS, ...input.filters };
    const weights = { ...DEFAULT_SHOPEE_RANKING_WEIGHTS, ...input.weights };
    const recent = new Set(input.recentItemIds ?? []);
    const pools = new Map<ShopeeLogicalCategory, ShopeeRankedCandidate[]>(
      categories.filter((item) => item.enabled).map((item) => [item.id, []]),
    );
    const eligible = new Map<string, number>();
    for (const product of products.values()) {
      const category = matchShopeeCategory(product, categories);
      if (!category || recent.has(product.itemId)) {
        result.itemsRejected += 1;
        continue;
      }
      if (filterShopeeCandidate(product, filters)) {
        result.itemsRejected += 1;
        continue;
      }
      eligible.set(category.id, (eligible.get(category.id) ?? 0) + 1);
      const pool = pools.get(category.id) ?? [];
      pool.push(
        createShopeeRankedCandidate({
          product,
          category: category.id,
          weights,
        }),
      );
      pool.sort(compareShopeeRankedCandidates);
      pool.splice(Math.min(100, Math.max(category.maxPerCategory, 20)));
      pools.set(category.id, pool);
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
    result.feed = { feedId, name: feedId, updatedAt: null, status: null };
    result.eligibleByCategory = Object.fromEntries(
      [...eligible.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    result.selected = selection.selected;
    result.status =
      reachedLimit || paginationError ? "PARTIAL" : "PREVIEW_COMPLETED";
    result.errorCode =
      paginationError ??
      (reachedLimit ? "SHOPEE_REMOTE_DISCOVERY_LIMIT_REACHED" : null);
    result.durationMs = Math.round(performance.now() - startedAt);
    return {
      result,
      winners: selection.selected.flatMap((candidate) => {
        const product = products.get(candidate.itemId);
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

export async function previewShopeeRemoteDiscovery(
  input: Parameters<typeof prepareShopeeRemoteDiscovery>[0],
) {
  return (await prepareShopeeRemoteDiscovery(input)).result;
}

type AcquireDiscoveryLock = (
  key: string,
  ttlMs: number,
  options: { env: NodeJS.ProcessEnv; requireRedis: true },
) => Promise<LockHandle>;

export async function runShopeeAutomatedDiscovery(input: {
  feedId: string;
  confirmLiveCall: boolean;
  confirmImport: boolean;
  environment?: NodeJS.ProcessEnv;
  client?: ShopeeRemoteFeedClient;
  signal?: AbortSignal;
  categories?: ShopeeCategoryRule[];
  filters?: Partial<ShopeeDiscoveryFilters>;
  weights?: Partial<ShopeeRankingWeights>;
  recentItemIds?: readonly string[];
  persistence?: ShopeeOperationalPersistence;
  bulkLinker?: typeof generateShopeeAffiliateLinksBulk;
  acquireDiscoveryLock?: AcquireDiscoveryLock;
}): Promise<ShopeeAutomatedDiscoveryResult> {
  const environment = input.environment ?? process.env;
  if (!input.confirmLiveCall) {
    const preview = await previewShopeeRemoteDiscovery(input);
    return {
      status: "FAILED",
      preview,
      importResult: null,
      externalRequests: 0,
      writes: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      stateModified: false,
      errorCode: "SHOPEE_REMOTE_DISCOVERY_NOT_CONFIRMED",
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
    if (prepared.result.status !== "PREVIEW_COMPLETED") {
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
          feedId: input.feedId,
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
    const importResult = await persistShopeeOperationalWinners({
      winners: prepared.winners,
      selected: prepared.result.selected,
      checksum,
      source: `OPEN_API_FEED:${input.feedId}`,
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
