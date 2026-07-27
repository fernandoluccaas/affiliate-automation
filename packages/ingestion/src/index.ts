import { createHash } from "node:crypto";
import { calculateOfferScore, type ScoreInput } from "@affiliate/scoring";
import {
  calculateValidatedDiscount,
  validateMarketplaceAffiliateUrl,
  validateOfferFacts,
  type ValidationFailureCode,
} from "@affiliate/validation";
import { prisma, type OfferStatus, type Prisma } from "@affiliate/database";
import {
  offerFormSchema as ingestionOfferFormSchema,
  type OfferFormValues,
} from "./offer-form-schema";

export {
  formatOfferFormError,
  offerFormSchema,
  parseDecimalInput,
  type OfferFormInput,
  type OfferFormValues,
} from "./offer-form-schema";

export const READY_TO_PUBLISH_MIN_SCORE = 70;

export type IngestOfferResult = {
  ok: boolean;
  offerId?: string;
  productId?: string;
  status: OfferStatus;
  statusReason: string;
  score?: number;
  scoreCompletenessPercentage?: number;
  discountPercentage?: number | null;
  affiliateLinkSlug?: string;
  productCreated?: boolean;
  offerCreated?: boolean;
  offerReused?: boolean;
  offerUpdated?: boolean;
  version?: number;
  fingerprint?: string;
  minimumScoreApplied?: number;
};

export type IngestOfferOptions = {
  now?: Date;
  minScore?: number;
};

type OfferFingerprintInput = {
  productId: string;
  originalPrice?: number | string | null;
  currentPrice: number | string;
  couponCode?: string | null;
  couponExpiration?: Date | string | null;
  affiliateUrl?: string | null;
  shippingStatus: string;
  stockStatus: string;
};

function statusForValidationFailure(code: ValidationFailureCode): OfferStatus {
  if (code === "EXPIRED_COUPON") {
    return "REJECTED_EXPIRED";
  }

  return "REJECTED_INVALID_DATA";
}

function buildSlug(
  title: string,
  marketplace: string,
  externalProductId: string,
) {
  const normalizedTitle = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  const base = normalizedTitle || "oferta";
  return `${base}-${marketplace.toLowerCase()}-${externalProductId.toLowerCase()}`.slice(
    0,
    92,
  );
}

function normalizeDecimal(value?: number | string | null) {
  if (value === null || value === undefined) {
    return "";
  }

  return Number(value).toFixed(2);
}

function normalizeCoupon(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeDate(value?: Date | string | null) {
  if (!value) {
    return "";
  }

  return new Date(value).toISOString();
}

function normalizeUrl(value?: string | null) {
  if (!value?.trim()) {
    return "";
  }

  try {
    const url = new URL(value.trim());
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

export function createOfferFingerprint(input: OfferFingerprintInput) {
  const normalized = [
    input.productId,
    normalizeDecimal(input.originalPrice),
    normalizeDecimal(input.currentPrice),
    normalizeCoupon(input.couponCode),
    normalizeDate(input.couponExpiration),
    normalizeUrl(input.affiliateUrl),
    input.shippingStatus,
    input.stockStatus,
  ];

  return createHash("sha256").update(normalized.join("|")).digest("hex");
}

async function reserveAffiliateSlug(
  tx: Prisma.TransactionClient,
  baseSlug: string,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    const existing = await tx.affiliateLink.findUnique({ where: { slug } });

    if (!existing) {
      return slug;
    }
  }

  return `${baseSlug}-${Date.now()}`;
}

function scoreInputFromOffer(
  input: OfferFormValues,
  discountPercentage: number | null,
  now: Date,
) {
  const scoreInput: ScoreInput = {
    discountPercentage,
    shippingStatus: input.shippingStatus,
    collectedAt: now,
  };

  if (input.commissionPercentage !== undefined) {
    scoreInput.commissionPercentage = input.commissionPercentage;
  }

  if (input.rating !== undefined) {
    scoreInput.rating = input.rating;
  }

  if (input.salesCount !== undefined) {
    scoreInput.salesCount = input.salesCount;
  }

  if (input.couponExpiration !== undefined) {
    scoreInput.couponExpiration = input.couponExpiration;
  }

  return scoreInput;
}

function buildValidationInput(
  input: OfferFormValues,
  discountPercentage: number | null,
  now: Date,
) {
  return {
    ...input,
    discountPercentage,
    freeShipping: input.shippingStatus === "FREE",
    collectedAt: now,
  };
}

function trackingStrategyForOffer(input: OfferFormValues) {
  return (
    input.trackingStrategy ??
    (input.marketplace === "MERCADO_LIVRE"
      ? "DIRECT_AFFILIATE_LINK"
      : "INTERNAL_REDIRECT")
  );
}

export async function ingestOffer(
  rawInput: unknown,
  options: IngestOfferOptions = {},
): Promise<IngestOfferResult> {
  const now = options.now ?? new Date();
  const minScore = options.minScore ?? READY_TO_PUBLISH_MIN_SCORE;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) =>
        ingestOfferInTransaction(tx, rawInput, { now, minScore }),
      );
    } catch (error) {
      if (attempt === 0 && isUniqueConstraintError(error)) {
        continue;
      }

      throw error;
    }
  }

  return prisma.$transaction(async (tx) =>
    ingestOfferInTransaction(tx, rawInput, { now, minScore }),
  );
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export async function ingestOfferInTransaction(
  tx: Prisma.TransactionClient,
  rawInput: unknown,
  options: Required<IngestOfferOptions>,
): Promise<IngestOfferResult> {
  const parsed = ingestionOfferFormSchema.safeParse(rawInput);

  if (!parsed.success) {
    return {
      ok: false,
      status: "REJECTED_INVALID_DATA",
      statusReason:
        parsed.error.issues[0]?.message ?? "Dados da oferta invalidos.",
    };
  }

  const input = parsed.data;
  const discount = calculateValidatedDiscount(
    input.originalPrice,
    input.currentPrice,
  );
  const discountPercentage = discount.ok ? discount.discountPercentage : null;
  const freeShipping = input.shippingStatus === "FREE";
  const trackingStrategy = trackingStrategyForOffer(input);
  const affiliateUrlValidation = input.affiliateUrl
    ? validateMarketplaceAffiliateUrl(input.marketplace, input.affiliateUrl)
    : null;
  const existingProduct = await tx.product.findUnique({
    where: {
      marketplace_externalProductId: {
        marketplace: input.marketplace,
        externalProductId: input.externalProductId,
      },
    },
    select: { id: true },
  });

  const product = await tx.product.upsert({
    where: {
      marketplace_externalProductId: {
        marketplace: input.marketplace,
        externalProductId: input.externalProductId,
      },
    },
    update: {
      title: input.title,
      productUrl: input.productUrl,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
      ...(input.rating !== undefined ? { rating: input.rating } : {}),
      ...(input.salesCount !== undefined
        ? { salesCount: input.salesCount }
        : {}),
    },
    create: {
      marketplace: input.marketplace,
      externalProductId: input.externalProductId,
      title: input.title,
      description: input.description ?? null,
      category: input.category ?? null,
      imageUrl: input.imageUrl ?? null,
      productUrl: input.productUrl,
      rating: input.rating ?? null,
      salesCount: input.salesCount ?? null,
    },
  });

  const duplicate = await tx.offer.findFirst({
    where: {
      marketplace: input.marketplace,
      productId: { not: product.id },
      OR: [
        { productUrl: input.productUrl },
        ...(input.affiliateUrl ? [{ affiliateUrl: input.affiliateUrl }] : []),
      ],
    },
    select: { id: true },
  });

  const offerFingerprint = createOfferFingerprint({
    productId: product.id,
    originalPrice: input.originalPrice ?? null,
    currentPrice: input.currentPrice,
    couponCode: input.couponCode ?? null,
    couponExpiration: input.couponExpiration ?? null,
    affiliateUrl: input.affiliateUrl ?? null,
    shippingStatus: input.shippingStatus,
    stockStatus: input.stockStatus,
  });

  let offer = await tx.offer.findFirst({
    where: { productId: product.id, offerFingerprint },
  });
  const offerReused = Boolean(offer);
  const offerCreated = !offer;
  let offerIsImmutable = false;
  let offerUpdated = false;

  if (offer) {
    offerIsImmutable = await isHistoricalOffer(tx, offer.id, offer.status);

    if (!offerIsImmutable) {
      offerUpdated = true;
      offer = await tx.offer.update({
        where: { id: offer.id },
        data: {
          title: input.title,
          productUrl: input.productUrl,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
          ...(input.commissionPercentage !== undefined
            ? { commissionPercentage: input.commissionPercentage }
            : {}),
          ...(input.rating !== undefined ? { rating: input.rating } : {}),
          ...(input.salesCount !== undefined
            ? { salesCount: input.salesCount }
            : {}),
          ...(input.affiliateLabel !== undefined
            ? { affiliateLabel: input.affiliateLabel }
            : {}),
          affiliateEligibility: input.affiliateEligibility,
          ...(input.sellerId !== undefined ? { sellerId: input.sellerId } : {}),
          ...(input.officialStoreId !== undefined
            ? { officialStoreId: input.officialStoreId }
            : {}),
          trackingStrategy,
          minimumScoreApplied: options.minScore,
          freeShipping,
          shippingStatus: input.shippingStatus,
          score: null,
          scoreCompletenessPercentage: null,
          status: "PENDING_VALIDATION",
          statusReason: null,
          collectedAt: options.now,
          verifiedAt: null,
        },
      });
    }
  } else {
    const lastVersion = await tx.offer.findFirst({
      where: { productId: product.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    offer = await tx.offer.create({
      data: {
        marketplace: input.marketplace,
        externalProductId: input.externalProductId,
        productId: product.id,
        version: (lastVersion?.version ?? 0) + 1,
        offerFingerprint,
        title: input.title,
        description: input.description ?? null,
        category: input.category ?? null,
        imageUrl: input.imageUrl ?? null,
        productUrl: input.productUrl,
        affiliateUrl: input.affiliateUrl ?? null,
        affiliateLabel: input.affiliateLabel ?? null,
        affiliateEligibility: input.affiliateEligibility,
        sellerId: input.sellerId ?? null,
        officialStoreId: input.officialStoreId ?? null,
        trackingStrategy,
        minimumScoreApplied: options.minScore,
        originalPrice: input.originalPrice ?? null,
        currentPrice: input.currentPrice,
        discountPercentage,
        couponCode: input.couponCode ?? null,
        couponExpiration: input.couponExpiration ?? null,
        commissionPercentage: input.commissionPercentage ?? null,
        rating: input.rating ?? null,
        salesCount: input.salesCount ?? null,
        freeShipping,
        shippingStatus: input.shippingStatus,
        stockStatus: input.stockStatus,
        status: "PENDING_VALIDATION",
        collectedAt: options.now,
      },
    });
  }

  if (!offerIsImmutable) {
    await tx.coupon.deleteMany({ where: { offerId: offer.id } });

    if (input.couponCode) {
      await tx.coupon.create({
        data: {
          offerId: offer.id,
          code: input.couponCode,
          expiresAt: input.couponExpiration ?? null,
        },
      });
    }
  }

  const score = calculateOfferScore(
    scoreInputFromOffer(input, discountPercentage, options.now),
    undefined,
    options.now,
  );

  if (!offerIsImmutable) {
    await tx.offerScore.create({
      data: {
        offerId: offer.id,
        total: score.total,
        completenessPercentage: score.scoreCompletenessPercentage,
        discountComponent: score.discountComponent,
        commissionComponent: score.commissionComponent,
        ratingComponent: score.ratingComponent,
        popularityComponent: score.popularityComponent,
        freeShippingComponent: score.freeShippingComponent,
        couponValidityComponent: score.couponValidityComponent,
        noveltyComponent: score.noveltyComponent,
        weights: score.weights,
      },
    });
  }

  const shouldCreateInternalAffiliateLink =
    input.affiliateUrl &&
    affiliateUrlValidation?.ok === true &&
    trackingStrategy === "INTERNAL_REDIRECT";
  const existingAffiliateLink = shouldCreateInternalAffiliateLink
    ? await tx.affiliateLink.findFirst({
        where: { offerId: offer.id },
        select: { slug: true },
      })
    : null;
  const affiliateLinkSlug = shouldCreateInternalAffiliateLink
    ? (existingAffiliateLink?.slug ??
      (await reserveAffiliateSlug(
        tx,
        buildSlug(input.title, input.marketplace, input.externalProductId),
      )))
    : undefined;

  if (
    shouldCreateInternalAffiliateLink &&
    !existingAffiliateLink &&
    affiliateLinkSlug &&
    input.affiliateUrl
  ) {
    await tx.affiliateLink.create({
      data: {
        offerId: offer.id,
        slug: affiliateLinkSlug,
        destination: input.affiliateUrl,
        marketplace: input.marketplace,
      },
    });
  }

  let status: OfferStatus = "READY_TO_PUBLISH";
  let statusReason = "Oferta valida e pronta para publicacao.";

  if (offerIsImmutable) {
    status = offer.status;
    statusReason =
      offer.statusReason ?? "Oferta historica preservada sem sobrescrita.";
  } else if (!discount.ok) {
    status = "REJECTED_INVALID_DATA";
    statusReason = discount.message;
  } else if (duplicate) {
    status = "REJECTED_DUPLICATE";
    statusReason = "Ja existe uma oferta cadastrada para a mesma URL.";
  } else if (affiliateUrlValidation && !affiliateUrlValidation.ok) {
    status = "REJECTED_INVALID_DATA";
    statusReason = affiliateUrlValidation.message;
  } else if (input.affiliateEligibility === "INELIGIBLE") {
    status = "REJECTED_INVALID_DATA";
    statusReason = "Oferta explicitamente inelegivel para afiliacao.";
  } else {
    const validation = validateOfferFacts(
      buildValidationInput(input, discountPercentage, options.now),
      options.now,
    );

    if (!validation.ok) {
      status = statusForValidationFailure(validation.code);
      statusReason = validation.message;
    } else if (score.total < options.minScore) {
      status = "REJECTED_LOW_SCORE";
      statusReason = `Score ${score.total} abaixo do minimo ${options.minScore}.`;
    } else if (!input.affiliateUrl) {
      status = "READY_FOR_AFFILIATE_LINK";
      statusReason = "Oferta valida aguardando link oficial de afiliado.";
    }
  }

  if (!offerIsImmutable) {
    await tx.offer.update({
      where: { id: offer.id },
      data: {
        status,
        statusReason,
        score: score.total,
        scoreCompletenessPercentage: score.scoreCompletenessPercentage,
        verifiedAt: options.now,
      },
    });
  }

  const result: IngestOfferResult = {
    ok: status === "READY_TO_PUBLISH",
    offerId: offer.id,
    productId: product.id,
    status,
    statusReason,
    score: score.total,
    scoreCompletenessPercentage: score.scoreCompletenessPercentage,
    discountPercentage,
    productCreated: !existingProduct,
    offerCreated,
    offerReused,
    offerUpdated,
    version: offer.version,
    fingerprint: offerFingerprint,
    minimumScoreApplied: offerIsImmutable
      ? offer.minimumScoreApplied
      : options.minScore,
  };

  if (affiliateLinkSlug) {
    result.affiliateLinkSlug = affiliateLinkSlug;
  }

  return result;
}

async function isHistoricalOffer(
  tx: Prisma.TransactionClient,
  offerId: string,
  status: OfferStatus,
) {
  if (status === "PUBLISHED") {
    return true;
  }

  const publicationCount = await tx.publication.count({ where: { offerId } });
  return publicationCount > 0;
}
