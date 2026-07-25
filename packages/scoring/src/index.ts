export type ScoreWeights = {
  discount: number;
  commission: number;
  rating: number;
  popularity: number;
  freeShipping: number;
  couponValidity: number;
  novelty: number;
};

export type ScoreInput = {
  discountPercentage?: number | null;
  commissionPercentage?: number | null;
  rating?: number | null;
  salesCount?: number | null;
  freeShipping?: boolean | null;
  shippingStatus?: "FREE" | "NOT_FREE" | "UNKNOWN" | string | null;
  couponExpiration?: Date | null;
  collectedAt: Date;
};

export type ScoreBreakdown = {
  total: number;
  discountComponent: number;
  commissionComponent: number;
  ratingComponent: number;
  popularityComponent: number;
  freeShippingComponent: number;
  couponValidityComponent: number;
  noveltyComponent: number;
  scoreCompletenessPercentage: number;
  weights: ScoreWeights;
};

export const defaultScoreWeights: ScoreWeights = {
  discount: 0.25,
  commission: 0.2,
  rating: 0.15,
  popularity: 0.1,
  freeShipping: 0.1,
  couponValidity: 0.1,
  novelty: 0.1,
};

function clamp(value: number, min = 0, max = 100) {
  return Math.min(Math.max(value, min), max);
}

export function calculateOfferScore(
  input: ScoreInput,
  weights: ScoreWeights = defaultScoreWeights,
  now = new Date(),
): ScoreBreakdown {
  const available: Array<{ component: number; weight: number }> = [];
  const discountComponent =
    input.discountPercentage === null || input.discountPercentage === undefined
      ? 0
      : clamp((input.discountPercentage / 50) * 100);
  const commissionComponent =
    input.commissionPercentage === null || input.commissionPercentage === undefined
      ? 0
      : clamp((input.commissionPercentage / 20) * 100);
  const ratingComponent =
    input.rating === null || input.rating === undefined ? 0 : clamp((input.rating / 5) * 100);
  const popularityComponent =
    input.salesCount === null || input.salesCount === undefined
      ? 0
      : clamp(Math.log10(input.salesCount + 1) * 25);
  const normalizedShippingStatus =
    input.shippingStatus ??
    (input.freeShipping === true ? "FREE" : input.freeShipping === false ? "NOT_FREE" : "UNKNOWN");
  const freeShippingComponent = normalizedShippingStatus === "FREE" ? 100 : 0;
  const couponValidityComponent =
    input.couponExpiration && input.couponExpiration > now ? 100 : 0;
  const offerAgeHours = Math.max(0, now.getTime() - input.collectedAt.getTime()) / 36e5;
  const noveltyComponent = clamp(100 - offerAgeHours * 4);

  if (input.discountPercentage !== null && input.discountPercentage !== undefined) {
    available.push({ component: discountComponent, weight: weights.discount });
  }

  if (input.commissionPercentage !== null && input.commissionPercentage !== undefined) {
    available.push({ component: commissionComponent, weight: weights.commission });
  }

  if (input.rating !== null && input.rating !== undefined) {
    available.push({ component: ratingComponent, weight: weights.rating });
  }

  if (input.salesCount !== null && input.salesCount !== undefined) {
    available.push({ component: popularityComponent, weight: weights.popularity });
  }

  if (normalizedShippingStatus !== "UNKNOWN") {
    available.push({ component: freeShippingComponent, weight: weights.freeShipping });
  }

  if (input.couponExpiration !== null && input.couponExpiration !== undefined) {
    available.push({ component: couponValidityComponent, weight: weights.couponValidity });
  }

  available.push({ component: noveltyComponent, weight: weights.novelty });

  const totalWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
  const weightedScore = available.reduce(
    (sum, item) => sum + item.component * item.weight,
    0,
  );
  const total = availableWeight > 0 ? Math.round(weightedScore / availableWeight) : 0;
  const scoreCompletenessPercentage =
    totalWeight > 0 ? Number(((availableWeight / totalWeight) * 100).toFixed(2)) : 0;

  return {
    total,
    discountComponent: Math.round(discountComponent),
    commissionComponent: Math.round(commissionComponent),
    ratingComponent: Math.round(ratingComponent),
    popularityComponent: Math.round(popularityComponent),
    freeShippingComponent,
    couponValidityComponent,
    noveltyComponent: Math.round(noveltyComponent),
    scoreCompletenessPercentage,
    weights,
  };
}
