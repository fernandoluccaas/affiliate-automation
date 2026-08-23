export type ShopeeAdvancedRankingWeights = {
  quality: number;
  discount: number;
  absoluteSavings: number;
  price: number;
  freshness: number;
  historicalPerformance: number;
  commission: number;
  productCooldownPenalty: number;
  sellerCooldownPenalty: number;
  duplicatePenalty: number;
  categoryConcentrationPenalty: number;
  sellerConcentrationPenalty: number;
};

export const DEFAULT_SHOPEE_ADVANCED_RANKING_WEIGHTS: ShopeeAdvancedRankingWeights = {
  quality: 25,
  discount: 20,
  absoluteSavings: 15,
  price: 10,
  freshness: 10,
  historicalPerformance: 15,
  commission: 5,
  productCooldownPenalty: 100,
  sellerCooldownPenalty: 20,
  duplicatePenalty: 40,
  categoryConcentrationPenalty: 5,
  sellerConcentrationPenalty: 10,
};

export type ShopeeAdvancedRankingInput = {
  itemId: string;
  qualityScore: number;
  salePrice: number;
  originalPrice?: number | null;
  discountPercentage?: number | null;
  collectedAt?: Date | null;
  now?: Date;
  commissionPercentage?: number | null;
  clicks?: number | null;
  conversions?: number | null;
  publishedAt?: Date | null;
  sellerLastPublishedAt?: Date | null;
  productCooldownHours?: number;
  sellerCooldownHours?: number;
  duplicateSimilarity?: number;
  categorySelectedCount?: number;
  sellerSelectedCount?: number;
};

export type ShopeeAdvancedScoreBreakdown = {
  quality: number;
  discount: number | null;
  absoluteSavings: number | null;
  price: number;
  freshness: number | null;
  historicalPerformance: number | null;
  commission: number | null;
  productCooldownPenalty: number;
  sellerCooldownPenalty: number;
  duplicatePenalty: number;
  categoryConcentrationPenalty: number;
  sellerConcentrationPenalty: number;
  availablePositiveWeight: number;
};

function bounded(value: number, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function withinCooldown(
  lastAt: Date | null | undefined,
  now: Date,
  cooldownHours: number,
) {
  return Boolean(
    lastAt &&
      cooldownHours > 0 &&
      now.getTime() - lastAt.getTime() < cooldownHours * 3_600_000,
  );
}

export function scoreShopeeAdvancedCandidate(
  input: ShopeeAdvancedRankingInput,
  weightOverrides: Partial<ShopeeAdvancedRankingWeights> = {},
) {
  const weights = {
    ...DEFAULT_SHOPEE_ADVANCED_RANKING_WEIGHTS,
    ...weightOverrides,
  };
  const now = input.now ?? new Date();
  const originalPrice = input.originalPrice ?? null;
  const savings =
    originalPrice !== null && originalPrice > input.salePrice
      ? originalPrice - input.salePrice
      : null;
  const discount =
    input.discountPercentage === null ||
    input.discountPercentage === undefined
      ? null
      : bounded((input.discountPercentage / 60) * 100);
  const absoluteSavings =
    savings === null ? null : bounded(Math.log10(savings + 1) * 35);
  const price = bounded(100 - Math.log10(Math.max(1, input.salePrice)) * 28);
  const freshness = input.collectedAt
    ? bounded(
        100 -
          ((now.getTime() - input.collectedAt.getTime()) / 3_600_000 / 168) *
            100,
      )
    : null;
  const clicks = input.clicks ?? null;
  const conversions = input.conversions ?? null;
  const historicalPerformance =
    clicks !== null && conversions !== null
      ? clicks === 0
        ? 0
        : bounded((conversions / clicks) * 2_000)
      : null;
  const commission =
    input.commissionPercentage === null ||
    input.commissionPercentage === undefined
      ? null
      : bounded((input.commissionPercentage / 20) * 100);
  const positive: Array<[number | null, number]> = [
    [bounded(input.qualityScore), weights.quality],
    [discount, weights.discount],
    [absoluteSavings, weights.absoluteSavings],
    [price, weights.price],
    [freshness, weights.freshness],
    [historicalPerformance, weights.historicalPerformance],
    [commission, weights.commission],
  ];
  const availablePositiveWeight = positive.reduce(
    (total, [value, weight]) => total + (value === null ? 0 : weight),
    0,
  );
  const positiveScore = positive.reduce(
    (total, [value, weight]) =>
      total + (value === null ? 0 : value * weight),
    0,
  );
  const productCooldownPenalty = withinCooldown(
    input.publishedAt,
    now,
    input.productCooldownHours ?? 168,
  )
    ? weights.productCooldownPenalty
    : 0;
  const sellerCooldownPenalty = withinCooldown(
    input.sellerLastPublishedAt,
    now,
    input.sellerCooldownHours ?? 24,
  )
    ? weights.sellerCooldownPenalty
    : 0;
  const duplicatePenalty =
    bounded(input.duplicateSimilarity ?? 0, 0, 1) * weights.duplicatePenalty;
  const categoryConcentrationPenalty =
    Math.max(0, input.categorySelectedCount ?? 0) *
    weights.categoryConcentrationPenalty;
  const sellerConcentrationPenalty =
    Math.max(0, input.sellerSelectedCount ?? 0) *
    weights.sellerConcentrationPenalty;
  const score = bounded(
    (availablePositiveWeight > 0
      ? positiveScore / availablePositiveWeight
      : 0) -
      productCooldownPenalty -
      sellerCooldownPenalty -
      duplicatePenalty -
      categoryConcentrationPenalty -
      sellerConcentrationPenalty,
  );
  return {
    score: rounded(score),
    components: {
      quality: rounded(bounded(input.qualityScore)),
      discount: discount === null ? null : rounded(discount),
      absoluteSavings:
        absoluteSavings === null ? null : rounded(absoluteSavings),
      price: rounded(price),
      freshness: freshness === null ? null : rounded(freshness),
      historicalPerformance:
        historicalPerformance === null
          ? null
          : rounded(historicalPerformance),
      commission: commission === null ? null : rounded(commission),
      productCooldownPenalty: rounded(productCooldownPenalty),
      sellerCooldownPenalty: rounded(sellerCooldownPenalty),
      duplicatePenalty: rounded(duplicatePenalty),
      categoryConcentrationPenalty: rounded(categoryConcentrationPenalty),
      sellerConcentrationPenalty: rounded(sellerConcentrationPenalty),
      availablePositiveWeight,
    } satisfies ShopeeAdvancedScoreBreakdown,
  };
}

export function compareShopeeAdvancedScores(
  left: { itemId: string; score: number },
  right: { itemId: string; score: number },
) {
  return right.score - left.score || left.itemId.localeCompare(right.itemId);
}
