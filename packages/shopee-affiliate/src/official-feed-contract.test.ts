import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ShopeeGetItemFeedDataResponseSchema,
  ShopeeListItemFeedsResponseSchema,
  parseShopeeOfficialFeedColumns,
} from "./official-feed-contract";

const columns = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    itemid: "3984825072",
    title: "Produto sanitizado",
    price: "39.90",
    sale_price: "31.90",
    discount_percentage: "20",
    item_rating: "4.86",
    global_category1: "Home & Living",
    global_category2: "Home Decor",
    global_catid1: "100015",
    global_catid2: "100087",
    global_item_attributes: "{}",
    image_link: "https://down-br.img.susercontent.com/file/safe",
    image_link_3: "https://down-br.img.susercontent.com/file/safe-3",
    product_link: "https://shopee.com.br/product/417683737/3984825072",
    "product_short link":
      "https://shopee.com.br/universal-link/product/417683737/3984825072?tracking=fixture",
    description: "Descrição segura",
    ...overrides,
  });

describe("Shopee official Item Feed schemas", () => {
  it("parses the sanitized official-contract fixtures", () => {
    const fixture = (name: string) =>
      JSON.parse(
        readFileSync(resolve(process.cwd(), "fixtures", name), "utf8"),
      ) as unknown;
    expect(
      ShopeeListItemFeedsResponseSchema.parse(
        fixture("official-item-feeds-sanitized.json"),
      ).feeds,
    ).toHaveLength(2);
    expect(
      ShopeeGetItemFeedDataResponseSchema.parse(
        fixture("official-item-feed-page-sanitized.json"),
      ).rows,
    ).toHaveLength(1);
  });

  it.each([0, 1, 2])("accepts a FULL list with %i feed(s)", (count) => {
    const feeds = Array.from({ length: count }, (_, index) => ({
      datafeedId: `ref-${index}_FULL_2026-08-19`,
      referenceId: `ref-${index}`,
      datafeedName: `Feed ${index}`,
      description: "Fixture",
      totalCount: index ? "100000" : 10000,
      date: index ? "2026-08-19" : "20260819",
      feedMode: "FULL",
    }));
    const parsed = ShopeeListItemFeedsResponseSchema.parse({ feeds });
    expect(parsed.feeds).toHaveLength(count);
    if (parsed.feeds[0]) expect(parsed.feeds[0].totalCount).toBe(10_000);
  });

  it("rejects unsafe Int64 counts and unknown response fields", () => {
    expect(() =>
      ShopeeListItemFeedsResponseSchema.parse({
        feeds: [
          {
            datafeedId: "feed",
            referenceId: "ref",
            datafeedName: "Feed",
            description: "",
            totalCount: "9007199254740992",
            date: "20260819",
            feedMode: "FULL",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      ShopeeListItemFeedsResponseSchema.parse({ feeds: [], surprise: true }),
    ).toThrow();
  });

  it.each([3, 500])("validates page limit %i and FULL updateType", (limit) => {
    expect(
      ShopeeGetItemFeedDataResponseSchema.parse({
        rows: [{ columns: columns(), updateType: null }],
        pageInfo: { offset: 0, limit, totalCount: 1, hasMore: false },
      }),
    ).toMatchObject({ pageInfo: { limit }, rows: [{ updateType: null }] });
  });

  it("rejects a page size above the official maximum", () => {
    expect(() =>
      ShopeeGetItemFeedDataResponseSchema.parse({
        rows: [],
        pageInfo: { offset: 0, limit: 501, totalCount: 0, hasMore: false },
      }),
    ).toThrow();
  });
});

describe("Shopee columns JSON normalization", () => {
  it("reuses the CSV commercial normalizer and never promotes product_short link", () => {
    const result = parseShopeeOfficialFeedColumns(
      columns({ extra: "ignored" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.product).toMatchObject({
        itemId: "3984825072",
        salePrice: 31.9,
        originalPrice: 39.9,
        itemRating: 4.86,
        category1: "Home & Living",
        source: "OPEN_API_FEED",
        verifiedAffiliateUrl: null,
      });
      expect(result.product.candidateAffiliateUrl).toBeNull();
    }
  });

  it.each([
    ["invalid JSON", "{", "SHOPEE_OPEN_API_COLUMNS_JSON_INVALID"],
    [
      "missing itemid",
      columns({ itemid: undefined }),
      "SHOPEE_OPEN_API_COLUMNS_SCHEMA_MISMATCH",
    ],
    [
      "invalid itemid",
      columns({ itemid: "abc" }),
      "SHOPEE_OPEN_API_INVALID_ITEM_ID",
    ],
    [
      "invalid price",
      columns({ sale_price: "NaN" }),
      "SHOPEE_OPEN_API_INVALID_SALE_PRICE",
    ],
    [
      "invalid rating",
      columns({ item_rating: "8" }),
      "SHOPEE_OPEN_API_INVALID_ITEM_RATING",
    ],
    [
      "invalid URL",
      columns({ product_link: "https://evil.example/product/1/3984825072" }),
      "SHOPEE_OPEN_API_INVALID_PRODUCT_URL",
    ],
  ])("rejects %s deterministically", (_label, raw, code) => {
    expect(parseShopeeOfficialFeedColumns(raw)).toEqual({ ok: false, code });
  });
});

export { columns as officialColumnsFixture };
