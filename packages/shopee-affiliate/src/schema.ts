import type {
  ShopeeBrazilRow,
  ShopeeDatafeedSchema,
  ShopeeOfficialBrRow,
} from "./types";

export const SHOPEE_OFFICIAL_BR_HEADERS = [
  "shop_rating",
  "itemid",
  "sale_price",
  "item_rating",
  "global_category3",
  "cb_option",
  "discount_percentage",
  "global_catid2",
  "price",
  "description",
  "title",
  "global_category1",
  "image_link_3",
  "global_catid1",
  "global_catid3",
  "like",
  "condition",
  "global_category2",
  "model_ids",
  "image_link",
  "model_names",
  "shop_name",
  "product_link",
  "product_short link",
] as const satisfies readonly (keyof ShopeeOfficialBrRow)[];

export const SHOPEE_BRAZIL_HEADERS = [
  "image_link",
  "itemid",
  "price",
  "global_category1",
  "description",
  "global_category2",
  "global_item_attributes",
  "item_rating",
  "sale_price",
  "global_catid2",
  "discount_percentage",
  "image_link_3",
  "title",
  "global_catid1",
  "product_link",
  "product_short link",
] as const satisfies readonly (keyof ShopeeBrazilRow)[];

function exact(headers: readonly string[], expected: readonly string[]) {
  return (
    headers.length === expected.length &&
    headers.every((header, index) => header === expected[index])
  );
}

export function identifyShopeeDatafeedSchema(
  headers: readonly string[],
): ShopeeDatafeedSchema | null {
  if (exact(headers, SHOPEE_OFFICIAL_BR_HEADERS)) return "OFFICIAL_BR";
  if (exact(headers, SHOPEE_BRAZIL_HEADERS)) return "BRAZIL";
  return null;
}

export function rowObject(
  headers: readonly string[],
  values: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    headers.map((header, index) => [header, values[index] ?? ""]),
  );
}
