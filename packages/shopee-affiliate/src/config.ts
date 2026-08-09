import type {
  ShopeeAffiliateConfiguration,
  ShopeeAffiliateMode,
  ShopeeCategoryRule,
  ShopeeDiscoveryFilters,
  ShopeeRankingWeights,
} from "./types";

const MODES = new Set<ShopeeAffiliateMode>([
  "OFF",
  "DATAFEED",
  "OPEN_API",
  "HYBRID",
]);

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  issue: string,
  issues: string[],
) {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push(issue);
    return fallback;
  }
  return value;
}

export function resolveShopeeAffiliateConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ShopeeAffiliateConfiguration {
  const issues: string[] = [];
  const enabled = environment.SHOPEE_AFFILIATE_ENABLED === "true";
  const requestedMode = (environment.SHOPEE_AFFILIATE_MODE ?? "OFF")
    .trim()
    .toUpperCase();
  const knownMode = MODES.has(requestedMode as ShopeeAffiliateMode);
  if (!knownMode) issues.push("SHOPEE_MODE_INVALID");
  const mode: ShopeeAffiliateMode =
    enabled && knownMode ? (requestedMode as ShopeeAffiliateMode) : "OFF";
  const maxFileBytes = boundedInteger(
    environment.SHOPEE_DATAFEED_MAX_FILE_BYTES,
    536_870_912,
    1_048_576,
    2_147_483_648,
    "SHOPEE_MAX_FILE_BYTES_INVALID",
    issues,
  );
  const maxTrackedItems = boundedInteger(
    environment.SHOPEE_DATAFEED_MAX_TRACKED_ITEMS,
    2_000_000,
    1_000,
    5_000_000,
    "SHOPEE_MAX_TRACKED_ITEMS_INVALID",
    issues,
  );
  if (enabled && requestedMode === "OFF") {
    issues.push("SHOPEE_ENABLED_WITH_OFF_MODE");
  }
  const configurationValid = issues.length === 0;
  const effectiveMode = configurationValid ? mode : "OFF";
  return {
    enabled: configurationValid && enabled && effectiveMode !== "OFF",
    requestedMode,
    mode: effectiveMode,
    state: !configurationValid
      ? "INVALID_CONFIGURATION"
      : effectiveMode === "DATAFEED"
        ? "READY_FOR_DATAFEED"
        : effectiveMode === "OPEN_API" || effectiveMode === "HYBRID"
          ? "WAITING_FOR_OFFICIAL_ACCESS"
          : "DISABLED",
    configurationValid,
    linksVerified:
      effectiveMode === "DATAFEED" &&
      environment.SHOPEE_DATAFEED_LINKS_VERIFIED === "true",
    externalRequestsEnabled: false,
    operationalWritesEnabled: false,
    maxFileBytes,
    maxTrackedItems,
    issues,
  };
}

export const SHOPEE_CATEGORY_CATALOG: readonly ShopeeCategoryRule[] = [
  {
    id: "CELULARES",
    label: "Celulares",
    enabled: true,
    priority: 60,
    minPerCategory: 1,
    maxPerCategory: 2,
    matches: [{ category1: "Mobile & Gadgets", category2: "Mobile Phones" }],
  },
  {
    id: "CASA",
    label: "Casa",
    enabled: true,
    priority: 50,
    minPerCategory: 1,
    maxPerCategory: 2,
    matches: [{ category1: "Home & Living" }],
  },
  {
    id: "MODA",
    label: "Moda",
    enabled: true,
    priority: 40,
    minPerCategory: 1,
    maxPerCategory: 2,
    matches: [
      { category1: "Women Clothes" },
      { category1: "Men Clothes" },
      { category1: "Fashion Accessories" },
    ],
  },
  {
    id: "RELOGIOS",
    label: "Relógios",
    enabled: true,
    priority: 30,
    minPerCategory: 1,
    maxPerCategory: 2,
    matches: [{ category1: "Watches" }],
  },
  {
    id: "AUTOMOTIVO",
    label: "Automotivo",
    enabled: true,
    priority: 20,
    minPerCategory: 1,
    maxPerCategory: 2,
    matches: [{ category1: "Spare Parts and Accessories for Vehicles" }],
  },
  {
    id: "ELETRODOMESTICOS",
    label: "Eletrodomésticos",
    enabled: true,
    priority: 10,
    minPerCategory: 1,
    maxPerCategory: 2,
    matches: [{ category1: "Home Appliances" }],
  },
] as const;

export const DEFAULT_SHOPEE_FILTERS: ShopeeDiscoveryFilters = {
  priceMin: null,
  priceMax: null,
  discountMin: 20,
  itemRatingMin: 4.7,
  shopRatingMin: null,
  allowedConditions: [],
  crossBorderAllowed: false,
  forbiddenWords: [],
  imageRequired: true,
  validProductUrlRequired: true,
};

export const DEFAULT_SHOPEE_RANKING_WEIGHTS: ShopeeRankingWeights = {
  discount: 30,
  itemRating: 30,
  shopRating: 15,
  likes: 10,
  completeness: 15,
};

export const DEFAULT_SHOPEE_SELECTION = {
  minPerCategory: 1,
  maxPerCategory: 2,
  maxTotalPerSession: 12,
  selectionMode: "ROUND_ROBIN" as const,
  backfill: false,
};
