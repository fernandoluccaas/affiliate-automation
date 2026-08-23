import { z } from "zod";

const nullableDecimal = z
  .union([z.number().finite(), z.string().trim().regex(/^\d+(?:\.\d+)?$/)])
  .transform(Number)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const nullableIdentifier = z
  .union([z.string().trim().min(1).max(128), z.number().int().nonnegative()])
  .transform(String)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const nullableUrl = z
  .string()
  .trim()
  .url()
  .nullable()
  .optional()
  .transform((value) => value ?? null);

export const ShopeeProductOfferV2NodeSchema = z
  .object({
    itemId: nullableIdentifier,
    shopId: nullableIdentifier,
    priceMin: nullableDecimal,
    priceMax: nullableDecimal,
    sales: nullableDecimal,
    ratingStar: nullableDecimal,
    commissionRate: nullableDecimal,
    sellerCommissionRate: nullableDecimal,
    shopeeCommissionRate: nullableDecimal,
    commission: nullableDecimal,
    productLink: nullableUrl,
    offerLink: nullableUrl,
    periodStartTime: nullableDecimal,
    periodEndTime: nullableDecimal,
  })
  .passthrough();

export const ShopeeProductOfferV2ResponseSchema = z
  .object({
    nodes: z.array(ShopeeProductOfferV2NodeSchema).max(50),
    pageInfo: z
      .object({
        page: z.number().int().positive(),
        limit: z.number().int().positive().max(50),
        hasNextPage: z.boolean(),
        scrollId: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type ShopeeProductOfferV2Node = z.infer<
  typeof ShopeeProductOfferV2NodeSchema
>;
