export const MULTI_CATEGORY_SELECTION_MODE = "ROUND_ROBIN" as const;

export type MultiCategoryRuntimeConfig = {
  enabled: boolean;
  minOffersPerCategory: number;
  maxOffersPerCategory: number;
  maxTotalPerSession: number;
  selectionMode: typeof MULTI_CATEGORY_SELECTION_MODE;
  allowCategoryBackfill: boolean;
  issues: string[];
};

export type MultiCategorySetting = {
  categoryId: string;
  name?: string | null;
  enabled: boolean;
  priority: number;
  minOffers?: number | null;
  maxOffers?: number | null;
  isLeaf?: boolean;
};

export type MultiCategorySelectionCandidate = {
  offerId: string;
  productId: string;
  sourceCategoryIds: string[];
  score: number | null;
  bestSellerPosition: number | null;
  discountPercentage: number | null;
  completenessPercentage: number | null;
  eligible: boolean;
  rejectionReason?: string | null;
};

export type MultiCategoryCategoryResult = {
  categoryId: string;
  requested: number;
  valid: number;
  rejected: number;
  withoutAffiliateLink: number;
  selected: number;
  minimum: number;
  maximum: number;
  quotaMet: boolean;
  reason: string | null;
};

export type MultiCategorySelectionResult = {
  selected: Array<
    MultiCategorySelectionCandidate & { primaryCategoryId: string }
  >;
  orderedOfferIds: string[];
  categories: MultiCategoryCategoryResult[];
  crossCategoryDuplicates: number;
  duplicateOfferIds: string[];
  quotaMet: number;
  quotaNotMet: number;
};

type Environment = Record<string, string | undefined>;

function integerSetting(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  code: string,
  issues: string[],
) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    if (value !== undefined && value !== null && value !== "")
      issues.push(code);
    return fallback;
  }
  return parsed;
}

function enabled(value: unknown) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

export function resolveMultiCategoryRuntimeConfig(
  environment: Environment = process.env,
  persisted: Partial<
    Omit<MultiCategoryRuntimeConfig, "issues" | "selectionMode">
  > & { selectionMode?: string } = {},
): MultiCategoryRuntimeConfig {
  const issues: string[] = [];
  const envEnabled = enabled(environment.MULTI_CATEGORY_DISCOVERY_ENABLED);
  const minOffersPerCategory = integerSetting(
    persisted.minOffersPerCategory ??
      environment.MULTI_CATEGORY_MIN_OFFERS_PER_CATEGORY,
    1,
    0,
    2,
    "INVALID_MIN_OFFERS_PER_CATEGORY",
    issues,
  );
  let maxOffersPerCategory = integerSetting(
    persisted.maxOffersPerCategory ??
      environment.MULTI_CATEGORY_MAX_OFFERS_PER_CATEGORY,
    2,
    1,
    10,
    "INVALID_MAX_OFFERS_PER_CATEGORY",
    issues,
  );
  if (maxOffersPerCategory < minOffersPerCategory) {
    issues.push("MAX_OFFERS_BELOW_MINIMUM");
    maxOffersPerCategory = Math.max(1, minOffersPerCategory);
  }
  const maxTotalPerSession = integerSetting(
    persisted.maxTotalPerSession ??
      environment.MULTI_CATEGORY_MAX_TOTAL_PER_SESSION,
    12,
    1,
    100,
    "INVALID_MAX_TOTAL_PER_SESSION",
    issues,
  );
  const requestedMode = String(
    persisted.selectionMode ??
      environment.MULTI_CATEGORY_SELECTION_MODE ??
      MULTI_CATEGORY_SELECTION_MODE,
  ).toUpperCase();
  const selectionMode = MULTI_CATEGORY_SELECTION_MODE;
  if (requestedMode !== selectionMode) issues.push("INVALID_SELECTION_MODE");
  const allowCategoryBackfill =
    persisted.allowCategoryBackfill ??
    enabled(environment.MULTI_CATEGORY_ALLOW_CATEGORY_BACKFILL);

  return {
    enabled: envEnabled && persisted.enabled !== false,
    minOffersPerCategory,
    maxOffersPerCategory,
    maxTotalPerSession,
    selectionMode,
    allowCategoryBackfill,
    issues,
  };
}

export function normalizeMultiCategorySettings(
  categoryIds: readonly string[],
  value: unknown,
): MultiCategorySetting[] {
  const raw = Array.isArray(value) ? value : [];
  const byId = new Map<string, MultiCategorySetting>();

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const categoryId = String(record.categoryId ?? "").trim();
    if (!categoryId || byId.has(categoryId)) continue;
    byId.set(categoryId, {
      categoryId,
      name: typeof record.name === "string" ? record.name.slice(0, 160) : null,
      enabled: record.enabled !== false,
      priority: Number.isInteger(Number(record.priority))
        ? Math.max(-100, Math.min(100, Number(record.priority)))
        : 0,
      minOffers:
        record.minOffers === null || record.minOffers === undefined
          ? null
          : Number(record.minOffers),
      maxOffers:
        record.maxOffers === null || record.maxOffers === undefined
          ? null
          : Number(record.maxOffers),
      isLeaf: record.isLeaf !== false,
    });
  }

  return [...new Set(categoryIds.map((id) => id.trim()).filter(Boolean))].map(
    (categoryId) =>
      byId.get(categoryId) ?? {
        categoryId,
        name: null,
        enabled: true,
        priority: 0,
        minOffers: null,
        maxOffers: null,
        isLeaf: true,
      },
  );
}

function compareCandidates(
  left: MultiCategorySelectionCandidate,
  right: MultiCategorySelectionCandidate,
) {
  const score = (right.score ?? -1) - (left.score ?? -1);
  if (score !== 0) return score;
  const rank =
    (left.bestSellerPosition ?? Number.MAX_SAFE_INTEGER) -
    (right.bestSellerPosition ?? Number.MAX_SAFE_INTEGER);
  if (rank !== 0) return rank;
  const discount =
    (right.discountPercentage ?? -1) - (left.discountPercentage ?? -1);
  if (discount !== 0) return discount;
  const completeness =
    (right.completenessPercentage ?? -1) - (left.completenessPercentage ?? -1);
  if (completeness !== 0) return completeness;
  return left.offerId.localeCompare(right.offerId);
}

function categoryLimits(
  setting: MultiCategorySetting,
  config: MultiCategoryRuntimeConfig,
) {
  const minimum = integerSetting(
    setting.minOffers,
    config.minOffersPerCategory,
    0,
    config.maxOffersPerCategory,
    "INVALID_CATEGORY_MINIMUM",
    [],
  );
  const maximum = integerSetting(
    setting.maxOffers,
    config.maxOffersPerCategory,
    1,
    10,
    "INVALID_CATEGORY_MAXIMUM",
    [],
  );
  return { minimum: Math.min(minimum, maximum), maximum };
}

export function selectBalancedMultiCategoryOffers(input: {
  settings: readonly MultiCategorySetting[];
  candidates: readonly MultiCategorySelectionCandidate[];
  config: MultiCategoryRuntimeConfig;
}): MultiCategorySelectionResult {
  const settings = input.settings
    .filter((setting) => setting.enabled && setting.isLeaf !== false)
    .map((setting, index) => ({ setting, index }))
    .sort(
      (left, right) =>
        right.setting.priority - left.setting.priority ||
        left.index - right.index,
    )
    .map(({ setting }) => setting);
  const categoryOrder = new Map(
    settings.map((setting, index) => [setting.categoryId, index]),
  );
  const requested = new Map(settings.map((setting) => [setting.categoryId, 0]));
  const rejected = new Map(settings.map((setting) => [setting.categoryId, 0]));
  const withoutLink = new Map(
    settings.map((setting) => [setting.categoryId, 0]),
  );
  const pools = new Map(
    settings.map((setting) => [
      setting.categoryId,
      [] as MultiCategorySelectionCandidate[],
    ]),
  );
  const duplicateOfferIds = new Set<string>();
  let crossCategoryDuplicates = 0;

  for (const candidate of input.candidates) {
    const categories = [...new Set(candidate.sourceCategoryIds)]
      .filter((categoryId) => categoryOrder.has(categoryId))
      .sort(
        (left, right) =>
          (categoryOrder.get(left) ?? 0) - (categoryOrder.get(right) ?? 0),
      );
    for (const categoryId of categories) {
      requested.set(categoryId, (requested.get(categoryId) ?? 0) + 1);
    }
    if (categories.length === 0) continue;
    if (categories.length > 1) {
      crossCategoryDuplicates += categories.length - 1;
      duplicateOfferIds.add(candidate.offerId);
    }
    const primaryCategoryId = categories[0] as string;
    if (!candidate.eligible) {
      rejected.set(
        primaryCategoryId,
        (rejected.get(primaryCategoryId) ?? 0) + 1,
      );
      if (candidate.rejectionReason === "AFFILIATE_LINK_REQUIRED") {
        withoutLink.set(
          primaryCategoryId,
          (withoutLink.get(primaryCategoryId) ?? 0) + 1,
        );
      }
      continue;
    }
    pools.get(primaryCategoryId)?.push(candidate);
  }

  for (const pool of pools.values()) pool.sort(compareCandidates);
  const selected: Array<
    MultiCategorySelectionCandidate & { primaryCategoryId: string }
  > = [];
  const selectedIds = new Set<string>();
  const selectedPerCategory = new Map(
    settings.map((setting) => [setting.categoryId, 0]),
  );
  const cursors = new Map(settings.map((setting) => [setting.categoryId, 0]));

  const fillRoundRobin = (limit: "minimum" | "maximum") => {
    let progress = true;
    while (progress && selected.length < input.config.maxTotalPerSession) {
      progress = false;
      for (const setting of settings) {
        if (selected.length >= input.config.maxTotalPerSession) break;
        const limits = categoryLimits(setting, input.config);
        const count = selectedPerCategory.get(setting.categoryId) ?? 0;
        if (count >= limits[limit]) continue;
        const pool = pools.get(setting.categoryId) ?? [];
        let cursor = cursors.get(setting.categoryId) ?? 0;
        while (cursor < pool.length && selectedIds.has(pool[cursor]!.offerId)) {
          cursor += 1;
        }
        cursors.set(setting.categoryId, cursor + 1);
        const candidate = pool[cursor];
        if (!candidate) continue;
        selected.push({ ...candidate, primaryCategoryId: setting.categoryId });
        selectedIds.add(candidate.offerId);
        selectedPerCategory.set(setting.categoryId, count + 1);
        progress = true;
      }
    }
  };

  fillRoundRobin("minimum");
  const allMinimumsMet = settings.every((setting) => {
    const limits = categoryLimits(setting, input.config);
    return (selectedPerCategory.get(setting.categoryId) ?? 0) >= limits.minimum;
  });
  if (allMinimumsMet || input.config.allowCategoryBackfill) {
    fillRoundRobin("maximum");
  }

  const categories = settings.map((setting): MultiCategoryCategoryResult => {
    const limits = categoryLimits(setting, input.config);
    const selectedCount = selectedPerCategory.get(setting.categoryId) ?? 0;
    const requestedCount = requested.get(setting.categoryId) ?? 0;
    const quotaMet = selectedCount >= limits.minimum;
    return {
      categoryId: setting.categoryId,
      requested: requestedCount,
      valid: pools.get(setting.categoryId)?.length ?? 0,
      rejected: rejected.get(setting.categoryId) ?? 0,
      withoutAffiliateLink: withoutLink.get(setting.categoryId) ?? 0,
      selected: selectedCount,
      minimum: limits.minimum,
      maximum: limits.maximum,
      quotaMet,
      reason: quotaMet
        ? null
        : requestedCount === 0
          ? "CATEGORY_WITHOUT_RESULTS"
          : "CATEGORY_QUOTA_NOT_MET",
    };
  });

  return {
    selected,
    orderedOfferIds: selected.map((candidate) => candidate.offerId),
    categories,
    crossCategoryDuplicates,
    duplicateOfferIds: [...duplicateOfferIds].sort(),
    quotaMet: categories.filter((category) => category.quotaMet).length,
    quotaNotMet: categories.filter((category) => !category.quotaMet).length,
  };
}

export function sanitizeMultiCategorySummary(
  result: MultiCategorySelectionResult,
) {
  return {
    categories: result.categories,
    selectedOfferIds: result.orderedOfferIds,
    distribution: result.selected.map((candidate, index) => ({
      position: index + 1,
      categoryId: candidate.primaryCategoryId,
      offerId: candidate.offerId,
    })),
    crossCategoryDuplicates: result.crossCategoryDuplicates,
    quotaMet: result.quotaMet,
    quotaNotMet: result.quotaNotMet,
  };
}
