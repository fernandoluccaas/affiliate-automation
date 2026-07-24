import { marketplaces, stockStatuses } from "@affiliate/shared";
import { z } from "zod";

const optionalText = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().optional());

const optionalUrl = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().url("Informe uma URL valida.").optional());

const optionalDate = z.preprocess((value) => {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return value;
  }

  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? value : date;
}, z.date("Informe uma data valida.").optional());

const optionalPercentage = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) {
    return undefined;
  }

  return value;
}, z.coerce.number().min(0).max(100).optional());

const optionalRating = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) {
    return undefined;
  }

  return value;
}, z.coerce.number().min(0).max(5).optional());

const optionalSalesCount = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) {
    return undefined;
  }

  return value;
}, z.coerce.number().int().min(0).optional());

export const offerFormSchema = z.object({
  marketplace: z.enum(marketplaces),
  externalProductId: z.string().trim().min(1, "Informe o ID externo do produto."),
  title: z.string().trim().min(3, "Informe um titulo com pelo menos 3 caracteres."),
  description: optionalText,
  category: optionalText,
  imageUrl: optionalUrl,
  productUrl: z.string().trim().url("Informe uma URL valida do produto."),
  affiliateUrl: optionalUrl,
  originalPrice: z.coerce.number().positive("O preco original deve ser maior que zero."),
  currentPrice: z.coerce.number().positive("O preco atual deve ser maior que zero."),
  couponCode: optionalText,
  couponExpiration: optionalDate,
  commissionPercentage: optionalPercentage,
  rating: optionalRating,
  salesCount: optionalSalesCount,
  freeShipping: z.coerce.boolean().default(false),
  stockStatus: z.enum(stockStatuses),
});

export type OfferFormValues = z.infer<typeof offerFormSchema>;
