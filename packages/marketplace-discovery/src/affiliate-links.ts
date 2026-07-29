import { prisma, Prisma } from "@affiliate/database";
import { ingestOffer, type IngestOfferResult } from "@affiliate/ingestion";
import {
  createMercadoLivreConnector,
  type MarketplaceConnector,
  type MarketplaceOfferCandidate,
} from "@affiliate/marketplace-connectors";
import { validateAffiliateUrl } from "@affiliate/validation";

export type AffiliateLinkBatchEntry = {
  line: number;
  externalId?: string;
  productUrl?: string;
  affiliateUrl: string;
};

export type AffiliateLinkParseIssue = {
  line: number;
  code: "INVALID_FORMAT" | "MISSING_IDENTIFIER" | "MISSING_AFFILIATE_URL";
  message: string;
};

export type AffiliateLinkParseResult = {
  entries: AffiliateLinkBatchEntry[];
  issues: AffiliateLinkParseIssue[];
};

export type AffiliateLinkPreviewStatus =
  | "VALID"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "INVALID_LINK"
  | "ALREADY_UPDATED";

export type AffiliateLinkPreviewItem = AffiliateLinkBatchEntry & {
  status: AffiliateLinkPreviewStatus;
  message: string;
  productId?: string;
  offerId?: string;
  normalizedAffiliateUrl?: string;
  createsProduct?: boolean;
};

export type AffiliateLinkBatchPreview = {
  items: AffiliateLinkPreviewItem[];
  counts: {
    valid: number;
    notFound: number;
    duplicates: number;
    invalidLinks: number;
    alreadyUpdated: number;
  };
};

export type ApplyAffiliateLinksBatchResult = {
  importJobId: string;
  status: "SUCCEEDED" | "SUCCEEDED_WITH_ERRORS";
  total: number;
  updated: number;
  ignored: number;
  failed: number;
  readyToPublish: number;
  readyForAffiliateLink: number;
  rejected: number;
  invalidLinks: number;
  notFound: number;
};

type AffiliateLinkBatchDependencies = {
  database: typeof prisma;
  ingest: typeof ingestOffer;
  createConnector: () => Promise<MarketplaceConnector>;
};

const MERCADO_LIVRE_PRODUCT_DOMAINS = [
  "mercadolivre.com.br",
  "mercadolibre.com",
] as const;

function normalizeExternalId(value: string) {
  return value.trim().toUpperCase().replace(/^MLB-/, "MLB");
}

function normalizeComparableUrl(value: string) {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim();
  }
}

function productDomainAllowed(host: string) {
  return MERCADO_LIVRE_PRODUCT_DOMAINS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

export function extractMercadoLivreExternalId(value: string) {
  const match = value.toUpperCase().match(/\bMLB-?(\d{6,})\b/);
  return match?.[1] ? `MLB${match[1]}` : null;
}

export function validateMercadoLivreProductUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return { ok: false as const, message: "URL do produto inválida." };
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !productDomainAllowed(url.hostname.toLowerCase())
  ) {
    return {
      ok: false as const,
      message: "A URL do produto deve usar HTTPS e um domínio Mercado Livre.",
    };
  }

  const externalId = extractMercadoLivreExternalId(url.toString());

  if (!externalId) {
    return {
      ok: false as const,
      message: "A URL do produto não contém um ID MLB reconhecível.",
    };
  }

  return {
    ok: true as const,
    normalizedUrl: url.toString(),
    externalId,
  };
}

export function parsePipeAffiliateLinks(
  raw: string,
): AffiliateLinkParseResult {
  const entries: AffiliateLinkBatchEntry[] = [];
  const issues: AffiliateLinkParseIssue[] = [];

  raw.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    const value = rawLine.trim();

    if (!value) return;

    const parts = value.split("|").map((part) => part.trim());

    if (parts.length !== 2) {
      issues.push({
        line,
        code: "INVALID_FORMAT",
        message: "Use identificador|affiliateUrl.",
      });
      return;
    }

    const [identifier, affiliateUrl] = parts;

    if (!identifier) {
      issues.push({
        line,
        code: "MISSING_IDENTIFIER",
        message: "Informe externalId ou productUrl.",
      });
      return;
    }

    if (!affiliateUrl) {
      issues.push({
        line,
        code: "MISSING_AFFILIATE_URL",
        message: "Informe affiliateUrl.",
      });
      return;
    }

    entries.push({
      line,
      ...(identifier.startsWith("http://") ||
      identifier.startsWith("https://")
        ? { productUrl: identifier }
        : { externalId: normalizeExternalId(identifier) }),
      affiliateUrl,
    });
  });

  return { entries, issues };
}

function parseDelimitedRow(row: string, delimiter: string) {
  const values: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];

    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }

  values.push(value.trim());
  return values;
}

export function parseAffiliateLinksCsv(
  raw: string,
): AffiliateLinkParseResult {
  const text = raw.replace(/^\uFEFF/, "");
  const rows = text.split(/\r?\n/).filter((row) => row.trim());

  if (rows.length === 0) return { entries: [], issues: [] };

  const headerRow = rows[0] as string;
  const delimiter =
    (headerRow.match(/;/g)?.length ?? 0) > (headerRow.match(/,/g)?.length ?? 0)
      ? ";"
      : ",";
  const headers = parseDelimitedRow(headerRow, delimiter).map((header) =>
    header.trim().toLowerCase(),
  );
  const externalIdIndex = headers.indexOf("externalid");
  const productUrlIndex = headers.indexOf("producturl");
  const affiliateUrlIndex = headers.indexOf("affiliateurl");
  const entries: AffiliateLinkBatchEntry[] = [];
  const issues: AffiliateLinkParseIssue[] = [];

  rows.slice(1).forEach((row, index) => {
    const line = index + 2;
    const values = parseDelimitedRow(row, delimiter);
    const externalId =
      externalIdIndex >= 0 ? values[externalIdIndex]?.trim() : undefined;
    const productUrl =
      productUrlIndex >= 0 ? values[productUrlIndex]?.trim() : undefined;
    const affiliateUrl =
      affiliateUrlIndex >= 0 ? values[affiliateUrlIndex]?.trim() : undefined;

    if (!externalId && !productUrl) {
      issues.push({
        line,
        code: "MISSING_IDENTIFIER",
        message: "Informe externalId ou productUrl.",
      });
      return;
    }

    if (!affiliateUrl) {
      issues.push({
        line,
        code: "MISSING_AFFILIATE_URL",
        message: "Informe affiliateUrl.",
      });
      return;
    }

    entries.push({
      line,
      ...(externalId
        ? { externalId: normalizeExternalId(externalId) }
        : {}),
      ...(productUrl ? { productUrl } : {}),
      affiliateUrl,
    });
  });

  return { entries, issues };
}

function batchLimit() {
  const parsed = Number(process.env.AFFILIATE_LINK_BATCH_MAX_ROWS ?? 1_000);
  return Number.isFinite(parsed)
    ? Math.min(10_000, Math.max(1, Math.floor(parsed)))
    : 1_000;
}

function batchKey(entry: AffiliateLinkBatchEntry) {
  if (entry.externalId) return `id:${normalizeExternalId(entry.externalId)}`;
  return `url:${normalizeComparableUrl(entry.productUrl ?? "")}`;
}

async function findProductAndOffer(
  database: typeof prisma,
  entry: AffiliateLinkBatchEntry,
) {
  const externalId =
    entry.externalId ??
    (entry.productUrl
      ? extractMercadoLivreExternalId(entry.productUrl)
      : undefined);
  const product = await database.product.findFirst({
    where: {
      marketplace: "MERCADO_LIVRE",
      OR: [
        ...(externalId
          ? [{ externalProductId: normalizeExternalId(externalId) }]
          : []),
        ...(entry.productUrl
          ? [{ productUrl: normalizeComparableUrl(entry.productUrl) }]
          : []),
      ],
    },
    include: {
      offers: {
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });

  return { product, offer: product?.offers[0] ?? null, externalId };
}

export async function previewAffiliateLinksBatch(
  entries: readonly AffiliateLinkBatchEntry[],
  dependencyOverrides: Partial<AffiliateLinkBatchDependencies> = {},
): Promise<AffiliateLinkBatchPreview> {
  const database = dependencyOverrides.database ?? prisma;
  const seen = new Set<string>();
  const items: AffiliateLinkPreviewItem[] = [];

  for (const entry of entries.slice(0, batchLimit())) {
    const key = batchKey(entry);

    if (seen.has(key)) {
      items.push({
        ...entry,
        status: "DUPLICATE",
        message: "Identificador duplicado neste lote.",
      });
      continue;
    }
    seen.add(key);

    const validation = validateAffiliateUrl(entry.affiliateUrl);

    if (!validation.ok) {
      items.push({
        ...entry,
        status: "INVALID_LINK",
        message: validation.message,
      });
      continue;
    }

    const lookup = await findProductAndOffer(database, entry);

    if (lookup.offer) {
      const alreadyUpdated =
        lookup.offer.affiliateUrl &&
        normalizeComparableUrl(lookup.offer.affiliateUrl) ===
          normalizeComparableUrl(validation.normalizedUrl);
      items.push({
        ...entry,
        status: alreadyUpdated ? "ALREADY_UPDATED" : "VALID",
        message: alreadyUpdated
          ? "O mesmo link já está aplicado à versão atual."
          : "Oferta encontrada e pronta para atualização.",
        ...(lookup.product?.id ? { productId: lookup.product.id } : {}),
        offerId: lookup.offer.id,
        normalizedAffiliateUrl: validation.normalizedUrl,
      });
      continue;
    }

    const productUrlValidation = entry.productUrl
      ? validateMercadoLivreProductUrl(entry.productUrl)
      : null;

    if (productUrlValidation?.ok) {
      items.push({
        ...entry,
        status: "VALID",
        message: "Produto novo será resolvido pela API oficial.",
        normalizedAffiliateUrl: validation.normalizedUrl,
        createsProduct: true,
      });
      continue;
    }

    items.push({
      ...entry,
      status: "NOT_FOUND",
      message:
        productUrlValidation && !productUrlValidation.ok
          ? productUrlValidation.message
          : "Produto não encontrado pelo identificador informado.",
    });
  }

  return {
    items,
    counts: {
      valid: items.filter((item) => item.status === "VALID").length,
      notFound: items.filter((item) => item.status === "NOT_FOUND").length,
      duplicates: items.filter((item) => item.status === "DUPLICATE").length,
      invalidLinks: items.filter((item) => item.status === "INVALID_LINK")
        .length,
      alreadyUpdated: items.filter(
        (item) => item.status === "ALREADY_UPDATED",
      ).length,
    },
  };
}

function decimal(value: Prisma.Decimal | null) {
  return value === null ? undefined : value.toString();
}

function existingOfferInput(
  offer: NonNullable<
    Awaited<ReturnType<typeof findProductAndOffer>>["offer"]
  >,
  affiliateUrl: string,
) {
  return {
    marketplace: offer.marketplace,
    externalProductId: offer.externalProductId,
    title: offer.title,
    description: offer.description ?? undefined,
    category: offer.category ?? undefined,
    imageUrl: offer.imageUrl ?? undefined,
    productUrl: offer.productUrl,
    affiliateUrl,
    affiliateLabel: offer.affiliateLabel ?? undefined,
    affiliateEligibility: offer.affiliateEligibility,
    affiliateFailure: null,
    sellerId: offer.sellerId ?? undefined,
    officialStoreId: offer.officialStoreId ?? undefined,
    sourceCategoryId: offer.sourceCategoryId ?? undefined,
    bestSellerPosition: offer.bestSellerPosition ?? undefined,
    sourceHighlightId: offer.sourceHighlightId ?? undefined,
    sourceHighlightType: offer.sourceHighlightType ?? undefined,
    resolutionStrategy: offer.resolutionStrategy ?? undefined,
    trackingStrategy: "DIRECT_AFFILIATE_LINK" as const,
    originalPrice: decimal(offer.originalPrice),
    currentPrice: offer.currentPrice.toString(),
    couponCode: offer.couponCode ?? undefined,
    couponExpiration: offer.couponExpiration ?? undefined,
    commissionPercentage: decimal(offer.commissionPercentage),
    rating: decimal(offer.rating),
    salesCount: offer.salesCount ?? undefined,
    shippingStatus: offer.shippingStatus,
    stockStatus: offer.stockStatus,
  };
}

function candidateInput(
  candidate: MarketplaceOfferCandidate,
  affiliateUrl: string,
) {
  return {
    marketplace: candidate.marketplace,
    externalProductId: candidate.externalProductId,
    title: candidate.title,
    description: candidate.description ?? undefined,
    category: candidate.category ?? undefined,
    imageUrl: candidate.imageUrl ?? undefined,
    productUrl: candidate.productUrl,
    affiliateUrl,
    affiliateEligibility: candidate.affiliateEligibility ?? "UNKNOWN",
    sellerId: candidate.sellerId ?? undefined,
    officialStoreId: candidate.officialStoreId ?? undefined,
    trackingStrategy: "DIRECT_AFFILIATE_LINK" as const,
    originalPrice: candidate.originalPrice ?? undefined,
    currentPrice: candidate.currentPrice,
    rating: candidate.rating ?? undefined,
    salesCount: candidate.salesCount ?? undefined,
    shippingStatus: candidate.shippingStatus ?? "UNKNOWN",
    stockStatus: candidate.stockStatus ?? "UNKNOWN",
  };
}

async function retirePendingVersion(
  database: typeof prisma,
  previousOfferId: string | undefined,
  result: IngestOfferResult,
) {
  if (!previousOfferId || !result.offerId || result.offerId === previousOfferId) {
    return;
  }

  await database.offer.updateMany({
    where: {
      id: previousOfferId,
      status: "READY_FOR_AFFILIATE_LINK",
      affiliateUrl: null,
    },
    data: {
      status: "REJECTED_DUPLICATE",
      statusReason:
        "Substituída por nova versão com link oficial de afiliado.",
    },
  });
}

export async function applyAffiliateLinksBatch(
  input: { entries: readonly AffiliateLinkBatchEntry[] },
  dependencyOverrides: Partial<AffiliateLinkBatchDependencies> = {},
): Promise<ApplyAffiliateLinksBatchResult> {
  const dependencies: AffiliateLinkBatchDependencies = {
    database: dependencyOverrides.database ?? prisma,
    ingest: dependencyOverrides.ingest ?? ingestOffer,
    createConnector:
      dependencyOverrides.createConnector ?? createMercadoLivreConnector,
  };
  const entries = input.entries.slice(0, batchLimit());
  const account = await dependencies.database.marketplaceAccount.findFirst({
    where: { marketplace: "MERCADO_LIVRE", enabled: true },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  const job = await dependencies.database.importJob.create({
    data: {
      marketplaceAccountId: account?.id ?? null,
      marketplace: "MERCADO_LIVRE",
      source: "AFFILIATE_LINK_BATCH",
      status: "RUNNING",
      totalFound: entries.length,
      startedAt: new Date(),
    },
  });
  const preview = await previewAffiliateLinksBatch(entries, dependencies);
  let connector: MarketplaceConnector | null = null;
  let updated = 0;
  let ignored = 0;
  let failed = 0;
  let readyToPublish = 0;
  let readyForAffiliateLink = 0;
  let rejected = 0;
  let invalidLinks = 0;
  let notFound = 0;
  let created = 0;

  for (const item of preview.items) {
    if (item.status !== "VALID") {
      ignored += 1;
      if (item.status === "INVALID_LINK") invalidLinks += 1;
      if (item.status === "NOT_FOUND") notFound += 1;

      await dependencies.database.importJobItem.create({
        data: {
          importJobId: job.id,
          sourceId: item.externalId ?? item.productUrl ?? null,
          stage:
            item.status === "INVALID_LINK"
              ? "AFFILIATE_LINK_VALIDATION"
              : "AFFILIATE_LINK_APPLICATION",
          status:
            item.status === "ALREADY_UPDATED" || item.status === "DUPLICATE"
              ? "SKIPPED"
              : "FAILED",
          attempts: 1,
          errorCode: item.status,
          errorMessage: item.message,
          metadata: { line: item.line },
        },
      });
      continue;
    }

    try {
      const lookup = await findProductAndOffer(dependencies.database, item);
      let result: IngestOfferResult;

      if (lookup.offer && item.normalizedAffiliateUrl) {
        result = await dependencies.ingest(
          existingOfferInput(lookup.offer, item.normalizedAffiliateUrl),
          { minScore: lookup.offer.minimumScoreApplied },
        );
      } else {
        const productUrl = item.productUrl as string;
        const productUrlValidation = validateMercadoLivreProductUrl(productUrl);

        if (!productUrlValidation.ok || !item.normalizedAffiliateUrl) {
          throw new Error(
            productUrlValidation.ok
              ? "Link afiliado inválido."
              : productUrlValidation.message,
          );
        }

        connector ??= await dependencies.createConnector();
        const candidate = await connector.getItem(
          productUrlValidation.externalId,
        );

        if (!candidate) {
          notFound += 1;
          ignored += 1;
          await dependencies.database.importJobItem.create({
            data: {
              importJobId: job.id,
              sourceId: productUrl,
              externalItemId: productUrlValidation.externalId,
              stage: "RESOLUTION",
              status: "FAILED",
              attempts: 1,
              errorCode: "PRODUCT_NOT_FOUND",
              errorMessage: "Produto não encontrado pela API oficial.",
              metadata: { line: item.line },
            },
          });
          continue;
        }

        result = await dependencies.ingest(
          candidateInput(candidate, item.normalizedAffiliateUrl),
          { minScore: 0 },
        );
        if (result.productCreated) created += 1;
      }

      await retirePendingVersion(
        dependencies.database,
        lookup.offer?.id,
        result,
      );
      updated += 1;
      if (result.status === "READY_TO_PUBLISH") readyToPublish += 1;
      else if (result.status === "READY_FOR_AFFILIATE_LINK")
        readyForAffiliateLink += 1;
      else if (result.status.startsWith("REJECTED")) rejected += 1;

      await dependencies.database.importJobItem.create({
        data: {
          importJobId: job.id,
          sourceId: item.externalId ?? item.productUrl ?? null,
          externalItemId:
            item.externalId ??
            (item.productUrl
              ? extractMercadoLivreExternalId(item.productUrl)
              : null),
          ...(result.productId ? { productId: result.productId } : {}),
          ...(result.offerId ? { offerId: result.offerId } : {}),
          stage: "AFFILIATE_LINK_APPLICATION",
          status: "SUCCEEDED",
          attempts: 1,
          metadata: {
            line: item.line,
            ingestionStatus: result.status,
            version: result.version,
          },
        },
      });
    } catch (error) {
      failed += 1;
      await dependencies.database.importJobItem.create({
        data: {
          importJobId: job.id,
          sourceId: item.externalId ?? item.productUrl ?? null,
          stage: "AFFILIATE_LINK_APPLICATION",
          status: "FAILED",
          attempts: 1,
          errorCode: "AFFILIATE_LINK_APPLICATION_FAILED",
          errorMessage:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Falha ao aplicar link.",
          metadata: { line: item.line },
        },
      });
    }
  }

  const hasErrors = invalidLinks + notFound + failed > 0;
  const status = hasErrors ? "SUCCEEDED_WITH_ERRORS" : "SUCCEEDED";

  await dependencies.database.importJob.update({
    where: { id: job.id },
    data: {
      status,
      totalResolved: updated,
      totalCreated: created,
      totalUpdated: updated - created,
      totalReadyToPublish: readyToPublish,
      totalReadyForAffiliateLink: readyForAffiliateLink,
      totalInvalidLinks: invalidLinks,
      totalNotFound: notFound,
      totalFailed: failed,
      finishedAt: new Date(),
      errorMessage: hasErrors
        ? "O lote foi concluído com erros isolados por linha."
        : null,
      summary: {
        total: entries.length,
        updated,
        ignored,
        failed,
        rejected,
      },
    },
  });

  return {
    importJobId: job.id,
    status,
    total: entries.length,
    updated,
    ignored,
    failed,
    readyToPublish,
    readyForAffiliateLink,
    rejected,
    invalidLinks,
    notFound,
  };
}
