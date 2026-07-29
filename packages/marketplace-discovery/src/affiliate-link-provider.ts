import type { Marketplace } from "@affiliate/shared";

export interface AffiliateLinkProvider {
  generate(input: {
    marketplace: Marketplace;
    productUrl: string;
    externalProductId?: string;
  }): Promise<AffiliateLinkGenerationResult>;
}

export type AffiliateLinkGenerationResult =
  | {
      status: "GENERATED";
      affiliateUrl: string;
      provider: string;
    }
  | {
      status: "MANUAL_REQUIRED";
      reason: string;
    }
  | {
      status: "INELIGIBLE";
      reason: string;
    };

export class ManualAffiliateLinkProvider implements AffiliateLinkProvider {
  async generate(_input: {
    marketplace: Marketplace;
    productUrl: string;
    externalProductId?: string;
  }): Promise<AffiliateLinkGenerationResult> {
    return {
      status: "MANUAL_REQUIRED",
      reason:
        "Gere o link no Portal oficial do marketplace e importe-o manualmente.",
    };
  }
}
