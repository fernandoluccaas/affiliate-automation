import { describe, expect, it } from "vitest";
import type { ShopeeBrazilRow, ShopeeOfficialBrRow } from "./types";
import {
  extractShopeeItemId,
  normalizeShopeeDatafeedRow,
  validateShopeeProductOrigin,
  validateShopeeUrl,
} from "./validation";

function brazil(overrides: Partial<ShopeeBrazilRow> = {}): ShopeeBrazilRow {
  return {
    image_link: "https://cf.shopee.com.br/file/image",
    itemid: "123",
    price: "150.00",
    global_category1: "Home & Living",
    description: "Descrição, com acentos",
    global_category2: "Decor",
    global_item_attributes: "",
    item_rating: "4.9",
    sale_price: "100.00",
    global_catid2: "20",
    discount_percentage: "33.3",
    image_link_3: "",
    title: "Produto",
    global_catid1: "10",
    product_link: "https://shopee.com.br/produto-i.1.123",
    "product_short link": "https://shope.ee/an_redir?origin_link=x",
    ...overrides,
  };
}

function official(
  overrides: Partial<ShopeeOfficialBrRow> = {},
): ShopeeOfficialBrRow {
  return {
    shop_rating: "4.8",
    itemid: "123",
    sale_price: "100",
    item_rating: "4.9",
    global_category3: "Decor",
    cb_option: "0",
    discount_percentage: "20",
    global_catid2: "20",
    price: "125",
    description: "Descrição",
    title: "Produto",
    global_category1: "Home & Living",
    image_link_3: "",
    global_catid1: "10",
    global_catid3: "30",
    like: "100",
    condition: "new",
    global_category2: "Decor",
    model_ids: "1|2",
    image_link: "https://cf.shopee.com.br/file/image",
    model_names: "A|B",
    shop_name: "Loja",
    product_link: "https://shopee.com.br/produto-i.1.123",
    "product_short link": "https://shope.ee/an_redir?origin_link=x",
    ...overrides,
  };
}

describe("Shopee datafeed normalization", () => {
  it("normalizes the Shopee Brasil schema without inventing optional data", () => {
    const result = normalizeShopeeDatafeedRow({
      schema: "BRAZIL",
      row: brazil(),
      linksVerified: false,
    });
    expect(result.ok && result.product).toMatchObject({
      itemId: "123",
      shopRating: null,
      likeCount: null,
      commissionAvailable: false,
      salesCountAvailable: false,
    });
  });

  it("normalizes the Oficial BR schema", () => {
    const result = normalizeShopeeDatafeedRow({
      schema: "OFFICIAL_BR",
      row: official(),
      linksVerified: false,
    });
    expect(result.ok && result.product).toMatchObject({
      shopRating: 4.8,
      likeCount: 100,
      crossBorder: false,
      modelIds: ["1", "2"],
    });
  });

  it("keeps the short link unverified while the gate is false", () => {
    const result = normalizeShopeeDatafeedRow({
      schema: "BRAZIL",
      row: brazil(),
      linksVerified: false,
    });
    expect(result.ok && result.product.verifiedAffiliateUrl).toBeNull();
    expect(result.ok && result.product.candidateAffiliateUrl).toContain(
      "shope.ee",
    );
  });

  it("maps the candidate link to verified only when the gate is true", () => {
    const result = normalizeShopeeDatafeedRow({
      schema: "BRAZIL",
      row: brazil(),
      linksVerified: true,
    });
    expect(result.ok && result.product.verifiedAffiliateUrl).toContain(
      "shope.ee",
    );
  });

  it.each([
    ["item id", { itemid: "" }, "INVALID_ITEM_ID"],
    ["title", { title: "" }, "MISSING_TITLE"],
    ["NaN price", { sale_price: "NaN" }, "INVALID_SALE_PRICE"],
    ["zero price", { sale_price: "0" }, "INVALID_SALE_PRICE"],
    ["infinite price", { sale_price: "Infinity" }, "INVALID_SALE_PRICE"],
    ["discount", { discount_percentage: "101" }, "INVALID_DISCOUNT"],
    ["rating", { item_rating: "5.1" }, "INVALID_ITEM_RATING"],
    [
      "product URL",
      { product_link: "https://evil.example/item" },
      "INVALID_PRODUCT_URL",
    ],
    [
      "short link",
      { "product_short link": "javascript:alert(1)" },
      "INVALID_CANDIDATE_LINK",
    ],
    [
      "image URL",
      { image_link: "https://evil.example/image" },
      "INVALID_IMAGE_URL",
    ],
  ])("rejects invalid %s", (_label, override, code) => {
    expect(
      normalizeShopeeDatafeedRow({
        schema: "BRAZIL",
        row: brazil(override),
        linksVerified: false,
      }),
    ).toEqual({ ok: false, code });
  });

  it("rejects invalid Oficial BR shop rating", () => {
    expect(
      normalizeShopeeDatafeedRow({
        schema: "OFFICIAL_BR",
        row: official({ shop_rating: "9" }),
        linksVerified: false,
      }),
    ).toEqual({ ok: false, code: "INVALID_SHOP_RATING" });
  });

  it("keeps empty optional fields null", () => {
    const result = normalizeShopeeDatafeedRow({
      schema: "BRAZIL",
      row: brazil({
        price: "",
        discount_percentage: "",
        item_rating: "",
        "product_short link": "",
      }),
      linksVerified: false,
    });
    expect(result.ok && result.product).toMatchObject({
      originalPrice: null,
      discountPercentage: null,
      itemRating: null,
      candidateAffiliateUrl: null,
    });
  });

  it("validates exact and subdomain Shopee hosts safely", () => {
    expect(validateShopeeUrl("https://shopee.com.br/item", "PRODUCT")).toBe(
      true,
    );
    expect(validateShopeeUrl("https://br.shp.ee/item", "SHORT_LINK")).toBe(
      false,
    );
    expect(validateShopeeUrl("https://notshopee.com.br/item", "PRODUCT")).toBe(
      false,
    );
  });

  it("rejects credentials and HTTP URLs", () => {
    expect(
      validateShopeeUrl("https://user:pass@shopee.com.br/item", "PRODUCT"),
    ).toBe(false);
    expect(validateShopeeUrl("http://shopee.com.br/item", "PRODUCT")).toBe(
      false,
    );
  });
});

describe("Shopee product itemId extraction", () => {
  it.each([
    [
      "https://shopee.com.br/opaanlp/344381236/52511551718",
      "52511551718",
    ],
    [
      "https://shopee.com.br/opaanlp/344381236/52511551718?utm_medium=affiliates&utm_source=fixture",
      "52511551718",
    ],
    [
      "https://shopee.com.br/OPAANLP/344381236/52511551718",
      "52511551718",
    ],
    ["https://shopee.com.br/product/344381236/52511551718", "52511551718"],
    [
      "https://shopee.com.br/produto-i.344381236.52511551718",
      "52511551718",
    ],
    ["https://shopee.com.br/item?itemId=52511551718", "52511551718"],
    ["https://shopee.com.br/item?item_id=52511551718", "52511551718"],
  ])("extracts the itemId from supported URL %s", (value, expected) => {
    expect(extractShopeeItemId(new URL(value))).toBe(expected);
  });

  it.each([
    "https://shopee.com.br/opaanlp//52511551718",
    "https://shopee.com.br/opaanlp/344381236",
    "https://shopee.com.br/opaanlp/shop/52511551718",
    "https://shopee.com.br/opaanlp/344381236/item",
    "https://shopee.com.br/opaanlp/344381236/52511551718/extra",
    "https://shopee.com.br/opaanlp/344381236/52511551718/extra?itemId=52511551718",
  ])("rejects an ambiguous or malformed opaanlp path %s", (value) => {
    expect(extractShopeeItemId(new URL(value))).toBeNull();
    expect(validateShopeeProductOrigin(value, "52511551718")).toEqual({
      ok: false,
      code: "SHOPEE_ORIGIN_ITEM_ID_MISSING",
    });
  });

  it("keeps an opaanlp itemId mismatch fail-closed", () => {
    expect(
      validateShopeeProductOrigin(
        "https://shopee.com.br/opaanlp/344381236/99999999999",
        "52511551718",
      ),
    ).toEqual({ ok: false, code: "SHOPEE_ORIGIN_ITEM_ID_MISMATCH" });
  });
});
