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
  constructor(
    private readonly reason = "AFFILIATE_SESSION_NOT_CONFIGURED: configure a sessao do Portal de Afiliados ou importe o link manualmente.",
  ) {}

  async generate(_input: {
    marketplace: Marketplace;
    productUrl: string;
    externalProductId?: string;
  }): Promise<AffiliateLinkGenerationResult> {
    return {
      status: "MANUAL_REQUIRED",
      reason: this.reason,
    };
  }
}

export type MercadoLivreAffiliateProviderFactoryInput =
  | {
      sessionStatus: "CONNECTED";
      generate: AffiliateLinkProvider["generate"];
    }
  | {
      sessionStatus: "NOT_CONFIGURED" | "EXPIRED" | "UNAVAILABLE";
      reason?: string;
    };

export class MercadoLivreAffiliateSessionLinkProvider implements AffiliateLinkProvider {
  constructor(private readonly generator: AffiliateLinkProvider["generate"]) {}

  generate(input: {
    marketplace: Marketplace;
    productUrl: string;
    externalProductId?: string;
  }) {
    if (input.marketplace !== "MERCADO_LIVRE") {
      return Promise.resolve({
        status: "INELIGIBLE" as const,
        reason: "MARKETPLACE_NOT_SUPPORTED",
      });
    }

    return this.generator(input);
  }
}

export function createMercadoLivreAffiliateLinkProvider(
  input: MercadoLivreAffiliateProviderFactoryInput,
): AffiliateLinkProvider {
  if (input.sessionStatus === "CONNECTED") {
    if (typeof input.generate !== "function") {
      throw new Error(
        "Connected Mercado Livre affiliate session has no link generator.",
      );
    }

    return new MercadoLivreAffiliateSessionLinkProvider(input.generate);
  }

  const reason =
    input.reason ??
    (input.sessionStatus === "EXPIRED"
      ? "AFFILIATE_SESSION_EXPIRED"
      : input.sessionStatus === "UNAVAILABLE"
        ? "AFFILIATE_SESSION_UNAVAILABLE"
        : "AFFILIATE_SESSION_NOT_CONFIGURED");
  return new ManualAffiliateLinkProvider(reason);
}
