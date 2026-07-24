import { calculateOfferScore, type ScoreInput } from "@affiliate/scoring";
import {
  calculateValidatedDiscount,
  validateOfferFacts,
  type ValidationFailureCode,
} from "@affiliate/validation";
import { prisma, type OfferStatus, type Prisma } from "@affiliate/database";
import { offerFormSchema, type OfferFormValues } from "./offer-form-schema";

export const READY_TO_PUBLISH_MIN_SCORE = 70;

type IngestOfferResult = {
  ok: boolean;
  offerId?: string;
  status: OfferStatus;
  statusReason: string;
  score?: number;
  discountPercentage?: number;
  affiliateLinkSlug?: string;
};

type IngestOfferOptions = {
  now?: Date;
  minScore?: number;
};

function statusForValidationFailure(code: ValidationFailureCode): OfferStatus {
  if (code === "EXPIRED_COUPON") {
    return "REJECTED_EXPIRED";
  }

  return "REJECTED_INVALID_DATA";
}

function buildSlug(title: string, marketplace: string, externalProductId: string) {
  const normalizedTitle = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  const base = normalizedTitle || "oferta";
  return `${base}-${marketplace.toLowerCase()}-${externalProductId.toLowerCase()}`.slice(0, 92);
}

async function reserveAffiliateSlug(tx: Prisma.TransactionClient, baseSlug: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
    const existing = await tx.affiliateLink.findUnique({ where: { slug } });

    if (!existing) {
      return slug;
    }
  }

  return `${baseSlug}-${Date.now()}`;
}

function scoreInputFromOffer(input: OfferFormValues, discountPercentage: number, now: Date) {
  const scoreInput: ScoreInput = {
    discountPercentage,
    freeShipping: input.freeShipping,
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

function buildValidationInput(input: OfferFormValues, discountPercentage: number, now: Date) {
  return {
    ...input,
    discountPercentage,
    collectedAt: now,
  };
}

export async function ingestOffer(
  rawInput: unknown,
  options: IngestOfferOptions = {},
): Promise<IngestOfferResult> {
  const now = options.now ?? new Date();
  const minScore = options.minScore ?? READY_TO_PUBLISH_MIN_SCORE;

  return prisma.$transaction(async (tx) => ingestOfferInTransaction(tx, rawInput, { now, minScore }));
}

export async function ingestOfferInTransaction(
  tx: Prisma.TransactionClient,
  rawInput: unknown,
  options: Required<IngestOfferOptions>,
): Promise<IngestOfferResult> {
  const parsed = offerFormSchema.safeParse(rawInput);

  if (!parsed.success) {
    return {
      ok: false,
      status: "REJECTED_INVALID_DATA",
      statusReason: parsed.error.issues[0]?.message ?? "Dados da oferta invalidos.",
    };
  }

  const input = parsed.data;
  const discount = calculateValidatedDiscount(input.originalPrice, input.currentPrice);
  const discountPercentage = discount.ok ? discount.discountPercentage : 0;

  const product = await tx.product.upsert({
    where: {
      marketplace_externalProductId: {
        marketplace: input.marketplace,
        externalProductId: input.externalProductId,
      },
    },
    update: {
      title: input.title,
      description: input.description ?? null,
      category: input.category ?? null,
      imageUrl: input.imageUrl ?? null,
      productUrl: input.productUrl,
      rating: input.rating ?? null,
      salesCount: input.salesCount ?? null,
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
      externalProductId: { not: input.externalProductId },
      OR: [
        { productUrl: input.productUrl },
        ...(input.affiliateUrl ? [{ affiliateUrl: input.affiliateUrl }] : []),
      ],
    },
    select: { id: true },
  });

  const offer = await tx.offer.upsert({
    where: {
      marketplace_externalProductId: {
        marketplace: input.marketplace,
        externalProductId: input.externalProductId,
      },
    },
    update: {
      productId: product.id,
      title: input.title,
      description: input.description ?? null,
      category: input.category ?? null,
      imageUrl: input.imageUrl ?? null,
      productUrl: input.productUrl,
      affiliateUrl: input.affiliateUrl ?? null,
      originalPrice: input.originalPrice,
      currentPrice: input.currentPrice,
      discountPercentage,
      couponCode: input.couponCode ?? null,
      couponExpiration: input.couponExpiration ?? null,
      commissionPercentage: input.commissionPercentage ?? null,
      rating: input.rating ?? null,
      salesCount: input.salesCount ?? null,
      freeShipping: input.freeShipping,
      stockStatus: input.stockStatus,
      score: null,
      status: "PENDING_VALIDATION",
      statusReason: null,
      collectedAt: options.now,
      verifiedAt: null,
    },
    create: {
      marketplace: input.marketplace,
      externalProductId: input.externalProductId,
      productId: product.id,
      title: input.title,
      description: input.description ?? null,
      category: input.category ?? null,
      imageUrl: input.imageUrl ?? null,
      productUrl: input.productUrl,
      affiliateUrl: input.affiliateUrl ?? null,
      originalPrice: input.originalPrice,
      currentPrice: input.currentPrice,
      discountPercentage,
      couponCode: input.couponCode ?? null,
      couponExpiration: input.couponExpiration ?? null,
      commissionPercentage: input.commissionPercentage ?? null,
      rating: input.rating ?? null,
      salesCount: input.salesCount ?? null,
      freeShipping: input.freeShipping,
      stockStatus: input.stockStatus,
      status: "PENDING_VALIDATION",
      collectedAt: options.now,
    },
  });

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

  const score = calculateOfferScore(
    scoreInputFromOffer(input, discountPercentage, options.now),
    undefined,
    options.now,
  );

  await tx.offerScore.create({
    data: {
      offerId: offer.id,
      total: score.total,
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

  const existingAffiliateLink = await tx.affiliateLink.findFirst({
    where: { offerId: offer.id },
    select: { slug: true },
  });
  const affiliateLinkSlug =
    existingAffiliateLink?.slug ??
    (await reserveAffiliateSlug(tx, buildSlug(input.title, input.marketplace, input.externalProductId)));

  if (!existingAffiliateLink) {
    await tx.affiliateLink.create({
      data: {
        offerId: offer.id,
        slug: affiliateLinkSlug,
        destination: input.affiliateUrl ?? input.productUrl,
        marketplace: input.marketplace,
      },
    });
  }

  let status: OfferStatus = "READY_TO_PUBLISH";
  let statusReason = "Oferta valida e pronta para publicacao.";

  if (!discount.ok) {
    status = "REJECTED_INVALID_DATA";
    statusReason = discount.message;
  } else if (duplicate) {
    status = "REJECTED_DUPLICATE";
    statusReason = "Ja existe uma oferta cadastrada para a mesma URL.";
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
    }
  }

  await tx.offer.update({
    where: { id: offer.id },
    data: {
      status,
      statusReason,
      score: score.total,
      verifiedAt: options.now,
    },
  });

  return {
    ok: status === "READY_TO_PUBLISH",
    offerId: offer.id,
    status,
    statusReason,
    score: score.total,
    discountPercentage,
    affiliateLinkSlug,
  };
}
