import {
  marketplaces,
  shippingStatuses,
  stockStatuses,
} from "@affiliate/shared";
import { sanitizeOperationalErrorMessage } from "@affiliate/validation";
import { z } from "zod";

const invalidDecimal = Symbol("invalidDecimal");

export function parseDecimalInput(value: unknown) {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== "string") {
    return invalidDecimal;
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  if (normalized.includes(",")) {
    const parts = normalized.split(",");

    if (parts.length !== 2) {
      return invalidDecimal;
    }

    const integerPart = parts[0];
    const decimalPart = parts[1];

    if (integerPart === undefined || decimalPart === undefined) {
      return invalidDecimal;
    }

    const validInteger =
      /^\d+$/.test(integerPart) || /^\d{1,3}(?:\.\d{3})+$/.test(integerPart);

    if (!validInteger || !/^\d+$/.test(decimalPart)) {
      return invalidDecimal;
    }

    const parsed = Number(`${integerPart.replace(/\./g, "")}.${decimalPart}`);
    return Number.isFinite(parsed) ? parsed : invalidDecimal;
  }

  if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) {
    const parsed = Number(normalized.replace(/\./g, ""));
    return Number.isFinite(parsed) ? parsed : invalidDecimal;
  }

  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : invalidDecimal;
  }

  return invalidDecimal;
}

function decimalPreprocessor(value: unknown) {
  const parsed = parseDecimalInput(value);
  return parsed === invalidDecimal ? value : parsed;
}

const optionalText = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().optional());

const optionalUrl = z.preprocess((value) => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().url("Informe uma URL valida.").optional());

const optionalDate = z.preprocess((value) => {
  if (value === null) {
    return null;
  }

  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return value;
  }

  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? value : date;
}, z.date("Informe uma data valida.").optional().nullable());

const optionalPercentage = z.preprocess((value) => {
  const parsed = decimalPreprocessor(value);
  return parsed === null ? undefined : parsed;
}, z.number("Informe um percentual valido.").min(0).max(100).optional());

const optionalRating = z.preprocess((value) => {
  const parsed = decimalPreprocessor(value);
  return parsed === null ? undefined : parsed;
}, z.number("Informe uma avaliacao valida.").min(0).max(5).optional());

const optionalPrice = z.preprocess((value) => {
  const parsed = decimalPreprocessor(value);
  return parsed === null ? undefined : parsed;
}, z.number("Informe um preco original valido.").positive("O preco original deve ser maior que zero.").optional());

const optionalSalesCount = z.preprocess((value) => {
  const parsed = decimalPreprocessor(value);
  return parsed === null ? undefined : parsed;
}, z.number("Informe uma quantidade de vendas valida.").int().min(0).optional());

const optionalPositiveInteger = z.preprocess((value) => {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value);
  }

  return value;
}, z.number("Informe uma posicao valida.").int().positive().optional());

const optionalFailureCode = z.preprocess(
  (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }

    return value;
  },
  optionalText.pipe(z.string().max(100).optional()),
);

const affiliateFailureSchema = z
  .object({
    stage: z.enum([
      "SESSION_WARMUP",
      "TAGS",
      "LINK_GENERATION",
      "RESPONSE_PARSING",
    ]),
    status: z.number().int().min(100).max(599).optional(),
    code: optionalFailureCode,
    message: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .transform(sanitizeOperationalErrorMessage),
    retryable: z.boolean().default(false),
    sessionExpired: z.boolean().default(false),
    productIneligible: z.boolean().default(false),
    attempts: z.number().int().min(0).max(3).optional(),
  })
  .strict();

const requiredPrice = z.preprocess(
  decimalPreprocessor,
  z
    .number("Preco atual invalido.")
    .positive("O preco atual deve ser maior que zero."),
);

export const offerFormSchema = z.object({
  marketplace: z.enum(marketplaces),
  externalProductId: z
    .string()
    .trim()
    .min(1, "Informe o ID externo do produto."),
  title: z
    .string()
    .trim()
    .min(3, "Informe um titulo com pelo menos 3 caracteres."),
  description: optionalText,
  category: optionalText,
  sourceCategoryId: optionalText,
  bestSellerPosition: optionalPositiveInteger,
  sourceHighlightId: optionalText,
  sourceHighlightType: z
    .enum(["ITEM", "PRODUCT", "USER_PRODUCT", "UNKNOWN"])
    .optional(),
  resolutionStrategy: z
    .enum([
      "ITEM_DIRECT",
      "PRODUCT_DIRECT_BUY_BOX",
      "PRODUCT_CHILD_BUY_BOX",
      "USER_PRODUCT_ACTIVE_ITEM",
    ])
    .optional(),
  imageUrl: optionalUrl,
  productUrl: z.string().trim().url("Informe uma URL valida do produto."),
  affiliateUrl: optionalUrl,
  affiliateLabel: optionalText,
  affiliateEligibility: z
    .enum(["ELIGIBLE", "INELIGIBLE", "UNKNOWN"])
    .default("UNKNOWN"),
  affiliateFailure: affiliateFailureSchema.nullable().optional(),
  sellerId: optionalText,
  officialStoreId: optionalText,
  trackingStrategy: z
    .enum(["INTERNAL_REDIRECT", "DIRECT_AFFILIATE_LINK"])
    .optional(),
  originalPrice: optionalPrice,
  currentPrice: requiredPrice,
  couponCode: optionalText,
  couponExpiration: optionalDate,
  commissionPercentage: optionalPercentage,
  rating: optionalRating,
  salesCount: optionalSalesCount,
  freeShipping: z.coerce.boolean().optional(),
  shippingStatus: z.enum(shippingStatuses).default("UNKNOWN"),
  stockStatus: z.enum(stockStatuses).default("UNKNOWN"),
});

export function formatOfferFormError(error: z.ZodError) {
  return error.issues
    .map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join(" ");
}

export type OfferFormInput = z.input<typeof offerFormSchema>;
export type OfferFormValues = z.output<typeof offerFormSchema>;
export type AffiliateFailureMetadata = z.output<typeof affiliateFailureSchema>;
