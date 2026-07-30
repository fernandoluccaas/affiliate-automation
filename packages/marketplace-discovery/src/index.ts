import { prisma, type MarketplaceAccount } from "@affiliate/database";
import { ingestOffer, type IngestOfferResult } from "@affiliate/ingestion";
import {
  MercadoLivreAffiliateApiError,
  MercadoLivreAffiliateLinkService,
  MercadoLivreApiError,
  MercadoLivreInvalidResponseError,
  createMercadoLivreConnector,
  decryptSecret,
  emitMercadoLivreOperationalMetric,
  encryptSecret,
  isSafeMercadoLivreProductPermalink,
  normalizeMercadoLivreCookie,
  parseMercadoLivreCookie,
  resolveMercadoLivreCatalogProductUrl,
  sanitizeMercadoLivreAffiliateError,
  selectBestMercadoLivreCatalogProductSummary,
  type CreateMercadoLivreAffiliateLinkInput,
  type CreateMercadoLivreAffiliateLinkResult,
  type MarketplaceConnector,
  type MarketplaceOfferCandidate,
  type MercadoLivreHighlightCandidate,
  type MercadoLivreHighlightResolutionResult,
  type MercadoLivreHighlightSkipReason,
  type MercadoLivreOperationalEvent,
  type MercadoLivreProduct,
  type MercadoLivreCatalogProductItemSummary,
  type MercadoLivreCatalogProductUrlResolution,
  type MercadoLivreProductItem,
  type MercadoLivreProductResolutionDiagnostics,
  type MercadoLivreResolutionStrategy,
  type MercadoLivreResolvedHighlightCandidate,
  type MercadoLivreUserProduct,
} from "@affiliate/marketplace-connectors";
import { acquireLock, type LockHandle } from "@affiliate/redis";
import {
  ManualAffiliateLinkProvider,
  createMercadoLivreAffiliateLinkProvider,
  type AffiliateLinkProvider,
} from "./affiliate-link-provider";

export {
  ManualAffiliateLinkProvider,
  MercadoLivreAffiliateSessionLinkProvider,
  createMercadoLivreAffiliateLinkProvider,
  type AffiliateLinkGenerationResult,
  type AffiliateLinkProvider,
} from "./affiliate-link-provider";
export {
  applyAffiliateLinksBatch,
  extractMercadoLivreExternalId,
  parseAffiliateLinksCsv,
  parsePipeAffiliateLinks,
  processAffiliateLinkJobs,
  previewAffiliateLinksBatch,
  queueAffiliateLinksBatch,
  validateMercadoLivreProductUrl,
  type AffiliateLinkBatchEntry,
  type AffiliateLinkBatchPreview,
  type AffiliateLinkPreviewItem,
  type AffiliateLinkPreviewStatus,
  type AffiliateLinkParseIssue,
  type AffiliateLinkParseResult,
  type ApplyAffiliateLinksBatchResult,
} from "./affiliate-links";

export type { MercadoLivreProductResolutionDiagnostics } from "@affiliate/marketplace-connectors";

const DISCOVERY_LOCK_TTL_MS = 10 * 60 * 1000;
const AFFILIATE_BATCH_CONCURRENCY = 2;
const MAX_AFFILIATE_BATCH_CONCURRENCY = 4;
const MAX_PENDING_AFFILIATE_LINKS_PER_RUN = 100;
const AFFILIATE_OPERATION_LOCK_PREFIX = "mercado-livre:affiliate-session";

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
  productResolvedViaItems: number;
  productItemsFetched: number;
  productItemsUsable: number;
  productItemsSkipped: number;
  productLeafWithoutWinner: number;
  productParentWithoutResolvableChild: number;
  resolvedItemCandidates: number;
  resolvedItems: number;
  resolvedCatalogProducts: number;
  resolvedCatalogProductsViaSummary: number;
  resolvedUserProducts: number;
  unresolvedCandidates: number;
  uniqueCandidates: number;
  itemsFetched: number;
  priceApiFetched: number;
  priceFallbackUsed: number;
  priceUnavailable: number;
  newProducts: number;
  newOfferVersions: number;
  existingOffers: number;
  updatedOffers: number;
  readyToPublish: number;
  readyForAffiliateLink: number;
  affiliateLinkAttempts: number;
  catalogProductPdpAffiliateRequested: number;
  catalogProductPdpAffiliateGenerated: number;
  catalogProductPdpAffiliateFailed: number;
  affiliateLinksGenerated: number;
  affiliateLinksReused: number;
  affiliateIneligible: number;
  affiliatePending: number;
  affiliateSkippedAfterSessionExpired: number;
  ingestionFailed: number;
  rejected: number;
  errors: number;
  candidateResolutionSkipReasons: Record<string, number>;
};

export type MercadoLivreDiscoveryResult = {
  ok: boolean;
  runId?: string;
  importJobId?: string;
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
  affiliateLinkProvider: AffiliateLinkProvider;
  affiliateLinkService: Pick<MercadoLivreAffiliateLinkService, "create"> &
    Partial<Pick<MercadoLivreAffiliateLinkService, "warmupSession">>;
  affiliateConcurrency: number;
  decryptCredential: typeof decryptSecret;
  encryptCredential: typeof encryptSecret;
  emitOperationalMetric: typeof emitMercadoLivreOperationalMetric;
  monotonicNow: () => number;
  ingest: typeof ingestOffer;
  lock: typeof acquireLock;
};

export type MercadoLivreDiscoveredCandidate = MarketplaceOfferCandidate & {
  sourceCategoryId?: string;
  bestSellerPosition?: number;
  affiliateFailure?: MercadoLivreAffiliateFailure | null;
};

export type MercadoLivreAffiliateFailure = {
  stage: "SESSION_WARMUP" | "TAGS" | "LINK_GENERATION" | "RESPONSE_PARSING";
  status?: number;
  code?: string;
  message: string;
  retryable: boolean;
  sessionExpired: boolean;
  productIneligible: boolean;
  attempts: number;
};

type AffiliateLinkCreator = (
  input: CreateMercadoLivreAffiliateLinkInput,
  options?: { skipInitialWarmup?: boolean },
) => Promise<CreateMercadoLivreAffiliateLinkResult>;

type AffiliateSessionCredentials =
  | {
      ready: true;
      affiliateTag: string;
      cookie: string;
      csrfToken: string | null;
      cookieChanged: boolean;
      csrfTokenChanged: boolean;
      expectedUpdatedAt: Date;
    }
  | {
      ready: false;
      failure: MercadoLivreAffiliateFailure;
    };

type AffiliateEnrichmentResult = {
  candidate: MercadoLivreDiscoveredCandidate;
  affiliateUrl: string | null;
  affiliateEligibility: "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN";
  affiliateLabel: string | null;
  affiliateFailure: MercadoLivreAffiliateFailure | null;
  linkAttempted: boolean;
  linkGenerated: boolean;
  linkReused: boolean;
};

type CandidateResolutionObserver = {
  onResult?: (
    result: MercadoLivreHighlightResolutionResult,
  ) => Promise<void> | void;
};

export type GeneratePendingMercadoLivreAffiliateLinksInput = {
  limit?: number;
  offerIds?: string[];
  dryRun?: boolean;
};

export type GeneratePendingMercadoLivreAffiliateLinksResult = {
  ok: boolean;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED" | "DRY_RUN";
  importJobId?: string;
  selected: number;
  processed: number;
  linksGenerated: number;
  updated: number;
  ineligible: number;
  pending: number;
  failed: number;
  errorCode?: string;
  errorMessage?: string;
};

function affiliateBatchConcurrency(value: string | number | undefined) {
  const parsed = Number(value ?? AFFILIATE_BATCH_CONCURRENCY);

  if (!Number.isFinite(parsed)) {
    return AFFILIATE_BATCH_CONCURRENCY;
  }

  return Math.min(
    MAX_AFFILIATE_BATCH_CONCURRENCY,
    Math.max(1, Math.floor(parsed)),
  );
}

function discoveryDependencies(
  dependencies: Partial<DiscoveryDependencies> = {},
): DiscoveryDependencies {
  return {
    database: dependencies.database ?? prisma,
    createConnector:
      dependencies.createConnector ?? createMercadoLivreConnector,
    affiliateLinkProvider:
      dependencies.affiliateLinkProvider ?? new ManualAffiliateLinkProvider(),
    affiliateLinkService:
      dependencies.affiliateLinkService ??
      new MercadoLivreAffiliateLinkService(),
    affiliateConcurrency: affiliateBatchConcurrency(
      dependencies.affiliateConcurrency ??
        process.env.MERCADOLIVRE_AFFILIATE_MAX_CONCURRENCY ??
        process.env.MERCADOLIVRE_DISCOVERY_MAX_CONCURRENCY,
    ),
    decryptCredential: dependencies.decryptCredential ?? decryptSecret,
    encryptCredential: dependencies.encryptCredential ?? encryptSecret,
    emitOperationalMetric:
      dependencies.emitOperationalMetric ??
      (process.env.NODE_ENV === "test"
        ? () => undefined
        : emitMercadoLivreOperationalMetric),
    monotonicNow: dependencies.monotonicNow ?? Date.now,
    ingest: dependencies.ingest ?? ingestOffer,
    lock: dependencies.lock ?? acquireLock,
  };
}

function affiliateOperationLockKey(marketplaceAccountId: string) {
  return `${AFFILIATE_OPERATION_LOCK_PREFIX}:${marketplaceAccountId}`;
}

function emitOperationalMetric(
  dependencies: DiscoveryDependencies,
  event: MercadoLivreOperationalEvent,
  fields: Parameters<typeof emitMercadoLivreOperationalMetric>[1],
) {
  try {
    dependencies.emitOperationalMetric(event, fields);
  } catch {
    // Metrics must never change the result of discovery or ingestion.
  }
}

function startLockHeartbeat(lock: LockHandle, ttlMs: number) {
  if (lock.mode === "unavailable") {
    return () => undefined;
  }

  const interval = setInterval(
    () => {
      void lock.extend(ttlMs).catch(() => false);
    },
    Math.max(1_000, Math.floor(ttlMs / 3)),
  );
  interval.unref();

  return () => clearInterval(interval);
}

function mergeAffiliateCookieSnapshots(
  currentCookie: string,
  cookieAtRequestStart: string,
  refreshedCookie: string,
) {
  const current = parseMercadoLivreCookie(
    normalizeMercadoLivreCookie(currentCookie),
  );
  const before = parseMercadoLivreCookie(
    normalizeMercadoLivreCookie(cookieAtRequestStart),
  );
  const refreshed = parseMercadoLivreCookie(
    normalizeMercadoLivreCookie(refreshedCookie),
  );

  for (const [name, value] of refreshed) {
    if (before.get(name) !== value) {
      current.set(name, value);
    }
  }

  for (const name of before.keys()) {
    if (!refreshed.has(name)) {
      current.delete(name);
    }
  }

  return normalizeMercadoLivreCookie(
    [...current.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
  );
}

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
    productResolvedViaItems: 0,
    productItemsFetched: 0,
    productItemsUsable: 0,
    productItemsSkipped: 0,
    productLeafWithoutWinner: 0,
    productParentWithoutResolvableChild: 0,
    resolvedItemCandidates: 0,
    resolvedItems: 0,
    resolvedCatalogProducts: 0,
    resolvedCatalogProductsViaSummary: 0,
    resolvedUserProducts: 0,
    unresolvedCandidates: 0,
    uniqueCandidates: 0,
    itemsFetched: 0,
    priceApiFetched: 0,
    priceFallbackUsed: 0,
    priceUnavailable: 0,
    newProducts: 0,
    newOfferVersions: 0,
    existingOffers: 0,
    updatedOffers: 0,
    readyToPublish: 0,
    readyForAffiliateLink: 0,
    affiliateLinkAttempts: 0,
    catalogProductPdpAffiliateRequested: 0,
    catalogProductPdpAffiliateGenerated: 0,
    catalogProductPdpAffiliateFailed: 0,
    affiliateLinksGenerated: 0,
    affiliateLinksReused: 0,
    affiliateIneligible: 0,
    affiliatePending: 0,
    affiliateSkippedAfterSessionExpired: 0,
    ingestionFailed: 0,
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

function candidateInput(candidate: MercadoLivreDiscoveredCandidate) {
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
    affiliateFailure: candidate.affiliateFailure,
    sourceCategoryId: candidate.sourceCategoryId ?? undefined,
    bestSellerPosition: candidate.bestSellerPosition ?? undefined,
    sourceHighlightId: candidate.sourceHighlightId ?? undefined,
    sourceHighlightType: candidate.sourceHighlightType ?? undefined,
    resolutionStrategy: candidate.resolutionStrategy ?? undefined,
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

function fixedAffiliateFailure(
  code: string,
  message: string,
  options: Partial<
    Pick<
      MercadoLivreAffiliateFailure,
      "retryable" | "sessionExpired" | "productIneligible" | "attempts"
    >
  > = {},
): MercadoLivreAffiliateFailure {
  return {
    stage: "LINK_GENERATION",
    code,
    message,
    retryable: options.retryable ?? false,
    sessionExpired: options.sessionExpired ?? false,
    productIneligible: options.productIneligible ?? false,
    attempts: options.attempts ?? 0,
  };
}

export function classifyMercadoLivreAffiliateError(
  error: unknown,
  secrets: readonly string[] = [],
  attempts = 1,
): MercadoLivreAffiliateFailure {
  if (error instanceof MercadoLivreAffiliateApiError) {
    const effectiveAttempts = error.attempts ?? attempts;
    const code =
      error.code === undefined
        ? undefined
        : sanitizeMercadoLivreAffiliateError(String(error.code), secrets).slice(
            0,
            100,
          );

    return {
      stage: error.stage,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(code ? { code } : {}),
      message: sanitizeMercadoLivreAffiliateError(error, secrets),
      retryable: error.retryable,
      sessionExpired: error.sessionExpired,
      productIneligible: error.productIneligible,
      attempts: effectiveAttempts,
    };
  }

  return {
    stage: "LINK_GENERATION",
    code: "UNKNOWN_AFFILIATE_ERROR",
    message: "Mercado Livre affiliate link generation failed.",
    retryable: true,
    sessionExpired: false,
    productIneligible: false,
    attempts,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
) {
  if (values.length === 0) {
    return [] as R[];
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(
    values.length,
    Math.max(1, Math.floor(concurrency)),
  );

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= values.length) {
        return;
      }

      results[index] = await mapper(values[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function loadAffiliateSessionCredentials(
  dependencies: DiscoveryDependencies,
  marketplaceAccountId: string,
  now: Date,
  metrics: MercadoLivreDiscoveryMetrics,
): Promise<AffiliateSessionCredentials> {
  const session =
    await dependencies.database.mercadoLivreAffiliateSession.findUnique({
      where: { marketplaceAccountId },
      select: {
        status: true,
        affiliateTag: true,
        cookieEncrypted: true,
        csrfTokenEncrypted: true,
        updatedAt: true,
      },
    });

  if (!session) {
    return {
      ready: false,
      failure: fixedAffiliateFailure(
        "AFFILIATE_SESSION_NOT_CONFIGURED",
        "Mercado Livre affiliate session is not configured.",
      ),
    };
  }

  if (session.status === "EXPIRED") {
    return {
      ready: false,
      failure: fixedAffiliateFailure(
        "AFFILIATE_SESSION_EXPIRED",
        "Mercado Livre affiliate session is expired.",
        { sessionExpired: true },
      ),
    };
  }

  if (session.status !== "CONNECTED" || !session.cookieEncrypted) {
    return {
      ready: false,
      failure: fixedAffiliateFailure(
        "AFFILIATE_SESSION_UNAVAILABLE",
        "Mercado Livre affiliate session is not ready.",
      ),
    };
  }

  const affiliateTag = session.affiliateTag?.trim();

  if (!affiliateTag) {
    return {
      ready: false,
      failure: fixedAffiliateFailure(
        "AFFILIATE_TAG_REQUIRED",
        "Mercado Livre affiliate tag is not configured.",
      ),
    };
  }

  try {
    return {
      ready: true,
      affiliateTag,
      cookie: dependencies.decryptCredential(session.cookieEncrypted),
      csrfToken: session.csrfTokenEncrypted
        ? dependencies.decryptCredential(session.csrfTokenEncrypted)
        : null,
      cookieChanged: false,
      csrfTokenChanged: false,
      expectedUpdatedAt: session.updatedAt,
    };
  } catch {
    const message = "Stored Mercado Livre affiliate credential is invalid.";

    try {
      await dependencies.database.mercadoLivreAffiliateSession.updateMany({
        where: {
          marketplaceAccountId,
          updatedAt: session.updatedAt,
        },
        data: {
          status: "ERROR",
          lastErrorAt: now,
          lastError: message,
        },
      });
    } catch {
      metrics.errors += 1;
    }

    return {
      ready: false,
      failure: fixedAffiliateFailure("AFFILIATE_CREDENTIAL_INVALID", message),
    };
  }
}

function pendingAfterExpiredFailure() {
  return fixedAffiliateFailure(
    "AFFILIATE_SESSION_EXPIRED_IN_BATCH",
    "Affiliate link generation was skipped because the session expired during this batch.",
    { sessionExpired: true },
  );
}

async function persistAffiliateSessionAfterBatch(
  dependencies: DiscoveryDependencies,
  marketplaceAccountId: string,
  session: AffiliateSessionCredentials,
  results: readonly AffiliateEnrichmentResult[],
  now: Date,
  metrics: MercadoLivreDiscoveryMetrics,
) {
  if (!session.ready) {
    return;
  }

  const attempted = results.some((result) => result.linkAttempted);

  if (!attempted) {
    return;
  }

  const expiredFailure = results.find(
    (result) =>
      result.linkAttempted && result.affiliateFailure?.sessionExpired === true,
  )?.affiliateFailure;

  try {
    await dependencies.database.mercadoLivreAffiliateSession.updateMany({
      where: {
        marketplaceAccountId,
        updatedAt: session.expectedUpdatedAt,
      },
      data: {
        ...(session.cookieChanged
          ? {
              cookieEncrypted: dependencies.encryptCredential(session.cookie),
              lastCookieUpdateAt: now,
            }
          : {}),
        ...(session.csrfTokenChanged
          ? {
              csrfTokenEncrypted: session.csrfToken
                ? dependencies.encryptCredential(session.csrfToken)
                : null,
            }
          : {}),
        status: expiredFailure ? "EXPIRED" : "CONNECTED",
        lastValidatedAt: now,
        lastErrorAt: expiredFailure ? now : null,
        lastError: expiredFailure?.message ?? null,
      },
    });
  } catch {
    metrics.errors += 1;
  }
}

function emitAffiliateItemMetric(
  dependencies: DiscoveryDependencies,
  event: MercadoLivreOperationalEvent,
  input: {
    jobId: string;
    marketplaceAccountId: string;
    externalItemId: string;
    stage: string;
    startedAt: number;
    status: string;
    attempt: number;
    errorCode?: string;
  },
) {
  emitOperationalMetric(dependencies, event, {
    jobId: input.jobId,
    marketplaceAccountId: input.marketplaceAccountId,
    externalItemId: input.externalItemId,
    stage: input.stage,
    durationMs: Math.max(0, dependencies.monotonicNow() - input.startedAt),
    status: input.status,
    attempt: input.attempt,
    count: 1,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
}

async function enrichCandidatesWithAffiliateLinks(
  candidates: readonly MercadoLivreDiscoveredCandidate[],
  dependencies: DiscoveryDependencies,
  marketplaceAccountId: string,
  importJobId: string,
  existingAffiliateLinks: ReadonlyMap<
    string,
    { affiliateUrl: string; affiliateLabel: string | null }
  >,
  metrics: MercadoLivreDiscoveryMetrics,
  now: Date,
) {
  const session = await loadAffiliateSessionCredentials(
    dependencies,
    marketplaceAccountId,
    now,
    metrics,
  );
  let stopNewLinkAttempts = false;
  let batchWarmupFailure: MercadoLivreAffiliateFailure | null = null;
  const createLink: AffiliateLinkCreator = (input, options) =>
    dependencies.affiliateLinkService.create(input, options);

  if (session.ready && dependencies.affiliateLinkService.warmupSession) {
    const cookieAtStart = session.cookie;
    const csrfTokenAtStart = session.csrfToken;

    try {
      const warmed = await dependencies.affiliateLinkService.warmupSession({
        cookie: cookieAtStart,
        csrfToken: csrfTokenAtStart,
      });
      if (warmed.cookie !== cookieAtStart) {
        session.cookie = warmed.cookie;
        session.cookieChanged = true;
      }
      if (warmed.csrfToken !== csrfTokenAtStart) {
        session.csrfToken = warmed.csrfToken;
        session.csrfTokenChanged = true;
      }
    } catch (error) {
      batchWarmupFailure = classifyMercadoLivreAffiliateError(error, [
        cookieAtStart,
        csrfTokenAtStart ?? "",
      ]);
      stopNewLinkAttempts = batchWarmupFailure.sessionExpired;
    }
  }

  const provider =
    session.ready && !batchWarmupFailure
      ? createMercadoLivreAffiliateLinkProvider({
          sessionStatus: "CONNECTED",
          generate: async (input) => {
            const cookieAtStart = session.cookie;
            const csrfTokenAtStart = session.csrfToken;
            const result = await createLink(
              {
                productUrl: input.productUrl,
                affiliateTag: session.affiliateTag,
                cookie: cookieAtStart,
                csrfToken: csrfTokenAtStart,
              },
              {
                skipInitialWarmup: true,
              },
            );

            if (result.refreshedCookie) {
              session.cookie = mergeAffiliateCookieSnapshots(
                session.cookie,
                cookieAtStart,
                result.refreshedCookie,
              );
              session.cookieChanged = true;
            }

            if ("refreshedCsrfToken" in result) {
              session.csrfToken = result.refreshedCsrfToken ?? null;
              session.csrfTokenChanged = true;
            }

            return {
              status: "GENERATED",
              affiliateUrl: result.affiliateUrl,
              provider: "mercado-livre-affiliate-portal",
            };
          },
        })
      : createMercadoLivreAffiliateLinkProvider({
          sessionStatus: (
            session.ready
              ? batchWarmupFailure?.sessionExpired
              : session.failure.sessionExpired
          )
            ? "EXPIRED"
            : !session.ready &&
                session.failure.code === "AFFILIATE_SESSION_NOT_CONFIGURED"
              ? "NOT_CONFIGURED"
              : "UNAVAILABLE",
          ...((session.ready ? batchWarmupFailure?.code : session.failure.code)
            ? {
                reason: (session.ready
                  ? batchWarmupFailure?.code
                  : session.failure.code) as string,
              }
            : {}),
        });

  const results = await mapWithConcurrency(
    candidates,
    dependencies.affiliateConcurrency,
    async (candidate): Promise<AffiliateEnrichmentResult> => {
      const itemStartedAt = dependencies.monotonicNow();
      const emitItem = (
        event: MercadoLivreOperationalEvent,
        status: string,
        attempt: number,
        errorCode?: string,
        stage = "LINK_GENERATION",
      ) =>
        emitAffiliateItemMetric(dependencies, event, {
          jobId: importJobId,
          marketplaceAccountId,
          externalItemId: candidate.externalProductId,
          stage,
          startedAt: itemStartedAt,
          status,
          attempt,
          ...(errorCode ? { errorCode } : {}),
        });
      const existing = existingAffiliateLinks.get(candidate.externalProductId);

      if (existing) {
        metrics.affiliateLinksReused += 1;
        return {
          candidate,
          affiliateUrl: existing.affiliateUrl,
          affiliateEligibility: "ELIGIBLE",
          affiliateLabel: existing.affiliateLabel,
          affiliateFailure: null,
          linkAttempted: false,
          linkGenerated: false,
          linkReused: true,
        };
      }

      if (!session.ready || batchWarmupFailure) {
        const generated = await provider.generate({
          marketplace: candidate.marketplace,
          productUrl: candidate.productUrl,
          externalProductId: candidate.externalProductId,
        });
        metrics.affiliatePending += 1;
        metrics.errors += 1;
        const failure = session.ready
          ? (batchWarmupFailure ??
            fixedAffiliateFailure(
              "AFFILIATE_SESSION_UNAVAILABLE",
              "Mercado Livre affiliate session is unavailable.",
            ))
          : session.failure;
        emitItem(
          "mercadolivre_affiliate_link_failed",
          "PENDING",
          failure.attempts,
          failure.code,
          failure.stage,
        );
        emitItem(
          "mercadolivre_discovery_items_pending_link",
          "PENDING",
          failure.attempts,
          failure.code,
          failure.stage,
        );
        return {
          candidate,
          affiliateUrl: null,
          affiliateEligibility: "UNKNOWN",
          affiliateLabel: null,
          affiliateFailure: {
            ...failure,
            message:
              generated.status === "MANUAL_REQUIRED"
                ? generated.reason
                : failure.message,
          },
          linkAttempted: Boolean(batchWarmupFailure),
          linkGenerated: false,
          linkReused: false,
        };
      }

      if (stopNewLinkAttempts) {
        const failure = pendingAfterExpiredFailure();
        metrics.affiliatePending += 1;
        metrics.affiliateSkippedAfterSessionExpired += 1;
        metrics.errors += 1;
        emitItem(
          "mercadolivre_affiliate_link_failed",
          "SKIPPED",
          failure.attempts,
          failure.code,
          failure.stage,
        );
        emitItem(
          "mercadolivre_discovery_items_pending_link",
          "PENDING",
          failure.attempts,
          failure.code,
          failure.stage,
        );
        return {
          candidate,
          affiliateUrl: null,
          affiliateEligibility: "UNKNOWN",
          affiliateLabel: session.affiliateTag,
          affiliateFailure: failure,
          linkAttempted: false,
          linkGenerated: false,
          linkReused: false,
        };
      }

      metrics.affiliateLinkAttempts += 1;
      if (candidate.candidateKind === "CATALOG_PRODUCT") {
        metrics.catalogProductPdpAffiliateRequested += 1;
      }

      try {
        const generated = await provider.generate({
          marketplace: candidate.marketplace,
          productUrl: candidate.productUrl,
          externalProductId: candidate.externalProductId,
        });

        if (generated.status !== "GENERATED") {
          throw new MercadoLivreAffiliateApiError(generated.reason, {
            stage: "LINK_GENERATION",
            code:
              generated.status === "INELIGIBLE"
                ? "PRODUCT_INELIGIBLE"
                : "MANUAL_REQUIRED",
            productIneligible: generated.status === "INELIGIBLE",
          });
        }

        metrics.affiliateLinksGenerated += 1;
        if (candidate.candidateKind === "CATALOG_PRODUCT") {
          metrics.catalogProductPdpAffiliateGenerated += 1;
        }
        emitItem("mercadolivre_affiliate_link_generated", "SUCCEEDED", 1);
        return {
          candidate,
          affiliateUrl: generated.affiliateUrl,
          affiliateEligibility: "ELIGIBLE",
          affiliateLabel: session.affiliateTag,
          affiliateFailure: null,
          linkAttempted: true,
          linkGenerated: true,
          linkReused: false,
        };
      } catch (error) {
        const failure = classifyMercadoLivreAffiliateError(
          error,
          [session.cookie, session.csrfToken ?? ""],
          error instanceof MercadoLivreAffiliateApiError ? error.attempts : 1,
        );

        metrics.errors += 1;
        if (candidate.candidateKind === "CATALOG_PRODUCT") {
          metrics.catalogProductPdpAffiliateFailed += 1;
          if (!failure.sessionExpired) {
            failure.code = "PRODUCT_PDP_AFFILIATE_LINK_UNSUPPORTED";
          }
        }

        if (failure.productIneligible) {
          metrics.affiliateIneligible += 1;
          emitItem(
            "mercadolivre_affiliate_link_failed",
            "INELIGIBLE",
            failure.attempts,
            failure.code,
            failure.stage,
          );
          emitItem(
            "mercadolivre_discovery_items_ineligible",
            "INELIGIBLE",
            failure.attempts,
            failure.code,
            failure.stage,
          );
          return {
            candidate,
            affiliateUrl: null,
            affiliateEligibility: "INELIGIBLE",
            affiliateLabel: session.affiliateTag,
            affiliateFailure: failure,
            linkAttempted: true,
            linkGenerated: false,
            linkReused: false,
          };
        }

        if (failure.sessionExpired) {
          const firstSessionExpiry = !stopNewLinkAttempts;
          stopNewLinkAttempts = true;

          if (firstSessionExpiry) {
            emitItem(
              "mercadolivre_affiliate_session_expired",
              "EXPIRED",
              failure.attempts,
              failure.code,
              failure.stage,
            );
          }
        }

        metrics.affiliatePending += 1;
        emitItem(
          "mercadolivre_affiliate_link_failed",
          "PENDING",
          failure.attempts,
          failure.code,
          failure.stage,
        );
        emitItem(
          "mercadolivre_discovery_items_pending_link",
          "PENDING",
          failure.attempts,
          failure.code,
          failure.stage,
        );
        return {
          candidate,
          affiliateUrl: null,
          affiliateEligibility: "UNKNOWN",
          affiliateLabel: session.affiliateTag,
          affiliateFailure: failure,
          linkAttempted: true,
          linkGenerated: false,
          linkReused: false,
        };
      }
    },
  );

  await persistAffiliateSessionAfterBatch(
    dependencies,
    marketplaceAccountId,
    session,
    results,
    now,
    metrics,
  );

  return results;
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
  metrics.productResolvedViaItems += diagnostics.productResolvedViaItems;
  metrics.resolvedCatalogProductsViaSummary +=
    diagnostics.productResolvedViaCatalogPdp;
  metrics.productItemsFetched += diagnostics.productItemsFetched;
  metrics.productItemsUsable += diagnostics.productItemsUsable;
  metrics.productItemsSkipped += diagnostics.productItemsSkipped;
  metrics.priceApiFetched += diagnostics.productItemsPriceApiFetched ?? 0;
  metrics.priceFallbackUsed += diagnostics.productItemsPriceFallbackUsed ?? 0;
  metrics.priceUnavailable += diagnostics.productItemsPriceUnavailable ?? 0;
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
    productResolvedViaItems: 0,
    productResolvedViaCatalogPdp: 0,
    productDetailEnrichmentUnavailable: false,
    productPdpFallbackEligible: false,
    productItemsFetched: 0,
    productItemsUsable: 0,
    productItemsSkipped: 0,
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
      kind: strategy === "USER_PRODUCT_ACTIVE_ITEM" ? "USER_PRODUCT" : "ITEM",
      marketplaceExternalId: resolvedItemId,
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

function catalogProductOfferCandidate(
  highlight: MercadoLivreHighlightCandidate,
  product: MercadoLivreProduct,
  summary: MercadoLivreCatalogProductItemSummary,
  productUrl: MercadoLivreCatalogProductUrlResolution,
  enrichment: MarketplaceOfferCandidate | null = null,
): MarketplaceOfferCandidate | null {
  const title = (product.name ?? product.familyName)?.trim() ?? "";
  const currentPrice =
    enrichment && enrichment.currentPrice > 0
      ? enrichment.currentPrice
      : summary.price;

  if (
    (product.status !== null && product.status !== "active") ||
    title.length < 3 ||
    product.pictureUrls.length === 0 ||
    currentPrice === undefined ||
    currentPrice <= 0
  ) {
    return null;
  }

  const enrichedOriginalPrice = enrichment?.originalPrice ?? null;
  const originalPrice =
    enrichedOriginalPrice !== null && enrichedOriginalPrice > currentPrice
      ? enrichedOriginalPrice
      : summary.originalPrice !== undefined &&
          summary.originalPrice > currentPrice
        ? summary.originalPrice
        : null;
  const stockStatus =
    enrichment?.stockStatus ??
    (summary.availableQuantity === undefined
      ? ("UNKNOWN" as const)
      : summary.availableQuantity > 0
        ? ("IN_STOCK" as const)
        : ("OUT_OF_STOCK" as const));
  const shippingStatus =
    enrichment?.shippingStatus ??
    (summary.freeShipping === undefined
      ? ("UNKNOWN" as const)
      : summary.freeShipping
        ? ("FREE" as const)
        : ("NOT_FREE" as const));
  const resolutionStrategy =
    productUrl.source === "CANONICAL_CATALOG_PDP"
      ? ("PRODUCT_CATALOG_CANONICAL_PDP" as const)
      : ("PRODUCT_CATALOG_PDP_FALLBACK" as const);

  return {
    marketplace: "MERCADO_LIVRE",
    externalProductId: product.id,
    title,
    description: null,
    category: summary.categoryId ?? highlight.categoryId,
    imageUrl: product.pictureUrls[0] as string,
    productUrl: productUrl.productUrl,
    affiliateUrl: null,
    currentPrice,
    originalPrice,
    stockStatus,
    shippingStatus,
    freeShipping: enrichment?.freeShipping ?? summary.freeShipping ?? null,
    availableQuantity:
      enrichment?.availableQuantity ?? summary.availableQuantity ?? null,
    sellerReputation:
      enrichment?.sellerReputation ?? summary.sellerReputation ?? null,
    rating: enrichment?.rating ?? null,
    salesCount: product.soldQuantity,
    sellerId: summary.sellerId ?? null,
    officialStoreId: summary.officialStoreId ?? null,
    affiliateEligibility: "UNKNOWN",
    trackingStrategy: "DIRECT_AFFILIATE_LINK",
    itemCondition: summary.condition === "new" ? "new" : ("unknown" as const),
    channels: [],
    resolvedProductId: product.id,
    resolvedItemId: summary.itemId,
    candidateKind: "CATALOG_PRODUCT",
    selectedCatalogItemId: summary.itemId,
    resolutionStrategy,
    productUrlSource: productUrl.source,
    priceSource: enrichment?.priceSource ?? "CATALOG_SUMMARY",
    collectedAt: new Date(),
  };
}

function resolvedCatalogProduct(
  candidate: MercadoLivreHighlightCandidate,
  product: MercadoLivreProduct,
  summary: MercadoLivreCatalogProductItemSummary,
  offerCandidate: MarketplaceOfferCandidate,
  diagnostics: MercadoLivreProductResolutionDiagnostics,
): MercadoLivreHighlightResolutionResult {
  return {
    ok: true,
    candidate: {
      kind: "CATALOG_PRODUCT",
      marketplaceExternalId: product.id,
      sourceHighlightId: candidate.id,
      sourceHighlightType: candidate.type,
      resolvedProductId: product.id,
      resolvedItemId: summary.itemId,
      selectedItemId: summary.itemId,
      ...(summary.sellerId ? { selectedSellerId: summary.sellerId } : {}),
      ...(offerCandidate.productUrlSource
        ? { productUrlSource: offerCandidate.productUrlSource }
        : {}),
      offerCandidate,
      resolutionStrategy:
        offerCandidate.resolutionStrategy as MercadoLivreResolutionStrategy,
      position: candidate.position,
      categoryId: candidate.categoryId,
    },
    diagnostics,
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

function booleanPreference(left: boolean, right: boolean) {
  return left === right ? 0 : left ? -1 : 1;
}

function isUsableMarketplaceCandidate(candidate: MarketplaceOfferCandidate) {
  const channels = marketplaceChannels(candidate);

  return (
    candidate.currentPrice > 0 &&
    (!candidate.itemStatus || candidate.itemStatus === "active") &&
    (channels.length === 0 || channels.includes("marketplace"))
  );
}

export function selectBestMercadoLivreProductItem(
  candidates: MarketplaceOfferCandidate[],
  productItems: Map<string, MercadoLivreProductItem> = new Map(),
) {
  const [chosen] = candidates
    .filter(isUsableMarketplaceCandidate)
    .sort((left, right) => {
      const leftMetadata = productItems.get(left.externalProductId);
      const rightMetadata = productItems.get(right.externalProductId);
      const active = booleanPreference(
        left.itemStatus === "active",
        right.itemStatus === "active",
      );
      if (active !== 0) return active;

      const condition = booleanPreference(
        left.itemCondition === "new" || leftMetadata?.condition === "new",
        right.itemCondition === "new" || rightMetadata?.condition === "new",
      );
      if (condition !== 0) return condition;

      const inStock = booleanPreference(
        left.stockStatus === "IN_STOCK" ||
          (leftMetadata?.availableQuantity ?? 0) > 0,
        right.stockStatus === "IN_STOCK" ||
          (rightMetadata?.availableQuantity ?? 0) > 0,
      );
      if (inStock !== 0) return inStock;

      const marketplaceChannel = booleanPreference(
        marketplaceChannels(left).includes("marketplace"),
        marketplaceChannels(right).includes("marketplace"),
      );
      if (marketplaceChannel !== 0) return marketplaceChannel;

      const freeShipping = booleanPreference(
        left.freeShipping === true || leftMetadata?.freeShipping === true,
        right.freeShipping === true || rightMetadata?.freeShipping === true,
      );
      if (freeShipping !== 0) return freeShipping;

      const officialStore = booleanPreference(
        Boolean(left.officialStoreId ?? leftMetadata?.officialStoreId),
        Boolean(right.officialStoreId ?? rightMetadata?.officialStoreId),
      );
      if (officialStore !== 0) return officialStore;

      const reputation = compareNullableNumberDesc(
        left.sellerReputation ?? leftMetadata?.sellerReputation ?? null,
        right.sellerReputation ?? rightMetadata?.sellerReputation ?? null,
      );
      if (reputation !== 0) return reputation;

      if (left.currentPrice !== right.currentPrice) {
        return left.currentPrice - right.currentPrice;
      }

      const quantity = compareNullableNumberDesc(
        left.availableQuantity ?? leftMetadata?.availableQuantity ?? null,
        right.availableQuantity ?? rightMetadata?.availableQuantity ?? null,
      );
      if (quantity !== 0) return quantity;
      return left.externalProductId.localeCompare(right.externalProductId);
    });

  return chosen ?? null;
}

export type MercadoLivreProductProbeResult = {
  productId: string;
  productFound: boolean;
  productStatus: string | null;
  productName: string | null;
  productPermalink: string | null;
  productPictureCount: number;
  buyBoxWinnerPresent: boolean;
  buyBoxWinnerItemId: string | null;
  selectedItemId: string | null;
  selectedSellerId: string | null;
  selectedPrice: number | null;
  selectedFreeShipping: boolean | null;
  itemHydrationAvailable: boolean;
  pdpFallbackEligible: boolean;
  diagnostics: Awaited<
    ReturnType<MarketplaceConnector["getProductItems"]>
  >["diagnostics"];
};

/**
 * Read-only PRODUCT probe. It deliberately avoids ingestion, affiliate-link
 * generation and job persistence so operators can inspect catalog resolution
 * without changing application state.
 */
export async function diagnoseMercadoLivreProduct(
  connector: MarketplaceConnector,
  productId: string,
): Promise<MercadoLivreProductProbeResult> {
  const [product, productItems] = await Promise.all([
    connector.getProduct(productId),
    connector.getProductItems(productId),
  ]);
  const summariesById = new Map(
    productItems.summaries.map((summary) => [summary.itemId, summary]),
  );
  const selected = selectBestMercadoLivreProductItem(
    productItems.candidates,
    summariesById,
  );
  const selectedSummary = selectBestMercadoLivreCatalogProductSummary(
    productItems.summaries,
  );
  const safePermalink =
    product && isSafeMercadoLivreProductPermalink(product.permalink)
      ? product.permalink
      : null;
  const catalogProductUrl = product
    ? resolveMercadoLivreCatalogProductUrl({
        productId: product.id,
        productPermalink: product.permalink,
        productStatus: product.status,
      })
    : null;
  const pdpCandidate =
    product && selectedSummary && catalogProductUrl
      ? catalogProductOfferCandidate(
          {
            id: productId,
            position: 1,
            type: "PRODUCT",
            rawType: "PRODUCT",
            categoryId: selectedSummary.categoryId ?? "",
          },
          product,
          selectedSummary,
          catalogProductUrl,
        )
      : null;

  return {
    productId,
    productFound: product !== null,
    productStatus: product?.status ?? null,
    productName: product ? (product.name ?? product.familyName) : null,
    productPermalink: safePermalink,
    productPictureCount: product?.pictureUrls.length ?? 0,
    buyBoxWinnerPresent: Boolean(product?.buyBoxWinnerItemId),
    buyBoxWinnerItemId: product?.buyBoxWinnerItemId ?? null,
    selectedItemId:
      selected?.externalProductId ?? selectedSummary?.itemId ?? null,
    selectedSellerId: selected?.sellerId ?? selectedSummary?.sellerId ?? null,
    selectedPrice: selected?.currentPrice ?? selectedSummary?.price ?? null,
    selectedFreeShipping:
      selected?.freeShipping ?? selectedSummary?.freeShipping ?? null,
    itemHydrationAvailable: productItems.diagnostics.productItemsHydrated > 0,
    pdpFallbackEligible: Boolean(pdpCandidate),
    diagnostics: productItems.diagnostics,
  };
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
        return resolvedHighlight(
          candidate,
          candidate.id,
          "HIGHLIGHT_ITEM_DIRECT",
        );
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
      const chosen = selectBestMercadoLivreProductItem(candidates);

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
      return this.resolveProductItemsFallback(candidate, product, diagnostics);
    }

    const childResolution = await this.resolveProductChildren(
      product,
      diagnostics,
    );

    if (!childResolution.ok) {
      if (childResolution.reason === "PRODUCT_PARENT_NO_RESOLVABLE_CHILD") {
        diagnostics.productParentWithoutResolvableChild += 1;
      }

      return this.resolveProductItemsFallback(candidate, product, diagnostics);
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

  private async resolveProductItemsFallback(
    candidate: MercadoLivreHighlightCandidate,
    product: MercadoLivreProduct,
    diagnostics: MercadoLivreProductResolutionDiagnostics,
  ): Promise<MercadoLivreHighlightResolutionResult> {
    let productItems;

    try {
      productItems = await this.connector.getProductItems(product.id);
    } catch {
      return skippedHighlight(
        candidate,
        "PRODUCT_ITEMS_API_ERROR",
        diagnostics,
      );
    }

    const productItemDiagnostics = productItems.diagnostics;
    diagnostics.productItemsFetched +=
      productItemDiagnostics.productItemsResultsCount;
    diagnostics.productItemsUsable += productItemDiagnostics.productItemsUsable;
    diagnostics.productItemsSkipped +=
      productItemDiagnostics.productItemsResultsCount -
      productItemDiagnostics.productItemsUsable;
    diagnostics.productItemsHttpStatus =
      productItemDiagnostics.productItemsHttpStatus;
    diagnostics.productItemsTotal = productItemDiagnostics.productItemsTotal;
    diagnostics.productItemsResultsCount =
      productItemDiagnostics.productItemsResultsCount;
    diagnostics.productItemsParsedCount =
      productItemDiagnostics.productItemsParsedCount;
    diagnostics.productItemsUniqueIds =
      productItemDiagnostics.productItemsUniqueIds;
    diagnostics.productItemsHydrationRequested =
      productItemDiagnostics.productItemsHydrationRequested;
    diagnostics.productItemsHydrated =
      productItemDiagnostics.productItemsHydrated;
    diagnostics.productItemsPriceApiFetched =
      productItemDiagnostics.priceApiFetched;
    diagnostics.productItemsPriceFallbackUsed =
      productItemDiagnostics.priceFallbackUsed;
    diagnostics.productItemsPriceUnavailable =
      productItemDiagnostics.priceUnavailable;
    diagnostics.productItemRejectionReasons =
      productItemDiagnostics.rejectionReasons;
    diagnostics.productItemSamples = productItemDiagnostics.samples;

    if (productItemDiagnostics.productItemsResultsCount === 0) {
      return skippedHighlight(candidate, "PRODUCT_ITEMS_EMPTY", diagnostics);
    }

    if (productItemDiagnostics.productItemsParsedCount === 0) {
      return skippedHighlight(
        candidate,
        "PRODUCT_ITEMS_SCHEMA_MISMATCH",
        diagnostics,
      );
    }

    const productItemById = new Map(
      productItems.summaries.map((item) => [item.itemId, item]),
    );
    const selectedSummary = selectBestMercadoLivreCatalogProductSummary(
      productItems.summaries,
    );
    const chosen = selectBestMercadoLivreProductItem(
      productItems.candidates,
      productItemById,
    );
    const detailFailureCount =
      (productItemDiagnostics.rejectionReasons
        .PRODUCT_ITEM_DETAIL_HTTP_ERROR ?? 0) +
      (productItemDiagnostics.rejectionReasons.PRODUCT_ITEM_DETAIL_NOT_FOUND ??
        0) +
      (productItemDiagnostics.rejectionReasons.PRODUCT_ITEM_SCHEMA_MISMATCH ??
        0);
    const detailEnrichmentUnavailable =
      productItemDiagnostics.productItemsUniqueIds > 0 &&
      productItemDiagnostics.productItemsHydrated === 0 &&
      detailFailureCount >= productItemDiagnostics.productItemsUniqueIds;
    diagnostics.productDetailEnrichmentUnavailable =
      detailEnrichmentUnavailable;
    const catalogProductUrl = resolveMercadoLivreCatalogProductUrl({
      productId: product.id,
      productPermalink: product.permalink,
      productStatus: product.status,
    });
    const selectedEnrichment = selectedSummary
      ? (productItems.candidates.find(
          (item) => item.externalProductId === selectedSummary.itemId,
        ) ?? null)
      : null;

    if (
      selectedSummary &&
      catalogProductUrl &&
      (catalogProductUrl.source === "CANONICAL_CATALOG_PDP" || !chosen)
    ) {
      const offerCandidate = catalogProductOfferCandidate(
        candidate,
        product,
        selectedSummary,
        catalogProductUrl,
        selectedEnrichment,
      );
      diagnostics.productPdpFallbackEligible = Boolean(offerCandidate);

      if (offerCandidate) {
        diagnostics.productResolvedViaCatalogPdp += 1;
        return resolvedCatalogProduct(
          candidate,
          product,
          selectedSummary,
          offerCandidate,
          diagnostics,
        );
      }

      return skippedHighlight(
        candidate,
        "PRODUCT_PDP_FALLBACK_INELIGIBLE",
        diagnostics,
      );
    }

    if (!chosen) {
      if (selectedSummary && !catalogProductUrl) {
        return skippedHighlight(
          candidate,
          "PRODUCT_CATALOG_URL_UNAVAILABLE",
          diagnostics,
        );
      }

      if (detailEnrichmentUnavailable) {
        return skippedHighlight(
          candidate,
          "PRODUCT_ITEMS_HYDRATION_FAILED",
          diagnostics,
        );
      }

      return skippedHighlight(
        candidate,
        "PRODUCT_ITEMS_NO_USABLE_ITEM",
        diagnostics,
      );
    }

    diagnostics.productResolvedViaItems += 1;
    return resolvedHighlight(
      candidate,
      chosen.externalProductId,
      "PRODUCT_ITEMS_FALLBACK",
      { resolvedProductId: product.id },
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
  observer: CandidateResolutionObserver = {},
): Promise<MercadoLivreDiscoveredCandidate[]> {
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
      await observer.onResult?.(result);

      if (!result.ok) {
        recordCandidateSkip(metrics, result.reason);
        continue;
      }

      metrics.resolvedItemCandidates += 1;
      if (result.candidate.kind === "CATALOG_PRODUCT") {
        metrics.resolvedCatalogProducts += 1;
      } else if (result.candidate.kind === "USER_PRODUCT") {
        metrics.resolvedUserProducts += 1;
      } else {
        metrics.resolvedItems += 1;
      }
      const candidateKey = `${result.candidate.kind}:${result.candidate.marketplaceExternalId}`;
      const existing = resolvedCandidates.get(candidateKey);

      if (!existing || result.candidate.position < existing.position) {
        resolvedCandidates.set(candidateKey, result.candidate);
      }
    }
  }

  metrics.uniqueCandidates = resolvedCandidates.size;
  const itemResolutions = [...resolvedCandidates.values()].filter(
    (candidate) => candidate.kind !== "CATALOG_PRODUCT",
  );
  const itemResult = await connector.getItemsWithDiagnostics(
    itemResolutions.flatMap((candidate) =>
      candidate.resolvedItemId ? [candidate.resolvedItemId] : [],
    ),
  );
  metrics.itemsFetched += itemResult.diagnostics.itemsFetched;
  metrics.priceApiFetched += itemResult.diagnostics.priceApiFetched;
  metrics.priceFallbackUsed += itemResult.diagnostics.priceFallbackUsed;
  metrics.priceUnavailable += itemResult.diagnostics.priceUnavailable;

  const itemResolutionById = new Map(
    itemResolutions.flatMap((candidate) =>
      candidate.resolvedItemId
        ? ([[candidate.resolvedItemId, candidate]] as const)
        : [],
    ),
  );
  const resolvedItems = itemResult.candidates.map((item) => {
    const source = itemResolutionById.get(item.externalProductId);

    if (!source) return item;

    return {
      ...item,
      sourceHighlightId: source.sourceHighlightId,
      sourceHighlightType: source.sourceHighlightType,
      sourceCategoryId: source.categoryId,
      bestSellerPosition: source.position,
      ...(source.resolvedProductId
        ? { resolvedProductId: source.resolvedProductId }
        : {}),
      resolvedItemId: item.externalProductId,
      resolutionStrategy: source.resolutionStrategy,
    };
  });
  const resolvedCatalogProducts = [...resolvedCandidates.values()].flatMap(
    (source) => {
      if (source.kind !== "CATALOG_PRODUCT" || !source.offerCandidate) {
        return [];
      }

      return [
        {
          ...source.offerCandidate,
          sourceHighlightId: source.sourceHighlightId,
          sourceHighlightType: source.sourceHighlightType,
          sourceCategoryId: source.categoryId,
          bestSellerPosition: source.position,
          ...(source.resolvedProductId
            ? { resolvedProductId: source.resolvedProductId }
            : {}),
          ...(source.selectedItemId
            ? {
                resolvedItemId: source.selectedItemId,
                selectedCatalogItemId: source.selectedItemId,
              }
            : {}),
          candidateKind: source.kind,
          resolutionStrategy: source.resolutionStrategy,
        },
      ];
    },
  );

  return [...resolvedItems, ...resolvedCatalogProducts];
}

function alertCodeForMercadoLivreError(error: unknown) {
  if (error instanceof MercadoLivreApiError && error.status === 429)
    return "MELI_RATE_LIMIT";
  if (error instanceof MercadoLivreInvalidResponseError)
    return "MELI_INVALID_RESPONSE";
  return "MELI_API_UNAVAILABLE";
}

function sanitizedError(error: unknown) {
  return sanitizeMercadoLivreAffiliateError(error).slice(0, 500);
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
  if (
    !result.productCreated &&
    (result.offerCreated || result.offerReused || result.offerUpdated)
  ) {
    metrics.updatedOffers += 1;
  }

  if (result.status === "READY_TO_PUBLISH") {
    metrics.readyToPublish += 1;
  } else if (result.status === "READY_FOR_AFFILIATE_LINK") {
    metrics.readyForAffiliateLink += 1;
  } else if (result.status.startsWith("REJECTED")) {
    metrics.rejected += 1;
  }
}

function candidatePassesDiscoveryPolicies(
  candidate: MercadoLivreDiscoveredCandidate,
  config: {
    minimumPrice: unknown;
    maximumPrice: unknown;
    minimumDiscountPercentage:
      number | string | { toString(): string } | null | undefined;
  },
) {
  const minimumPrice = Number(config.minimumPrice ?? 0);
  const maximumPrice = Number(config.maximumPrice ?? 0);

  if (minimumPrice > 0 && candidate.currentPrice < minimumPrice) {
    return false;
  }

  if (maximumPrice > 0 && candidate.currentPrice > maximumPrice) {
    return false;
  }

  const discount = calculateCandidateDiscount(
    candidate.originalPrice,
    candidate.currentPrice,
  );

  return passesMinimumDiscount(config.minimumDiscountPercentage, discount);
}

async function existingAffiliateLinksForCandidates(
  database: typeof prisma,
  candidates: readonly MercadoLivreDiscoveredCandidate[],
) {
  if (candidates.length === 0) {
    return new Map<
      string,
      { affiliateUrl: string; affiliateLabel: string | null }
    >();
  }

  const offers = await database.offer.findMany({
    where: {
      marketplace: "MERCADO_LIVRE",
      externalProductId: {
        in: candidates.map((candidate) => candidate.externalProductId),
      },
      affiliateUrl: { not: null },
      affiliateEligibility: { not: "INELIGIBLE" },
    },
    orderBy: { collectedAt: "desc" },
    distinct: ["externalProductId"],
    select: {
      externalProductId: true,
      affiliateUrl: true,
      affiliateLabel: true,
    },
  });
  const links = new Map<
    string,
    { affiliateUrl: string; affiliateLabel: string | null }
  >();

  for (const offer of offers) {
    if (offer.affiliateUrl && !links.has(offer.externalProductId)) {
      links.set(offer.externalProductId, {
        affiliateUrl: offer.affiliateUrl,
        affiliateLabel: offer.affiliateLabel,
      });
    }
  }

  return links;
}

async function retireReplacedPendingOfferVersions(
  database: typeof prisma,
  result: IngestOfferResult,
) {
  if (!result.ok || !result.offerId || !result.productId) {
    return;
  }

  await database.offer.updateMany({
    where: {
      productId: result.productId,
      id: { not: result.offerId },
      status: "READY_FOR_AFFILIATE_LINK",
      affiliateUrl: null,
    },
    data: {
      status: "REJECTED_DUPLICATE",
      statusReason:
        "Substituida por versao validada com link oficial de afiliado.",
    },
  });
}

function itemSourceData(candidate: MercadoLivreDiscoveredCandidate) {
  return {
    sourceId: candidate.sourceHighlightId ?? candidate.externalProductId,
    sourceType: candidate.sourceHighlightType ?? "ITEM",
    bestSellerPosition: candidate.bestSellerPosition,
    externalItemId:
      candidate.selectedCatalogItemId ?? candidate.externalProductId,
  };
}

async function persistIngestionResultItem(
  database: typeof prisma,
  importJobId: string,
  enrichment: AffiliateEnrichmentResult,
  result: IngestOfferResult,
  metrics: MercadoLivreDiscoveryMetrics,
) {
  const source = itemSourceData(enrichment.candidate);
  const failure = enrichment.affiliateFailure;
  let stage: "AFFILIATE_LINK" | "INGESTION" = "INGESTION";
  let status: "SUCCEEDED" | "PENDING_AFFILIATE_LINK" | "INELIGIBLE" | "FAILED" =
    "SUCCEEDED";
  let errorCode: string | undefined;
  let errorMessage: string | undefined;

  if (failure?.productIneligible) {
    stage = "AFFILIATE_LINK";
    status = "INELIGIBLE";
    errorCode = failure.code ?? "PRODUCT_INELIGIBLE";
    errorMessage = failure.message;
  } else if (failure) {
    stage = "AFFILIATE_LINK";
    status = "PENDING_AFFILIATE_LINK";
    errorCode = failure.code ?? "AFFILIATE_LINK_PENDING";
    errorMessage = failure.message;
  } else if (result.status.startsWith("REJECTED")) {
    status = "FAILED";
    errorCode = result.status;
    errorMessage = result.statusReason;
    metrics.ingestionFailed += 1;
    metrics.errors += 1;
  }

  await database.importJobItem.create({
    data: {
      importJobId,
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      ...(source.bestSellerPosition !== undefined
        ? { position: source.bestSellerPosition }
        : {}),
      externalItemId: source.externalItemId,
      ...(result.offerId ? { offerId: result.offerId } : {}),
      stage,
      status,
      attempts: failure?.attempts ?? (enrichment.linkAttempted ? 1 : 0),
      ...(errorCode ? { errorCode } : {}),
      ...(errorMessage ? { errorMessage } : {}),
      metadata: {
        resolutionStrategy: enrichment.candidate.resolutionStrategy ?? null,
        candidateKind: enrichment.candidate.candidateKind ?? "ITEM",
        selectedCatalogItemId:
          enrichment.candidate.selectedCatalogItemId ?? null,
        selectedSellerId: enrichment.candidate.sellerId ?? null,
        linkGenerated: enrichment.linkGenerated,
        linkReused: enrichment.linkReused,
        ingestionStatus: result.status,
      },
    },
  });
}

async function ingestAffiliateEnrichments(
  enrichments: readonly AffiliateEnrichmentResult[],
  dependencies: DiscoveryDependencies,
  importJobId: string,
  minimumScore:
    number | ((candidate: MercadoLivreDiscoveredCandidate) => number),
  now: Date,
  metrics: MercadoLivreDiscoveryMetrics,
) {
  await mapWithConcurrency(
    enrichments,
    dependencies.affiliateConcurrency,
    async (enrichment) => {
      const candidate: MercadoLivreDiscoveredCandidate = {
        ...enrichment.candidate,
        affiliateUrl: enrichment.affiliateUrl,
        affiliateLabel: enrichment.affiliateLabel,
        affiliateEligibility: enrichment.affiliateEligibility,
        affiliateFailure: enrichment.affiliateFailure,
      };
      const candidateMinimumScore =
        typeof minimumScore === "function"
          ? minimumScore(enrichment.candidate)
          : minimumScore;

      try {
        const result = await dependencies.ingest(candidateInput(candidate), {
          now,
          minScore: candidateMinimumScore,
        });
        recordIngestMetrics(metrics, result);
        await retireReplacedPendingOfferVersions(dependencies.database, result);
        await persistIngestionResultItem(
          dependencies.database,
          importJobId,
          enrichment,
          result,
          metrics,
        );
      } catch {
        metrics.errors += 1;
        metrics.ingestionFailed += 1;
        const source = itemSourceData(enrichment.candidate);

        await dependencies.database.importJobItem.create({
          data: {
            importJobId,
            sourceId: source.sourceId,
            sourceType: source.sourceType,
            ...(source.bestSellerPosition !== undefined
              ? { position: source.bestSellerPosition }
              : {}),
            externalItemId: source.externalItemId,
            stage: "INGESTION",
            status: "FAILED",
            attempts: 1,
            errorCode: "INGESTION_FAILED",
            errorMessage: "Mercado Livre offer ingestion failed.",
            metadata: {
              resolutionStrategy:
                enrichment.candidate.resolutionStrategy ?? null,
              candidateKind: enrichment.candidate.candidateKind ?? "ITEM",
              selectedCatalogItemId:
                enrichment.candidate.selectedCatalogItemId ?? null,
              selectedSellerId: enrichment.candidate.sellerId ?? null,
            },
          },
        });
      }
    },
  );
}

async function enrichCandidatesWithProvider(
  candidates: readonly MercadoLivreDiscoveredCandidate[],
  dependencies: DiscoveryDependencies,
  existingLinks: ReadonlyMap<
    string,
    { affiliateUrl: string; affiliateLabel: string | null }
  >,
  metrics: MercadoLivreDiscoveryMetrics,
) {
  return mapWithConcurrency(
    candidates,
    dependencies.affiliateConcurrency,
    async (candidate): Promise<AffiliateEnrichmentResult> => {
      const existing = existingLinks.get(candidate.externalProductId);

      if (existing) {
        metrics.affiliateLinksReused += 1;
        return {
          candidate,
          affiliateUrl: existing.affiliateUrl,
          affiliateEligibility: "ELIGIBLE",
          affiliateLabel: existing.affiliateLabel,
          affiliateFailure: null,
          linkAttempted: false,
          linkGenerated: false,
          linkReused: true,
        };
      }

      metrics.affiliateLinkAttempts += 1;
      if (candidate.candidateKind === "CATALOG_PRODUCT") {
        metrics.catalogProductPdpAffiliateRequested += 1;
      }
      const generated = await dependencies.affiliateLinkProvider.generate({
        marketplace: candidate.marketplace,
        productUrl: candidate.productUrl,
        externalProductId: candidate.externalProductId,
      });

      if (generated.status === "GENERATED") {
        metrics.affiliateLinksGenerated += 1;
        if (candidate.candidateKind === "CATALOG_PRODUCT") {
          metrics.catalogProductPdpAffiliateGenerated += 1;
        }
        emitOperationalMetric(
          dependencies,
          "mercadolivre_affiliate_link_generated",
          {
            stage: "AFFILIATE_LINK",
            status: "SUCCEEDED",
            count: 1,
          },
        );
        return {
          candidate,
          affiliateUrl: generated.affiliateUrl,
          affiliateEligibility: "ELIGIBLE",
          affiliateLabel: generated.provider,
          affiliateFailure: null,
          linkAttempted: true,
          linkGenerated: true,
          linkReused: false,
        };
      }

      if (generated.status === "INELIGIBLE") {
        metrics.affiliateIneligible += 1;
        if (candidate.candidateKind === "CATALOG_PRODUCT") {
          metrics.catalogProductPdpAffiliateFailed += 1;
        }
        emitOperationalMetric(
          dependencies,
          "mercadolivre_discovery_items_ineligible",
          {
            stage: "AFFILIATE_LINK",
            status: "INELIGIBLE",
            count: 1,
          },
        );
        return {
          candidate,
          affiliateUrl: null,
          affiliateEligibility: "INELIGIBLE",
          affiliateLabel: null,
          affiliateFailure: fixedAffiliateFailure(
            candidate.candidateKind === "CATALOG_PRODUCT"
              ? "PRODUCT_PDP_AFFILIATE_LINK_UNSUPPORTED"
              : "AFFILIATE_LINK_INELIGIBLE",
            generated.reason,
            { productIneligible: true, attempts: 1 },
          ),
          linkAttempted: true,
          linkGenerated: false,
          linkReused: false,
        };
      }

      metrics.affiliatePending += 1;
      if (candidate.candidateKind === "CATALOG_PRODUCT") {
        metrics.catalogProductPdpAffiliateFailed += 1;
      }
      emitOperationalMetric(
        dependencies,
        "mercadolivre_discovery_items_pending_link",
        {
          stage: "AFFILIATE_LINK",
          status: "MANUAL_REQUIRED",
          count: 1,
          errorCode: "MANUAL_REQUIRED",
        },
      );
      return {
        candidate,
        affiliateUrl: null,
        affiliateEligibility: "UNKNOWN",
        affiliateLabel: null,
        affiliateFailure: fixedAffiliateFailure(
          candidate.candidateKind === "CATALOG_PRODUCT"
            ? "PRODUCT_PDP_AFFILIATE_LINK_UNSUPPORTED"
            : "MANUAL_REQUIRED",
          generated.reason,
          { attempts: 1 },
        ),
        linkAttempted: true,
        linkGenerated: false,
        linkReused: false,
      };
    },
  );
}

function importJobTotals(metrics: MercadoLivreDiscoveryMetrics) {
  return {
    totalFound: metrics.candidatesFound,
    totalResolved: metrics.uniqueCandidates,
    totalLinksGenerated: metrics.affiliateLinksGenerated,
    totalReadyToPublish: metrics.readyToPublish,
    totalReadyForAffiliateLink: metrics.readyForAffiliateLink,
    totalIneligible: metrics.affiliateIneligible,
    totalCreated: metrics.newProducts,
    totalUpdated: metrics.updatedOffers,
    totalFailed: metrics.unresolvedCandidates + metrics.ingestionFailed,
  };
}

export class MercadoLivreDiscoveryService {
  private readonly dependencies: DiscoveryDependencies;
  private readonly useConfiguredAffiliateProvider: boolean;

  constructor(dependencies: Partial<DiscoveryDependencies> = {}) {
    this.useConfiguredAffiliateProvider = Boolean(
      dependencies.affiliateLinkProvider,
    );
    this.dependencies = discoveryDependencies(dependencies);
  }

  async run(
    now = new Date(),
    options: MercadoLivreDiscoveryOptions = {},
  ): Promise<MercadoLivreDiscoveryResult> {
    const operationStartedAt = this.dependencies.monotonicNow();
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
      discoveryLockKey(account),
      DISCOVERY_LOCK_TTL_MS,
    );

    if (!lock.acquired) {
      return skippedResult(metrics, "DISCOVERY_ALREADY_RUNNING");
    }
    const stopLockHeartbeat = startLockHeartbeat(lock, DISCOVERY_LOCK_TTL_MS);

    let runId: string | undefined;
    let importJobId: string | undefined;

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
      const categoryIds = jsonStringArray(config.categoryIds);
      const importJob = await this.dependencies.database.importJob.create({
        data: {
          marketplaceAccountId: account.id,
          marketplace: "MERCADO_LIVRE",
          categoryId:
            categoryIds.length === 1 ? (categoryIds[0] ?? null) : null,
          status: "RUNNING",
          source: "MERCADOLIVRE_BEST_SELLERS",
          startedAt: now,
          summary: metrics,
        },
      });
      importJobId = importJob.id;
      emitOperationalMetric(this.dependencies, "mercadolivre_import_created", {
        jobId: importJob.id,
        marketplaceAccountId: account.id,
        stage: "DISCOVERY",
        durationMs: Math.max(
          0,
          this.dependencies.monotonicNow() - operationStartedAt,
        ),
        status: "RUNNING",
        count: 1,
      });
      const connector = await this.dependencies.createConnector();
      const candidates = await discoverCandidatesFromLeafCategories(
        connector,
        categoryIds,
        Math.min(config.maxCandidatesPerCategory, 20),
        metrics,
        {
          onResult: async (result) => {
            if (result.ok) {
              return;
            }

            await this.dependencies.database.importJobItem.create({
              data: {
                importJobId: importJob.id,
                sourceId: result.candidate.id,
                sourceType: result.candidate.type,
                position: result.candidate.position,
                stage: "RESOLUTION",
                status: "FAILED",
                attempts: 1,
                errorCode: result.reason,
                errorMessage: `Mercado Livre highlight could not be resolved: ${result.reason}.`,
                metadata: result.diagnostics ?? {},
              },
            });
          },
        },
      );
      const uniqueCandidates = new Map(
        candidates.map((candidate) => [candidate.externalProductId, candidate]),
      );
      const selectedCandidates = [...uniqueCandidates.values()].filter(
        (candidate) => candidatePassesDiscoveryPolicies(candidate, config),
      );
      const discoveryDurationMs = Math.max(
        0,
        this.dependencies.monotonicNow() - operationStartedAt,
      );
      emitOperationalMetric(
        this.dependencies,
        "mercadolivre_discovery_items_found",
        {
          jobId: importJob.id,
          marketplaceAccountId: account.id,
          stage: "DISCOVERY",
          durationMs: discoveryDurationMs,
          status: "SUCCEEDED",
          count: metrics.candidatesFound,
        },
      );
      emitOperationalMetric(
        this.dependencies,
        "mercadolivre_discovery_items_resolved",
        {
          jobId: importJob.id,
          marketplaceAccountId: account.id,
          stage: "RESOLUTION",
          durationMs: discoveryDurationMs,
          status: "SUCCEEDED",
          count: metrics.uniqueCandidates,
        },
      );
      const existingAffiliateLinks = await existingAffiliateLinksForCandidates(
        this.dependencies.database,
        selectedCandidates,
      );
      let enrichments: AffiliateEnrichmentResult[] = [];

      if (selectedCandidates.length > 0) {
        if (this.useConfiguredAffiliateProvider) {
          enrichments = await enrichCandidatesWithProvider(
            selectedCandidates,
            this.dependencies,
            existingAffiliateLinks,
            metrics,
          );
        } else {
          const affiliateSessionLock = await this.dependencies.lock(
            affiliateOperationLockKey(account.id),
            DISCOVERY_LOCK_TTL_MS,
          );

          if (!affiliateSessionLock.acquired) {
            enrichments = await enrichCandidatesWithProvider(
              selectedCandidates,
              {
                ...this.dependencies,
                affiliateLinkProvider: new ManualAffiliateLinkProvider(
                  "AFFILIATE_SESSION_BUSY",
                ),
              },
              existingAffiliateLinks,
              metrics,
            );
          } else {
            const stopAffiliateLockHeartbeat = startLockHeartbeat(
              affiliateSessionLock,
              DISCOVERY_LOCK_TTL_MS,
            );

            try {
              enrichments = await enrichCandidatesWithAffiliateLinks(
                selectedCandidates,
                this.dependencies,
                account.id,
                importJob.id,
                existingAffiliateLinks,
                metrics,
                now,
              );
            } finally {
              stopAffiliateLockHeartbeat();
              await affiliateSessionLock.release();
            }
          }
        }
      }

      await ingestAffiliateEnrichments(
        enrichments,
        this.dependencies,
        importJob.id,
        config.minimumScore,
        now,
        metrics,
      );

      const hasPartialFailures =
        metrics.errors > 0 ||
        metrics.unresolvedCandidates > 0 ||
        metrics.affiliateIneligible > 0;
      const status = hasPartialFailures ? "PARTIAL" : "SUCCEEDED";
      const issueCount = metrics.errors + metrics.unresolvedCandidates;
      const lastError =
        status === "PARTIAL"
          ? `Discovery completed with ${issueCount} item or operational issue(s).`
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
          data: {
            status: hasPartialFailures ? "PARTIAL" : "SUCCEEDED",
            finishedAt: new Date(),
            metrics,
          },
        }),
        this.dependencies.database.importJob.update({
          where: { id: importJob.id },
          data: {
            status: hasPartialFailures ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED",
            ...importJobTotals(metrics),
            finishedAt: new Date(),
            errorMessage: lastError,
            summary: metrics,
          },
        }),
      ]);
      emitOperationalMetric(this.dependencies, "mercadolivre_import_updated", {
        jobId: importJob.id,
        marketplaceAccountId: account.id,
        stage: "INGESTION",
        durationMs: Math.max(
          0,
          this.dependencies.monotonicNow() - operationStartedAt,
        ),
        status: hasPartialFailures ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED",
        count: 1,
      });

      return {
        ok: true,
        runId: run.id,
        importJobId: importJob.id,
        status,
        metrics,
      };
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
            metadata: {
              stage: "DISCOVERY",
              status: "FAILED",
              errorCode,
            },
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
        ...(importJobId
          ? [
              this.dependencies.database.importJob.update({
                where: { id: importJobId },
                data: {
                  status: "FAILED",
                  ...importJobTotals(metrics),
                  finishedAt: new Date(),
                  summary: metrics,
                  errorMessage,
                },
              }),
            ]
          : []),
      ]);
      if (importJobId) {
        emitOperationalMetric(
          this.dependencies,
          "mercadolivre_import_updated",
          {
            jobId: importJobId,
            marketplaceAccountId: account.id,
            stage: "DISCOVERY",
            durationMs: Math.max(
              0,
              this.dependencies.monotonicNow() - operationStartedAt,
            ),
            status: "FAILED",
            count: 1,
            errorCode,
          },
        );
      }

      return {
        ok: false,
        ...(runId ? { runId } : {}),
        ...(importJobId ? { importJobId } : {}),
        status: "FAILED",
        metrics,
        errorCode,
        errorMessage,
      };
    } finally {
      stopLockHeartbeat();
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

function normalizedPendingLimit(value: number | undefined) {
  if (value === undefined) {
    return 25;
  }

  if (!Number.isFinite(value) || value < 1) {
    return null;
  }

  return Math.min(MAX_PENDING_AFFILIATE_LINKS_PER_RUN, Math.floor(value));
}

function normalizedOfferIds(values: readonly string[] | undefined) {
  if (!values) {
    return [];
  }

  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, MAX_PENDING_AFFILIATE_LINKS_PER_RUN),
    ),
  ];
}

function highlightTypeFromStoredValue(
  value: string | null,
): MarketplaceOfferCandidate["sourceHighlightType"] | undefined {
  return value === "ITEM" ||
    value === "PRODUCT" ||
    value === "USER_PRODUCT" ||
    value === "UNKNOWN"
    ? value
    : undefined;
}

function resolutionStrategyFromStoredValue(
  value: string | null,
): MercadoLivreResolutionStrategy | undefined {
  return value === "ITEM_DIRECT" ||
    value === "HIGHLIGHT_ITEM_DIRECT" ||
    value === "PRODUCT_DIRECT_BUY_BOX" ||
    value === "PRODUCT_CHILD_BUY_BOX" ||
    value === "PRODUCT_ITEMS_FALLBACK" ||
    value === "PRODUCT_CATALOG_PDP_FALLBACK" ||
    value === "USER_PRODUCT_ACTIVE_ITEM"
    ? value
    : undefined;
}

export async function generatePendingMercadoLivreAffiliateLinks(
  input: GeneratePendingMercadoLivreAffiliateLinksInput = {},
  dependencyOverrides: Partial<DiscoveryDependencies> = {},
): Promise<GeneratePendingMercadoLivreAffiliateLinksResult> {
  const limit = normalizedPendingLimit(input.limit);

  if (limit === null) {
    return {
      ok: false,
      status: "FAILED",
      selected: 0,
      processed: 0,
      linksGenerated: 0,
      updated: 0,
      ineligible: 0,
      pending: 0,
      failed: 0,
      errorCode: "INVALID_LIMIT",
      errorMessage: "Pending affiliate link limit must be a positive number.",
    };
  }

  const dependencies = discoveryDependencies(dependencyOverrides);
  const operationStartedAt = dependencies.monotonicNow();
  const account = await dependencies.database.marketplaceAccount.findFirst({
    where: {
      marketplace: "MERCADO_LIVRE",
      enabled: true,
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });

  if (!account) {
    return {
      ok: false,
      status: "FAILED",
      selected: 0,
      processed: 0,
      linksGenerated: 0,
      updated: 0,
      ineligible: 0,
      pending: 0,
      failed: 0,
      errorCode: "MELI_ACCOUNT_NOT_FOUND",
      errorMessage: "Mercado Livre account is not configured.",
    };
  }

  const offerIds = normalizedOfferIds(input.offerIds);
  const pendingOffers = await dependencies.database.offer.findMany({
    where: {
      marketplace: "MERCADO_LIVRE",
      status: "READY_FOR_AFFILIATE_LINK",
      affiliateUrl: null,
      ...(offerIds.length > 0 ? { id: { in: offerIds } } : {}),
    },
    orderBy: { collectedAt: "desc" },
    distinct: ["externalProductId"],
    take: limit,
    select: {
      id: true,
      productId: true,
      externalProductId: true,
      title: true,
      description: true,
      category: true,
      imageUrl: true,
      productUrl: true,
      affiliateLabel: true,
      sellerId: true,
      officialStoreId: true,
      sourceCategoryId: true,
      bestSellerPosition: true,
      sourceHighlightId: true,
      sourceHighlightType: true,
      resolutionStrategy: true,
      trackingStrategy: true,
      originalPrice: true,
      currentPrice: true,
      couponCode: true,
      couponExpiration: true,
      commissionPercentage: true,
      rating: true,
      salesCount: true,
      shippingStatus: true,
      stockStatus: true,
      minimumScoreApplied: true,
    },
  });
  const currentOfferChecks = await mapWithConcurrency(
    pendingOffers,
    dependencies.affiliateConcurrency,
    async (offer) => {
      if (!offer.productId) {
        return offer;
      }

      const current = await dependencies.database.offer.findFirst({
        where: { productId: offer.productId },
        orderBy: { version: "desc" },
        select: { id: true },
      });

      if (current?.id === offer.id) {
        return offer;
      }

      if (!input.dryRun) {
        await dependencies.database.offer.updateMany({
          where: {
            id: offer.id,
            status: "READY_FOR_AFFILIATE_LINK",
            affiliateUrl: null,
          },
          data: {
            status: "REJECTED_DUPLICATE",
            statusReason:
              "Substituida por uma versao mais recente desta oferta.",
          },
        });
      }

      return null;
    },
  );
  const offers = currentOfferChecks.filter(
    (offer): offer is NonNullable<typeof offer> => offer !== null,
  );

  if (input.dryRun) {
    return {
      ok: true,
      status: "DRY_RUN",
      selected: offers.length,
      processed: 0,
      linksGenerated: 0,
      updated: 0,
      ineligible: 0,
      pending: offers.length,
      failed: 0,
    };
  }

  if (offers.length === 0) {
    return {
      ok: true,
      status: "SUCCEEDED",
      selected: 0,
      processed: 0,
      linksGenerated: 0,
      updated: 0,
      ineligible: 0,
      pending: 0,
      failed: 0,
    };
  }

  const lock = await dependencies.lock(
    affiliateOperationLockKey(account.id),
    DISCOVERY_LOCK_TTL_MS,
  );

  if (!lock.acquired) {
    return {
      ok: false,
      status: "FAILED",
      selected: offers.length,
      processed: 0,
      linksGenerated: 0,
      updated: 0,
      ineligible: 0,
      pending: offers.length,
      failed: 0,
      errorCode: "AFFILIATE_ENRICHMENT_ALREADY_RUNNING",
      errorMessage: "Pending affiliate link enrichment is already running.",
    };
  }
  const stopLockHeartbeat = startLockHeartbeat(lock, DISCOVERY_LOCK_TTL_MS);

  const now = new Date();
  const metrics = createMercadoLivreDiscoveryMetrics();
  metrics.candidatesFound = offers.length;
  metrics.resolvedItemCandidates = offers.length;
  metrics.uniqueCandidates = offers.length;
  let importJobId: string | undefined;

  try {
    const importJob = await dependencies.database.importJob.create({
      data: {
        marketplaceAccountId: account.id,
        marketplace: "MERCADO_LIVRE",
        status: "RUNNING",
        source: "MERCADO_LIVRE_PENDING_AFFILIATE_LINKS",
        totalFound: offers.length,
        totalResolved: offers.length,
        startedAt: now,
        summary: metrics,
      },
    });
    importJobId = importJob.id;
    emitOperationalMetric(dependencies, "mercadolivre_import_created", {
      jobId: importJob.id,
      marketplaceAccountId: account.id,
      stage: "AFFILIATE_LINK",
      durationMs: Math.max(0, dependencies.monotonicNow() - operationStartedAt),
      status: "RUNNING",
      count: 1,
    });
    const minimumScores = new Map<string, number>();
    const candidates: MercadoLivreDiscoveredCandidate[] = offers.map(
      (offer) => {
        minimumScores.set(offer.externalProductId, offer.minimumScoreApplied);
        const sourceHighlightType = highlightTypeFromStoredValue(
          offer.sourceHighlightType,
        );
        const resolutionStrategy = resolutionStrategyFromStoredValue(
          offer.resolutionStrategy,
        );

        return {
          marketplace: "MERCADO_LIVRE",
          externalProductId: offer.externalProductId,
          title: offer.title,
          description: offer.description,
          category: offer.category,
          imageUrl: offer.imageUrl,
          productUrl: offer.productUrl,
          affiliateUrl: null,
          affiliateLabel: offer.affiliateLabel,
          affiliateEligibility: "UNKNOWN",
          affiliateFailure: null,
          sellerId: offer.sellerId,
          officialStoreId: offer.officialStoreId,
          ...(offer.sourceCategoryId
            ? { sourceCategoryId: offer.sourceCategoryId }
            : {}),
          ...(offer.bestSellerPosition !== null
            ? { bestSellerPosition: offer.bestSellerPosition }
            : {}),
          ...(offer.sourceHighlightId
            ? { sourceHighlightId: offer.sourceHighlightId }
            : {}),
          ...(sourceHighlightType ? { sourceHighlightType } : {}),
          ...(resolutionStrategy ? { resolutionStrategy } : {}),
          trackingStrategy: offer.trackingStrategy,
          originalPrice: offer.originalPrice
            ? Number(offer.originalPrice)
            : null,
          currentPrice: Number(offer.currentPrice),
          couponCode: offer.couponCode,
          couponExpiration: offer.couponExpiration,
          commissionPercentage: offer.commissionPercentage
            ? Number(offer.commissionPercentage)
            : null,
          rating: offer.rating ? Number(offer.rating) : null,
          salesCount: offer.salesCount,
          shippingStatus: offer.shippingStatus,
          stockStatus: offer.stockStatus,
        };
      },
    );
    const existingAffiliateLinks = await existingAffiliateLinksForCandidates(
      dependencies.database,
      candidates,
    );
    const enrichments = await enrichCandidatesWithAffiliateLinks(
      candidates,
      dependencies,
      account.id,
      importJob.id,
      existingAffiliateLinks,
      metrics,
      now,
    );

    await ingestAffiliateEnrichments(
      enrichments,
      dependencies,
      importJob.id,
      (candidate) => minimumScores.get(candidate.externalProductId) ?? 0,
      now,
      metrics,
    );

    const hasFailures =
      metrics.errors > 0 ||
      metrics.affiliateIneligible > 0 ||
      metrics.affiliatePending > 0;
    const status = hasFailures ? "PARTIAL" : "SUCCEEDED";
    const errorMessage = hasFailures
      ? `Affiliate enrichment completed with ${metrics.errors} item error(s).`
      : null;

    await dependencies.database.importJob.update({
      where: { id: importJob.id },
      data: {
        status: hasFailures ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED",
        ...importJobTotals(metrics),
        finishedAt: new Date(),
        errorMessage,
        summary: metrics,
      },
    });
    emitOperationalMetric(dependencies, "mercadolivre_import_updated", {
      jobId: importJob.id,
      marketplaceAccountId: account.id,
      stage: "AFFILIATE_LINK",
      durationMs: Math.max(0, dependencies.monotonicNow() - operationStartedAt),
      status: hasFailures ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED",
      count: 1,
    });

    return {
      ok: true,
      status,
      importJobId: importJob.id,
      selected: offers.length,
      processed: offers.length,
      linksGenerated: metrics.affiliateLinksGenerated,
      updated: metrics.updatedOffers,
      ineligible: metrics.affiliateIneligible,
      pending: metrics.readyForAffiliateLink,
      failed: metrics.ingestionFailed,
    };
  } catch (error) {
    const errorMessage = sanitizedError(error);

    if (importJobId) {
      await dependencies.database.importJob.update({
        where: { id: importJobId },
        data: {
          status: "FAILED",
          ...importJobTotals(metrics),
          finishedAt: new Date(),
          errorMessage,
          summary: metrics,
        },
      });
      emitOperationalMetric(dependencies, "mercadolivre_import_updated", {
        jobId: importJobId,
        marketplaceAccountId: account.id,
        stage: "AFFILIATE_LINK",
        durationMs: Math.max(
          0,
          dependencies.monotonicNow() - operationStartedAt,
        ),
        status: "FAILED",
        count: 1,
        errorCode: "AFFILIATE_ENRICHMENT_FAILED",
      });
    }

    return {
      ok: false,
      status: "FAILED",
      ...(importJobId ? { importJobId } : {}),
      selected: offers.length,
      processed:
        metrics.readyToPublish +
        metrics.readyForAffiliateLink +
        metrics.rejected,
      linksGenerated: metrics.affiliateLinksGenerated,
      updated: metrics.updatedOffers,
      ineligible: metrics.affiliateIneligible,
      pending: metrics.readyForAffiliateLink,
      failed: metrics.ingestionFailed + 1,
      errorCode: "AFFILIATE_ENRICHMENT_FAILED",
      errorMessage,
    };
  } finally {
    stopLockHeartbeat();
    await lock.release();
  }
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
  selected: number;
  refreshed: number;
  unchanged: number;
  newVersions: number;
  notFound: number;
  affiliateUrlsPreserved: number;
  itemsFetched: number;
  priceApiFetched: number;
  priceFallbackUsed: number;
  priceUnavailable: number;
  failures: Array<{
    externalProductId: string;
    errorMessage: string;
  }>;
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
    selected: 0,
    refreshed: 0,
    unchanged: 0,
    newVersions: 0,
    notFound: 0,
    affiliateUrlsPreserved: 0,
    itemsFetched: 0,
    priceApiFetched: 0,
    priceFallbackUsed: 0,
    priceUnavailable: 0,
    failures: [],
  };
}

type RefreshMercadoLivreOffersDependencies = {
  database: typeof prisma;
  createConnector: () => Promise<MarketplaceConnector>;
  ingest: typeof ingestOffer;
};

export async function refreshMercadoLivreOffers(
  now = new Date(),
  dependencyOverrides: Partial<RefreshMercadoLivreOffersDependencies> = {},
) {
  const dependencies: RefreshMercadoLivreOffersDependencies = {
    database: dependencyOverrides.database ?? prisma,
    createConnector:
      dependencyOverrides.createConnector ?? createMercadoLivreConnector,
    ingest: dependencyOverrides.ingest ?? ingestOffer,
  };
  const metrics = emptyJobMetrics();
  const account = await dependencies.database.marketplaceAccount.findFirst({
    where: { marketplace: "MERCADO_LIVRE", enabled: true, status: "CONNECTED" },
    orderBy: { updatedAt: "desc" },
  });

  if (!account) return metrics;

  const offers = await dependencies.database.offer.findMany({
    where: { marketplace: "MERCADO_LIVRE", status: { notIn: ["PUBLISHED"] } },
    distinct: ["externalProductId"],
    orderBy: { collectedAt: "desc" },
    take: 50,
  });
  metrics.selected = offers.length;

  if (offers.length === 0) return metrics;

  const run = await dependencies.database.automationRun.create({
    data: {
      marketplaceAccountId: account.id,
      name: "mercado-livre-refresh",
      status: "RUNNING",
      idempotencyKey: `mercado-livre-refresh:${now.toISOString()}`,
      startedAt: now,
      metrics,
    },
  });
  const terminalOfferIds = new Set<string>();

  try {
    const connector = await dependencies.createConnector();
    const itemResult = await connector.getItemsWithDiagnostics(
      offers.map((offer) => offer.externalProductId),
    );
    metrics.itemsFetched = itemResult.diagnostics.itemsFetched;
    metrics.priceApiFetched = itemResult.diagnostics.priceApiFetched;
    metrics.priceFallbackUsed = itemResult.diagnostics.priceFallbackUsed;
    metrics.priceUnavailable = itemResult.diagnostics.priceUnavailable;
    const candidateByExternalId = new Map(
      itemResult.candidates.map((candidate) => [
        candidate.externalProductId,
        candidate,
      ]),
    );

    await mapWithConcurrency(
      offers,
      AFFILIATE_BATCH_CONCURRENCY,
      async (currentOffer) => {
        const candidate = candidateByExternalId.get(
          currentOffer.externalProductId,
        );

        if (!candidate) {
          metrics.notFound += 1;
          terminalOfferIds.add(currentOffer.externalProductId);
          return;
        }

        const sourceHighlightType = highlightTypeFromStoredValue(
          currentOffer.sourceHighlightType,
        );
        const resolutionStrategy = resolutionStrategyFromStoredValue(
          currentOffer.resolutionStrategy,
        );
        const enrichedCandidate: MercadoLivreDiscoveredCandidate = {
          ...candidate,
          affiliateUrl: currentOffer.affiliateUrl,
          affiliateLabel: currentOffer.affiliateLabel,
          affiliateEligibility: currentOffer.affiliateEligibility,
          affiliateFailure:
            currentOffer.affiliateFailure as MercadoLivreAffiliateFailure | null,
          trackingStrategy: currentOffer.trackingStrategy,
          ...(currentOffer.sourceCategoryId
            ? { sourceCategoryId: currentOffer.sourceCategoryId }
            : {}),
          ...(currentOffer.bestSellerPosition !== null
            ? { bestSellerPosition: currentOffer.bestSellerPosition }
            : {}),
          ...(currentOffer.sourceHighlightId
            ? { sourceHighlightId: currentOffer.sourceHighlightId }
            : {}),
          ...(sourceHighlightType ? { sourceHighlightType } : {}),
          ...(resolutionStrategy ? { resolutionStrategy } : {}),
        };

        try {
          const result = await dependencies.ingest(
            candidateInput(enrichedCandidate),
            {
              now,
              minScore: currentOffer.minimumScoreApplied,
            },
          );
          metrics.refreshed += 1;

          if (result.offerCreated) {
            metrics.newVersions += 1;
          } else if (result.offerReused) {
            metrics.unchanged += 1;
          }

          if (currentOffer.affiliateUrl) {
            metrics.affiliateUrlsPreserved += 1;
          }
        } catch (error) {
          metrics.failed += 1;
          metrics.failures.push({
            externalProductId: currentOffer.externalProductId,
            errorMessage: sanitizedError(error),
          });
        } finally {
          terminalOfferIds.add(currentOffer.externalProductId);
        }
      },
    );

    await dependencies.database.automationRun.update({
      where: { id: run.id },
      data: {
        status: metrics.failed > 0 ? "PARTIAL" : "SUCCEEDED",
        finishedAt: new Date(),
        metrics,
        errorMessage:
          metrics.failed > 0
            ? `Refresh completed with ${metrics.failed} offer failure(s).`
            : null,
      },
    });
  } catch (error) {
    const errorMessage = sanitizedError(error);

    for (const offer of offers) {
      if (terminalOfferIds.has(offer.externalProductId)) {
        continue;
      }

      metrics.failed += 1;
      metrics.failures.push({
        externalProductId: offer.externalProductId,
        errorMessage,
      });
    }

    await dependencies.database.$transaction([
      dependencies.database.marketplaceAccount.update({
        where: { id: account.id },
        data: { lastErrorAt: new Date(), lastError: errorMessage },
      }),
      dependencies.database.systemAlert.create({
        data: {
          severity: "ERROR",
          source: "mercado-livre.refresh",
          message: alertCodeForMercadoLivreError(error),
          metadata: {
            stage: "REFRESH",
            status: "FAILED",
            errorCode: alertCodeForMercadoLivreError(error),
          },
        },
      }),
      dependencies.database.automationRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          metrics,
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
