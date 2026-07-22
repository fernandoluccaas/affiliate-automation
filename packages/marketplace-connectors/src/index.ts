import type { Marketplace } from "@affiliate/shared";

export type MarketplaceOfferCandidate = {
  marketplace: Marketplace;
  externalProductId: string;
  title: string;
  productUrl: string;
  imageUrl?: string;
  originalPrice: number;
  currentPrice: number;
  collectedAt: Date;
};

export interface MarketplaceConnector {
  marketplace: Marketplace;
  healthCheck(): Promise<boolean>;
  collectOffers(): Promise<MarketplaceOfferCandidate[]>;
}
