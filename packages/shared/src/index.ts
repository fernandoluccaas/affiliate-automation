export const marketplaces = ["SHOPEE", "MERCADO_LIVRE"] as const;
export type Marketplace = (typeof marketplaces)[number];

export const offerStatuses = [
  "REJECTED_INVALID_DATA",
  "REJECTED_EXPIRED",
  "REJECTED_DUPLICATE",
  "REJECTED_LOW_SCORE",
  "QUARANTINED_INTEGRATION_ERROR",
  "READY_TO_PUBLISH",
  "SCHEDULED",
  "PUBLISHED",
  "PUBLICATION_FAILED",
] as const;
export type OfferStatus = (typeof offerStatuses)[number];

export const stockStatuses = ["IN_STOCK", "OUT_OF_STOCK", "UNKNOWN"] as const;
export type StockStatus = (typeof stockStatuses)[number];

export function isSupportedMarketplace(value: string): value is Marketplace {
  return marketplaces.includes(value as Marketplace);
}

export function calculateDiscountPercentage(originalPrice: number, currentPrice: number) {
  if (originalPrice <= 0 || currentPrice < 0 || currentPrice > originalPrice) {
    return 0;
  }

  return Number((((originalPrice - currentPrice) / originalPrice) * 100).toFixed(2));
}
