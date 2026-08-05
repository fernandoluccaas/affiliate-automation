import {
  calculateDiscountPercentage,
  marketplaces,
  shippingStatuses,
  stockStatuses,
} from "@affiliate/shared";
import { z } from "zod";

export const MINIMUM_INGESTION_DATA = [
  "marketplace",
  "externalProductId",
  "title",
  "productUrl",
  "currentPrice",
] as const;

export const MINIMUM_VALID_OFFER_DATA = MINIMUM_INGESTION_DATA;

export const MINIMUM_PUBLICATION_DATA = [
  ...MINIMUM_VALID_OFFER_DATA,
  "affiliateUrl",
] as const;

export const offerInputSchema = z.object({
  marketplace: z.enum(marketplaces),
  externalProductId: z.string().min(1),
  title: z.string().min(3),
  description: z.string().optional(),
  category: z.string().optional(),
  imageUrl: z.string().url().optional(),
  productUrl: z.string().url(),
  affiliateUrl: z.string().url().optional(),
  affiliateLabel: z.string().optional().nullable(),
  affiliateEligibility: z
    .enum(["ELIGIBLE", "INELIGIBLE", "UNKNOWN"])
    .default("UNKNOWN"),
  sellerId: z.string().optional().nullable(),
  officialStoreId: z.string().optional().nullable(),
  trackingStrategy: z
    .enum(["INTERNAL_REDIRECT", "DIRECT_AFFILIATE_LINK"])
    .optional(),
  originalPrice: z.number().positive().optional().nullable(),
  currentPrice: z.number().positive(),
  discountPercentage: z.number().min(0).max(100).optional().nullable(),
  couponCode: z.string().optional(),
  couponExpiration: z.date().optional(),
  commissionPercentage: z.number().min(0).max(100).optional().nullable(),
  rating: z.number().min(0).max(5).optional().nullable(),
  salesCount: z.number().int().min(0).optional().nullable(),
  freeShipping: z.boolean().optional().nullable(),
  shippingStatus: z.enum(shippingStatuses).default("UNKNOWN"),
  stockStatus: z.enum(stockStatuses).default("UNKNOWN"),
  collectedAt: z.date(),
});

export type OfferInput = z.infer<typeof offerInputSchema>;

export type ValidationFailureCode =
  | "INVALID_SCHEMA"
  | "INVALID_MARKETPLACE"
  | "INVALID_PRICE"
  | "DISCOUNT_MISMATCH"
  | "EXPIRED_COUPON"
  | "MISSING_IMAGE"
  | "OUT_OF_STOCK";

export type ValidationResult =
  | { ok: true; normalizedDiscountPercentage: number | null }
  | { ok: false; code: ValidationFailureCode; message: string };

export function validateOfferFacts(
  input: unknown,
  now = new Date(),
): ValidationResult {
  const parsed = offerInputSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, code: "INVALID_SCHEMA", message: parsed.error.message };
  }

  const offer = parsed.data;

  if (
    offer.originalPrice !== null &&
    offer.originalPrice !== undefined &&
    offer.currentPrice > offer.originalPrice
  ) {
    return {
      ok: false,
      code: "INVALID_PRICE",
      message: "Current price cannot be greater than original price.",
    };
  }

  const calculatedDiscount =
    offer.originalPrice === null || offer.originalPrice === undefined
      ? null
      : calculateDiscountPercentage(offer.originalPrice, offer.currentPrice);

  if (
    calculatedDiscount !== null &&
    offer.discountPercentage !== null &&
    offer.discountPercentage !== undefined &&
    Math.abs(calculatedDiscount - offer.discountPercentage) > 0.01
  ) {
    return {
      ok: false,
      code: "DISCOUNT_MISMATCH",
      message:
        "Discount percentage must match the internally calculated value.",
    };
  }

  if (offer.couponExpiration && offer.couponExpiration <= now) {
    return { ok: false, code: "EXPIRED_COUPON", message: "Coupon is expired." };
  }

  if (offer.stockStatus === "OUT_OF_STOCK") {
    return {
      ok: false,
      code: "OUT_OF_STOCK",
      message: "Offer is out of stock.",
    };
  }

  return { ok: true, normalizedDiscountPercentage: calculatedDiscount };
}

export function calculateValidatedDiscount(
  originalPrice: number | null | undefined,
  currentPrice: number,
) {
  if (currentPrice <= 0) {
    return {
      ok: false as const,
      code: "INVALID_PRICE" as const,
      message: "Current price must be greater than zero.",
    };
  }

  if (originalPrice === null || originalPrice === undefined) {
    return {
      ok: true as const,
      discountPercentage: null,
    };
  }

  if (originalPrice <= 0 || currentPrice > originalPrice) {
    return {
      ok: false as const,
      code: "INVALID_PRICE" as const,
      message:
        "Current price cannot exceed original price, and original price must be greater than zero.",
    };
  }

  return {
    ok: true as const,
    discountPercentage: calculateDiscountPercentage(
      originalPrice,
      currentPrice,
    ),
  };
}

const DEFAULT_OPERATIONAL_ERROR_MESSAGE = "Operational request failed.";
const MAX_OPERATIONAL_ERROR_MESSAGE_LENGTH = 500;
const COOKIE_HEADER_VALUE =
  /^(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;\r\n]*)(?:;\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;\r\n]*)*$/;

export function sanitizeOperationalErrorMessage(value: unknown) {
  const raw =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : DEFAULT_OPERATIONAL_ERROR_MESSAGE;
  const redactedRaw = COOKIE_HEADER_VALUE.test(raw.trim()) ? "[REDACTED]" : raw;
  const sanitized = [...redactedRaw]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join("")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|x-xsrf-token)\b\s*[:=]\s*[^\r\n]*/gi,
      "[REDACTED]",
    )
    .replace(
      /(["']?(?:cookie|set-cookie|csrf|csrf-token|csrf_token|xsrf-token|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,}\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /([?&](?:cookie|csrf|xsrf|access_token|refresh_token|token)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;\s,]+;\s*)+[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;\s,]+/g,
      "[REDACTED]",
    )
    .trim()
    .slice(0, MAX_OPERATIONAL_ERROR_MESSAGE_LENGTH);

  return sanitized || DEFAULT_OPERATIONAL_ERROR_MESSAGE;
}

function isPrivateIpv4(hostname: string) {
  const parts = hostname.split(".").map(Number);

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second] = parts as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname: string) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

export type MarketplaceAffiliateUrlValidation =
  | { ok: true; normalizedUrl: string }
  | {
      ok: false;
      code:
        | "INVALID_URL"
        | "HTTPS_REQUIRED"
        | "EMBEDDED_CREDENTIALS"
        | "LOCAL_OR_PRIVATE_HOST"
        | "HOST_NOT_ALLOWED";
      message: string;
    };

export type AffiliateUrlValidationResult = MarketplaceAffiliateUrlValidation;

const MERCADO_LIVRE_AFFILIATE_DOMAINS = [
  "meli.la",
  "mercadolivre.com.br",
  "mercadolibre.com",
] as const;
const SHOPEE_AFFILIATE_DOMAINS = [
  "shopee.com.br",
  "shopee.com",
  "shope.ee",
] as const;

function hostnameMatchesDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function validateAffiliateUrl(
  value: string,
): AffiliateUrlValidationResult {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      code: "INVALID_URL",
      message: "Affiliate URL is invalid.",
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      code: "HTTPS_REQUIRED",
      message: "Affiliate URL must use HTTPS.",
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      code: "EMBEDDED_CREDENTIALS",
      message: "Affiliate URL cannot contain embedded credentials.",
    };
  }

  const hostname = url.hostname.toLowerCase();

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    return {
      ok: false,
      code: "LOCAL_OR_PRIVATE_HOST",
      message: "Affiliate URL cannot use a local or private host.",
    };
  }

  if (
    !MERCADO_LIVRE_AFFILIATE_DOMAINS.some((domain) =>
      hostnameMatchesDomain(hostname, domain),
    )
  ) {
    return {
      ok: false,
      code: "HOST_NOT_ALLOWED",
      message: "Affiliate URL host is not allowed for Mercado Livre.",
    };
  }

  return { ok: true, normalizedUrl: url.toString() };
}

export function validateMarketplaceAffiliateUrl(
  marketplace: string,
  value: string,
): MarketplaceAffiliateUrlValidation {
  if (marketplace === "MERCADO_LIVRE") {
    return validateAffiliateUrl(value);
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return {
      ok: false,
      code: "INVALID_URL",
      message: "Affiliate URL is invalid.",
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      code: "HTTPS_REQUIRED",
      message: "Affiliate URL must use HTTPS.",
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      code: "EMBEDDED_CREDENTIALS",
      message: "Affiliate URL cannot contain embedded credentials.",
    };
  }

  const hostname = url.hostname.toLowerCase();

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  ) {
    return {
      ok: false,
      code: "LOCAL_OR_PRIVATE_HOST",
      message: "Affiliate URL cannot use a local or private host.",
    };
  }

  if (
    marketplace === "SHOPEE" &&
    !SHOPEE_AFFILIATE_DOMAINS.some((domain) =>
      hostnameMatchesDomain(hostname, domain),
    )
  ) {
    return {
      ok: false,
      code: "HOST_NOT_ALLOWED",
      message: "Affiliate URL host is not allowed for Shopee.",
    };
  }

  return { ok: true, normalizedUrl: url.toString() };
}
