import { MercadoLivreAffiliateApiError } from "./affiliate-errors";
import { MercadoLivreAffiliateLinkService } from "./affiliate-link";
import {
  MercadoLivreAffiliateSessionService,
  type MercadoLivreAffiliateHttpOptions,
  type ValidateMercadoLivreAffiliateSessionInput,
  type ValidateMercadoLivreAffiliateSessionResult,
  type WarmMercadoLivreAffiliateSessionInput,
  type WarmMercadoLivreAffiliateSessionResult,
} from "./affiliate-session";
import type {
  CreateMercadoLivreAffiliateLinkInput,
  CreateMercadoLivreAffiliateLinkResult,
} from "./affiliate-types";

export type MercadoLivreAffiliateEndpointMode = "stripe_v2" | "create_link_v2";

export interface MercadoLivreAffiliatePortalAdapter {
  readonly mode: MercadoLivreAffiliateEndpointMode;
  warmupSession(
    input: WarmMercadoLivreAffiliateSessionInput,
  ): Promise<WarmMercadoLivreAffiliateSessionResult>;
  listTags(
    input: ValidateMercadoLivreAffiliateSessionInput,
  ): Promise<ValidateMercadoLivreAffiliateSessionResult>;
  createLinks(
    inputs: readonly CreateMercadoLivreAffiliateLinkInput[],
  ): Promise<CreateMercadoLivreAffiliateLinkResult[]>;
}

export class StripeV2MercadoLivreAffiliatePortalAdapter implements MercadoLivreAffiliatePortalAdapter {
  readonly mode = "stripe_v2" as const;
  private readonly sessionService: MercadoLivreAffiliateSessionService;
  private readonly linkService: MercadoLivreAffiliateLinkService;

  constructor(options: MercadoLivreAffiliateHttpOptions = {}) {
    this.sessionService = new MercadoLivreAffiliateSessionService(options);
    this.linkService = new MercadoLivreAffiliateLinkService(options);
  }

  warmupSession(input: WarmMercadoLivreAffiliateSessionInput) {
    return this.sessionService.warmup(input);
  }

  listTags(input: ValidateMercadoLivreAffiliateSessionInput) {
    return this.sessionService.getTags(input);
  }

  async createLinks(
    inputs: readonly CreateMercadoLivreAffiliateLinkInput[],
  ): Promise<CreateMercadoLivreAffiliateLinkResult[]> {
    const results: CreateMercadoLivreAffiliateLinkResult[] = [];

    for (const input of inputs) {
      results.push(await this.linkService.create(input));
    }

    return results;
  }
}

export function createMercadoLivreAffiliatePortalAdapter(
  options: MercadoLivreAffiliateHttpOptions & {
    mode?: MercadoLivreAffiliateEndpointMode;
  } = {},
): MercadoLivreAffiliatePortalAdapter {
  const mode =
    options.mode ??
    (options.env?.MERCADO_LIVRE_AFFILIATE_ENDPOINT_MODE as
      MercadoLivreAffiliateEndpointMode | undefined) ??
    (process.env.MERCADO_LIVRE_AFFILIATE_ENDPOINT_MODE as
      MercadoLivreAffiliateEndpointMode | undefined) ??
    "stripe_v2";

  if (mode !== "stripe_v2") {
    throw new MercadoLivreAffiliateApiError(
      "The configured Mercado Livre affiliate endpoint mode is not enabled.",
      {
        stage: "RESPONSE_PARSING",
        code: "AFFILIATE_ENDPOINT_MODE_NOT_ENABLED",
      },
    );
  }

  return new StripeV2MercadoLivreAffiliatePortalAdapter(options);
}
