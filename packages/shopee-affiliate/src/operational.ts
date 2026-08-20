import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { prisma, Prisma, type PrismaClient } from "@affiliate/database";
import {
  ingestOfferInTransaction,
  type IngestOfferResult,
} from "@affiliate/ingestion";
import {
  collectSelectedShopeeProducts,
  previewShopeeDatafeeds,
} from "./discovery";
import {
  ShopeeOpenApiAffiliateLinkProvider,
  ShopeeOpenApiClient,
  ShopeeOpenApiError,
  sanitizeShopeeSubIds,
} from "./open-api";
import { resolveShopeeAffiliateConfiguration } from "./config";
import type {
  ShopeeAffiliateLinkProvider,
  ShopeeCategoryRule,
  ShopeeDatafeedPreviewResult,
  ShopeeDatafeedProduct,
  ShopeeDiscoveryFilters,
  ShopeeRankedCandidate,
} from "./types";
import {
  validateShopeeGeneratedShortLink,
  validateShopeeProductOrigin,
} from "./validation";

const IMPORT_TYPE = "SHOPEE_DATAFEED_OPERATIONAL";
const ADAPTER_VERSION = "6A.3";

export type ShopeeOperationalWinner = {
  candidate: ShopeeRankedCandidate;
  product: ShopeeDatafeedProduct;
};

export type ShopeeWinnerPersistenceResult = IngestOfferResult & {
  linkStatus: "GENERATED" | "REUSED" | "PENDING";
  errorCode?: string;
};

export interface ShopeeOperationalPersistence {
  findDuplicateImport(checksum: string): Promise<{ id: string } | null>;
  startImport(input: {
    checksum: string;
    totalFound: number;
    source: string;
  }): Promise<{ id: string }>;
  persistWinner(input: {
    jobId: string;
    position: number;
    winner: ShopeeOperationalWinner;
    subIds?: string[];
    now: Date;
  }): Promise<ShopeeWinnerPersistenceResult>;
  recordFailure(input: {
    jobId: string;
    position: number;
    itemId: string;
    errorCode: string;
  }): Promise<void>;
  finishImport(input: {
    jobId: string;
    status: "SUCCEEDED" | "SUCCEEDED_WITH_ERRORS" | "FAILED";
    metrics: ShopeeOperationalMetrics;
    summary: Prisma.InputJsonValue;
  }): Promise<void>;
}

export type ShopeeOperationalMetrics = {
  selected: number;
  created: number;
  updated: number;
  linksGenerated: number;
  linksReused: number;
  readyToPublish: number;
  pendingAffiliateLink: number;
  failed: number;
};

export type ShopeeOperationalImportResult = {
  status:
    "PREVIEW_COMPLETED" | "SUCCEEDED" | "SUCCEEDED_WITH_ERRORS" | "DUPLICATE";
  preview: ShopeeDatafeedPreviewResult;
  importJobId: string | null;
  metrics: ShopeeOperationalMetrics;
  stateModified: boolean;
  publicationsCreated: 0;
  messagesSent: 0;
  autoLinkResult?: ShopeeBulkAffiliateLinkResult;
};

export type ShopeeAffiliateLinkApplicationResult = {
  status: "LINKED" | "ALREADY_LINKED";
  offerId: string;
  itemId: string;
  attempts: 1;
  linkStatus: "GENERATED" | "REUSED" | "EXISTING";
  offerStatus: string;
};

export type ShopeeBulkAffiliateLinkItemResult = {
  offerId: string;
  itemId: string | null;
  status: "LINKED" | "ALREADY_LINKED" | "FAILED" | "NOT_ATTEMPTED";
  attempts: number;
  linkStatus?: "GENERATED" | "REUSED" | "EXISTING";
  errorCode?: string;
};

export type ShopeeBulkAffiliateLinkResult = {
  status: "SUCCEEDED" | "SUCCEEDED_WITH_ERRORS" | "FAILED" | "DRY_RUN";
  source: "IMPORT" | "MANUAL_BULK" | "RETRY";
  requested: number;
  eligible: number;
  attempted: number;
  linked: number;
  alreadyLinked: number;
  failed: number;
  notAttempted: number;
  readyToPublish: number;
  remainingPending: number;
  linksRequested: number;
  linksGenerated: number;
  linksReused: number;
  linksFailed: number;
  linksSkipped: number;
  apiAttempts: number;
  retryAttempts: number;
  durationMs: number;
  externalRequests: number;
  writes: number;
  publicationsCreated: 0;
  messagesSent: 0;
  items: ShopeeBulkAffiliateLinkItemResult[];
};

function safeCode(error: unknown) {
  if (error instanceof ShopeeOpenApiError) return error.code;
  const message = error instanceof Error ? error.message : "";
  return /^SHOPEE_[A-Z0-9_]+$/.test(message)
    ? message
    : "SHOPEE_OPERATIONAL_ITEM_FAILED";
}

function sessionChecksum(preview: ShopeeDatafeedPreviewResult) {
  const stable = {
    files: preview.files.map((file) => file.checksum).sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export async function loadRecentShopeeItemIds(input: {
  database?: PrismaClient;
  now?: Date;
  windowDays: number;
}) {
  if (input.windowDays <= 0) return [];
  const database = input.database ?? prisma;
  const since = new Date(
    (input.now ?? new Date()).getTime() - input.windowDays * 86_400_000,
  );
  const rows = await database.importJobItem.findMany({
    where: {
      createdAt: { gte: since },
      sourceId: { not: null },
      status: { not: "FAILED" },
      importJob: { marketplace: "SHOPEE", importType: IMPORT_TYPE },
    },
    distinct: ["sourceId"],
    select: { sourceId: true },
  });
  return rows.flatMap((row) => (row.sourceId ? [row.sourceId] : []));
}

export type ShopeeOperationalOfferState = {
  offerCounts: { pending: number; ready: number };
  pendingOffers: Array<{
    id: string;
    title: string;
    externalProductId: string;
    statusReason: string | null;
  }>;
};

export async function loadShopeeOperationalOfferState(
  database: PrismaClient = prisma,
): Promise<ShopeeOperationalOfferState> {
  const versions = await database.offer.findMany({
    where: { marketplace: "SHOPEE" },
    orderBy: [{ externalProductId: "asc" }, { version: "desc" }],
    select: {
      id: true,
      title: true,
      externalProductId: true,
      status: true,
      statusReason: true,
      updatedAt: true,
    },
  });
  const currentByItem = new Map<string, (typeof versions)[number]>();
  for (const version of versions) {
    if (!currentByItem.has(version.externalProductId)) {
      currentByItem.set(version.externalProductId, version);
    }
  }
  const current = [...currentByItem.values()];
  return {
    offerCounts: {
      pending: current.filter(
        (offer) => offer.status === "READY_FOR_AFFILIATE_LINK",
      ).length,
      ready: current.filter((offer) => offer.status === "READY_TO_PUBLISH")
        .length,
    },
    pendingOffers: current
      .filter((offer) => offer.status === "READY_FOR_AFFILIATE_LINK")
      .sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
      )
      .slice(0, 20)
      .map(({ id, title, externalProductId, statusReason }) => ({
        id,
        title,
        externalProductId,
        statusReason,
      })),
  };
}

function attributionLabel(
  originUrl: string,
  subIds: readonly string[] | undefined,
) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ originUrl, subIds: subIds ?? [] }))
    .digest("hex")
    .slice(0, 24);
  return `SHOPEE_OPEN_API:${digest}`;
}

function offerInput(
  winner: ShopeeOperationalWinner,
  input: { affiliateUrl?: string; affiliateLabel?: string },
) {
  const { product, candidate } = winner;
  return {
    marketplace: "SHOPEE" as const,
    externalProductId: product.itemId,
    title: product.title,
    ...(product.description ? { description: product.description } : {}),
    category: candidate.category,
    ...(product.category1Id ? { sourceCategoryId: product.category1Id } : {}),
    ...(product.imageUrl ? { imageUrl: product.imageUrl } : {}),
    productUrl: product.sourceProductUrl,
    ...(input.affiliateUrl ? { affiliateUrl: input.affiliateUrl } : {}),
    ...(input.affiliateLabel ? { affiliateLabel: input.affiliateLabel } : {}),
    affiliateEligibility: "ELIGIBLE" as const,
    trackingStrategy: "INTERNAL_REDIRECT" as const,
    ...(product.originalPrice !== null
      ? { originalPrice: product.originalPrice }
      : {}),
    currentPrice: product.salePrice,
    ...(product.itemRating !== null ? { rating: product.itemRating } : {}),
    shippingStatus: "UNKNOWN" as const,
    stockStatus: "UNKNOWN" as const,
  };
}

async function reusableAffiliateUrl(
  tx: Prisma.TransactionClient,
  winner: ShopeeOperationalWinner,
  label: string,
) {
  const existing = await tx.offer.findFirst({
    where: {
      marketplace: "SHOPEE",
      externalProductId: winner.product.itemId,
      productUrl: winner.product.sourceProductUrl,
      affiliateLabel: label,
      affiliateUrl: { not: null },
      affiliateLinks: { some: { active: true } },
    },
    orderBy: { version: "desc" },
    select: { affiliateUrl: true },
  });
  if (!existing?.affiliateUrl) return null;
  const validated = validateShopeeGeneratedShortLink(existing.affiliateUrl);
  return validated.ok ? validated.normalizedUrl : null;
}

export function createPrismaShopeeOperationalPersistence(
  database: PrismaClient = prisma,
): ShopeeOperationalPersistence {
  return {
    findDuplicateImport(checksum) {
      return database.importJob.findFirst({
        where: {
          marketplace: "SHOPEE",
          importType: IMPORT_TYPE,
          fileChecksum: checksum,
          status: { in: ["SUCCEEDED", "SUCCEEDED_WITH_ERRORS"] },
        },
        select: { id: true },
      });
    },
    startImport(input) {
      return database.importJob.create({
        data: {
          marketplace: "SHOPEE",
          importType: IMPORT_TYPE,
          fileChecksum: input.checksum,
          adapterVersion: ADAPTER_VERSION,
          status: "RUNNING",
          source: input.source,
          totalFound: input.totalFound,
          startedAt: new Date(),
        },
        select: { id: true },
      });
    },
    async persistWinner(input) {
      return database.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shopee:${input.winner.product.itemId}`}))`;
        const origin = validateShopeeProductOrigin(
          input.winner.product.sourceProductUrl,
          input.winner.product.itemId,
        );
        if (!origin.ok) throw new ShopeeOpenApiError(origin.code);
        const subIds = sanitizeShopeeSubIds(input.subIds);
        const label = attributionLabel(origin.normalizedUrl, subIds);
        const reused = await reusableAffiliateUrl(tx, input.winner, label);
        const affiliateUrl = reused;
        const linkStatus: ShopeeWinnerPersistenceResult["linkStatus"] = reused
          ? "REUSED"
          : "PENDING";
        let pendingResult: IngestOfferResult | null = null;

        if (!reused) {
          pendingResult = await ingestOfferInTransaction(
            tx,
            offerInput(input.winner, {}),
            {
              now: input.now,
              minScore: 0,
            },
          );
        }

        const result = affiliateUrl
          ? await ingestOfferInTransaction(
              tx,
              offerInput(input.winner, {
                affiliateUrl,
                affiliateLabel: label,
              }),
              { now: input.now, minScore: 70 },
            )
          : (pendingResult ??
            (await ingestOfferInTransaction(tx, offerInput(input.winner, {}), {
              now: input.now,
              minScore: 0,
            })));
        await tx.importJobItem.create({
          data: {
            importJobId: input.jobId,
            sourceId: input.winner.product.itemId,
            sourceType: input.winner.product.sources.join("+"),
            position: input.position,
            externalItemId: input.winner.product.itemId,
            productId: result.productId ?? null,
            offerId: result.offerId ?? null,
            stage: "AFFILIATE_LINK",
            status: affiliateUrl
              ? result.status === "READY_TO_PUBLISH"
                ? "SUCCEEDED"
                : "INELIGIBLE"
              : "PENDING_AFFILIATE_LINK",
            attempts: 0,
            metadata: {
              category: input.winner.candidate.category,
              score: input.winner.candidate.score,
              linkStatus,
              offerStatus: result.status,
            },
          },
        });
        return { ...result, linkStatus };
      });
    },
    async finishImport(input) {
      await database.importJob.update({
        where: { id: input.jobId },
        data: {
          status: input.status,
          totalResolved: input.metrics.selected - input.metrics.failed,
          totalCreated: input.metrics.created,
          totalUpdated: input.metrics.updated,
          totalLinksGenerated: input.metrics.linksGenerated,
          totalReadyToPublish: input.metrics.readyToPublish,
          totalReadyForAffiliateLink: input.metrics.pendingAffiliateLink,
          totalFailed: input.metrics.failed,
          summary: input.summary,
          finishedAt: new Date(),
        },
      });
    },
    async recordFailure(input) {
      await database.importJobItem.create({
        data: {
          importJobId: input.jobId,
          sourceId: input.itemId,
          sourceType: "DATAFEED",
          position: input.position,
          externalItemId: input.itemId,
          stage: "PERSISTENCE",
          status: "FAILED",
          attempts: 1,
          errorCode: input.errorCode,
          errorMessage: input.errorCode,
        },
      });
    },
  };
}

export function createShopeeOpenApiProviderFromEnvironment(
  environment: NodeJS.ProcessEnv,
) {
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  if (!configuration.openApiReady) return undefined;
  const appId = environment.SHOPEE_OPEN_API_APP_ID?.trim();
  const secret = environment.SHOPEE_OPEN_API_SECRET?.trim();
  if (!appId || !secret) return undefined;
  return new ShopeeOpenApiAffiliateLinkProvider(
    new ShopeeOpenApiClient(
      { appId, secret },
      {
        timeoutMs: configuration.openApiTimeoutMs,
        rateLimitPerHour: configuration.openApiRateLimitPerHour,
      },
    ),
  );
}

export async function importShopeeOperationalOffers(input: {
  files: string[];
  confirmImport: boolean;
  environment?: NodeJS.ProcessEnv;
  categories?: ShopeeCategoryRule[];
  filters?: Partial<ShopeeDiscoveryFilters>;
  subIds?: string[];
  now?: Date;
  persistence?: ShopeeOperationalPersistence;
  linkProvider?: ShopeeAffiliateLinkProvider;
  recentItemIds?: string[];
  bulkLinker?: typeof generateShopeeAffiliateLinksBulk;
}): Promise<ShopeeOperationalImportResult> {
  const environment = input.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  if (
    !configuration.enabled ||
    !["DATAFEED", "HYBRID"].includes(configuration.mode)
  ) {
    throw new ShopeeOpenApiError("SHOPEE_DATAFEED_MODE_REQUIRED");
  }
  const recentItemIds =
    input.recentItemIds ??
    (input.persistence
      ? []
      : await loadRecentShopeeItemIds({
          windowDays: configuration.recentSelectionWindowDays,
          ...(input.now ? { now: input.now } : {}),
        }));
  const preview = await previewShopeeDatafeeds({
    files: input.files,
    environment,
    ...(input.categories ? { categories: input.categories } : {}),
    ...(input.filters ? { filters: input.filters } : {}),
    maxTotal: 12,
    recentItemIds,
    maxPerShop: configuration.maxPerShopPerSession,
  });
  const emptyMetrics: ShopeeOperationalMetrics = {
    selected: preview.selected.length,
    created: 0,
    updated: 0,
    linksGenerated: 0,
    linksReused: 0,
    readyToPublish: 0,
    pendingAffiliateLink: 0,
    failed: 0,
  };
  if (!input.confirmImport) {
    return {
      status: "PREVIEW_COMPLETED",
      preview,
      importJobId: null,
      metrics: emptyMetrics,
      stateModified: false,
      publicationsCreated: 0,
      messagesSent: 0,
    };
  }
  const persistence =
    input.persistence ?? createPrismaShopeeOperationalPersistence();
  const checksum = sessionChecksum(preview);
  const duplicate = await persistence.findDuplicateImport(checksum);
  if (duplicate) {
    return {
      status: "DUPLICATE",
      preview,
      importJobId: duplicate.id,
      metrics: emptyMetrics,
      stateModified: false,
      publicationsCreated: 0,
      messagesSent: 0,
    };
  }
  const job = await persistence.startImport({
    checksum,
    totalFound: preview.selected.length,
    source: preview.files.map((file) => file.name).join("+"),
  });
  const metrics = { ...emptyMetrics };
  let winners: ShopeeOperationalWinner[];
  try {
    winners = await collectSelectedShopeeProducts({
      files: input.files,
      selected: preview.selected,
      environment,
    });
  } catch (error) {
    metrics.failed = metrics.selected;
    await persistence.finishImport({
      jobId: job.id,
      status: "FAILED",
      metrics,
      summary: {
        errorCode: safeCode(error),
        publicationsCreated: 0,
        messagesSent: 0,
      },
    });
    throw error;
  }
  const persistedOfferIds: string[] = [];
  for (const [index, winner] of winners.entries()) {
    try {
      const result = await persistence.persistWinner({
        jobId: job.id,
        position: index + 1,
        winner,
        ...(input.subIds ? { subIds: input.subIds } : {}),
        now: input.now ?? new Date(),
      });
      if (result.offerId) persistedOfferIds.push(result.offerId);
      if (result.productCreated || result.offerCreated) metrics.created += 1;
      else if (result.offerUpdated) metrics.updated += 1;
      if (result.linkStatus === "GENERATED") metrics.linksGenerated += 1;
      if (result.linkStatus === "REUSED") metrics.linksReused += 1;
      if (result.status === "READY_TO_PUBLISH") metrics.readyToPublish += 1;
      else if (result.status === "READY_FOR_AFFILIATE_LINK") {
        metrics.pendingAffiliateLink += 1;
      } else {
        metrics.failed += 1;
      }
    } catch (error) {
      metrics.failed += 1;
      await persistence.recordFailure({
        jobId: job.id,
        position: index + 1,
        itemId: winner.product.itemId,
        errorCode: safeCode(error),
      });
    }
  }
  const resolvedIds = new Set(winners.map((winner) => winner.product.itemId));
  const unresolved = preview.selected.filter(
    (candidate) => !resolvedIds.has(candidate.itemId),
  );
  for (const candidate of unresolved) {
    metrics.failed += 1;
    await persistence.recordFailure({
      jobId: job.id,
      position:
        preview.selected.findIndex((item) => item.itemId === candidate.itemId) +
        1,
      itemId: candidate.itemId,
      errorCode: "SHOPEE_SELECTED_ITEM_NOT_RESOLVED",
    });
  }
  let autoLinkResult: ShopeeBulkAffiliateLinkResult | undefined;
  if (
    configuration.autoLinkAfterImport &&
    configuration.mode === "HYBRID" &&
    configuration.openApiReady &&
    persistedOfferIds.length > 0
  ) {
    try {
      const bulkLinker = input.bulkLinker ?? generateShopeeAffiliateLinksBulk;
      autoLinkResult = await bulkLinker({
        offerIds: persistedOfferIds,
        maxItems: configuration.autoLinkMaxPerRun,
        source: "IMPORT",
        confirmGenerate: true,
        subIds: input.subIds ?? ["sourcedatafeed", "autolink"],
        environment,
        ...(input.linkProvider ? { linkProvider: input.linkProvider } : {}),
      });
      metrics.linksGenerated += autoLinkResult.linksGenerated;
      metrics.linksReused += autoLinkResult.linksReused;
      metrics.readyToPublish += autoLinkResult.linked;
      metrics.pendingAffiliateLink = Math.max(
        0,
        metrics.pendingAffiliateLink - autoLinkResult.linked,
      );
    } catch {
      // The committed import remains valid and keeps its manual-link fallback.
    }
  }
  const status =
    metrics.failed || metrics.pendingAffiliateLink
      ? "SUCCEEDED_WITH_ERRORS"
      : "SUCCEEDED";
  await persistence.finishImport({
    jobId: job.id,
    status,
    metrics,
    summary: {
      selectedItemIds: preview.selected.map((item) => item.itemId),
      openApiConfigured: configuration.openApiConfigured,
      openApiReady: configuration.openApiReady,
      autoLink: autoLinkResult
        ? {
            status: autoLinkResult.status,
            requested: autoLinkResult.requested,
            linked: autoLinkResult.linked,
            alreadyLinked: autoLinkResult.alreadyLinked,
            failed: autoLinkResult.failed,
            notAttempted: autoLinkResult.notAttempted,
            apiAttempts: autoLinkResult.apiAttempts,
          }
        : null,
      publicationsCreated: 0,
      messagesSent: 0,
    },
  });
  return {
    status,
    preview,
    importJobId: job.id,
    metrics,
    stateModified: true,
    publicationsCreated: 0,
    messagesSent: 0,
    ...(autoLinkResult ? { autoLinkResult } : {}),
  };
}

function winnerFromOffer(offer: {
  externalProductId: string;
  title: string;
  description: string | null;
  category: string | null;
  sourceCategoryId: string | null;
  imageUrl: string | null;
  productUrl: string;
  originalPrice: Prisma.Decimal | null;
  currentPrice: Prisma.Decimal;
  discountPercentage: Prisma.Decimal | null;
  rating: Prisma.Decimal | null;
}): ShopeeOperationalWinner {
  const category = (offer.category ??
    "CASA") as ShopeeRankedCandidate["category"];
  return {
    product: {
      itemId: offer.externalProductId,
      title: offer.title,
      description: offer.description,
      originalPrice: offer.originalPrice ? Number(offer.originalPrice) : null,
      salePrice: Number(offer.currentPrice),
      discountPercentage: offer.discountPercentage
        ? Number(offer.discountPercentage)
        : null,
      itemRating: offer.rating ? Number(offer.rating) : null,
      shopRating: null,
      likeCount: null,
      condition: null,
      crossBorder: null,
      category1: category,
      category1Id: offer.sourceCategoryId,
      category2: null,
      category2Id: null,
      category3: null,
      category3Id: null,
      shopName: null,
      imageUrl: offer.imageUrl ?? "",
      secondaryImageUrl: null,
      sourceProductUrl: offer.productUrl,
      candidateAffiliateUrl: null,
      verifiedAffiliateUrl: null,
      modelIds: null,
      modelNames: null,
      commissionAvailable: false,
      salesCountAvailable: false,
      source: "OFFICIAL_BR",
      sources: ["OFFICIAL_BR"],
    },
    candidate: {
      itemId: offer.externalProductId,
      title: offer.title,
      category,
      salePrice: Number(offer.currentPrice),
      originalPrice: offer.originalPrice ? Number(offer.originalPrice) : null,
      discountPercentage: offer.discountPercentage
        ? Number(offer.discountPercentage)
        : null,
      itemRating: offer.rating ? Number(offer.rating) : null,
      shopRating: null,
      imageUrl: offer.imageUrl ?? "",
      sourceProductHost: "shopee.com.br",
      candidateLinkHost: null,
      linkStatus: "MISSING",
      score: 0,
      components: {
        discountScore: null,
        itemRatingScore: null,
        shopRatingScore: null,
        likeScore: null,
        completenessScore: 0,
        diversityPenalty: 0,
      },
      sources: ["OFFICIAL_BR"],
    },
  };
}

const affiliateLinkOfferSelect = {
  id: true,
  marketplace: true,
  externalProductId: true,
  title: true,
  description: true,
  category: true,
  sourceCategoryId: true,
  imageUrl: true,
  productUrl: true,
  affiliateUrl: true,
  originalPrice: true,
  currentPrice: true,
  discountPercentage: true,
  rating: true,
  status: true,
  version: true,
} satisfies Prisma.OfferSelect;

export async function generateAndApplyShopeeAffiliateLink(input: {
  offerId: string;
  subIds?: string[];
  environment?: NodeJS.ProcessEnv;
  linkProvider?: ShopeeAffiliateLinkProvider;
  database?: PrismaClient;
  now?: Date;
}): Promise<ShopeeAffiliateLinkApplicationResult> {
  const environment = input.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  if (!input.linkProvider && !configuration.openApiReady) {
    throw new ShopeeOpenApiError("SHOPEE_OPEN_API_NOT_READY");
  }
  const subIds = sanitizeShopeeSubIds(input.subIds);
  const provider =
    input.linkProvider ??
    createShopeeOpenApiProviderFromEnvironment(environment);
  if (!provider) throw new ShopeeOpenApiError("SHOPEE_OPEN_API_NOT_READY");
  const database = input.database ?? prisma;
  const requested = await database.offer.findUnique({
    where: { id: input.offerId },
    select: { marketplace: true, externalProductId: true },
  });
  if (!requested || requested.marketplace !== "SHOPEE") {
    throw new ShopeeOpenApiError("SHOPEE_OFFER_NOT_FOUND");
  }
  const current = await database.offer.findFirst({
    where: {
      marketplace: "SHOPEE",
      externalProductId: requested.externalProductId,
    },
    orderBy: { version: "desc" },
    select: affiliateLinkOfferSelect,
  });
  if (!current) throw new ShopeeOpenApiError("SHOPEE_OFFER_NOT_FOUND");
  if (
    current.status === "READY_TO_PUBLISH" &&
    current.affiliateUrl &&
    validateShopeeGeneratedShortLink(current.affiliateUrl).ok
  ) {
    return {
      status: "ALREADY_LINKED",
      offerId: current.id,
      itemId: current.externalProductId,
      attempts: 1,
      linkStatus: "EXISTING",
      offerStatus: current.status,
    };
  }
  if (current.status !== "READY_FOR_AFFILIATE_LINK") {
    throw new ShopeeOpenApiError("SHOPEE_OFFER_NOT_ELIGIBLE");
  }
  const winner = winnerFromOffer(current);
  const origin = validateShopeeProductOrigin(
    current.productUrl,
    current.externalProductId,
  );
  if (!origin.ok) throw new ShopeeOpenApiError(origin.code);
  const label = attributionLabel(origin.normalizedUrl, subIds);
  const reusable = await database.$transaction((tx) =>
    reusableAffiliateUrl(tx, winner, label),
  );
  let resolvedUrl = reusable;
  let linkStatus: ShopeeAffiliateLinkApplicationResult["linkStatus"] = reusable
    ? "REUSED"
    : "GENERATED";
  if (!resolvedUrl) {
    const generated = await provider.resolve(
      winner.product,
      subIds ? { subIds } : undefined,
    );
    if (generated.status !== "VERIFIED") {
      throw new ShopeeOpenApiError(generated.reason);
    }
    resolvedUrl = generated.affiliateUrl;
  }
  const validated = validateShopeeGeneratedShortLink(resolvedUrl);
  if (!validated.ok) throw new ShopeeOpenApiError(validated.code);

  return database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shopee:${current.externalProductId}`}))`;
    const latest = await tx.offer.findFirst({
      where: {
        marketplace: "SHOPEE",
        externalProductId: current.externalProductId,
      },
      orderBy: { version: "desc" },
      select: affiliateLinkOfferSelect,
    });
    if (!latest) throw new ShopeeOpenApiError("SHOPEE_OFFER_NOT_FOUND");
    if (
      latest.status === "READY_TO_PUBLISH" &&
      latest.affiliateUrl &&
      validateShopeeGeneratedShortLink(latest.affiliateUrl).ok
    ) {
      return {
        status: "ALREADY_LINKED",
        offerId: latest.id,
        itemId: latest.externalProductId,
        attempts: 1,
        linkStatus: "EXISTING",
        offerStatus: latest.status,
      };
    }
    if (latest.status !== "READY_FOR_AFFILIATE_LINK") {
      throw new ShopeeOpenApiError("SHOPEE_OFFER_NOT_ELIGIBLE");
    }
    const latestWinner = winnerFromOffer(latest);
    const racedReusable = await reusableAffiliateUrl(tx, latestWinner, label);
    if (racedReusable) {
      resolvedUrl = racedReusable;
      linkStatus = "REUSED";
    }
    if (!resolvedUrl) {
      throw new ShopeeOpenApiError("SHOPEE_OPEN_API_SHORT_LINK_MISSING");
    }
    const result = await ingestOfferInTransaction(
      tx,
      offerInput(latestWinner, {
        affiliateUrl: resolvedUrl,
        affiliateLabel: label,
      }),
      { now: input.now ?? new Date(), minScore: 70 },
    );
    if (result.status !== "READY_TO_PUBLISH") {
      throw new ShopeeOpenApiError("SHOPEE_AFFILIATE_LINK_APPLICATION_FAILED");
    }
    return {
      status: "LINKED",
      offerId: result.offerId ?? latest.id,
      itemId: latest.externalProductId,
      attempts: 1,
      linkStatus,
      offerStatus: result.status,
    };
  });
}

export async function retryShopeeAffiliateLink(
  input: Parameters<typeof generateAndApplyShopeeAffiliateLink>[0],
) {
  return generateAndApplyShopeeAffiliateLink(input);
}

type ShopeeBulkOfferCandidate = {
  id: string;
  marketplace: string;
  externalProductId: string;
  productUrl: string;
  affiliateUrl: string | null;
  status: string;
  version: number;
};

const GLOBAL_BULK_ERROR_CODES = new Set([
  "SHOPEE_OPEN_API_AUTHENTICATION_FAILED",
  "SHOPEE_OPEN_API_CREDENTIALS_MISSING",
  "SHOPEE_OPEN_API_LOCAL_RATE_LIMITED",
  "SHOPEE_OPEN_API_NOT_READY",
  "SHOPEE_OPEN_API_RATE_LIMITED",
  "SHOPEE_OPEN_API_SYSTEM_ERROR",
  "SHOPEE_AFFILIATE_CONFIGURATION_INVALID",
]);

const RETRYABLE_BULK_ERROR_CODES = new Set([
  "SHOPEE_OPEN_API_TIMEOUT",
  "SHOPEE_OPEN_API_REQUEST_FAILED",
  "SHOPEE_OPEN_API_HTTP_ERROR",
  "SHOPEE_OPEN_API_RATE_LIMITED",
  "SHOPEE_OPEN_API_SYSTEM_ERROR",
]);

const NO_REQUEST_ERROR_CODES = new Set([
  "SHOPEE_SUB_ID_INVALID",
  "SHOPEE_SUB_IDS_LIMIT_EXCEEDED",
  "SHOPEE_ORIGIN_URL_INVALID",
  "SHOPEE_ORIGIN_ITEM_ID_INVALID",
  "SHOPEE_ORIGIN_ITEM_ID_MISMATCH",
  "SHOPEE_ORIGIN_ITEM_ID_REQUIRED",
  "SHOPEE_OFFER_NOT_ELIGIBLE",
  "SHOPEE_OFFER_NOT_FOUND",
  "SHOPEE_OPEN_API_LOCAL_RATE_LIMITED",
]);

function isRetryableBulkError(error: unknown, code: string) {
  if (code === "SHOPEE_OPEN_API_LOCAL_RATE_LIMITED") return false;
  return (
    (error instanceof ShopeeOpenApiError && error.retryable) ||
    RETRYABLE_BULK_ERROR_CODES.has(code)
  );
}

async function loadShopeeBulkOffers(
  database: PrismaClient,
  offerIds: readonly string[] | undefined,
) {
  const rows = await database.offer.findMany({
    where: offerIds?.length
      ? { id: { in: [...offerIds] } }
      : { marketplace: "SHOPEE" },
    orderBy: [{ externalProductId: "asc" }, { version: "desc" }],
    select: {
      id: true,
      marketplace: true,
      externalProductId: true,
      productUrl: true,
      affiliateUrl: true,
      status: true,
      version: true,
    },
  });
  if (offerIds?.length) {
    const byId = new Map(rows.map((offer) => [offer.id, offer]));
    return offerIds.flatMap((id) => {
      const offer = byId.get(id);
      return offer ? [offer] : [];
    });
  }
  const current = new Map<string, (typeof rows)[number]>();
  for (const offer of rows) {
    if (!current.has(offer.externalProductId)) {
      current.set(offer.externalProductId, offer);
    }
  }
  return [...current.values()]
    .filter((offer) => offer.status === "READY_FOR_AFFILIATE_LINK")
    .sort((left, right) => left.id.localeCompare(right.id));
}

function emptyBulkResult(input: {
  source: ShopeeBulkAffiliateLinkResult["source"];
  status: ShopeeBulkAffiliateLinkResult["status"];
  requested: number;
  eligible: number;
  durationMs: number;
  items?: ShopeeBulkAffiliateLinkItemResult[];
}): ShopeeBulkAffiliateLinkResult {
  const items = input.items ?? [];
  return {
    status: input.status,
    source: input.source,
    requested: input.requested,
    eligible: input.eligible,
    attempted: 0,
    linked: 0,
    alreadyLinked: 0,
    failed: 0,
    notAttempted: items.filter((item) => item.status === "NOT_ATTEMPTED")
      .length,
    readyToPublish: 0,
    remainingPending: input.eligible,
    linksRequested: input.eligible,
    linksGenerated: 0,
    linksReused: 0,
    linksFailed: 0,
    linksSkipped: items.length,
    apiAttempts: 0,
    retryAttempts: 0,
    durationMs: input.durationMs,
    externalRequests: 0,
    writes: 0,
    publicationsCreated: 0,
    messagesSent: 0,
    items,
  };
}

export async function generateShopeeAffiliateLinksBulk(input: {
  offerIds?: string[];
  maxItems?: number;
  source: ShopeeBulkAffiliateLinkResult["source"];
  confirmGenerate: boolean;
  dryRun?: boolean;
  subIds?: string[];
  environment?: NodeJS.ProcessEnv;
  database?: PrismaClient;
  linkProvider?: ShopeeAffiliateLinkProvider;
  dependencies?: {
    loadOffers?: () => Promise<ShopeeBulkOfferCandidate[]>;
    applyLink?: typeof generateAndApplyShopeeAffiliateLink;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
  };
}): Promise<ShopeeBulkAffiliateLinkResult> {
  if (!input.confirmGenerate && !input.dryRun) {
    throw new ShopeeOpenApiError("SHOPEE_BULK_LINK_NOT_CONFIRMED");
  }
  const environment = input.environment ?? process.env;
  const configuration = resolveShopeeAffiliateConfiguration(environment);
  const maxItems = input.maxItems ?? configuration.autoLinkMaxPerRun;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 12) {
    throw new ShopeeOpenApiError("SHOPEE_BULK_LINK_MAX_INVALID");
  }
  const offerIds = input.offerIds
    ? [...new Set(input.offerIds.map((id) => id.trim()).filter(Boolean))]
    : undefined;
  if (offerIds && offerIds.length > maxItems) {
    throw new ShopeeOpenApiError("SHOPEE_BULK_LINK_MAX_EXCEEDED");
  }
  const now = input.dependencies?.now ?? Date.now;
  const startedAt = now();
  const database = input.database ?? prisma;
  const loaded = input.dependencies?.loadOffers
    ? await input.dependencies.loadOffers()
    : await loadShopeeBulkOffers(database, offerIds);
  const loadedById = new Map(loaded.map((offer) => [offer.id, offer]));
  const candidates = offerIds
    ? offerIds.map(
        (id) =>
          loadedById.get(id) ?? {
            id,
            marketplace: "",
            externalProductId: "",
            productUrl: "",
            affiliateUrl: null,
            status: "NOT_FOUND",
            version: 0,
          },
      )
    : [...loaded].sort((left, right) => left.id.localeCompare(right.id));
  const offers = candidates.slice(0, maxItems);
  const requested = offerIds?.length ?? offers.length;
  const eligible = offers.filter(
    (offer) =>
      offer.marketplace === "SHOPEE" &&
      offer.status === "READY_FOR_AFFILIATE_LINK",
  );
  if (input.dryRun) {
    return emptyBulkResult({
      source: input.source,
      status: "DRY_RUN",
      requested,
      eligible: eligible.length,
      durationMs: Math.max(0, now() - startedAt),
      items: eligible.map((offer) => ({
        offerId: offer.id,
        itemId: offer.externalProductId || null,
        status: "NOT_ATTEMPTED",
        attempts: 0,
        errorCode: "SHOPEE_BULK_LINK_DRY_RUN",
      })),
    });
  }
  if (
    !configuration.configurationValid ||
    configuration.mode !== "HYBRID" ||
    !configuration.openApiReady
  ) {
    const errorCode = !configuration.configurationValid
      ? "SHOPEE_AFFILIATE_CONFIGURATION_INVALID"
      : "SHOPEE_OPEN_API_NOT_READY";
    return emptyBulkResult({
      source: input.source,
      status: "FAILED",
      requested,
      eligible: eligible.length,
      durationMs: Math.max(0, now() - startedAt),
      items: eligible.map((offer) => ({
        offerId: offer.id,
        itemId: offer.externalProductId || null,
        status: "NOT_ATTEMPTED",
        attempts: 0,
        errorCode,
      })),
    });
  }
  const provider =
    input.linkProvider ??
    createShopeeOpenApiProviderFromEnvironment(environment);
  if (!provider) throw new ShopeeOpenApiError("SHOPEE_OPEN_API_NOT_READY");
  const applyLink =
    input.dependencies?.applyLink ?? generateAndApplyShopeeAffiliateLink;
  const sleep =
    input.dependencies?.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const items: ShopeeBulkAffiliateLinkItemResult[] = [];
  let apiAttempts = 0;
  let retryAttempts = 0;
  let globalFailure: string | null = null;

  for (const offer of offers) {
    if (globalFailure) {
      items.push({
        offerId: offer.id,
        itemId: offer.externalProductId || null,
        status: "NOT_ATTEMPTED",
        attempts: 0,
        errorCode: "SHOPEE_BULK_LINK_GLOBAL_FAILURE",
      });
      continue;
    }
    if (offer.marketplace !== "SHOPEE") {
      items.push({
        offerId: offer.id,
        itemId: offer.externalProductId || null,
        status: "FAILED",
        attempts: 0,
        errorCode: "SHOPEE_OFFER_NOT_ELIGIBLE",
      });
      continue;
    }
    if (
      offer.status === "READY_TO_PUBLISH" &&
      offer.affiliateUrl &&
      validateShopeeGeneratedShortLink(offer.affiliateUrl).ok
    ) {
      items.push({
        offerId: offer.id,
        itemId: offer.externalProductId || null,
        status: "ALREADY_LINKED",
        attempts: 0,
      });
      continue;
    }
    if (offer.status !== "READY_FOR_AFFILIATE_LINK") {
      items.push({
        offerId: offer.id,
        itemId: offer.externalProductId,
        status: "FAILED",
        attempts: 0,
        errorCode: "SHOPEE_OFFER_NOT_ELIGIBLE",
      });
      continue;
    }
    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      try {
        const result = await applyLink({
          offerId: offer.id,
          subIds: input.subIds ?? ["sourcedatafeed", "autolink"],
          environment,
          linkProvider: provider,
          database,
        });
        if (result.linkStatus === "GENERATED") apiAttempts += 1;
        items.push({
          offerId: result.offerId,
          itemId: result.itemId,
          status: result.status,
          attempts,
          linkStatus: result.linkStatus,
        });
        break;
      } catch (error) {
        const errorCode = safeCode(error);
        if (!NO_REQUEST_ERROR_CODES.has(errorCode)) apiAttempts += 1;
        const retryable = isRetryableBulkError(error, errorCode);
        if (retryable && attempts < 2) {
          retryAttempts += 1;
          await sleep(100);
          continue;
        }
        items.push({
          offerId: offer.id,
          itemId: offer.externalProductId,
          status: "FAILED",
          attempts,
          errorCode,
        });
        if (GLOBAL_BULK_ERROR_CODES.has(errorCode)) globalFailure = errorCode;
        break;
      }
    }
  }
  const linked = items.filter((item) => item.status === "LINKED").length;
  const alreadyLinked = items.filter(
    (item) => item.status === "ALREADY_LINKED",
  ).length;
  const failed = items.filter((item) => item.status === "FAILED").length;
  const notAttempted = items.filter(
    (item) => item.status === "NOT_ATTEMPTED",
  ).length;
  const generated = items.filter(
    (item) => item.status === "LINKED" && item.linkStatus === "GENERATED",
  ).length;
  const reused = items.filter(
    (item) => item.status === "ALREADY_LINKED" || item.linkStatus === "REUSED",
  ).length;
  return {
    status:
      linked + alreadyLinked === 0 && (failed > 0 || notAttempted > 0)
        ? "FAILED"
        : failed > 0 || notAttempted > 0
          ? "SUCCEEDED_WITH_ERRORS"
          : "SUCCEEDED",
    source: input.source,
    requested,
    eligible: eligible.length,
    attempted: items.filter((item) => item.attempts > 0).length,
    linked,
    alreadyLinked,
    failed,
    notAttempted,
    readyToPublish: linked + alreadyLinked,
    remainingPending: failed + notAttempted,
    linksRequested: eligible.length,
    linksGenerated: generated,
    linksReused: reused,
    linksFailed: failed,
    linksSkipped: alreadyLinked + notAttempted,
    apiAttempts,
    retryAttempts,
    durationMs: Math.max(0, now() - startedAt),
    externalRequests: apiAttempts,
    writes: linked,
    publicationsCreated: 0,
    messagesSent: 0,
    items,
  };
}

export type ShopeeDnsResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

function ipv4Octets(address: string) {
  const octets = address.split(".").map(Number);
  return octets.length === 4 &&
    octets.every((octet) => octet >= 0 && octet <= 255)
    ? octets
    : null;
}

export function isPublicShopeeRedirectAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const octets = ipv4Octets(address);
    if (!octets) return false;
    const [first = 0, second = 0, third = 0] = octets;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third <= 2) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  if (version !== 6) return false;
  const normalized = address.toLowerCase().split("%")[0] ?? "";
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (mapped) return isPublicShopeeRedirectAddress(mapped);
  const mappedHex = normalized.match(/::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/u);
  if (mappedHex?.[1] && mappedHex[2]) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPublicShopeeRedirectAddress(
      `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
    );
  }
  const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !normalized.startsWith("2001:db8:") &&
    !normalized.startsWith("2002:") &&
    !normalized.startsWith("3fff:")
  );
}

const MANUAL_REDIRECT_HOSTS = new Set([
  "s.shopee.com.br",
  "shopee.com.br",
  "www.shopee.com.br",
]);

function isShopeeProductRedirectHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "shopee.com.br" || normalized === "www.shopee.com.br";
}

const defaultShopeeDnsResolver: ShopeeDnsResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

async function assertSafeShopeeRedirectTarget(
  value: string,
  resolveDns: ShopeeDnsResolver,
  signal: AbortSignal,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_REDIRECT_REJECTED");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    !MANUAL_REDIRECT_HOSTS.has(hostname)
  ) {
    throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_REDIRECT_REJECTED");
  }
  let addresses: Awaited<ReturnType<ShopeeDnsResolver>>;
  try {
    addresses = await new Promise((resolve, reject) => {
      const abort = () => reject(new Error("SHOPEE_MANUAL_LINK_ABORTED"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      resolveDns(hostname).then(
        (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  } catch {
    if (signal.aborted)
      throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_TIMEOUT", true);
    throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_DNS_FAILED", true);
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => !isPublicShopeeRedirectAddress(entry.address))
  ) {
    throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_SSRF_BLOCKED");
  }
}

export async function resolveManualShopeeShortLink(input: {
  shortLink: string;
  expectedItemId: string;
  fetch?: typeof fetch;
  resolveDns?: ShopeeDnsResolver;
  timeoutMs?: number;
  maxRedirects?: number;
}) {
  const initial = validateShopeeGeneratedShortLink(input.shortLink);
  if (!initial.ok) throw new ShopeeOpenApiError(initial.code);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 10_000,
  );
  let current = initial.normalizedUrl;
  const visited = new Set<string>();
  const resolveDns = input.resolveDns ?? defaultShopeeDnsResolver;
  const maxRedirects = Math.max(1, Math.min(5, input.maxRedirects ?? 5));
  try {
    for (let redirect = 0; redirect < maxRedirects; redirect += 1) {
      if (visited.has(current)) {
        throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_REDIRECT_LOOP");
      }
      visited.add(current);
      await assertSafeShopeeRedirectTarget(
        current,
        resolveDns,
        controller.signal,
      );
      const response = await (input.fetch ?? fetch)(current, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) {
        throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_REDIRECT_REJECTED");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_DESTINATION_MISSING");
      }
      const next = new URL(location, current).toString();
      if (visited.has(next)) {
        throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_REDIRECT_LOOP");
      }
      await assertSafeShopeeRedirectTarget(next, resolveDns, controller.signal);
      const product = validateShopeeProductOrigin(next, input.expectedItemId);
      if (product.ok) return product.normalizedUrl;
      if (product.code === "SHOPEE_ORIGIN_ITEM_ID_MISMATCH") {
        throw new ShopeeOpenApiError("SHOPEE_AFFILIATE_LINK_PRODUCT_MISMATCH");
      }
      if (
        product.code === "SHOPEE_ORIGIN_ITEM_ID_MISSING" &&
        isShopeeProductRedirectHost(new URL(next).hostname)
      ) {
        throw new ShopeeOpenApiError("SHOPEE_AFFILIATE_LINK_ITEM_ID_MISSING");
      }
      const intermediate = validateShopeeGeneratedShortLink(next);
      if (!intermediate.ok) {
        throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_REDIRECT_REJECTED");
      }
      current = intermediate.normalizedUrl;
    }
    throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_REDIRECT_LIMIT");
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ShopeeOpenApiError("SHOPEE_MANUAL_LINK_TIMEOUT", true);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function applyManualShopeeAffiliateLink(input: {
  offerId: string;
  affiliateUrl: string;
  database?: PrismaClient;
  fetch?: typeof fetch;
  resolveDns?: ShopeeDnsResolver;
  ingestOffer?: typeof ingestOfferInTransaction;
  now?: Date;
}) {
  const shortLink = validateShopeeGeneratedShortLink(input.affiliateUrl);
  if (!shortLink.ok) throw new ShopeeOpenApiError(shortLink.code);
  const database = input.database ?? prisma;
  const offer = await database.offer.findUnique({
    where: { id: input.offerId },
    select: {
      marketplace: true,
      externalProductId: true,
      title: true,
      description: true,
      category: true,
      sourceCategoryId: true,
      imageUrl: true,
      productUrl: true,
      originalPrice: true,
      currentPrice: true,
      discountPercentage: true,
      rating: true,
    },
  });
  if (!offer || offer.marketplace !== "SHOPEE") {
    throw new ShopeeOpenApiError("SHOPEE_OFFER_NOT_FOUND");
  }
  await resolveManualShopeeShortLink({
    shortLink: shortLink.normalizedUrl,
    expectedItemId: offer.externalProductId,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.resolveDns ? { resolveDns: input.resolveDns } : {}),
  });
  const winner = winnerFromOffer(offer);
  return database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shopee:${offer.externalProductId}`}))`;
    return (input.ingestOffer ?? ingestOfferInTransaction)(
      tx,
      offerInput(winner, {
        affiliateUrl: shortLink.normalizedUrl,
        affiliateLabel: `SHOPEE_MANUAL:${createHash("sha256")
          .update(offer.productUrl)
          .digest("hex")
          .slice(0, 24)}`,
      }),
      { now: input.now ?? new Date(), minScore: 70 },
    );
  });
}
