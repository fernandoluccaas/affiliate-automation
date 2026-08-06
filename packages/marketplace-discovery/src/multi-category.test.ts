import { describe, expect, it } from "vitest";
import {
  normalizeMultiCategorySettings,
  resolveMultiCategoryRuntimeConfig,
  selectBalancedMultiCategoryOffers,
  type MultiCategorySelectionCandidate,
  type MultiCategorySetting,
} from "./multi-category";

const runtime = resolveMultiCategoryRuntimeConfig(
  {
    MULTI_CATEGORY_DISCOVERY_ENABLED: "true",
    MULTI_CATEGORY_MIN_OFFERS_PER_CATEGORY: "1",
    MULTI_CATEGORY_MAX_OFFERS_PER_CATEGORY: "2",
    MULTI_CATEGORY_MAX_TOTAL_PER_SESSION: "12",
    MULTI_CATEGORY_SELECTION_MODE: "ROUND_ROBIN",
    MULTI_CATEGORY_ALLOW_CATEGORY_BACKFILL: "false",
  },
  { enabled: true },
);

function setting(
  categoryId: string,
  overrides: Partial<MultiCategorySetting> = {},
): MultiCategorySetting {
  return {
    categoryId,
    name: categoryId,
    enabled: true,
    priority: 0,
    minOffers: null,
    maxOffers: null,
    isLeaf: true,
    ...overrides,
  };
}

function candidate(
  offerId: string,
  categoryId: string,
  overrides: Partial<MultiCategorySelectionCandidate> = {},
): MultiCategorySelectionCandidate {
  return {
    offerId,
    productId: `product-${offerId}`,
    sourceCategoryIds: [categoryId],
    score: 80,
    bestSellerPosition: 1,
    discountPercentage: 20,
    completenessPercentage: 90,
    eligible: true,
    rejectionReason: null,
    ...overrides,
  };
}

describe("multi-category runtime configuration", () => {
  it("is fail-closed when the feature flag is absent", () => {
    expect(
      resolveMultiCategoryRuntimeConfig({}, { enabled: true }).enabled,
    ).toBe(false);
  });

  it("uses safe defaults for invalid values", () => {
    const result = resolveMultiCategoryRuntimeConfig(
      {
        MULTI_CATEGORY_DISCOVERY_ENABLED: "true",
        MULTI_CATEGORY_MIN_OFFERS_PER_CATEGORY: "99",
        MULTI_CATEGORY_MAX_OFFERS_PER_CATEGORY: "nope",
        MULTI_CATEGORY_MAX_TOTAL_PER_SESSION: "0",
        MULTI_CATEGORY_SELECTION_MODE: "RANDOM",
      },
      { enabled: true },
    );
    expect(result).toMatchObject({
      enabled: true,
      minOffersPerCategory: 1,
      maxOffersPerCategory: 2,
      maxTotalPerSession: 12,
      selectionMode: "ROUND_ROBIN",
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        "INVALID_MIN_OFFERS_PER_CATEGORY",
        "INVALID_MAX_OFFERS_PER_CATEGORY",
        "INVALID_MAX_TOTAL_PER_SESSION",
        "INVALID_SELECTION_MODE",
      ]),
    );
  });

  it("normalizes duplicate categories without duplicating configuration", () => {
    expect(
      normalizeMultiCategorySettings(
        ["MLB-A", "MLB-A"],
        [{ categoryId: "MLB-A", priority: 5 }],
      ),
    ).toHaveLength(1);
  });
});

describe("balanced multi-category selection", () => {
  it("selects one category", () => {
    const result = selectBalancedMultiCategoryOffers({
      settings: [setting("celulares")],
      candidates: [candidate("a", "celulares")],
      config: runtime,
    });
    expect(result.orderedOfferIds).toEqual(["a"]);
    expect(result.quotaMet).toBe(1);
  });

  it("interleaves two categories in round robin order", () => {
    const result = selectBalancedMultiCategoryOffers({
      settings: [setting("celulares"), setting("casa")],
      candidates: [
        candidate("cel-1", "celulares", { score: 90 }),
        candidate("cel-2", "celulares", { score: 80 }),
        candidate("casa-1", "casa", { score: 90 }),
        candidate("casa-2", "casa", { score: 80 }),
      ],
      config: runtime,
    });
    expect(result.orderedOfferIds).toEqual([
      "cel-1",
      "casa-1",
      "cel-2",
      "casa-2",
    ]);
  });

  it("balances six fictitious categories", () => {
    const categories = [
      "celulares",
      "casa",
      "moda",
      "relogios",
      "automotivo",
      "eletrodomesticos",
    ];
    const result = selectBalancedMultiCategoryOffers({
      settings: categories.map((id) => setting(id)),
      candidates: categories.flatMap((id) => [
        candidate(`${id}-1`, id),
        candidate(`${id}-2`, id, { bestSellerPosition: 2 }),
      ]),
      config: runtime,
    });
    expect(result.orderedOfferIds.slice(0, 6)).toEqual(
      categories.map((id) => `${id}-1`),
    );
    expect(result.orderedOfferIds).toHaveLength(12);
  });

  it("enforces the per-category maximum", () => {
    const result = selectBalancedMultiCategoryOffers({
      settings: [setting("casa")],
      candidates: [1, 2, 3].map((number) =>
        candidate(`casa-${number}`, "casa", { bestSellerPosition: number }),
      ),
      config: runtime,
    });
    expect(result.orderedOfferIds).toHaveLength(2);
  });

  it("enforces the total session maximum", () => {
    const result = selectBalancedMultiCategoryOffers({
      settings: [setting("a"), setting("b")],
      candidates: [candidate("a-1", "a"), candidate("b-1", "b")],
      config: { ...runtime, maxTotalPerSession: 1 },
    });
    expect(result.orderedOfferIds).toEqual(["a-1"]);
  });

  it("uses priority only to change the initial round-robin order", () => {
    const result = selectBalancedMultiCategoryOffers({
      settings: [setting("a"), setting("b", { priority: 10 })],
      candidates: [
        candidate("a-1", "a"),
        candidate("a-2", "a"),
        candidate("b-1", "b"),
        candidate("b-2", "b"),
      ],
      config: runtime,
    });
    expect(result.orderedOfferIds).toEqual(["b-1", "a-1", "b-2", "a-2"]);
  });

  it("uses deterministic score, ranking, discount, completeness and id order", () => {
    const result = selectBalancedMultiCategoryOffers({
      settings: [setting("a", { maxOffers: 1 })],
      candidates: [
        candidate("z", "a", { score: 80, bestSellerPosition: 2 }),
        candidate("b", "a", { score: 90, bestSellerPosition: 3 }),
        candidate("a", "a", { score: 90, bestSellerPosition: 3 }),
      ],
      config: runtime,
    });
    expect(result.orderedOfferIds).toEqual(["a"]);
  });

  it("does not select candidates without an affiliate link", () => {
    const result = selectBalancedMultiCategoryOffers({
      settings: [setting("a")],
      candidates: [
        candidate("pending", "a", {
          eligible: false,
          rejectionReason: "AFFILIATE_LINK_REQUIRED",
        }),
      ],
      config: runtime,
    });
    expect(result.orderedOfferIds).toEqual([]);
    expect(result.categories[0]).toMatchObject({
      withoutAffiliateLink: 1,
      quotaMet: false,
      reason: "CATEGORY_QUOTA_NOT_MET",
    });
  });

  it("records an empty category without failing another category", () => {
    const result = selectBalancedMultiCategoryOffers({
      settings: [setting("empty"), setting("valid")],
      candidates: [candidate("valid-1", "valid")],
      config: runtime,
    });
    expect(result.orderedOfferIds).toEqual(["valid-1"]);
    expect(result.quotaNotMet).toBe(1);
    expect(result.categories[0]?.reason).toBe("CATEGORY_WITHOUT_RESULTS");
  });

  it("deduplicates the same product or offer across categories", () => {
    const result = selectBalancedMultiCategoryOffers({
      settings: [setting("a"), setting("b")],
      candidates: [candidate("shared", "a", { sourceCategoryIds: ["a", "b"] })],
      config: runtime,
    });
    expect(result.orderedOfferIds).toEqual(["shared"]);
    expect(result.crossCategoryDuplicates).toBe(1);
    expect(result.duplicateOfferIds).toEqual(["shared"]);
  });

  it("does not use a non-leaf or disabled category", () => {
    const result = selectBalancedMultiCategoryOffers({
      settings: [
        setting("parent", { isLeaf: false }),
        setting("disabled", { enabled: false }),
      ],
      candidates: [
        candidate("parent", "parent"),
        candidate("disabled", "disabled"),
      ],
      config: runtime,
    });
    expect(result.categories).toEqual([]);
    expect(result.orderedOfferIds).toEqual([]);
  });

  it("keeps category backfill explicit and within category maximums", () => {
    const withoutBackfill = selectBalancedMultiCategoryOffers({
      settings: [setting("empty"), setting("full", { maxOffers: 2 })],
      candidates: [candidate("one", "full"), candidate("two", "full")],
      config: runtime,
    });
    const result = selectBalancedMultiCategoryOffers({
      settings: [setting("empty"), setting("full", { maxOffers: 2 })],
      candidates: [candidate("one", "full"), candidate("two", "full")],
      config: { ...runtime, allowCategoryBackfill: true },
    });
    expect(withoutBackfill.orderedOfferIds).toEqual(["one"]);
    expect(result.orderedOfferIds).toEqual(["one", "two"]);
    expect(
      result.categories.find((entry) => entry.categoryId === "empty")?.quotaMet,
    ).toBe(false);
  });
});
