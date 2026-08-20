import type {
  ShopeeBrazilRow,
  ShopeeDatafeedProduct,
  ShopeeDatafeedSchema,
  ShopeeOfficialBrRow,
} from "./types";

type RawRow = ShopeeOfficialBrRow | ShopeeBrazilRow;

const PRODUCT_DOMAINS = ["shopee.com.br"];
const SHORT_LINK_DOMAINS = ["shope.ee", "s.shopee.com.br"];
const IMAGE_DOMAINS = ["susercontent.com", "shopee.com.br", "shopee.com"];

function hostAllowed(host: string, allowedDomains: readonly string[]) {
  return allowedDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

export function validateShopeeUrl(
  value: string,
  kind: "PRODUCT" | "SHORT_LINK" | "IMAGE",
) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return false;
    if (kind === "PRODUCT" && url.hostname.toLowerCase() === "s.shopee.com.br")
      return false;
    const domains =
      kind === "PRODUCT"
        ? PRODUCT_DOMAINS
        : kind === "SHORT_LINK"
          ? SHORT_LINK_DOMAINS
          : IMAGE_DOMAINS;
    return hostAllowed(url.hostname.toLowerCase(), domains);
  } catch {
    return false;
  }
}

export type ShopeeProductUrlValidation =
  | { ok: true; normalizedUrl: string; itemId: string }
  | { ok: false; code: string };

export function extractShopeeItemId(url: URL) {
  const pathMatch = url.pathname.match(/-i\.\d+\.(\d+)(?:\/|$)/i);
  if (pathMatch?.[1]) return pathMatch[1];
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments[0]?.toLowerCase() === "product" &&
    /^\d+$/.test(segments[2] ?? "")
  ) {
    return segments[2]!;
  }
  if (segments[0]?.toLowerCase() === "opaanlp") {
    return segments.length === 3 &&
      /^\d+$/.test(segments[1] ?? "") &&
      /^\d+$/.test(segments[2] ?? "")
      ? segments[2]!
      : null;
  }
  const queryItemId =
    url.searchParams.get("itemId") ?? url.searchParams.get("item_id");
  return queryItemId && /^\d+$/.test(queryItemId) ? queryItemId : null;
}

export function validateShopeeProductOrigin(
  value: string,
  expectedItemId: string,
): ShopeeProductUrlValidation {
  if (!validateShopeeUrl(value, "PRODUCT")) {
    return { ok: false, code: "SHOPEE_ORIGIN_URL_INVALID" };
  }
  const url = new URL(value);
  if (url.pathname === "/go" || url.pathname.startsWith("/go/")) {
    return { ok: false, code: "SHOPEE_ORIGIN_INTERNAL_TRACKING_REJECTED" };
  }
  const itemId = extractShopeeItemId(url);
  if (!itemId) return { ok: false, code: "SHOPEE_ORIGIN_ITEM_ID_MISSING" };
  if (itemId !== expectedItemId) {
    return { ok: false, code: "SHOPEE_ORIGIN_ITEM_ID_MISMATCH" };
  }
  return { ok: true, normalizedUrl: url.toString(), itemId };
}

export type ShopeeShortLinkValidation =
  { ok: true; normalizedUrl: string } | { ok: false; code: string };

export function validateShopeeGeneratedShortLink(
  value: string,
): ShopeeShortLinkValidation {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hostname.toLowerCase() !== "s.shopee.com.br" ||
      url.pathname === "/go" ||
      url.pathname.startsWith("/go/")
    ) {
      return { ok: false, code: "SHOPEE_SHORT_LINK_INVALID" };
    }
    return { ok: true, normalizedUrl: url.toString() };
  } catch {
    return { ok: false, code: "SHOPEE_SHORT_LINK_INVALID" };
  }
}

function decimal(value: string, options: { minimum: number; maximum: number }) {
  const trimmed = value.trim();
  if (!trimmed || !/^-?\d+(?:[.,]\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) &&
    parsed >= options.minimum &&
    parsed <= options.maximum
    ? parsed
    : null;
}

function optionalDecimal(
  value: string,
  options: { minimum: number; maximum: number },
) {
  return value.trim() ? decimal(value, options) : null;
}

function optionalInteger(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function optional(value: string | undefined) {
  const result = value?.trim();
  return result ? result : null;
}

function list(value: string | undefined) {
  const result = value
    ?.split(/[|,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return result?.length ? result : null;
}

function crossBorder(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "sim", "cb"].includes(normalized)) return true;
  if (["0", "false", "no", "nao", "não"].includes(normalized)) return false;
  return null;
}

export function normalizeShopeeDatafeedRecord(input: {
  schema: ShopeeDatafeedSchema;
  record: RawRow;
  linksVerified: boolean;
  source?: ShopeeDatafeedProduct["source"];
}): { ok: true; product: ShopeeDatafeedProduct } | { ok: false; code: string } {
  const row = input.record;
  const itemId = row.itemid.trim();
  if (!itemId || !/^\d+$/.test(itemId))
    return { ok: false, code: "INVALID_ITEM_ID" };
  const title = row.title.trim();
  if (!title) return { ok: false, code: "MISSING_TITLE" };
  const salePrice = decimal(row.sale_price, {
    minimum: Number.EPSILON,
    maximum: 1_000_000_000,
  });
  if (salePrice === null) return { ok: false, code: "INVALID_SALE_PRICE" };
  const originalPrice = optionalDecimal(row.price, {
    minimum: Number.EPSILON,
    maximum: 1_000_000_000,
  });
  if (row.price.trim() && originalPrice === null) {
    return { ok: false, code: "INVALID_ORIGINAL_PRICE" };
  }
  const discountPercentage = optionalDecimal(row.discount_percentage, {
    minimum: 0,
    maximum: 100,
  });
  if (row.discount_percentage.trim() && discountPercentage === null) {
    return { ok: false, code: "INVALID_DISCOUNT" };
  }
  const itemRating = optionalDecimal(row.item_rating, {
    minimum: 0,
    maximum: 5,
  });
  if (row.item_rating.trim() && itemRating === null) {
    return { ok: false, code: "INVALID_ITEM_RATING" };
  }
  const productUrl = row.product_link.trim();
  if (!validateShopeeUrl(productUrl, "PRODUCT")) {
    return { ok: false, code: "INVALID_PRODUCT_URL" };
  }
  const imageUrl = row.image_link.trim();
  if (!imageUrl || !validateShopeeUrl(imageUrl, "IMAGE")) {
    return { ok: false, code: "INVALID_IMAGE_URL" };
  }
  const candidateAffiliateUrl = optional(row["product_short link"]);
  if (
    candidateAffiliateUrl &&
    !validateShopeeUrl(candidateAffiliateUrl, "SHORT_LINK")
  ) {
    return { ok: false, code: "INVALID_CANDIDATE_LINK" };
  }
  const official =
    input.schema === "OFFICIAL_BR" ? (row as ShopeeOfficialBrRow) : null;
  const shopRating = official
    ? optionalDecimal(official.shop_rating, { minimum: 0, maximum: 5 })
    : null;
  if (official?.shop_rating.trim() && shopRating === null) {
    return { ok: false, code: "INVALID_SHOP_RATING" };
  }
  const likeCount = official ? optionalInteger(official.like) : null;
  if (official?.like.trim() && likeCount === null) {
    return { ok: false, code: "INVALID_LIKE_COUNT" };
  }
  const secondaryImageUrl = optional(row.image_link_3);
  if (secondaryImageUrl && !validateShopeeUrl(secondaryImageUrl, "IMAGE")) {
    return { ok: false, code: "INVALID_SECONDARY_IMAGE_URL" };
  }
  const category1 = row.global_category1.trim();
  if (!category1) return { ok: false, code: "MISSING_CATEGORY_1" };
  return {
    ok: true,
    product: {
      itemId,
      title,
      description: optional(row.description),
      originalPrice:
        originalPrice !== null && originalPrice >= salePrice
          ? originalPrice
          : null,
      salePrice,
      discountPercentage,
      itemRating,
      shopRating,
      likeCount,
      condition: optional(official?.condition),
      crossBorder: crossBorder(official?.cb_option),
      category1,
      category1Id: optional(row.global_catid1),
      category2: optional(row.global_category2),
      category2Id: optional(row.global_catid2),
      category3: optional(official?.global_category3),
      category3Id: optional(official?.global_catid3),
      shopName: optional(official?.shop_name),
      imageUrl,
      secondaryImageUrl,
      sourceProductUrl: productUrl,
      candidateAffiliateUrl,
      verifiedAffiliateUrl:
        input.linksVerified && candidateAffiliateUrl
          ? candidateAffiliateUrl
          : null,
      modelIds: list(official?.model_ids),
      modelNames: list(official?.model_names),
      commissionAvailable: false,
      salesCountAvailable: false,
      source: input.source ?? input.schema,
      sources: [input.source ?? input.schema],
    },
  };
}

export function normalizeShopeeDatafeedRow(input: {
  schema: ShopeeDatafeedSchema;
  row: RawRow;
  linksVerified: boolean;
}) {
  return normalizeShopeeDatafeedRecord({
    schema: input.schema,
    record: input.row,
    linksVerified: input.linksVerified,
  });
}

export function urlHost(value: string | null) {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}
