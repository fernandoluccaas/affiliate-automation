import type { Marketplace, ShippingStatus, StockStatus } from "@affiliate/shared";

export type MarketplaceOfferCandidate = {
  marketplace: Marketplace;
  externalProductId: string;
  title: string;
  productUrl: string;
  currentPrice: number;
  description?: string | null;
  category?: string | null;
  imageUrl?: string | null;
  originalPrice?: number | null;
  discountPercentage?: number | null;
  couponCode?: string | null;
  couponExpiration?: Date | null;
  affiliateUrl?: string | null;
  commissionPercentage?: number | null;
  rating?: number | null;
  salesCount?: number | null;
  freeShipping?: boolean | null;
  shippingStatus?: ShippingStatus;
  stockStatus?: StockStatus;
  collectedAt?: Date;
};

export interface MarketplaceConnector {
  marketplace: Marketplace;
  healthCheck(): Promise<boolean>;
  collectOffers(): Promise<MarketplaceOfferCandidate[]>;
}
