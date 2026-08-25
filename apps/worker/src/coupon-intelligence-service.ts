import { prisma, Prisma, type PrismaClient } from "@affiliate/database";
import {
  MercadoLivreCouponProvider,
  ShopeeCouponProvider,
  createCouponSnapshot,
  evaluateCouponSnapshotFreshness,
  resolveBestCoupon,
  resolveCouponIntelligenceConfiguration,
  type CouponCandidate,
  type CouponProvider,
} from "@affiliate/shared";

type CouponRecord = {
  marketplace: "SHOPEE" | "MERCADO_LIVRE" | null;
  externalCouponId: string | null;
  sourceKey: string | null;
  code: string | null;
  benefitType: "PERCENTAGE" | "FIXED_AMOUNT" | "AUTOMATIC" | "OTHER";
  percentage: { toString(): string } | string | null;
  discountAmount: { toString(): string } | string | null;
  minimumSpend: { toString(): string } | string | null;
  maximumDiscount: { toString(): string } | string | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  autoApply: boolean;
  scope: "PRODUCT" | "SELLER" | "STORE" | "PLATFORM" | "CATEGORY" | "UNKNOWN";
  sellerId: string | null;
  productExternalId: string | null;
  source: string;
  status: "ACTIVE" | "INACTIVE" | "UNKNOWN";
  active: boolean;
  lastValidatedAt: Date | null;
  applicability: "CONFIRMED" | "CONDITIONAL" | "UNKNOWN" | "NOT_APPLICABLE";
  applicabilityReason: string | null;
  confidence: number | null;
};

function text(value: { toString(): string } | string | null) {
  return value === null ? null : value.toString();
}

export function persistedCouponCandidate(
  coupon: CouponRecord,
  fallback: {
    marketplace: "SHOPEE" | "MERCADO_LIVRE";
    externalProductId: string;
    sellerId: string | null;
    now: Date;
  },
): CouponCandidate {
  return {
    marketplace: coupon.marketplace ?? fallback.marketplace,
    externalCouponId: coupon.externalCouponId,
    sourceKey: coupon.sourceKey,
    code: coupon.code,
    benefitType: coupon.benefitType,
    percentage: text(coupon.percentage),
    fixedAmount: text(coupon.discountAmount),
    minimumSpend: text(coupon.minimumSpend),
    maximumDiscount: text(coupon.maximumDiscount),
    startsAt: coupon.startsAt,
    expiresAt: coupon.expiresAt,
    autoApply: coupon.autoApply,
    scope: coupon.scope,
    sellerId: coupon.sellerId,
    productExternalId: coupon.productExternalId,
    source: coupon.source,
    status: coupon.status,
    active: coupon.active,
    lastValidatedAt: coupon.lastValidatedAt ?? new Date(0),
    applicability: coupon.applicability,
    applicabilityReason: coupon.applicabilityReason,
    confidence: coupon.confidence ?? 0,
  };
}

function providerFor(
  marketplace: "SHOPEE" | "MERCADO_LIVRE",
  providers?: Partial<Record<"SHOPEE" | "MERCADO_LIVRE", CouponProvider>>,
) {
  return (
    providers?.[marketplace] ??
    (marketplace === "SHOPEE"
      ? new ShopeeCouponProvider()
      : new MercadoLivreCouponProvider())
  );
}

function sanitizedMetadata(value: Record<string, unknown> | null | undefined) {
  if (!value) return Prisma.JsonNull;
  const forbidden = /token|secret|cookie|authorization|password|credential/i;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !forbidden.test(key))
      .slice(0, 20)
      .map(([key, item]) => [
        key,
        ["string", "number", "boolean"].includes(typeof item) || item === null
          ? item
          : String(item).slice(0, 256),
      ]),
  ) as Prisma.InputJsonValue;
}

function sanitizedProviderReason(value: string | null) {
  return value && /^[A-Z0-9_]{1,120}$/u.test(value)
    ? value
    : "COUPON_PROVIDER_UNAVAILABLE";
}

export async function loadCouponIntelligenceStatus(input: {
  database?: PrismaClient;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
} = {}) {
  const database = input.database ?? prisma;
  const environment = input.environment ?? process.env;
  const now = input.now ?? new Date();
  const configuration = resolveCouponIntelligenceConfiguration(environment);
  const coupons = await database.coupon.findMany({
    select: {
      offerId: true,
      marketplace: true,
      applicability: true,
      active: true,
      selected: true,
      expiresAt: true,
      lastValidatedAt: true,
      itemPrice: true,
      offer: { select: { currentPrice: true } },
    },
  });
  const summarize = (marketplace: "SHOPEE" | "MERCADO_LIVRE") => {
    const matching = coupons.filter((coupon) => coupon.marketplace === marketplace);
    return {
      offersWithCoupon: new Set(
        matching.filter((coupon) => coupon.active).map((coupon) => coupon.offerId),
      ).size,
      confirmed: matching.filter(
        (coupon) => coupon.active && coupon.applicability === "CONFIRMED",
      ).length,
      conditional: matching.filter(
        (coupon) => coupon.active && coupon.applicability === "CONDITIONAL",
      ).length,
      stale: matching.filter(
        (coupon) =>
          coupon.active &&
          (!coupon.lastValidatedAt ||
            now.getTime() - coupon.lastValidatedAt.getTime() >
              configuration.refreshTtlMinutes * 60_000 ||
            Boolean(
              coupon.expiresAt &&
                coupon.expiresAt.getTime() <=
                  now.getTime() + configuration.expirySafetyMinutes * 60_000,
            ) ||
            Boolean(
              coupon.itemPrice &&
                coupon.itemPrice.toString() !==
                  coupon.offer.currentPrice.toString(),
            )),
      ).length,
      expiringSoon: matching.filter(
        (coupon) =>
          coupon.active &&
          coupon.expiresAt &&
          coupon.expiresAt.getTime() <=
            now.getTime() + configuration.expirySafetyMinutes * 60_000,
      ).length,
      selected: matching.filter((coupon) => coupon.active && coupon.selected)
        .length,
    };
  };
  return {
    enabled: configuration.enabled,
    rankingEnabled: configuration.rankingEnabled,
    configurationIssues: configuration.issues,
    shopee: {
      sourceSupported: false,
      reason: "SHOPEE_AFFILIATE_COUPON_DISCOVERY_UNAVAILABLE",
      ...summarize("SHOPEE"),
    },
    mercadoLivre: {
      sourceSupported: false,
      reason: "MERCADO_LIVRE_AFFILIATE_COUPON_DISCOVERY_UNAVAILABLE",
      ...summarize("MERCADO_LIVRE"),
    },
    externalRequests: 0 as const,
    writes: 0 as const,
    stateModified: false as const,
  };
}

export async function previewOfferCoupons(input: {
  offerId: string;
  database?: PrismaClient;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
}) {
  const database = input.database ?? prisma;
  const now = input.now ?? new Date();
  const configuration = resolveCouponIntelligenceConfiguration(
    input.environment ?? process.env,
  );
  const offer = await database.offer.findUnique({
    where: { id: input.offerId },
    include: { coupons: true },
  });
  if (!offer) throw new Error("COUPON_OFFER_NOT_FOUND");
  const resolution = resolveBestCoupon({
    candidates: offer.coupons.map((coupon) =>
      persistedCouponCandidate(coupon, {
        marketplace: offer.marketplace,
        externalProductId: offer.externalProductId,
        sellerId: offer.sellerId,
        now,
      }),
    ),
    price: offer.currentPrice.toString(),
    marketplace: offer.marketplace,
    externalProductId: offer.externalProductId,
    sellerId: offer.sellerId,
    now,
    refreshTtlMinutes: configuration.refreshTtlMinutes,
    expirySafetyMinutes: configuration.expirySafetyMinutes,
  });
  return {
    status: "PREVIEW",
    offerId: offer.id,
    marketplace: offer.marketplace,
    candidates: resolution.candidates.map((coupon) => {
      const snapshot = createCouponSnapshot(coupon);
      const freshness = snapshot
        ? evaluateCouponSnapshotFreshness({
            snapshot,
            now,
            currentPrice: offer.currentPrice.toString(),
            ttlMinutes: configuration.refreshTtlMinutes,
            expirySafetyMinutes: configuration.expirySafetyMinutes,
          })
        : { fresh: false, reason: coupon.resolutionReason };
      return {
        sourceKey: coupon.sourceKey,
        codeConfigured: Boolean(coupon.code),
        source: coupon.source,
        applicability: coupon.resolutionStatus,
        reason: coupon.resolutionReason,
        effectivePrice: coupon.effectivePriceCalculated,
        expiresAt: coupon.expiresAt?.toISOString() ?? null,
        fresh: freshness.fresh,
        freshnessReason: freshness.reason,
      };
    }),
    bestCoupon: resolution.bestCoupon
      ? createCouponSnapshot(resolution.bestCoupon)
      : null,
    externalRequests: 0 as const,
    writes: 0 as const,
    stateModified: false as const,
  };
}

export async function refreshOfferCoupons(input: {
  offerId: string;
  confirmRefresh: boolean;
  database?: PrismaClient;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  providers?: Partial<Record<"SHOPEE" | "MERCADO_LIVRE", CouponProvider>>;
}) {
  if (!input.confirmRefresh) throw new Error("COUPON_REFRESH_NOT_CONFIRMED");
  const database = input.database ?? prisma;
  const environment = input.environment ?? process.env;
  const configuration = resolveCouponIntelligenceConfiguration(environment);
  if (!configuration.enabled) {
    return {
      status: "DISABLED",
      reason: "COUPON_INTELLIGENCE_DISABLED",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    } as const;
  }
  const offer = await database.offer.findUnique({
    where: { id: input.offerId },
    select: {
      id: true,
      marketplace: true,
      externalProductId: true,
      sellerId: true,
      currentPrice: true,
    },
  });
  if (!offer) throw new Error("COUPON_OFFER_NOT_FOUND");
  const marketplaceEnabled =
    offer.marketplace === "SHOPEE"
      ? configuration.shopeeDiscoveryEnabled
      : configuration.mercadoLivreDiscoveryEnabled;
  if (!marketplaceEnabled) {
    return {
      status: "DISABLED",
      reason: "COUPON_MARKETPLACE_DISCOVERY_DISABLED",
      externalRequests: 0,
      writes: 0,
      stateModified: false,
    } as const;
  }
  const now = input.now ?? new Date();
  const provider = providerFor(offer.marketplace, input.providers);
  const discovered = await provider.refreshCoupons({
    offerId: offer.id,
    externalProductId: offer.externalProductId,
    sellerId: offer.sellerId,
    price: offer.currentPrice.toString(),
    now,
  });
  if (!discovered.supported) {
    return {
      status: "UNSUPPORTED",
      reason: sanitizedProviderReason(discovered.reason),
      externalRequests: discovered.externalRequests,
      writes: 0,
      stateModified: false,
    } as const;
  }
  const resolution = resolveBestCoupon({
    candidates: discovered.candidates.slice(
      0,
      configuration.discoveryMaxPerCycle,
    ),
    price: offer.currentPrice.toString(),
    marketplace: offer.marketplace,
    externalProductId: offer.externalProductId,
    sellerId: offer.sellerId,
    now,
    refreshTtlMinutes: configuration.refreshTtlMinutes,
    expirySafetyMinutes: configuration.expirySafetyMinutes,
  });
  const persistableCoupons = resolution.candidates.filter(
    (coupon) => coupon.marketplace === offer.marketplace,
  );
  const sources = [
    ...new Set(
      [
        discovered.source,
        ...persistableCoupons.map((coupon) => coupon.source),
      ].filter((source): source is string => Boolean(source)),
    ),
  ];
  await database.$transaction(async (tx) => {
    const sourceKeys = persistableCoupons.map((coupon) => coupon.sourceKey);
    for (const source of sources) {
      await tx.coupon.updateMany({
        where: {
          offerId: offer.id,
          source,
          sourceKey: { notIn: sourceKeys },
        },
        data: { active: false, selected: false, status: "INACTIVE" },
      });
    }
    for (const coupon of persistableCoupons) {
      await tx.coupon.upsert({
        where: {
          offerId_sourceKey: { offerId: offer.id, sourceKey: coupon.sourceKey },
        },
        update: {
          code: coupon.code ?? null,
          benefitType: coupon.benefitType,
          percentage: coupon.percentage ?? null,
          discountAmount: coupon.fixedAmount ?? null,
          minimumSpend: coupon.minimumSpend ?? null,
          maximumDiscount: coupon.maximumDiscount ?? null,
          startsAt: coupon.startsAt ?? null,
          expiresAt: coupon.expiresAt ?? null,
          autoApply: coupon.autoApply,
          scope: coupon.scope,
          sellerId: coupon.sellerId ?? null,
          productExternalId: coupon.productExternalId ?? null,
          status: coupon.status,
          active: coupon.active,
          selected: coupon.sourceKey === resolution.bestCoupon?.sourceKey,
          lastValidatedAt: coupon.lastValidatedAt,
          applicability:
            coupon.resolutionStatus === "REJECTED"
              ? "NOT_APPLICABLE"
              : coupon.resolutionStatus,
          applicabilityReason: coupon.resolutionReason,
          confidence: coupon.confidence,
          itemPrice: coupon.itemPrice,
          calculatedDiscount: coupon.discountAmountCalculated,
          calculatedEffectivePrice: coupon.effectivePriceCalculated,
          metadata: sanitizedMetadata(coupon.metadata),
        },
        create: {
          offerId: offer.id,
          marketplace: coupon.marketplace,
          externalCouponId: coupon.externalCouponId ?? null,
          sourceKey: coupon.sourceKey,
          code: coupon.code ?? null,
          benefitType: coupon.benefitType,
          percentage: coupon.percentage ?? null,
          discountAmount: coupon.fixedAmount ?? null,
          minimumSpend: coupon.minimumSpend ?? null,
          maximumDiscount: coupon.maximumDiscount ?? null,
          startsAt: coupon.startsAt ?? null,
          expiresAt: coupon.expiresAt ?? null,
          autoApply: coupon.autoApply,
          scope: coupon.scope,
          sellerId: coupon.sellerId ?? null,
          productExternalId: coupon.productExternalId ?? null,
          source: coupon.source,
          status: coupon.status,
          active: coupon.active,
          selected: coupon.sourceKey === resolution.bestCoupon?.sourceKey,
          lastValidatedAt: coupon.lastValidatedAt,
          applicability:
            coupon.resolutionStatus === "REJECTED"
              ? "NOT_APPLICABLE"
              : coupon.resolutionStatus,
          applicabilityReason: coupon.resolutionReason,
          confidence: coupon.confidence,
          itemPrice: coupon.itemPrice,
          calculatedDiscount: coupon.discountAmountCalculated,
          calculatedEffectivePrice: coupon.effectivePriceCalculated,
          metadata: sanitizedMetadata(coupon.metadata),
        },
      });
    }
  });
  return {
    status: "SUCCEEDED",
    reason: null,
    candidates: resolution.candidates.length,
    confirmed: resolution.confirmed,
    conditional: resolution.conditional,
    rejected: resolution.rejected,
    bestCoupon: resolution.bestCoupon
      ? createCouponSnapshot(resolution.bestCoupon)
      : null,
    externalRequests: discovered.externalRequests,
    writes: persistableCoupons.length + sources.length,
    stateModified: true,
  } as const;
}
