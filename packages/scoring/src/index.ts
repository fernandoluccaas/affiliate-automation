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
  discountPercentage: number;
  commissionPercentage?: number;
  rating?: number;
  salesCount?: number;
  freeShipping: boolean;
  couponExpiration?: Date;
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
  const discountComponent = clamp((input.discountPercentage / 50) * 100);
  const commissionComponent = clamp(((input.commissionPercentage ?? 0) / 20) * 100);
  const ratingComponent = clamp(((input.rating ?? 0) / 5) * 100);
  const popularityComponent = clamp(Math.log10((input.salesCount ?? 0) + 1) * 25);
  const freeShippingComponent = input.freeShipping ? 100 : 0;
  const couponValidityComponent =
    input.couponExpiration && input.couponExpiration > now ? 100 : 0;
  const offerAgeHours = Math.max(0, now.getTime() - input.collectedAt.getTime()) / 36e5;
  const noveltyComponent = clamp(100 - offerAgeHours * 4);

  const total = Math.round(
    discountComponent * weights.discount +
      commissionComponent * weights.commission +
      ratingComponent * weights.rating +
      popularityComponent * weights.popularity +
      freeShippingComponent * weights.freeShipping +
      couponValidityComponent * weights.couponValidity +
      noveltyComponent * weights.novelty,
  );

  return {
    total,
    discountComponent: Math.round(discountComponent),
    commissionComponent: Math.round(commissionComponent),
    ratingComponent: Math.round(ratingComponent),
    popularityComponent: Math.round(popularityComponent),
    freeShippingComponent,
    couponValidityComponent,
    noveltyComponent: Math.round(noveltyComponent),
    weights,
  };
}
