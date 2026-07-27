import {
  MercadoLivreApiError,
  MercadoLivreHighlightResolver,
  MercadoLivreInvalidResponseError,
  createMercadoLivreConnector,
  type MarketplaceConnector,
  type MarketplaceOfferCandidate,
  type MercadoLivreHighlightCandidate,
  type MercadoLivreHighlightSkipReason,
  type MercadoLivreProductResolutionDiagnostics,
  type MercadoLivreResolvedHighlightCandidate,
} from "@affiliate/marketplace-connectors";
import { prisma } from "@affiliate/database";
import { ingestOffer } from "@affiliate/ingestion";

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

type MercadoLivreJobOptions = {
  force?: boolean;
};

function emptyMetrics(): MercadoLivreJobMetrics {
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

function jsonStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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

function baseRunMetrics() {
  return {
    categoriesProcessed: 0,
    categoriesWithHighlights: 0,
    categoriesSkipped: 0,
    categorySkipReasons: {} as Record<string, number>,
    candidatesFound: 0,
    uniqueCandidates: 0,
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
    candidateResolutionSkipReasons: {} as Record<string, number>,
    itemsFetched: 0,
    pricesFetched: 0,
    newProducts: 0,
    newOfferVersions: 0,
    existingOffers: 0,
    readyForAffiliateLink: 0,
    rejected: 0,
    errors: 0,
  };
}

type CategorySkipReason =
  | "NO_HIGHLIGHTS_FOR_CATEGORY"
  | "CATEGORY_NOT_LEAF"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_API_ERROR";

function recordCategorySkip(metrics: ReturnType<typeof baseRunMetrics>, reason: CategorySkipReason) {
  metrics.categoriesSkipped += 1;
  metrics.categorySkipReasons[reason] = (metrics.categorySkipReasons[reason] ?? 0) + 1;
}

function recordCandidateSkip(metrics: ReturnType<typeof baseRunMetrics>, reason: MercadoLivreHighlightSkipReason) {
  metrics.unresolvedCandidates += 1;
  metrics.candidateResolutionSkipReasons[reason] = (metrics.candidateResolutionSkipReasons[reason] ?? 0) + 1;
}

function countHighlight(metrics: ReturnType<typeof baseRunMetrics>, candidate: MercadoLivreHighlightCandidate) {
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
  metrics: ReturnType<typeof baseRunMetrics>,
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
  metrics.productParentWithoutResolvableChild += diagnostics.productParentWithoutResolvableChild;
}

function discountPercentage(originalPrice: number | null | undefined, currentPrice: number) {
  if (!originalPrice || originalPrice <= 0 || currentPrice <= 0 || currentPrice > originalPrice) {
    return null;
  }

  return ((originalPrice - currentPrice) / originalPrice) * 100;
}

async function connectedAccount() {
  return prisma.marketplaceAccount.findFirst({
    where: { marketplace: "MERCADO_LIVRE", enabled: true, status: "CONNECTED" },
    orderBy: { updatedAt: "desc" },
  });
}

function alertCodeForMercadoLivreError(error: unknown) {
  if (error instanceof MercadoLivreApiError && error.status === 429) {
    return "MELI_RATE_LIMIT";
  }

  if (error instanceof MercadoLivreInvalidResponseError) {
    return "MELI_INVALID_RESPONSE";
  }

  return "MELI_API_UNAVAILABLE";
}

function isNotFound(error: unknown) {
  return error instanceof MercadoLivreApiError && error.status === 404;
}

export async function discoverCandidatesFromLeafCategories(
  connector: MarketplaceConnector,
  categoryIds: string[],
  maxCandidatesPerCategory: number,
  metrics: ReturnType<typeof baseRunMetrics>,
) {
  const resolvedCandidates = new Map<string, MercadoLivreResolvedHighlightCandidate>();
  const resolver = new MercadoLivreHighlightResolver(connector);

  for (const categoryId of categoryIds) {
    metrics.categoriesProcessed += 1;

    let category;

    try {
      category = await connector.getCategory(categoryId);
    } catch (error) {
      recordCategorySkip(metrics, isNotFound(error) ? "CATEGORY_NOT_FOUND" : "CATEGORY_API_ERROR");
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
      recordCategorySkip(metrics, isNotFound(error) ? "NO_HIGHLIGHTS_FOR_CATEGORY" : "CATEGORY_API_ERROR");
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
        resolvedCandidates.set(result.candidate.resolvedItemId, result.candidate);
      }
    }
  }

  metrics.uniqueCandidates = resolvedCandidates.size;
  const items = await connector.getItems([...resolvedCandidates.keys()]);

  return items.map((item) => {
    const source = resolvedCandidates.get(item.externalProductId);

    if (!source) {
      return item;
    }

    return {
      ...item,
      sourceHighlightId: source.sourceHighlightId,
      sourceHighlightType: source.sourceHighlightType,
      ...(source.resolvedProductId ? { resolvedProductId: source.resolvedProductId } : {}),
      resolvedItemId: source.resolvedItemId,
      resolutionStrategy: source.resolutionStrategy,
    };
  });
}

export async function collectMercadoLivreCandidates(now = new Date(), options: MercadoLivreJobOptions = {}) {
  const metrics = emptyMetrics();
  const config = await prisma.mercadoLivreDiscoveryConfig.findFirst({ orderBy: { updatedAt: "desc" } });
  const account = await connectedAccount();

  if (!config?.enabled || !account) {
    return metrics;
  }

  if (!options.force && config.lastRunAt) {
    const nextRunAt = new Date(config.lastRunAt.getTime() + config.refreshIntervalMinutes * 60_000);

    if (nextRunAt > now) {
      return metrics;
    }
  }

  const runMetrics = baseRunMetrics();
  const run = await prisma.automationRun.create({
    data: {
      marketplaceAccountId: account.id,
      name: "mercado-livre-discovery",
      status: "RUNNING",
      idempotencyKey: `mercado-livre-discovery:${now.toISOString()}`,
      startedAt: now,
      metrics: runMetrics,
    },
  });

  try {
    const connector = await createMercadoLivreConnector();
    const categoryIds = jsonStringArray(config.categoryIds);
    const candidates = await discoverCandidatesFromLeafCategories(
      connector,
      categoryIds,
      Math.min(config.maxCandidatesPerCategory, 20),
      runMetrics,
    );
    const unique = new Map(candidates.map((candidate) => [candidate.externalProductId, candidate]));
    runMetrics.itemsFetched = unique.size;
    runMetrics.pricesFetched = unique.size;

    for (const candidate of unique.values()) {
      if (config.minimumPrice && candidate.currentPrice < Number(config.minimumPrice)) {
        continue;
      }

      if (config.maximumPrice && candidate.currentPrice > Number(config.maximumPrice)) {
        continue;
      }

      const candidateDiscount = discountPercentage(candidate.originalPrice, candidate.currentPrice);

      if (
        config.minimumDiscountPercentage &&
        (candidateDiscount === null || candidateDiscount < Number(config.minimumDiscountPercentage))
      ) {
        continue;
      }

      const existingProduct = await prisma.product.findUnique({
        where: {
          marketplace_externalProductId: {
            marketplace: candidate.marketplace,
            externalProductId: candidate.externalProductId,
          },
        },
        select: { id: true },
      });
      const ingestOptions = config.minimumScore > 0 ? { now, minScore: config.minimumScore } : { now };
      const result = await ingestOffer(candidateInput(candidate), ingestOptions);

      if (!existingProduct && result.offerId) {
        runMetrics.newProducts += 1;
      }

      if (result.status === "READY_FOR_AFFILIATE_LINK") {
        runMetrics.readyForAffiliateLink += 1;
      } else if (result.ok) {
        runMetrics.newOfferVersions += 1;
      } else if (result.status.startsWith("REJECTED")) {
        runMetrics.rejected += 1;
      } else {
        runMetrics.existingOffers += 1;
      }
    }

    await prisma.$transaction([
      prisma.mercadoLivreDiscoveryConfig.update({
        where: { id: config.id },
        data: { lastRunAt: now, lastRunSummary: runMetrics },
      }),
      prisma.marketplaceAccount.update({
        where: { id: account.id },
        data: { lastSyncAt: now, lastErrorAt: null, lastError: null },
      }),
      prisma.automationRun.update({
        where: { id: run.id },
        data: { status: "SUCCEEDED", finishedAt: new Date(), metrics: runMetrics },
      }),
    ]);
  } catch (error) {
    runMetrics.errors += 1;
    const message = error instanceof Error ? error.message : "Mercado Livre discovery failed.";
    const alertCode = alertCodeForMercadoLivreError(error);
    await prisma.$transaction([
      prisma.marketplaceAccount.update({
        where: { id: account.id },
        data: { status: "ERROR", lastErrorAt: new Date(), lastError: message },
      }),
      prisma.systemAlert.create({
        data: {
          severity: "ERROR",
          source: "mercado-livre.discovery",
          message: alertCode,
          metadata: { error: message },
        },
      }),
      prisma.automationRun.update({
        where: { id: run.id },
        data: { status: "FAILED", finishedAt: new Date(), metrics: runMetrics, errorMessage: message },
      }),
    ]);
  }

  return metrics;
}

export async function refreshMercadoLivreOffers(now = new Date()) {
  const metrics = emptyMetrics();
  const account = await connectedAccount();

  if (!account) {
    return metrics;
  }

  const offers = await prisma.offer.findMany({
    where: { marketplace: "MERCADO_LIVRE", status: { notIn: ["PUBLISHED"] } },
    distinct: ["externalProductId"],
    orderBy: { collectedAt: "desc" },
    take: 50,
  });

  if (offers.length === 0) {
    return metrics;
  }

  const runMetrics = baseRunMetrics();
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

    for (const offer of offers) {
      const candidate = await connector.getItem(offer.externalProductId);

      if (!candidate) {
        continue;
      }

      const result = await ingestOffer(candidateInput(candidate), { now });
      runMetrics.itemsFetched += 1;
      runMetrics.pricesFetched += 1;

      if (result.status === "READY_FOR_AFFILIATE_LINK") {
        runMetrics.readyForAffiliateLink += 1;
      } else if (result.ok) {
        runMetrics.newOfferVersions += 1;
      } else if (result.status.startsWith("REJECTED")) {
        runMetrics.rejected += 1;
      } else {
        runMetrics.existingOffers += 1;
      }
    }

    await prisma.automationRun.update({
      where: { id: run.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), metrics: runMetrics },
    });
  } catch (error) {
    runMetrics.errors += 1;
    const message = error instanceof Error ? error.message : "Mercado Livre refresh failed.";
    const alertCode = alertCodeForMercadoLivreError(error);
    await prisma.systemAlert.create({
      data: {
        severity: "ERROR",
        source: "mercado-livre.refresh",
        message: alertCode,
        metadata: { error: message },
      },
    });
    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        metrics: runMetrics,
        errorMessage: message,
      },
    });
  }

  return metrics;
}
