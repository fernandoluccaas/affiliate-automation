import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import {
  DEFAULT_SHOPEE_FILTERS,
  DEFAULT_SHOPEE_RANKING_WEIGHTS,
  DEFAULT_SHOPEE_SELECTION,
  SHOPEE_CATEGORY_CATALOG,
  resolveShopeeAffiliateConfiguration,
} from "./config";
import { DatafeedOfferProvider } from "./parser";
import type {
  ShopeeCategoryRule,
  ShopeeDatafeedInspectResult,
  ShopeeDatafeedIssue,
  ShopeeDatafeedPreviewResult,
  ShopeeDatafeedProduct,
  ShopeeDiscoveryFilters,
  ShopeeLogicalCategory,
  ShopeeRankedCandidate,
  ShopeeRankingWeights,
  ShopeeScoreBreakdown,
} from "./types";
import { urlHost, validateShopeeUrl } from "./validation";

const ISSUE_SAMPLE_LIMIT = 20;
const BUCKET_COUNT = 64;

function increment(map: Map<string, number>, key: string, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function objectFromCounts(map: Map<string, number>) {
  return Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

function safeFiles(files: readonly string[]) {
  const unique = [...new Set(files.map((file) => file.trim()).filter(Boolean))];
  if (unique.length === 0) throw new Error("SHOPEE_DATAFEED_FILE_REQUIRED");
  if (unique.length > 2) throw new Error("SHOPEE_DATAFEED_MAX_TWO_FILES");
  return unique;
}

export async function inspectShopeeDatafeeds(input: {
  files: string[];
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  provider?: DatafeedOfferProvider;
}): Promise<ShopeeDatafeedInspectResult> {
  const startedAt = performance.now();
  const configuration = resolveShopeeAffiliateConfiguration(input.environment);
  const files = safeFiles(input.files);
  const seen = new Set<string>();
  const categoryCounts = new Map<string, number>();
  const issueCounts = new Map<string, number>();
  const issueSamples: ShopeeDatafeedIssue[] = [];
  let duplicates = 0;
  const provider = input.provider ?? new DatafeedOfferProvider();
  const summaries = await provider.stream({
    files,
    linksVerified: configuration.linksVerified,
    maxFileBytes: configuration.maxFileBytes,
    ...(input.signal ? { signal: input.signal } : {}),
    onProduct(product) {
      if (
        seen.size >= configuration.maxTrackedItems &&
        !seen.has(product.itemId)
      ) {
        throw new Error("SHOPEE_DATAFEED_IDENTITY_LIMIT_EXCEEDED");
      }
      if (seen.has(product.itemId)) duplicates += 1;
      else seen.add(product.itemId);
      increment(categoryCounts, product.category1);
    },
    onIssue(issue) {
      increment(issueCounts, issue.code);
      if (issueSamples.length < ISSUE_SAMPLE_LIMIT) issueSamples.push(issue);
    },
  });
  return {
    status: "INSPECTED",
    files: summaries,
    rowsProcessed: summaries.reduce((sum, item) => sum + item.rowsProcessed, 0),
    validRows: summaries.reduce((sum, item) => sum + item.validRows, 0),
    invalidRows: summaries.reduce((sum, item) => sum + item.invalidRows, 0),
    duplicateItems: duplicates,
    categories: objectFromCounts(categoryCounts),
    validProductUrls: summaries.reduce(
      (sum, item) => sum + item.validProductUrls,
      0,
    ),
    candidateShortLinks: summaries.reduce(
      (sum, item) => sum + item.candidateShortLinks,
      0,
    ),
    issuesByCode: objectFromCounts(issueCounts),
    issueSamples,
    durationMs: Math.round(performance.now() - startedAt),
    stateModified: false,
  };
}

function completeness(product: ShopeeDatafeedProduct) {
  const fields = [
    product.description,
    product.originalPrice,
    product.discountPercentage,
    product.itemRating,
    product.shopRating,
    product.likeCount,
    product.condition,
    product.crossBorder,
    product.category2,
    product.category3,
    product.shopName,
    product.secondaryImageUrl,
    product.candidateAffiliateUrl,
    product.modelIds,
    product.modelNames,
  ];
  return fields.filter((value) => value !== null && value !== "").length;
}

function deterministicPrimary(
  left: ShopeeDatafeedProduct,
  right: ShopeeDatafeedProduct,
) {
  const completenessDelta = completeness(right) - completeness(left);
  if (completenessDelta !== 0) return completenessDelta > 0 ? right : left;
  const priority = { OFFICIAL_BR: 2, BRAZIL: 1 } as const;
  const priorityDelta = priority[right.source] - priority[left.source];
  if (priorityDelta !== 0) return priorityDelta > 0 ? right : left;
  const leftKey = `${left.title}\0${left.sourceProductUrl}`;
  const rightKey = `${right.title}\0${right.sourceProductUrl}`;
  return rightKey.localeCompare(leftKey) < 0 ? right : left;
}

export function mergeShopeeDatafeedProducts(
  left: ShopeeDatafeedProduct,
  right: ShopeeDatafeedProduct,
  conflicts: Map<string, number>,
) {
  for (const [field, leftValue, rightValue] of [
    ["PRICE", left.salePrice, right.salePrice],
    ["DISCOUNT", left.discountPercentage, right.discountPercentage],
    ["ITEM_RATING", left.itemRating, right.itemRating],
    ["SHOP_RATING", left.shopRating, right.shopRating],
  ] as const) {
    if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
      increment(conflicts, `CONFLICT_${field}`);
    }
  }
  const primary = deterministicPrimary(left, right);
  const secondary = primary === left ? right : left;
  const merged = { ...primary };
  for (const key of Object.keys(merged) as Array<keyof ShopeeDatafeedProduct>) {
    const current = merged[key];
    const fallback = secondary[key];
    if (
      (current === null ||
        current === "" ||
        (Array.isArray(current) && current.length === 0)) &&
      fallback !== null &&
      fallback !== ""
    ) {
      // The assignment is safe because both values come from the same typed field.
      (merged as Record<string, unknown>)[key] = fallback;
    }
  }
  merged.sources = [...new Set([...left.sources, ...right.sources])].sort();
  return merged;
}

export function matchShopeeCategory(
  product: ShopeeDatafeedProduct,
  categories: readonly ShopeeCategoryRule[] = SHOPEE_CATEGORY_CATALOG,
) {
  return (
    categories.find(
      (category) =>
        category.enabled &&
        category.matches.some(
          (rule) =>
            product.category1 === rule.category1 &&
            (!rule.category2 || product.category2 === rule.category2),
        ),
    ) ?? null
  );
}

export function filterShopeeCandidate(
  product: ShopeeDatafeedProduct,
  filters: ShopeeDiscoveryFilters,
) {
  if (filters.priceMin !== null && product.salePrice < filters.priceMin)
    return "PRICE_BELOW_MINIMUM";
  if (filters.priceMax !== null && product.salePrice > filters.priceMax)
    return "PRICE_ABOVE_MAXIMUM";
  if (
    filters.discountMin !== null &&
    (product.discountPercentage === null ||
      product.discountPercentage < filters.discountMin)
  )
    return "DISCOUNT_BELOW_MINIMUM";
  if (
    filters.itemRatingMin !== null &&
    (product.itemRating === null || product.itemRating < filters.itemRatingMin)
  )
    return "ITEM_RATING_BELOW_MINIMUM";
  if (
    filters.shopRatingMin !== null &&
    product.shopRating !== null &&
    product.shopRating < filters.shopRatingMin
  )
    return "SHOP_RATING_BELOW_MINIMUM";
  if (
    filters.allowedConditions.length > 0 &&
    product.condition !== null &&
    !filters.allowedConditions.some(
      (condition) =>
        condition.toLowerCase() === product.condition?.toLowerCase(),
    )
  )
    return "CONDITION_NOT_ALLOWED";
  if (!filters.crossBorderAllowed && product.crossBorder === true)
    return "CROSS_BORDER_NOT_ALLOWED";
  const normalizedTitle = product.title.toLocaleLowerCase("pt-BR");
  if (
    filters.forbiddenWords.some((word) =>
      normalizedTitle.includes(word.toLocaleLowerCase("pt-BR")),
    )
  )
    return "FORBIDDEN_WORD";
  if (filters.imageRequired && !validateShopeeUrl(product.imageUrl, "IMAGE"))
    return "IMAGE_REQUIRED";
  if (
    filters.validProductUrlRequired &&
    !validateShopeeUrl(product.sourceProductUrl, "PRODUCT")
  )
    return "PRODUCT_URL_REQUIRED";
  return null;
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

export function scoreShopeeCandidate(
  product: ShopeeDatafeedProduct,
  weights: ShopeeRankingWeights = DEFAULT_SHOPEE_RANKING_WEIGHTS,
  diversityPenalty = 0,
) {
  const components: ShopeeScoreBreakdown = {
    discountScore:
      product.discountPercentage === null
        ? null
        : Math.min(100, (product.discountPercentage / 60) * 100),
    itemRatingScore:
      product.itemRating === null ? null : (product.itemRating / 5) * 100,
    shopRatingScore:
      product.shopRating === null ? null : (product.shopRating / 5) * 100,
    likeScore:
      product.likeCount === null
        ? null
        : Math.min(100, Math.log10(product.likeCount + 1) * 25),
    completenessScore: (completeness(product) / 15) * 100,
    diversityPenalty: Math.max(0, diversityPenalty),
  };
  const values: Array<[number | null, number]> = [
    [components.discountScore, weights.discount],
    [components.itemRatingScore, weights.itemRating],
    [components.shopRatingScore, weights.shopRating],
    [components.likeScore, weights.likes],
    [components.completenessScore, weights.completeness],
  ];
  const availableWeight = values.reduce(
    (sum, [value, weight]) => sum + (value === null ? 0 : weight),
    0,
  );
  const weighted = values.reduce(
    (sum, [value, weight]) => sum + (value === null ? 0 : value * weight),
    0,
  );
  return {
    score: rounded(
      Math.max(
        0,
        (availableWeight ? weighted / availableWeight : 0) - diversityPenalty,
      ),
    ),
    components: {
      ...components,
      discountScore:
        components.discountScore === null
          ? null
          : rounded(components.discountScore),
      itemRatingScore:
        components.itemRatingScore === null
          ? null
          : rounded(components.itemRatingScore),
      shopRatingScore:
        components.shopRatingScore === null
          ? null
          : rounded(components.shopRatingScore),
      likeScore:
        components.likeScore === null ? null : rounded(components.likeScore),
      completenessScore: rounded(components.completenessScore),
    },
  };
}

function compareRanked(
  left: ShopeeRankedCandidate,
  right: ShopeeRankedCandidate,
) {
  return (
    right.score - left.score ||
    (right.discountPercentage ?? -1) - (left.discountPercentage ?? -1) ||
    (right.itemRating ?? -1) - (left.itemRating ?? -1) ||
    left.itemId.localeCompare(right.itemId)
  );
}

function normalizedCategories(categories: readonly ShopeeCategoryRule[]) {
  return categories
    .map((category, index) => ({
      ...category,
      priority: Number.isFinite(category.priority) ? category.priority : 0,
      minPerCategory: Math.max(
        0,
        Math.min(2, Math.trunc(category.minPerCategory)),
      ),
      maxPerCategory: Math.max(
        1,
        Math.min(10, Math.trunc(category.maxPerCategory)),
      ),
      index,
    }))
    .map((category) => ({
      ...category,
      minPerCategory: Math.min(
        category.minPerCategory,
        category.maxPerCategory,
      ),
    }))
    .filter((category) => category.enabled)
    .sort(
      (left, right) =>
        right.priority - left.priority || left.index - right.index,
    );
}

export function selectShopeeRoundRobin(input: {
  pools: Map<ShopeeLogicalCategory, ShopeeRankedCandidate[]>;
  categories?: readonly ShopeeCategoryRule[];
  maxTotal?: number;
  backfill?: boolean;
  maxPerShop?: number;
}) {
  const categories = normalizedCategories(
    input.categories ?? SHOPEE_CATEGORY_CATALOG,
  );
  const maxTotal = Math.max(1, Math.min(100, input.maxTotal ?? 12));
  const selected: ShopeeRankedCandidate[] = [];
  const counts = new Map<ShopeeLogicalCategory, number>();
  const cursors = new Map<ShopeeLogicalCategory, number>();
  const shopCounts = new Map<string, number>();
  const maxPerShop = Math.max(1, Math.min(12, input.maxPerShop ?? 2));
  const fill = (limit: "minPerCategory" | "maxPerCategory") => {
    let progressed = true;
    while (progressed && selected.length < maxTotal) {
      progressed = false;
      for (const category of categories) {
        if (selected.length >= maxTotal) break;
        const count = counts.get(category.id) ?? 0;
        if (count >= category[limit]) continue;
        let cursor = cursors.get(category.id) ?? 0;
        const pool = input.pools.get(category.id) ?? [];
        let candidate = pool[cursor];
        while (candidate?.shopName?.trim()) {
          const shopKey = candidate.shopName.trim().toLocaleLowerCase("pt-BR");
          if ((shopCounts.get(shopKey) ?? 0) < maxPerShop) break;
          cursor += 1;
          candidate = pool[cursor];
        }
        cursors.set(category.id, cursor);
        if (!candidate) continue;
        selected.push(candidate);
        counts.set(category.id, count + 1);
        cursors.set(category.id, cursor + 1);
        if (candidate.shopName?.trim()) {
          const shopKey = candidate.shopName.trim().toLocaleLowerCase("pt-BR");
          shopCounts.set(shopKey, (shopCounts.get(shopKey) ?? 0) + 1);
        }
        progressed = true;
      }
    }
  };
  fill("minPerCategory");
  const minimumsMet = categories.every(
    (category) => (counts.get(category.id) ?? 0) >= category.minPerCategory,
  );
  if (minimumsMet || input.backfill === true) fill("maxPerCategory");
  return { selected, counts };
}

async function writeWithBackpressure(
  writer: ReturnType<typeof createWriteStream>,
  value: string,
) {
  if (!writer.write(value)) await once(writer, "drain");
}

async function closeWriter(writer: ReturnType<typeof createWriteStream>) {
  writer.end();
  await once(writer, "finish");
}

function bucketFor(itemId: string) {
  return (
    Number.parseInt(
      createHash("sha256").update(itemId).digest("hex").slice(0, 8),
      16,
    ) % BUCKET_COUNT
  );
}

function compactProduct(product: ShopeeDatafeedProduct) {
  return { ...product, description: null };
}

export async function previewShopeeDatafeeds(input: {
  files: string[];
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  provider?: DatafeedOfferProvider;
  categories?: ShopeeCategoryRule[];
  filters?: Partial<ShopeeDiscoveryFilters>;
  weights?: Partial<ShopeeRankingWeights>;
  maxTotal?: number;
  backfill?: boolean;
  recentItemIds?: readonly string[];
  maxPerShop?: number;
}): Promise<ShopeeDatafeedPreviewResult> {
  const startedAt = performance.now();
  const configuration = resolveShopeeAffiliateConfiguration(input.environment);
  const files = safeFiles(input.files);
  const categories = normalizedCategories(
    input.categories ?? SHOPEE_CATEGORY_CATALOG,
  );
  const filters = { ...DEFAULT_SHOPEE_FILTERS, ...input.filters };
  const weights = { ...DEFAULT_SHOPEE_RANKING_WEIGHTS, ...input.weights };
  const recentItemIds = new Set(input.recentItemIds ?? []);
  const tempPrefix = join(tmpdir(), "affiliate-shopee-preview-");
  const temporaryDirectory = await mkdtemp(tempPrefix);
  const writers = new Map<number, ReturnType<typeof createWriteStream>>();
  const issues = new Map<string, number>();
  const conflicts = new Map<string, number>();
  const rejected = new Map<string, number>();
  const categoryCandidates = new Map<ShopeeLogicalCategory, number>();
  const categoryEligible = new Map<ShopeeLogicalCategory, number>();
  const categoryRejected = new Map<ShopeeLogicalCategory, number>();
  let duplicates = 0;
  try {
    const provider = input.provider ?? new DatafeedOfferProvider();
    const summaries = await provider.stream({
      files,
      linksVerified: configuration.linksVerified,
      maxFileBytes: configuration.maxFileBytes,
      ...(input.signal ? { signal: input.signal } : {}),
      async onProduct(product) {
        const bucket = bucketFor(product.itemId);
        let writer = writers.get(bucket);
        if (!writer) {
          await mkdir(temporaryDirectory, { recursive: true });
          writer = createWriteStream(
            join(temporaryDirectory, `${bucket}.ndjson`),
            {
              encoding: "utf8",
              flags: "a",
            },
          );
          writers.set(bucket, writer);
        }
        await writeWithBackpressure(
          writer,
          `${JSON.stringify(compactProduct(product))}\n`,
        );
      },
      onIssue(issue) {
        increment(issues, issue.code);
      },
    });
    await Promise.all([...writers.values()].map(closeWriter));
    const pools = new Map<ShopeeLogicalCategory, ShopeeRankedCandidate[]>(
      categories.map((category) => [category.id, []]),
    );
    for (const [bucket] of [...writers.entries()].sort(([a], [b]) => a - b)) {
      const reader = createInterface({
        input: (await import("node:fs")).createReadStream(
          join(temporaryDirectory, `${bucket}.ndjson`),
          { encoding: "utf8", highWaterMark: 64 * 1024 },
        ),
        crlfDelay: Infinity,
      });
      const byItem = new Map<string, ShopeeDatafeedProduct>();
      for await (const line of reader) {
        if (input.signal?.aborted) throw new Error("SHOPEE_DATAFEED_ABORTED");
        const product = JSON.parse(line) as ShopeeDatafeedProduct;
        const previous = byItem.get(product.itemId);
        if (previous) {
          duplicates += 1;
          byItem.set(
            product.itemId,
            mergeShopeeDatafeedProducts(previous, product, conflicts),
          );
        } else {
          if (byItem.size >= configuration.maxTrackedItems) {
            throw new Error("SHOPEE_DATAFEED_IDENTITY_LIMIT_EXCEEDED");
          }
          byItem.set(product.itemId, product);
        }
      }
      for (const product of byItem.values()) {
        const category = matchShopeeCategory(product, categories);
        if (!category) continue;
        increment(categoryCandidates, category.id);
        if (recentItemIds.has(product.itemId)) {
          increment(rejected, "RECENTLY_SELECTED");
          increment(categoryRejected, category.id);
          continue;
        }
        const rejection = filterShopeeCandidate(product, filters);
        if (rejection) {
          increment(rejected, rejection);
          increment(categoryRejected, category.id);
          continue;
        }
        increment(categoryEligible, category.id);
        const scored = scoreShopeeCandidate(product, weights);
        const candidate: ShopeeRankedCandidate = {
          itemId: product.itemId,
          title: product.title.slice(0, 180),
          category: category.id,
          salePrice: product.salePrice,
          originalPrice: product.originalPrice,
          discountPercentage: product.discountPercentage,
          itemRating: product.itemRating,
          shopRating: product.shopRating,
          shopName: product.shopName,
          imageUrl: product.imageUrl,
          sourceProductHost: urlHost(product.sourceProductUrl) ?? "invalid",
          candidateLinkHost: urlHost(product.candidateAffiliateUrl),
          linkStatus: product.verifiedAffiliateUrl
            ? "VERIFIED"
            : product.candidateAffiliateUrl
              ? "NOT_VERIFIED"
              : "MISSING",
          score: scored.score,
          components: scored.components,
          sources: product.sources,
        };
        const pool = pools.get(category.id) ?? [];
        pool.push(candidate);
        pool.sort(compareRanked);
        pool.splice(Math.min(100, Math.max(category.maxPerCategory, 20)));
        pools.set(category.id, pool);
      }
    }
    const selection = selectShopeeRoundRobin({
      pools,
      categories,
      maxTotal: input.maxTotal ?? DEFAULT_SHOPEE_SELECTION.maxTotalPerSession,
      backfill: input.backfill ?? DEFAULT_SHOPEE_SELECTION.backfill,
      maxPerShop:
        input.maxPerShop ?? configuration.maxPerShopPerSession,
    });
    return {
      status: "PREVIEW_COMPLETED",
      files: summaries,
      rowsProcessed: summaries.reduce(
        (sum, file) => sum + file.rowsProcessed,
        0,
      ),
      validRows: summaries.reduce((sum, file) => sum + file.validRows, 0),
      invalidRows: summaries.reduce((sum, file) => sum + file.invalidRows, 0),
      duplicateItems: duplicates,
      mergeConflicts: [...conflicts.values()].reduce(
        (sum, value) => sum + value,
        0,
      ),
      conflictsByCode: objectFromCounts(conflicts),
      rejectedByCode: objectFromCounts(rejected),
      categories: categories.map((category) => {
        const selected = selection.counts.get(category.id) ?? 0;
        return {
          id: category.id,
          label: category.label,
          candidates: categoryCandidates.get(category.id) ?? 0,
          eligible: categoryEligible.get(category.id) ?? 0,
          rejected: categoryRejected.get(category.id) ?? 0,
          selected,
          quotaMet: selected >= category.minPerCategory,
        };
      }),
      selected: selection.selected,
      linksVerified: configuration.linksVerified,
      publicationAllowed: false,
      databaseWrites: 0,
      publicationsCreated: 0,
      messagesSent: 0,
      durationMs: Math.round(performance.now() - startedAt),
      stateModified: false,
    };
  } finally {
    for (const writer of writers.values()) {
      if (!writer.closed) writer.destroy();
    }
    const expectedRoot = join(tmpdir(), "affiliate-shopee-preview-");
    if (temporaryDirectory.startsWith(expectedRoot)) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export async function collectSelectedShopeeProducts(input: {
  files: string[];
  selected: readonly ShopeeRankedCandidate[];
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  provider?: DatafeedOfferProvider;
}) {
  const configuration = resolveShopeeAffiliateConfiguration(input.environment);
  const wanted = new Set(
    input.selected.slice(0, 12).map((item) => item.itemId),
  );
  const products = new Map<string, ShopeeDatafeedProduct>();
  const conflicts = new Map<string, number>();
  const provider = input.provider ?? new DatafeedOfferProvider();
  await provider.stream({
    files: safeFiles(input.files),
    linksVerified: configuration.linksVerified,
    maxFileBytes: configuration.maxFileBytes,
    ...(input.signal ? { signal: input.signal } : {}),
    onProduct(product) {
      if (!wanted.has(product.itemId)) return;
      const previous = products.get(product.itemId);
      products.set(
        product.itemId,
        previous
          ? mergeShopeeDatafeedProducts(previous, product, conflicts)
          : product,
      );
    },
  });
  return input.selected.slice(0, 12).flatMap((candidate) => {
    const product = products.get(candidate.itemId);
    return product ? [{ candidate, product }] : [];
  });
}
