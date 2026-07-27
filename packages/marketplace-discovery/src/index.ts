import { prisma, type MarketplaceAccount } from "@affiliate/database";
import { ingestOffer, type IngestOfferResult } from "@affiliate/ingestion";
import {
  MercadoLivreApiError,
  MercadoLivreInvalidResponseError,
  createMercadoLivreConnector,
  type MarketplaceConnector,
  type MarketplaceOfferCandidate,
  type MercadoLivreHighlightCandidate,
  type MercadoLivreHighlightResolutionResult,
  type MercadoLivreHighlightSkipReason,
  type MercadoLivreProduct,
  type MercadoLivreProductResolutionDiagnostics,
  type MercadoLivreResolutionStrategy,
  type MercadoLivreResolvedHighlightCandidate,
  type MercadoLivreUserProduct,
} from "@affiliate/marketplace-connectors";
import { acquireLock } from "@affiliate/redis";

export type { MercadoLivreProductResolutionDiagnostics } from "@affiliate/marketplace-connectors";

const DISCOVERY_LOCK_TTL_MS = 10 * 60 * 1000;

export type MercadoLivreCategorySkipReason =
  | "NO_HIGHLIGHTS_FOR_CATEGORY"
  | "CATEGORY_NOT_LEAF"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_API_ERROR";

export type MercadoLivreDiscoveryMetrics = {
  categoriesProcessed: number;
  categoriesWithHighlights: number;
  categoriesSkipped: number;
  categorySkipReasons: Record<string, number>;
  candidatesFound: number;
  highlightItemCount: number;
  highlightProductCount: number;
  highlightUserProductCount: number;
  highlightUnknownTypeCount: number;
  productDirectWinnerCount: number;
  productParentCount: number;
  productLeafCount: number;
  productResolvedDirectly: number;
  productResolvedViaChild: number;
  productLeafWithoutWinner: number;
  productParentWithoutResolvableChild: number;
  resolvedItemCandidates: number;
  unresolvedCandidates: number;
  uniqueCandidates: number;
  itemsFetched: number;
  priceApiFetched: number;
  priceFallbackUsed: number;
  priceUnavailable: number;
  newProducts: number;
  newOfferVersions: number;
  existingOffers: number;
  readyForAffiliateLink: number;
  rejected: number;
  errors: number;
  candidateResolutionSkipReasons: Record<string, number>;
};

export type MercadoLivreDiscoveryResult = {
  ok: boolean;
  runId?: string;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED" | "SKIPPED";
  metrics: MercadoLivreDiscoveryMetrics;
  errorCode?: string;
  errorMessage?: string;
};

export type MercadoLivreDiscoveryOptions = {
  force?: boolean;
};

type DiscoveryDependencies = {
  database: typeof prisma;
  createConnector: () => Promise<MarketplaceConnector>;
  ingest: typeof ingestOffer;
  lock: typeof acquireLock;
};

export function createMercadoLivreDiscoveryMetrics(): MercadoLivreDiscoveryMetrics {
  return {
    categoriesProcessed: 0,
    categoriesWithHighlights: 0,
    categoriesSkipped: 0,
    categorySkipReasons: {},
    candidatesFound: 0,
    highlightItemCount: 0,
    highlightProductCount: 0,
    highlightUserProductCount: 0,
    highlightUnknownTypeCount: 0,
    productDirectWinnerCount: 0,
    productParentCount: 0,
    productLeafCount: 0,
    productResolvedDirectly: 0,
    productResolvedViaChild: 0,
    productLeafWithoutWinner: 0,
    productParentWithoutResolvableChild: 0,
    resolvedItemCandidates: 0,
    unresolvedCandidates: 0,
    uniqueCandidates: 0,
    itemsFetched: 0,
    priceApiFetched: 0,
    priceFallbackUsed: 0,
    priceUnavailable: 0,
    newProducts: 0,
    newOfferVersions: 0,
    existingOffers: 0,
    readyForAffiliateLink: 0,
    rejected: 0,
    errors: 0,
    candidateResolutionSkipReasons: {},
  };
}

function jsonStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function candidateInput(candidate: MarketplaceOfferCandidate) {
  return {
    marketplace: candidate.marketplace,
    externalProductId: candidate.externalProductId,
    title: candidate.title,
    description: candidate.description ?? undefined,
    category: candidate.category ?? undefined,
    imageUrl: candidate.imageUrl ?? undefined,
    productUrl: candidate.productUrl,
    affiliateUrl: candidate.affiliateUrl ?? undefined,
    affiliateLabel: candidate.affiliateLabel ?? undefined,
    affiliateEligibility: candidate.affiliateEligibility ?? "UNKNOWN",
    sellerId: candidate.sellerId ?? undefined,
    officialStoreId: candidate.officialStoreId ?? undefined,
    trackingStrategy: candidate.trackingStrategy ?? "DIRECT_AFFILIATE_LINK",
    originalPrice: candidate.originalPrice ?? undefined,
    currentPrice: candidate.currentPrice,
    couponCode: candidate.couponCode ?? undefined,
    couponExpiration: candidate.couponExpiration ?? undefined,
    commissionPercentage: candidate.commissionPercentage ?? undefined,
    rating: candidate.rating ?? undefined,
    salesCount: candidate.salesCount ?? undefined,
    shippingStatus: candidate.shippingStatus ?? "UNKNOWN",
    stockStatus: candidate.stockStatus ?? "UNKNOWN",
  };
}

export function calculateCandidateDiscount(
  originalPrice: number | null | undefined,
  currentPrice: number,
) {
  if (
    originalPrice === null ||
    originalPrice === undefined ||
    originalPrice <= 0
  ) {
    return null;
  }

  if (currentPrice <= 0 || currentPrice > originalPrice) {
    return null;
  }

  return ((originalPrice - currentPrice) / originalPrice) * 100;
}

export function passesMinimumDiscount(
  minimumDiscountValue:
    number | string | { toString(): string } | null | undefined,
  discountPercentage: number | null,
) {
  const minimumDiscount = Number(minimumDiscountValue ?? 0);

  if (!Number.isFinite(minimumDiscount) || minimumDiscount <= 0) {
    return true;
  }

  return discountPercentage !== null && discountPercentage >= minimumDiscount;
}

function recordCategorySkip(
  metrics: MercadoLivreDiscoveryMetrics,
  reason: MercadoLivreCategorySkipReason,
) {
  metrics.categoriesSkipped += 1;
  metrics.categorySkipReasons[reason] =
    (metrics.categorySkipReasons[reason] ?? 0) + 1;
}

function recordCandidateSkip(
  metrics: MercadoLivreDiscoveryMetrics,
  reason: MercadoLivreHighlightSkipReason,
) {
  metrics.unresolvedCandidates += 1;
  metrics.candidateResolutionSkipReasons[reason] =
    (metrics.candidateResolutionSkipReasons[reason] ?? 0) + 1;
}

function countHighlight(
  metrics: MercadoLivreDiscoveryMetrics,
  candidate: MercadoLivreHighlightCandidate,
) {
  if (candidate.type === "ITEM") {
    metrics.highlightItemCount += 1;
  } else if (candidate.type === "PRODUCT") {
    metrics.highlightProductCount += 1;
  } else if (candidate.type === "USER_PRODUCT") {
    metrics.highlightUserProductCount += 1;
  } else {
    metrics.highlightUnknownTypeCount += 1;
  }
}

function recordProductDiagnostics(
  metrics: MercadoLivreDiscoveryMetrics,
  diagnostics?: MercadoLivreProductResolutionDiagnostics,
) {
  if (!diagnostics) {
    return;
  }

  metrics.productDirectWinnerCount += diagnostics.productDirectWinnerCount;
  metrics.productParentCount += diagnostics.productParentCount;
  metrics.productLeafCount += diagnostics.productLeafCount;
  metrics.productResolvedDirectly += diagnostics.productResolvedDirectly;
  metrics.productResolvedViaChild += diagnostics.productResolvedViaChild;
  metrics.productLeafWithoutWinner += diagnostics.productLeafWithoutWinner;
  metrics.productParentWithoutResolvableChild +=
    diagnostics.productParentWithoutResolvableChild;
}

function isNotFound(error: unknown) {
  return error instanceof MercadoLivreApiError && error.status === 404;
}

function marketplaceChannels(candidate: MarketplaceOfferCandidate) {
  return (candidate.channels ?? []).map((channel) => channel.toLowerCase());
}

function emptyProductDiagnostics(): MercadoLivreProductResolutionDiagnostics {
  return {
    productDirectWinnerCount: 0,
    productParentCount: 0,
    productLeafCount: 0,
    productResolvedDirectly: 0,
    productResolvedViaChild: 0,
    productLeafWithoutWinner: 0,
    productParentWithoutResolvableChild: 0,
  };
}

function countProductShape(
  product: MercadoLivreProduct,
  diagnostics: MercadoLivreProductResolutionDiagnostics,
) {
  if (product.childrenIds.length > 0) {
    diagnostics.productParentCount += 1;
  } else {
    diagnostics.productLeafCount += 1;
  }

  if (product.buyBoxWinnerItemId) {
    diagnostics.productDirectWinnerCount += 1;
  }
}

function resolvedHighlight(
  candidate: MercadoLivreHighlightCandidate,
  resolvedItemId: string,
  strategy: MercadoLivreResolutionStrategy,
  metadata: { resolvedProductId?: string } = {},
  diagnostics?: MercadoLivreProductResolutionDiagnostics,
): MercadoLivreHighlightResolutionResult {
  return {
    ok: true,
    candidate: {
      sourceHighlightId: candidate.id,
      sourceHighlightType: candidate.type,
      ...(metadata.resolvedProductId
        ? { resolvedProductId: metadata.resolvedProductId }
        : {}),
      resolvedItemId,
      resolutionStrategy: strategy,
      position: candidate.position,
      categoryId: candidate.categoryId,
    },
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function skippedHighlight(
  candidate: MercadoLivreHighlightCandidate,
  reason: MercadoLivreHighlightSkipReason,
  diagnostics?: MercadoLivreProductResolutionDiagnostics,
): MercadoLivreHighlightResolutionResult {
  return {
    ok: false,
    candidate,
    reason,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function compareNullableNumberDesc(left: number | null, right: number | null) {
  if (left !== null && right !== null && left !== right) {
    return right - left;
  }

  if (left !== null && right === null) return -1;
  if (left === null && right !== null) return 1;
  return 0;
}

function compareNullablePriceAsc(left: number | null, right: number | null) {
  if (left !== null && right !== null && left !== right) {
    return left - right;
  }

  if (left !== null && right === null) return -1;
  if (left === null && right !== null) return 1;
  return 0;
}

type ProductChildCandidate = {
  product: MercadoLivreProduct;
  terminal: boolean;
};

type ProductChildResolution =
  | { ok: true; product: MercadoLivreProduct }
  | { ok: false; reason: MercadoLivreHighlightSkipReason };

export class MercadoLivreHighlightResolver {
  constructor(
    private readonly connector: MarketplaceConnector,
    private readonly options: {
      maxProductDepth?: number;
      maxProductsInspected?: number;
    } = {},
  ) {}

  async resolveCandidate(
    candidate: MercadoLivreHighlightCandidate,
  ): Promise<MercadoLivreHighlightResolutionResult> {
    try {
      if (candidate.type === "UNKNOWN") {
        return skippedHighlight(candidate, "UNSUPPORTED_HIGHLIGHT_TYPE");
      }

      if (candidate.type === "ITEM") {
        return resolvedHighlight(candidate, candidate.id, "ITEM_DIRECT");
      }

      if (candidate.type === "PRODUCT") {
        return this.resolveProductCandidate(candidate);
      }

      let userProduct: MercadoLivreUserProduct | null;

      try {
        userProduct = await this.connector.getUserProduct(candidate.id);
      } catch (error) {
        if (isNotFound(error)) {
          return skippedHighlight(candidate, "USER_PRODUCT_NOT_FOUND");
        }

        throw error;
      }

      if (!userProduct) {
        return skippedHighlight(candidate, "USER_PRODUCT_NOT_FOUND");
      }

      if (!userProduct.userId) {
        return skippedHighlight(candidate, "USER_PRODUCT_NO_USER");
      }

      const itemIds = await this.connector.getItemsByUserProduct(
        userProduct.userId,
        userProduct.id,
      );

      if (itemIds.length === 0) {
        return skippedHighlight(candidate, "USER_PRODUCT_NO_ACTIVE_ITEM");
      }

      const candidates = await this.connector.getItems(itemIds);
      const order = new Map(itemIds.map((itemId, index) => [itemId, index]));
      const [chosen] = candidates
        .filter((item) => item.currentPrice > 0)
        .filter((item) => !item.itemStatus || item.itemStatus === "active")
        .filter((item) => {
          const channels = marketplaceChannels(item);
          return channels.length === 0 || channels.includes("marketplace");
        })
        .sort((left, right) => {
          const leftOrder =
            order.get(left.externalProductId) ?? Number.MAX_SAFE_INTEGER;
          const rightOrder =
            order.get(right.externalProductId) ?? Number.MAX_SAFE_INTEGER;

          if (leftOrder !== rightOrder) return leftOrder - rightOrder;
          return left.externalProductId.localeCompare(right.externalProductId);
        });

      if (!chosen) {
        return skippedHighlight(candidate, "USER_PRODUCT_NO_ACTIVE_ITEM");
      }

      return resolvedHighlight(
        candidate,
        chosen.externalProductId,
        "USER_PRODUCT_ACTIVE_ITEM",
      );
    } catch {
      return skippedHighlight(candidate, "CANDIDATE_RESOLUTION_ERROR");
    }
  }

  private async resolveProductCandidate(
    candidate: MercadoLivreHighlightCandidate,
  ): Promise<MercadoLivreHighlightResolutionResult> {
    const diagnostics = emptyProductDiagnostics();
    let product: MercadoLivreProduct | null;

    try {
      product = await this.connector.getProduct(candidate.id);
    } catch (error) {
      if (isNotFound(error)) {
        return skippedHighlight(candidate, "PRODUCT_NOT_FOUND", diagnostics);
      }

      throw error;
    }

    if (!product) {
      return skippedHighlight(candidate, "PRODUCT_NOT_FOUND", diagnostics);
    }

    countProductShape(product, diagnostics);

    if (product.buyBoxWinnerItemId) {
      diagnostics.productResolvedDirectly += 1;
      return resolvedHighlight(
        candidate,
        product.buyBoxWinnerItemId,
        "PRODUCT_DIRECT_BUY_BOX",
        { resolvedProductId: product.id },
        diagnostics,
      );
    }

    if (product.childrenIds.length === 0) {
      diagnostics.productLeafWithoutWinner += 1;
      return skippedHighlight(
        candidate,
        "PRODUCT_LEAF_NO_BUY_BOX_WINNER",
        diagnostics,
      );
    }

    const childResolution = await this.resolveProductChildren(
      product,
      diagnostics,
    );

    if (!childResolution.ok) {
      if (childResolution.reason === "PRODUCT_PARENT_NO_RESOLVABLE_CHILD") {
        diagnostics.productParentWithoutResolvableChild += 1;
      }

      return skippedHighlight(candidate, childResolution.reason, diagnostics);
    }

    diagnostics.productResolvedViaChild += 1;
    return resolvedHighlight(
      candidate,
      childResolution.product.buyBoxWinnerItemId as string,
      "PRODUCT_CHILD_BUY_BOX",
      { resolvedProductId: childResolution.product.id },
      diagnostics,
    );
  }

  private async resolveProductChildren(
    parent: MercadoLivreProduct,
    diagnostics: MercadoLivreProductResolutionDiagnostics,
  ): Promise<ProductChildResolution> {
    const maxDepth = this.options.maxProductDepth ?? 4;
    const maxProductsInspected = this.options.maxProductsInspected ?? 50;
    const visited = new Set([parent.id]);
    const queue = parent.childrenIds.map((id) => ({ id, depth: 1 }));
    const candidates: ProductChildCandidate[] = [];
    let inspected = 1;
    let loadedChildren = 0;
    let childNotFound = false;
    let childError = false;
    let depthLimited = false;

    while (queue.length > 0) {
      const current = queue.shift();

      if (!current || visited.has(current.id)) continue;

      if (inspected >= maxProductsInspected) {
        return { ok: false, reason: "PRODUCT_TREE_SIZE_LIMIT" };
      }

      visited.add(current.id);
      inspected += 1;

      let product: MercadoLivreProduct | null;

      try {
        product = await this.connector.getProduct(current.id);
      } catch (error) {
        if (isNotFound(error)) {
          childNotFound = true;
        } else {
          childError = true;
        }
        continue;
      }

      if (!product) {
        childNotFound = true;
        continue;
      }

      loadedChildren += 1;
      countProductShape(product, diagnostics);
      const terminal = product.childrenIds.length === 0;

      if (product.buyBoxWinnerItemId) {
        candidates.push({ product, terminal });
      }

      if (product.childrenIds.length > 0) {
        if (current.depth >= maxDepth) {
          depthLimited = true;
          continue;
        }

        for (const childId of product.childrenIds) {
          if (!visited.has(childId)) {
            queue.push({ id: childId, depth: current.depth + 1 });
          }
        }
      } else if (!product.buyBoxWinnerItemId) {
        diagnostics.productLeafWithoutWinner += 1;
      }
    }

    const chosen = this.chooseProductChild(candidates);

    if (chosen) return { ok: true, product: chosen };
    if (depthLimited) return { ok: false, reason: "PRODUCT_TREE_DEPTH_LIMIT" };
    if (childError)
      return { ok: false, reason: "PRODUCT_CHILD_RESOLUTION_ERROR" };
    if (childNotFound && loadedChildren === 0) {
      return { ok: false, reason: "PRODUCT_CHILD_NOT_FOUND" };
    }
    return { ok: false, reason: "PRODUCT_PARENT_NO_RESOLVABLE_CHILD" };
  }

  private chooseProductChild(candidates: ProductChildCandidate[]) {
    const [chosen] = [...candidates].sort((left, right) => {
      const leftActive = left.product.status === "active";
      const rightActive = right.product.status === "active";

      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      if (left.terminal !== right.terminal) return left.terminal ? -1 : 1;

      const soldQuantity = compareNullableNumberDesc(
        left.product.soldQuantity,
        right.product.soldQuantity,
      );
      if (soldQuantity !== 0) return soldQuantity;

      const price = compareNullablePriceAsc(
        left.product.buyBoxWinnerPrice,
        right.product.buyBoxWinnerPrice,
      );
      if (price !== 0) return price;
      return left.product.id.localeCompare(right.product.id);
    });

    return chosen?.product ?? null;
  }
}

export async function discoverCandidatesFromLeafCategories(
  connector: MarketplaceConnector,
  categoryIds: string[],
  maxCandidatesPerCategory: number,
  metrics: MercadoLivreDiscoveryMetrics,
) {
  const resolvedCandidates = new Map<
    string,
    MercadoLivreResolvedHighlightCandidate
  >();
  const resolver = new MercadoLivreHighlightResolver(connector);

  for (const categoryId of categoryIds) {
    metrics.categoriesProcessed += 1;
    let category;

    try {
      category = await connector.getCategory(categoryId);
    } catch (error) {
      const reason = isNotFound(error)
        ? "CATEGORY_NOT_FOUND"
        : "CATEGORY_API_ERROR";
      recordCategorySkip(metrics, reason);
      if (reason === "CATEGORY_API_ERROR") metrics.errors += 1;
      continue;
    }

    if (!category) {
      recordCategorySkip(metrics, "CATEGORY_NOT_FOUND");
      continue;
    }

    if (category.children.length > 0) {
      recordCategorySkip(metrics, "CATEGORY_NOT_LEAF");
      continue;
    }

    let highlights;

    try {
      highlights = await connector.getBestSellers(category.id);
    } catch (error) {
      const reason = isNotFound(error)
        ? "NO_HIGHLIGHTS_FOR_CATEGORY"
        : "CATEGORY_API_ERROR";
      recordCategorySkip(metrics, reason);
      if (reason === "CATEGORY_API_ERROR") metrics.errors += 1;
      continue;
    }

    if (highlights.length === 0) {
      recordCategorySkip(metrics, "NO_HIGHLIGHTS_FOR_CATEGORY");
      continue;
    }

    metrics.categoriesWithHighlights += 1;

    for (const item of highlights.slice(0, maxCandidatesPerCategory)) {
      metrics.candidatesFound += 1;
      countHighlight(metrics, item);
      const result = await resolver.resolveCandidate(item);
      recordProductDiagnostics(metrics, result.diagnostics);

      if (!result.ok) {
        recordCandidateSkip(metrics, result.reason);
        continue;
      }

      metrics.resolvedItemCandidates += 1;
      const existing = resolvedCandidates.get(result.candidate.resolvedItemId);

      if (!existing || result.candidate.position < existing.position) {
        resolvedCandidates.set(
          result.candidate.resolvedItemId,
          result.candidate,
        );
      }
    }
  }

  metrics.uniqueCandidates = resolvedCandidates.size;
  const itemResult = await connector.getItemsWithDiagnostics([
    ...resolvedCandidates.keys(),
  ]);
  metrics.itemsFetched += itemResult.diagnostics.itemsFetched;
  metrics.priceApiFetched += itemResult.diagnostics.priceApiFetched;
  metrics.priceFallbackUsed += itemResult.diagnostics.priceFallbackUsed;
  metrics.priceUnavailable += itemResult.diagnostics.priceUnavailable;

  return itemResult.candidates.map((item) => {
    const source = resolvedCandidates.get(item.externalProductId);

    if (!source) return item;

    return {
      ...item,
      sourceHighlightId: source.sourceHighlightId,
      sourceHighlightType: source.sourceHighlightType,
      ...(source.resolvedProductId
        ? { resolvedProductId: source.resolvedProductId }
        : {}),
      resolvedItemId: source.resolvedItemId,
      resolutionStrategy: source.resolutionStrategy,
    };
  });
}

function alertCodeForMercadoLivreError(error: unknown) {
  if (error instanceof MercadoLivreApiError && error.status === 429)
    return "MELI_RATE_LIMIT";
  if (error instanceof MercadoLivreInvalidResponseError)
    return "MELI_INVALID_RESPONSE";
  return "MELI_API_UNAVAILABLE";
}

function sanitizedError(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Mercado Livre discovery failed.";
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500);
}

function skippedResult(
  metrics: MercadoLivreDiscoveryMetrics,
  errorCode: string,
  errorMessage?: string,
): MercadoLivreDiscoveryResult {
  return {
    ok: false,
    status: "SKIPPED",
    metrics,
    errorCode,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function recordIngestMetrics(
  metrics: MercadoLivreDiscoveryMetrics,
  result: IngestOfferResult,
) {
  if (result.productCreated) metrics.newProducts += 1;
  if (result.offerCreated) metrics.newOfferVersions += 1;
  if (result.offerReused) metrics.existingOffers += 1;

  if (result.status === "READY_FOR_AFFILIATE_LINK") {
    metrics.readyForAffiliateLink += 1;
  } else if (result.status.startsWith("REJECTED")) {
    metrics.rejected += 1;
  }
}

export class MercadoLivreDiscoveryService {
  private readonly dependencies: DiscoveryDependencies;

  constructor(dependencies: Partial<DiscoveryDependencies> = {}) {
    this.dependencies = {
      database: dependencies.database ?? prisma,
      createConnector:
        dependencies.createConnector ?? createMercadoLivreConnector,
      ingest: dependencies.ingest ?? ingestOffer,
      lock: dependencies.lock ?? acquireLock,
    };
  }

  async run(
    now = new Date(),
    options: MercadoLivreDiscoveryOptions = {},
  ): Promise<MercadoLivreDiscoveryResult> {
    const metrics = createMercadoLivreDiscoveryMetrics();
    const config =
      await this.dependencies.database.mercadoLivreDiscoveryConfig.findFirst({
        orderBy: { updatedAt: "desc" },
      });

    if (!config?.enabled) {
      return skippedResult(metrics, "DISCOVERY_DISABLED");
    }

    if (!config.bestSellersEnabled) {
      return skippedResult(
        metrics,
        "DISCOVERY_SOURCE_DISABLED",
        "Discovery por highlights esta desabilitado e o category search ainda e somente um probe.",
      );
    }

    const account =
      await this.dependencies.database.marketplaceAccount.findFirst({
        where: {
          marketplace: "MERCADO_LIVRE",
          enabled: true,
          status: "CONNECTED",
        },
        orderBy: { updatedAt: "desc" },
      });

    if (!account) {
      return {
        ok: false,
        status: "FAILED",
        metrics,
        errorCode: "MELI_NOT_CONNECTED",
        errorMessage: "Mercado Livre account is not connected.",
      };
    }

    if (!options.force && config.lastRunAt) {
      const nextRunAt = new Date(
        config.lastRunAt.getTime() + config.refreshIntervalMinutes * 60_000,
      );

      if (nextRunAt > now) {
        return skippedResult(metrics, "DISCOVERY_NOT_DUE");
      }
    }

    const lock = await this.dependencies.lock(
      `mercado-livre:discovery:${account.id}`,
      DISCOVERY_LOCK_TTL_MS,
    );

    if (!lock.acquired) {
      return skippedResult(metrics, "DISCOVERY_ALREADY_RUNNING");
    }

    let runId: string | undefined;

    try {
      const run = await this.dependencies.database.automationRun.create({
        data: {
          marketplaceAccountId: account.id,
          name: "mercado-livre-discovery",
          status: "RUNNING",
          idempotencyKey: `mercado-livre-discovery:${now.toISOString()}`,
          startedAt: now,
          metrics,
        },
      });
      runId = run.id;
      const connector = await this.dependencies.createConnector();
      const candidates = await discoverCandidatesFromLeafCategories(
        connector,
        jsonStringArray(config.categoryIds),
        Math.min(config.maxCandidatesPerCategory, 20),
        metrics,
      );
      const uniqueCandidates = new Map(
        candidates.map((candidate) => [candidate.externalProductId, candidate]),
      );

      for (const candidate of uniqueCandidates.values()) {
        const minimumPrice = Number(config.minimumPrice ?? 0);
        const maximumPrice = Number(config.maximumPrice ?? 0);

        if (minimumPrice > 0 && candidate.currentPrice < minimumPrice) continue;
        if (maximumPrice > 0 && candidate.currentPrice > maximumPrice) continue;

        const discount = calculateCandidateDiscount(
          candidate.originalPrice,
          candidate.currentPrice,
        );

        if (!passesMinimumDiscount(config.minimumDiscountPercentage, discount))
          continue;

        try {
          const result = await this.dependencies.ingest(
            candidateInput(candidate),
            {
              now,
              minScore: config.minimumScore,
            },
          );
          recordIngestMetrics(metrics, result);
        } catch {
          metrics.errors += 1;
        }
      }

      const status = metrics.errors > 0 ? "PARTIAL" : "SUCCEEDED";
      const lastError =
        status === "PARTIAL"
          ? `Discovery completed with ${metrics.errors} operational error(s).`
          : null;

      await this.dependencies.database.$transaction([
        this.dependencies.database.mercadoLivreDiscoveryConfig.update({
          where: { id: config.id },
          data: { lastRunAt: now, lastRunSummary: metrics },
        }),
        this.dependencies.database.marketplaceAccount.update({
          where: { id: account.id },
          data: {
            lastSyncAt: now,
            lastErrorAt: lastError ? new Date() : null,
            lastError,
          },
        }),
        this.dependencies.database.automationRun.update({
          where: { id: run.id },
          data: { status: "SUCCEEDED", finishedAt: new Date(), metrics },
        }),
      ]);

      return { ok: true, runId: run.id, status, metrics };
    } catch (error) {
      metrics.errors += 1;
      const errorMessage = sanitizedError(error);
      const errorCode = alertCodeForMercadoLivreError(error);

      await this.dependencies.database.$transaction([
        this.dependencies.database.marketplaceAccount.update({
          where: { id: account.id },
          data: { lastErrorAt: new Date(), lastError: errorMessage },
        }),
        this.dependencies.database.systemAlert.create({
          data: {
            severity: "ERROR",
            source: "mercado-livre.discovery",
            message: errorCode,
            metadata: { error: errorMessage },
          },
        }),
        ...(runId
          ? [
              this.dependencies.database.automationRun.update({
                where: { id: runId },
                data: {
                  status: "FAILED",
                  finishedAt: new Date(),
                  metrics,
                  errorMessage,
                },
              }),
            ]
          : []),
      ]);

      return {
        ok: false,
        ...(runId ? { runId } : {}),
        status: "FAILED",
        metrics,
        errorCode,
        errorMessage,
      };
    } finally {
      await lock.release();
    }
  }
}

export async function collectMercadoLivreCandidates(
  now = new Date(),
  options: MercadoLivreDiscoveryOptions = {},
) {
  return new MercadoLivreDiscoveryService().run(now, options);
}

export type MercadoLivreJobMetrics = {
  readyOffersFound: number;
  scheduled: number;
  published: number;
  exported: number;
  failed: number;
  retried: number;
  expired: number;
  skipped: number;
  skipReasons: Record<string, number>;
};

function emptyJobMetrics(): MercadoLivreJobMetrics {
  return {
    readyOffersFound: 0,
    scheduled: 0,
    published: 0,
    exported: 0,
    failed: 0,
    retried: 0,
    expired: 0,
    skipped: 0,
    skipReasons: {},
  };
}

export async function refreshMercadoLivreOffers(now = new Date()) {
  const metrics = emptyJobMetrics();
  const account = await prisma.marketplaceAccount.findFirst({
    where: { marketplace: "MERCADO_LIVRE", enabled: true, status: "CONNECTED" },
    orderBy: { updatedAt: "desc" },
  });

  if (!account) return metrics;

  const offers = await prisma.offer.findMany({
    where: { marketplace: "MERCADO_LIVRE", status: { notIn: ["PUBLISHED"] } },
    distinct: ["externalProductId"],
    orderBy: { collectedAt: "desc" },
    take: 50,
  });

  if (offers.length === 0) return metrics;

  const runMetrics = createMercadoLivreDiscoveryMetrics();
  const run = await prisma.automationRun.create({
    data: {
      marketplaceAccountId: account.id,
      name: "mercado-livre-refresh",
      status: "RUNNING",
      idempotencyKey: `mercado-livre-refresh:${now.toISOString()}`,
      startedAt: now,
      metrics: runMetrics,
    },
  });

  try {
    const connector = await createMercadoLivreConnector();
    const itemResult = await connector.getItemsWithDiagnostics(
      offers.map((offer) => offer.externalProductId),
    );
    runMetrics.itemsFetched = itemResult.diagnostics.itemsFetched;
    runMetrics.priceApiFetched = itemResult.diagnostics.priceApiFetched;
    runMetrics.priceFallbackUsed = itemResult.diagnostics.priceFallbackUsed;
    runMetrics.priceUnavailable = itemResult.diagnostics.priceUnavailable;
    const offerByExternalId = new Map(
      offers.map((offer) => [offer.externalProductId, offer]),
    );

    for (const candidate of itemResult.candidates) {
      const currentOffer = offerByExternalId.get(candidate.externalProductId);
      if (!currentOffer) continue;

      const enrichedCandidate: MarketplaceOfferCandidate = {
        ...candidate,
        affiliateUrl: currentOffer.affiliateUrl,
        affiliateLabel: currentOffer.affiliateLabel,
        affiliateEligibility: currentOffer.affiliateEligibility,
      };
      const result = await ingestOffer(candidateInput(enrichedCandidate), {
        now,
        minScore: currentOffer.minimumScoreApplied,
      });
      recordIngestMetrics(runMetrics, result);
    }

    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        metrics: runMetrics,
      },
    });
  } catch (error) {
    runMetrics.errors += 1;
    const errorMessage = sanitizedError(error);
    await prisma.$transaction([
      prisma.marketplaceAccount.update({
        where: { id: account.id },
        data: { lastErrorAt: new Date(), lastError: errorMessage },
      }),
      prisma.systemAlert.create({
        data: {
          severity: "ERROR",
          source: "mercado-livre.refresh",
          message: alertCodeForMercadoLivreError(error),
          metadata: { error: errorMessage },
        },
      }),
      prisma.automationRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          metrics: runMetrics,
          errorMessage,
        },
      }),
    ]);
  }

  return metrics;
}

export function discoveryLockKey(account: Pick<MarketplaceAccount, "id">) {
  return `mercado-livre:discovery:${account.id}`;
}
