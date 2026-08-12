import type {
  ShopeeAffiliateLinkProvider,
  ShopeeConversionProvider,
  ShopeeDatafeedProduct,
  ShopeeOfferProvider,
} from "./types";

export class DatafeedAffiliateLinkProvider implements ShopeeAffiliateLinkProvider {
  readonly kind = "DATAFEED" as const;

  async resolve(product: ShopeeDatafeedProduct) {
    return product.verifiedAffiliateUrl
      ? ({
          status: "VERIFIED",
          affiliateUrl: product.verifiedAffiliateUrl,
        } as const)
      : ({
          status: "UNVERIFIED",
          candidateUrl: product.candidateAffiliateUrl,
          reason: product.candidateAffiliateUrl
            ? "SHOPEE_DATAFEED_ATTRIBUTION_NOT_VERIFIED"
            : "SHOPEE_DATAFEED_LINK_MISSING",
        } as const);
  }
}

export class OpenApiOfferProvider implements ShopeeOfferProvider {
  readonly kind = "OPEN_API" as const;
  readonly available = false;

  async stream(): Promise<never> {
    throw new Error("SHOPEE_OPEN_API_WAITING_FOR_OFFICIAL_ACCESS");
  }
}

export class OpenApiAffiliateLinkProvider implements ShopeeAffiliateLinkProvider {
  readonly kind = "OPEN_API" as const;

  async resolve(): Promise<never> {
    throw new Error("SHOPEE_OPEN_API_WAITING_FOR_OFFICIAL_ACCESS");
  }
}

export class OpenApiConversionProvider implements ShopeeConversionProvider {
  readonly kind = "OPEN_API" as const;
  readonly available = false as const;

  async preflight() {
    return {
      ready: false as const,
      reason: "SHOPEE_OPEN_API_WAITING_FOR_OFFICIAL_ACCESS",
    };
  }
}

export function assertShopeeOperationalPublishingAllowed(input: {
  linksVerified: boolean;
}): never {
  if (!input.linksVerified) {
    throw new Error("SHOPEE_DATAFEED_LINKS_NOT_VERIFIED");
  }
  throw new Error("SHOPEE_DATAFEED_PREVIEW_ONLY");
}
