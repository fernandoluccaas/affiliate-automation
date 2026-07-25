import { calculateDiscountPercentage, marketplaces, shippingStatuses, stockStatuses } from "@affiliate/shared";
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

export function validateOfferFacts(input: unknown, now = new Date()): ValidationResult {
  const parsed = offerInputSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false, code: "INVALID_SCHEMA", message: parsed.error.message };
  }

  const offer = parsed.data;

  if (offer.originalPrice !== null && offer.originalPrice !== undefined && offer.currentPrice > offer.originalPrice) {
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
      message: "Discount percentage must match the internally calculated value.",
    };
  }

  if (offer.couponExpiration && offer.couponExpiration <= now) {
    return { ok: false, code: "EXPIRED_COUPON", message: "Coupon is expired." };
  }

  if (offer.stockStatus === "OUT_OF_STOCK") {
    return { ok: false, code: "OUT_OF_STOCK", message: "Offer is out of stock." };
  }

  return { ok: true, normalizedDiscountPercentage: calculatedDiscount };
}

export function calculateValidatedDiscount(originalPrice: number | null | undefined, currentPrice: number) {
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
      message: "Current price cannot exceed original price, and original price must be greater than zero.",
    };
  }

  return {
    ok: true as const,
    discountPercentage: calculateDiscountPercentage(originalPrice, currentPrice),
  };
}
